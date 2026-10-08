// x402 客户端模拟（标准 x402 exact-SVM 快速路径的本地实现，配 scripts/x402-gateway.mjs）：
//   1. GET  报价（402）
//   2. 付款：一笔只含 ComputeBudget + TransferChecked(→ ATA(vault_auth)) + Memo 的交易
//   3. POST 带 X-PAYMENT: <付款签名> 入账（网关校验 + credit_x402_deposit）
//   4. 复核：座位账本 deposited_total 与 DepositRecord
//
// 用法: node scripts/x402-pay.mjs <tableId> <seatIdx> <payerKeyFile> [amountTusdc]
//   amountTusdc 省略 = 该桌最小买入；payer 默认 keys/test-players.json 的第 1 个。
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { L1_RPC } from "./env.mjs";
import { encode as bs58Encode } from "./lib/bs58.mjs";

/** Memo 程序（标准 x402 客户端的「ComputeBudget + TransferChecked + Memo」三件套）。 */
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const memoIx = (text) =>
  new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [],
    data: Buffer.from(text, "utf8"),
  });

const GATEWAY = process.env.GATEWAY_URL ?? "http://127.0.0.1:8790";
const TUSDC = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];

const tableId = Number(process.argv[2] ?? 20);
const seatIdx = Number(process.argv[3] ?? 0);
const payerFile = process.argv[4] ?? null;
const amountArg = process.argv[5] ? Math.round(Number(process.argv[5]) * 1e6) : null;

const players = JSON.parse(fs.readFileSync("keys/test-players.json", "utf8"));
const payer = payerFile
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerFile, "utf8"))))
  : Keypair.fromSecretKey(Uint8Array.from(players["0"]));
console.log("付款人:", payer.publicKey.toBase58());

const l1 = new Connection(L1_RPC, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(30000) }) });
const table = pda([Buffer.from("table"), u32le(tableId)]);
const vaultAuth = pda([Buffer.from("vault_auth"), table.toBuffer()]);
const vault = getAssociatedTokenAddressSync(TUSDC, vaultAuth, true);
const seat = pda([Buffer.from("seat"), table.toBuffer(), Buffer.from([seatIdx])]);

// 1) 报价
const q = await fetch(`${GATEWAY}/v1/tables/${tableId}/seats/${seatIdx}?payer=${payer.publicKey.toBase58()}`);
console.log("报价 HTTP", q.status);
const quote = await q.json();
const acc = quote.accepts?.[0];
if (!acc) { console.log(JSON.stringify(quote).slice(0, 400)); process.exit(1); }
const amount = amountArg ?? Number(acc.maxAmountRequired);
console.log(`  方案 ${acc.scheme} · 网络 ${acc.network}`);
console.log(`  payTo ${acc.payTo}（表 vault_auth=${vaultAuth.toBase58()} 一致=${acc.payTo === vaultAuth.toBase58()}）`);
console.log(`  金额 ${amount} 单位（${amount / 1e6} tUSDC）`);
if (acc.payTo !== vaultAuth.toBase58()) { console.error("payTo 不是本桌 vault_auth，终止"); process.exit(1); }

// 2) 付款（标准路径：ComputeBudget + TransferChecked + Memo）
const payerAta = getAssociatedTokenAddressSync(TUSDC, payer.publicKey, true);
const tx = new Transaction();
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }));
if (!(await l1.getAccountInfo(payerAta))) {
  tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, payerAta, payer.publicKey, TUSDC));
}
tx.add(createTransferCheckedInstruction(payerAta, TUSDC, vault, payer.publicKey, amount, 6));
tx.add(memoIx(`x402 table=${tableId} seat=${seatIdx} payer=${payer.publicKey.toBase58()}`));
tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
tx.sign(payer);
const paySig = await l1.sendRawTransaction(tx.serialize(), { skipPreflight: false });
await l1.confirmTransaction(paySig, "confirmed");
console.log("付款交易:", paySig);

// 3) 入账
const r = await fetch(`${GATEWAY}/v1/tables/${tableId}/seats/${seatIdx}?payer=${payer.publicKey.toBase58()}&amount=${amount}`, {
  method: "POST",
  headers: { "X-PAYMENT": paySig },
});
const body = await r.json();
console.log("入账 HTTP", r.status, JSON.stringify(body).slice(0, 400));
if (!body.ok) process.exit(1);

// 4) 复核：座位账本 + DepositRecord
const seatInfo = await l1.getAccountInfo(seat);
const deposited = seatInfo.data.readBigUInt64LE(186); // SeatLedger: deposited_total@186 (paid_total@194)
const occupant = new PublicKey(seatInfo.data.slice(41, 73)).toBase58();
console.log(
  `座位 ${seatIdx}: occupant=${occupant.slice(0, 8)}… deposited_total=${deposited} ` +
    `(${Number(deposited) / 1e6} tUSDC) 本座=${occupant === payer.publicKey.toBase58()}`
);
const rec = await l1.getAccountInfo(new PublicKey(body.depositRecord));
console.log(`DepositRecord ${body.depositRecord.slice(0, 10)}…: ${rec ? `存在 ${rec.data.length}B` : "不存在"}`);
// 审计闭环：DepositRecord 里的 64 字节签名回编后必须等于付款交易签名
let sigBack = null;
if (rec) {
  const sigBytes = rec.data.slice(89, 153); // DepositRecord: payer32 table32 seat1 amount8 credited_at8 sig64 bump1
  sigBack = bs58Encode(sigBytes);
  console.log(`DepositRecord.sig 回编 == 付款交易: ${sigBack === paySig}（${sigBack.slice(0, 12)}…）`);
}
console.log(
  occupant === payer.publicKey.toBase58() && deposited >= BigInt(amount) && sigBack === paySig
    ? "X402_PAY_OK"
    : "X402_PAY_MISMATCH"
);
