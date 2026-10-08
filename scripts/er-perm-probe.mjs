// 单桌 ER 权限探测（幂等；成功 → 提示可全量续跑）。
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { ER_BASE_URL } from "./env.mjs";
import { tablePdas, EPHEMERAL_VAULT } from "./lib/deploy-table.mjs";

const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const nacl = (await import("tweetnacl")).default;
const { token } = await getAuthToken(ER_BASE_URL, deployer.publicKey, async (msg) =>
  nacl.sign.detached(msg, deployer.secretKey)
);
const er = new Connection(`${ER_BASE_URL}?token=${token}`, "confirmed");
const l1 = new Connection(process.env.L1_URL ?? process.env.HELIUS_RPC ?? process.env.NEXT_PUBLIC_L1_RPC ?? "https://rpc.magicblock.app/devnet", "confirmed");
const program = new anchor.Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(deployer), { commitment: "confirmed" }));

const tableId = Number(process.argv[2] ?? 27);
const p = tablePdas(programId, tableId);
if (await er.getAccountInfo(p.permission(p.deck))) {
  console.log(`桌 #${tableId} 权限已存在（无需重建）`);
  process.exit(0);
}
const ix = await program.methods.initPermissions().accounts({
  table: p.table, deck: p.deck,
  hand0: p.hand(0), hand1: p.hand(1), hand2: p.hand(2), hand3: p.hand(3), hand4: p.hand(4),
  hand5: p.hand(5), hand6: p.hand(6), hand7: p.hand(7), hand8: p.hand(8),
  permissionDeck: p.permission(p.deck),
  permissionHand0: p.permission(p.hand(0)), permissionHand1: p.permission(p.hand(1)),
  permissionHand2: p.permission(p.hand(2)), permissionHand3: p.permission(p.hand(3)),
  permissionHand4: p.permission(p.hand(4)), permissionHand5: p.permission(p.hand(5)),
  permissionHand6: p.permission(p.hand(6)), permissionHand7: p.permission(p.hand(7)),
  permissionHand8: p.permission(p.hand(8)),
  vault: EPHEMERAL_VAULT, commitPayer: p.commitPayer, admin: deployer.publicKey,
}).instruction();
const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
tx.feePayer = deployer.publicKey;
tx.recentBlockhash = (await er.getLatestBlockhash("confirmed")).blockhash;
tx.sign(deployer);
// 先 L1 模拟（拿日志）：多数指令的失败原因在这里一眼可见（6010 之类），
// 且不会被 TEE「不返回日志」的特性挡住。
{
  const txSim = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
  txSim.feePayer = deployer.publicKey;
  txSim.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
  txSim.sign(deployer);
  const r = await fetch(process.env.L1_SIM_URL ?? (process.env.L1_URL ?? process.env.HELIUS_RPC ?? "https://rpc.magicblock.app/devnet"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "simulateTransaction",
      params: [Buffer.from(txSim.serialize()).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }],
    }),
  });
  const j = await r.json();
  const v = j.result?.value;
  if (v?.err) {
    console.log("L1 模拟失败（直接看原因）:", JSON.stringify(v.err));
    for (const l of v.logs ?? []) if (/AnchorError|Error Code|Left|Right|failed/.test(l)) console.log("  ", l.slice(0, 200));
    process.exit(1);
  }
  console.log("L1 模拟通过（CU", v?.unitsConsumed, "），继续发 ER…");
}

const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
for (let i = 0; i < 25; i++) {
  const st = await er.getSignatureStatuses([sig]);
  const s = st.value[0];
  if (s?.err) { console.log(`桌 #${tableId} 建权限失败：`, JSON.stringify(s.err)); process.exit(1); }
  if (s?.confirmationStatus) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const ok = !!(await er.getAccountInfo(p.permission(p.deck)));
console.log(`桌 #${tableId} 建权限${ok ? "成功 ✓（可全量续跑：node scripts/deploy-tables.mjs）" : "仍未生效"}`);
