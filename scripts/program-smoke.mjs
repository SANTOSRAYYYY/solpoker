// program-smoke — 部署后的派发烟测（2026-10-08 教训固化）。
//
// 背景：一次 `anchor build` 静默中止导致部署的是旧 .so，新指令在链上返回
// `Custom:101 InstructionFallbackNotFound`（派发失败），而「部署成功」的打印
// 看不出来。本脚本对若干指令发**故意非法**的调用（因此不改任何状态），再从
// 交易的日志里确认出现 `Program log: Instruction: <Name>`——这是「程序真的认
// 这条指令」的直接证据；顺便验证 `audit_table`（permissionless 只读）能通过，
// 即 I-X 守恒断言成立。
//
// 用法: node scripts/program-smoke.mjs [tableId=20]
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { L1_RPC } from "./env.mjs";
import { tablePdas, EPHEMERAL_VAULT } from "./lib/deploy-table.mjs";

const TUSDC = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");

const tableId = Number(process.argv[2] ?? 20);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const l1 = new Connection(L1_RPC, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(30000) }) });
const program = new anchor.Program(idl, new anchor.AnchorProvider(l1, new anchor.Wallet(deployer), { commitment: "confirmed" }));
const p = tablePdas(programId, tableId);
const vault = getAssociatedTokenAddressSync(TUSDC, p.vaultAuth, true);
const playerAta = getAssociatedTokenAddressSync(TUSDC, deployer.publicKey, true);
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);

/** 发一笔（预期可能失败），返回 {sig, err} 并抓日志。 */
async function send(ix) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
  tx.feePayer = deployer.publicKey;
  tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(deployer);
  const sig = await l1.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  let err = null;
  for (let i = 0; i < 25; i++) {
    const st = await l1.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) { err = s.err; break; }
    if (s?.confirmationStatus) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const logs = (await l1.getTransaction(sig, { maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? [];
  return { sig, err, logs };
}

const results = [];
async function probe(name, ix, { expectSuccess = false } = {}) {
  const { sig, err, logs } = await send(ix);
  const dispatched = logs.some((l) => l === `Program log: Instruction: ${name}`);
  const ok = dispatched && (expectSuccess ? !err : true); // 失败也 OK：只要派发到
  results.push({ name, dispatched, err, sig, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name.padEnd(20)} 派发=${dispatched ? "是" : "否"}  ` +
      `错误=${err ? JSON.stringify(err).slice(0, 46) : "无"}  ${sig.slice(0, 10)}…`
  );
}

// 1) 老指令：top_up，金额非法（预期业务错误，证明派发）
await probe(
  "TopUp",
  await program.methods.topUp(0, new BN(1)).accounts({
    table: p.table, seat: p.seat(0), vaultAuth: p.vaultAuth, vault, mint: TUSDC,
    playerAta, payer: deployer.publicKey,
  }).instruction()
);

// 2) 新指令（x402 标准模式）：金额非法 → 预期 BadBuyIn，证明派发
const sigBytes = Buffer.alloc(64, 7);
const [depositRecord] = PublicKey.findProgramAddressSync(
  [Buffer.from("x402"), sigBytes.slice(0, 32), sigBytes.slice(32, 64)], programId
);
await probe(
  "CreditX402Deposit",
  await program.methods
    .creditX402Deposit(0, deployer.publicKey, new BN(1), Array.from(sigBytes.slice(0, 32)), Array.from(sigBytes.slice(32, 64)))
    .accounts({
      config, table: p.table, seat: p.seat(0), depositRecord,
      other0: p.seat(1), other1: p.seat(2), other2: p.seat(3), other3: p.seat(4),
      other4: p.seat(5), other5: p.seat(6), other6: p.seat(7), other7: p.seat(8),
      gateway: deployer.publicKey, agentProfile: null,
    })
    .instruction()
);

// 3) audit_table（permissionless 只读）：应成功 —— 同时证明 I-X 守恒成立
const seatPdas = Array.from({ length: 9 }, (_, i) => p.seat(i));
await probe(
  "AuditTable",
  await program.methods.auditTable().accounts({
    table: p.table, game: p.game, vaultAuth: p.vaultAuth, vault, mint: TUSDC,
    seat0: seatPdas[0], seat1: seatPdas[1], seat2: seatPdas[2], seat3: seatPdas[3], seat4: seatPdas[4],
    seat5: seatPdas[5], seat6: seatPdas[6], seat7: seatPdas[7], seat8: seatPdas[8],
    payer: deployer.publicKey,
  }).instruction(),
  { expectSuccess: true }
);

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length === 0 ? "PROGRAM_SMOKE_OK" : "PROGRAM_SMOKE_FAIL"}（${results.length - bad.length}/${results.length}）`);
if (bad.length) {
  console.log("未通过：", bad.map((b) => b.name).join(", "));
  process.exit(1);
}
