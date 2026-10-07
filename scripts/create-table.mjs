// 一键建桌：新桌全流程引导（"换新桌"一条命令）。
//   create_table → create_seats → create_hands → delegate ×14 → ER init_permissions
// 幂等：已存在的步骤自动跳过；完成后打印需要写入 web/.env.local 的桌号。
//
// 用法: node scripts/create-table.mjs <tableId> [sb=0.1] [bb=0.2] [ante=0.02]
// 例:   node scripts/create-table.mjs 10
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const L1_URL = process.env.L1_URL ?? "http://127.0.0.1:8898/devnet";
const ER_BASE = process.env.ER_BASE ?? "http://127.0.0.1:7799";
const ER_CU = 1_400_000;
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");

const TABLE_ID = Number(process.argv[2]);
if (!Number.isInteger(TABLE_ID)) {
  console.error("用法: node scripts/create-table.mjs <tableId> [sb] [bb] [ante]");
  process.exit(1);
}
const SB = BigInt(Math.round(Number(process.argv[3] ?? 0.1) * 1e6));
const BB = BigInt(Math.round(Number(process.argv[4] ?? 0.2) * 1e6));
const ANTE = BigInt(Math.round(Number(process.argv[5] ?? 0.02) * 1e6));

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const [delegPayer] = PublicKey.findProgramAddressSync([Buffer.from("deleg_payer")], programId);
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(TABLE_ID)], programId);
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault_auth"), table.toBuffer()], programId);
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
const vault = getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuth, true);
const [game] = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId);
const [handProof] = PublicKey.findProgramAddressSync([Buffer.from("proof"), table.toBuffer()], programId);
const [handSecrets] = PublicKey.findProgramAddressSync([Buffer.from("secrets"), table.toBuffer()], programId);
const [deck] = PublicKey.findProgramAddressSync([Buffer.from("deck"), table.toBuffer(), Buffer.from([0, 0])], programId);
const [commitPayer] = PublicKey.findProgramAddressSync([Buffer.from("commit_payer"), table.toBuffer()], programId);
const seat = (i) => PublicKey.findProgramAddressSync([Buffer.from("seat"), table.toBuffer(), Buffer.from([i])], programId)[0];
const hand = (i) => PublicKey.findProgramAddressSync([Buffer.from("hand"), table.toBuffer(), Buffer.from([0, 0]), Buffer.from([i])], programId)[0];
const perm = (acc) => PublicKey.findProgramAddressSync([Buffer.from("permission:"), acc.toBuffer()], PERMISSION_PROGRAM)[0];

const l1 = new Connection(L1_URL, "confirmed");

async function sendAndConfirm(conn, ixs, signers, label, cu = null) {
  const tx = new Transaction();
  if (cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const t0 = Date.now();
  for (;;) {
    const st = await conn.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
      console.log(`✓ ${label} (${Date.now() - t0}ms)`);
      return sig;
    }
    if (Date.now() - t0 > 120000) throw new Error(`${label} confirmation timeout`);
    await new Promise((r) => setTimeout(r, 700));
  }
}

console.log(`table #${TABLE_ID} → ${table.toBase58()}`);
const program = new anchor.Program(idl, new anchor.AnchorProvider(l1, new anchor.Wallet(deployer), { commitment: "confirmed" }));

// 0) ProgramConfig 必须已初始化（init_config 全链一次性）
if (!(await l1.getAccountInfo(config))) {
  const ix = await program.methods
    .initConfig(deployer.publicKey, TEE_VALIDATOR, deployer.publicKey)
    .accounts({ config, delegPayer, admin: deployer.publicKey })
    .instruction();
  await sendAndConfirm(l1, [ix], [deployer], "init_config (L1)");
} else console.log("… config exists");

