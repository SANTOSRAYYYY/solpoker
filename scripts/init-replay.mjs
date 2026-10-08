// init-replay — 给已存在的桌补 HandReplay（§8.7 整手复算输入，2026-10-08）。
//
// 用法: node scripts/init-replay.mjs 5,6,7,8,9,11,12
import { L1_RPC } from "./env.mjs";
// 幂等：已创建/已委托的步骤自动跳过（可反复跑）。
//
// 每张桌两步（都是 L1 交易，deployer 付款）：
//   1) init_replay：创建 HandReplay 账户（4,048B）
//   2) delegate_table(14)：委托给 TEE validator（DelegPayer 付租金 ~0.0015 SOL/桌）
//
// 部署新程序后必须对所有在跑的桌执行一次——advance 现在把 HandReplay 作为必填账户。
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";

const L1_URL = L1_RPC;
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

const ids = (process.argv[2] ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n));
if (ids.length === 0) {
  console.error("用法: node scripts/init-replay.mjs 5,6,7,8,9,11,12");
  process.exit(1);
}

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const [delegPayer] = PublicKey.findProgramAddressSync([Buffer.from("deleg_payer")], programId);

const l1 = new Connection(L1_URL, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(20000) }) });
const program = new anchor.Program(idl, new anchor.AnchorProvider(l1, new anchor.Wallet(deployer), { commitment: "confirmed" }));

async function send(ixs, label) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(...ixs);
  tx.feePayer = deployer.publicKey;
  tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(deployer);
  const sig = await l1.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  for (let t = 0; ; t++) {
    const st = await l1.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) throw new Error(`${label} failed: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
      console.log(`  ✓ ${label}: ${sig.slice(0, 12)}…`);
      return;
    }
    if (t > 120) throw new Error(`${label} timeout`);
    await new Promise((r) => setTimeout(r, 700));
  }
}

for (const id of ids) {
  console.log(`桌 #${id}`);
  const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(id)], programId);
  const [replay] = PublicKey.findProgramAddressSync([Buffer.from("replay"), table.toBuffer()], programId);

  const tInfo = await l1.getAccountInfo(table);
  if (!tInfo) {
    console.log("  … 桌不存在，跳过");
    continue;
  }

  // 1) 创建
  const cur = await l1.getAccountInfo(replay);
  if (cur && cur.data.length >= 4048) {
    console.log("  … HandReplay 已存在");
  } else {
    const ix = await program.methods.initReplay().accounts({
      table, replay, admin: deployer.publicKey,
    }).instruction();
    await send([ix], `init_replay #${id}`);
  }

  // 2) 委托（幂等：owner 已是 DLP 就跳过）
  const after = await l1.getAccountInfo(replay);
  if (after?.owner.equals(DLP)) {
    console.log("  … 已委托");
  } else {
    const ix = await program.methods
      .delegateTable(TEE_VALIDATOR, 14)
      .accounts({ table, delegPayer, target: replay, admin: deployer.publicKey })
      .instruction();
    await send([ix], `delegate_table[14] #${id}`);
  }
}
console.log("\nINIT_REPLAY_OK");
