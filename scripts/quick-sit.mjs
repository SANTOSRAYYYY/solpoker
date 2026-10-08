// quick-sit — 以「真人」身份入座（不带 AgentProfile），用于在混合桌上凑一手牌。
//
// 与 agent.mjs sit 的区别：那个会带上 AgentProfile（= 以 agent 身份入座），
import { L1_RPC } from "./env.mjs";
// 而混合桌 §2.3 禁止同主人的两个 agent 同桌。把其中一个按真人入座即可开局
// （真人座位不受同主人规则约束）。
//
// 用法: node scripts/quick-sit.mjs carol 11 1 20
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";

const [name, tableIdArg, seatArg, buyArg] = process.argv.slice(2);
if (!name || !tableIdArg || !seatArg) {
  console.error("用法: node scripts/quick-sit.mjs <agentName> <tableId> <seat> [buyIn=20]");
  process.exit(1);
}
const TABLE_ID = Number(tableIdArg);
const SEAT = Number(seatArg);
const BUY_IN = BigInt(Math.round(Number(buyArg ?? 20) * 1e6));

const L1_URL = L1_RPC;
const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const SESSION_KEY_LAMPORTS = 1_000_000;
const SESSION_TTL_S = 7 * 24 * 3600;

const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`keys/agents/${name}.json`, "utf8")).secretKey)
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const table = pda([Buffer.from("table"), u32le(TABLE_ID)]);
const seatPda = (i) => pda([Buffer.from("seat"), table.toBuffer(), Buffer.from([i])]);
const vaultAuth = pda([Buffer.from("vault_auth"), table.toBuffer()]);

const l1 = new Connection(L1_URL, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(20000) }) });
const program = new anchor.Program(idl, new anchor.AnchorProvider(l1, new anchor.Wallet(kp), { commitment: "confirmed" }));

async function send(ixs, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      tx.add(...ixs);
      tx.feePayer = kp.publicKey;
      tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
      tx.sign(kp);
      const sig = await l1.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      const t0 = Date.now();
      for (;;) {
        const st = await l1.getSignatureStatuses([sig]);
        const s = st.value[0];
        if (s?.err) throw new Error(`${label} failed: ${JSON.stringify(s.err)}`);
        if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
          console.log(`  ✓ ${label}: ${sig.slice(0, 12)}…`);
          return sig;
        }
        if (Date.now() - t0 > 45000) throw new Error(`${label} confirm timeout`);
        await new Promise((r) => setTimeout(r, 700));
      }
    } catch (e) {
      console.log(`  attempt ${attempt} ${label}: ${String(e.message ?? e).slice(0, 120)}`);
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

console.log(`quick-sit ${name} → 桌#${TABLE_ID} 座${SEAT}（真人身份，无 AgentProfile）`);
const ata = getAssociatedTokenAddressSync(TUSDC_MINT, kp.publicKey);
const vault = getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuth, true);
const ixs = [];
if (!(await l1.getAccountInfo(ata))) {
  ixs.push(createAssociatedTokenAccountInstruction(kp.publicKey, ata, kp.publicKey, TUSDC_MINT));
}
ixs.push(
  await program.methods
    .sitDown(SEAT, new BN(BUY_IN.toString()), kp.publicKey, new BN(Math.floor(Date.now() / 1000) + SESSION_TTL_S))
    .accounts({
      table,
      seat: seatPda(SEAT),
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, k) => k)
          .filter((k) => k !== SEAT)
          .map((k, n) => [`other${n}`, seatPda(k)])
      ),
      agentProfile: null,
      vaultAuth,
      vault,
      mint: TUSDC_MINT,
      playerAta: ata,
      payer: kp.publicKey,
    })
    .instruction()
);
await send(ixs, `sit_down ${name}`);
console.log("QUICK_SIT_OK");