// 1) 桌面核心账户
if (!(await l1.getAccountInfo(table))) {
  // vault = ATA(vault_auth, mint)：先建 ATA（deployer 付租金）
  if (!(await l1.getAccountInfo(vault))) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(deployer.publicKey, vault, vaultAuth, TUSDC_MINT)
    );
    await sendAndConfirm(l1, [tx.instructions[0]], [deployer], "create vault ATA");
  }
  const args = {
    tableId: TABLE_ID, kind: 0, sb: new BN(SB.toString()), bb: new BN(BB.toString()),
    ante: new BN(ANTE.toString()), minBuyInBb: 100, maxBuyInBb: 1000,
    rakeBps: 250, rakeCapBb: 3, rakeMinPotBb: 1,
    actionTimeoutS: 30, commitTimeoutS: 10, revealTimeoutS: 10,
    vrfTimeoutS: 10, vrfMaxAttempts: 3, maxStrikes: 3,
    commitEveryNHands: 1, heartbeatS: 1800, escapeStaleS: 7200,
  };
  {
    const ix = await program.methods.createTable(args).accounts({
      table, vaultAuth, vault, mint: TUSDC_MINT,
      game, handProof, handSecrets, deck, commitPayer, admin: deployer.publicKey,
    }).instruction();
    await sendAndConfirm(l1, [ix], [deployer], "create_table (L1)");
  }
  {
    const ix = await program.methods.createSeats().accounts({
      table,
      seat0: seat(0), seat1: seat(1), seat2: seat(2), seat3: seat(3), seat4: seat(4),
      seat5: seat(5), seat6: seat(6), seat7: seat(7), seat8: seat(8),
      admin: deployer.publicKey,
    }).instruction();
    await sendAndConfirm(l1, [ix], [deployer], "create_seats (L1)");
  }
  {
    const ix = await program.methods.createHands().accounts({
      table,
      hand0: hand(0), hand1: hand(1), hand2: hand(2), hand3: hand(3), hand4: hand(4),
      hand5: hand(5), hand6: hand(6), hand7: hand(7), hand8: hand(8),
      admin: deployer.publicKey,
    }).instruction();
    await sendAndConfirm(l1, [ix], [deployer], "create_hands (L1)");
  }
} else console.log("… table exists");

// 2) 委托 ×14（每个账户单独判 DLP owner，可断点续跑）
const targets = [commitPayer, game, handProof, handSecrets, deck, ...Array.from({ length: 9 }, (_, i) => hand(i))];
for (let di = 0; di < 14; di++) {
  const info = await l1.getAccountInfo(targets[di]);
  if (info?.owner.equals(DLP)) { console.log(`… delegate[${di}] already`); continue; }
  const ix = await program.methods
    .delegateTable(TEE_VALIDATOR, di)
    .accounts({ table, delegPayer, target: targets[di], admin: deployer.publicKey })
    .instruction();
  await sendAndConfirm(l1, [ix], [deployer], `delegate_table[${di}] (L1)`);
}

// 3) ER 权限（幂等：已建跳过）
const nacl = (await import("tweetnacl")).default;
const { token } = await getAuthToken(ER_BASE, deployer.publicKey, async (msg) =>
  nacl.sign.detached(msg, deployer.secretKey)
);
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");
const erProgram = new anchor.Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(deployer), { commitment: "confirmed" }));
if (!(await er.getAccountInfo(perm(deck)))) {
  const ix = await erProgram.methods.initPermissions().accounts({
    table, deck,
    hand0: hand(0), hand1: hand(1), hand2: hand(2), hand3: hand(3), hand4: hand(4),
    hand5: hand(5), hand6: hand(6), hand7: hand(7), hand8: hand(8),
    permissionDeck: perm(deck),
    permissionHand0: perm(hand(0)), permissionHand1: perm(hand(1)),
    permissionHand2: perm(hand(2)), permissionHand3: perm(hand(3)),
    permissionHand4: perm(hand(4)), permissionHand5: perm(hand(5)),
    permissionHand6: perm(hand(6)), permissionHand7: perm(hand(7)),
    permissionHand8: perm(hand(8)),
    vault: EPHEMERAL_VAULT, commitPayer, admin: deployer.publicKey,
  }).instruction();
  await sendAndConfirm(er, [ix], [deployer], "init_permissions (ER)", ER_CU);
} else console.log("… permissions exist");

console.log(`\n✅ 桌 #${TABLE_ID} 就绪（盲注 ${Number(SB) / 1e6}/${Number(BB) / 1e6}，ante ${Number(ANTE) / 1e6}）`);
console.log(`提示：把 #${TABLE_ID} 加进 crank 与大厅白名单：`);
console.log(`  1) 重启 crank: node scripts/crank.mjs 5,6,7,8,9,${TABLE_ID}`);
console.log(`  2) web/.env.local: NEXT_PUBLIC_TABLE_IDS=5,6,7,8,9,${TABLE_ID}`);
