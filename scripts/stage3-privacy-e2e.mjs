// Stage 3 on-chain acceptance: PER privacy layer on devnet-tee.
//
// Flow: create_table (L1) → delegate_game (L1) → init_permissions (ER,
// Deck is_private members=[]) → debug_arm_vrf → request_vrf → fulfilled
// (CPI writes unaffected by PER) → visibility checks:
//   stranger token reads Deck  → must FAIL (§4: PER 强制，不是服务端不返回)
//   stranger token reads Game  → must SUCCEED (公开账户)
//
// Usage: node scripts/stage3-privacy-e2e.mjs [tableId]

import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const L1_URL = "http://127.0.0.1:8898/devnet";
const ER_BASE = "http://127.0.0.1:7799";
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const ER_VRF_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const PERMISSION_PROGRAM_ID = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const TABLE_ID = Number(process.argv[2] ?? 44);

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);

const tableIdBuf = Buffer.alloc(4);
tableIdBuf.writeUInt32LE(TABLE_ID);
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), tableIdBuf], programId);
const [game] = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId);
const [deck] = PublicKey.findProgramAddressSync(
  [Buffer.from("deck"), table.toBuffer(), Buffer.from([0, 0])],
  programId
);
const [permission] = PublicKey.findProgramAddressSync(
  [Buffer.from("permission:"), deck.toBuffer()],
  PERMISSION_PROGRAM_ID
);
const [commitPayer] = PublicKey.findProgramAddressSync(
  [Buffer.from("commit_payer"), table.toBuffer()],
  programId
);

const l1 = new Connection(L1_URL, "confirmed");

async function sendAndConfirm(connection, ixs, signers, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize());
  const t0 = Date.now();
  for (;;) {
    const st = await connection.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
      console.log(`✓ ${label}: ${sig} (${Date.now() - t0}ms)`);
      return sig;
    }
    if (Date.now() - t0 > 120000) throw new Error(`${label} confirmation timeout`);
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function tokenFor(kp) {
  const { token } = await getAuthToken(ER_BASE, kp.publicKey, async (msg) => {
    const nacl = (await import("tweetnacl")).default;
    return nacl.sign.detached(msg, kp.secretKey);
  });
  return token;
}

console.log(`table_id=${TABLE_ID}`);
console.log(`table=${table.toBase58()}\ndeck =${deck.toBase58()}\nperm =${permission.toBase58()}`);

// ---- 1/2. create + delegate ----
const provider = new anchor.AnchorProvider(l1, new anchor.Wallet(deployer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

if (!(await l1.getAccountInfo(table))) {
  const ix = await program.methods
    .createTable(TABLE_ID)
    .accounts({ table, game, deck, commitPayer, admin: deployer.publicKey })
    .instruction();
  await sendAndConfirm(l1, [ix], [deployer], "create_table (L1)");
} else console.log("… table exists");

const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const gi = await l1.getAccountInfo(game);
if (!gi?.owner.equals(DLP)) {
  const ix = await program.methods
    .delegateGame(TEE_VALIDATOR)
    .accounts({ table, game, deck, commitPayer, admin: deployer.publicKey })
    .instruction();
  await sendAndConfirm(l1, [ix], [deployer], "delegate_game (L1)");
} else console.log("… game delegated");

// ---- 3. init_permissions (ER) ----
const erToken = await tokenFor(deployer);
const er = new Connection(`${ER_BASE}?token=${erToken}`, "confirmed");
const erProgram = new anchor.Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(deployer), { commitment: "confirmed" }));

if (!(await er.getAccountInfo(permission))) {
  const ix = await erProgram.methods
    .initPermissions()
    .accounts({ table, deck, permission, commitPayer, admin: deployer.publicKey })
    .instruction();
  await sendAndConfirm(er, [ix], [deployer], "init_permissions (ER, Deck members=[])");
} else console.log("… permission exists");

// ---- 4/5. arm + request + fulfill (CPI writes must be unaffected) ----
const o = 8 + 32 + 8 + 5 + 1;
const states = ["Idle", "Ready", "Pending", "Fulfilled", "Void"];
// 2026-10-10（审计 P1-9）：debug_arm_vrf 已从生产程序删除。stage-3 遗留 harness
// 需改用 advance 的 phase 流程 arm——在此之前无法继续。
throw new Error("debug_arm_vrf 已于 2026-10-10 移除（审计 P1-9）：stage3 harness 需改写为 advance 流程");
const tRequest = Date.now();
{
  const ix = await erProgram.methods
    .requestVrf()
    .accounts({ table, game, payer: deployer.publicKey, vrf: { oracleQueue: ER_VRF_QUEUE } })
    .instruction();
  await sendAndConfirm(er, [ix], [deployer], "request_vrf (ER)");
}
let fulfilled = false;
for (let i = 0; i < 60; i++) {
  const acc = await er.getAccountInfo(game);
  if (states[acc.data.readUInt8(o)] === "Fulfilled") {
    fulfilled = true;
    console.log(`✓ VRF fulfilled in ${Date.now() - tRequest}ms (PER in place, CPI writes unaffected)`);
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!fulfilled) {
  console.error("✗ fulfillment timeout");
  process.exit(1);
}

// ---- 6. visibility checks with a stranger wallet ----
const stranger = Keypair.generate();
const strangerEr = new Connection(`${ER_BASE}?token=${await tokenFor(stranger)}`, "confirmed");

let deckDenied = false;
try {
  const d = await strangerEr.getAccountInfo(deck);
  if (d === null) deckDenied = true; // null response = filtered out
  else {
    console.error(`✗ PRIVACY FAIL: stranger read Deck (${d.data.length} bytes)`);
    process.exit(1);
  }
} catch (e) {
  deckDenied = true;
  console.log(`✓ stranger read Deck denied (${String(e).slice(0, 80)})`);
}
if (deckDenied && !(await strangerEr.getAccountInfo(deck))) {
  console.log("✓ Deck returns null/denied for stranger (PER enforced)");
}

const g = await strangerEr.getAccountInfo(game);
if (g && g.data.length > 0) {
  console.log(`✓ stranger read Game OK (${g.data.length} bytes, public as designed)`);
} else {
  console.error("✗ Game should be publicly readable");
  process.exit(1);
}

console.log("STAGE3_PRIVACY_E2E_OK");
