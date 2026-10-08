// x402 退款 CLI：把「已付进 TableVault 但未入账」的付款退回付款人。
//   node scripts/x402-refund.mjs <tableId> <payerPubkey> <amountTusdc> <paymentSig>
//
// 例（桌 20 那笔因 SameOwner 未入账的 10 tUSDC）：
//   node scripts/x402-refund.mjs 20 DghwJF8EXEEqUvSdJpvBQh3fVQRAncKLzYtA3L9YKui5 10 jv8ygBF4…
//
// 前置：调用者需持有 config.gateway 的密钥（默认 keys/deployer.json）。
// 安全性：程序只允许动「盈余」（退款后余额 ≥ I-X 要求）；RefundRecord 以付款签名
// 两半为种子，同一笔付款不可能被重复退款。
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { L1_RPC } from "./env.mjs";
import { tablePdas } from "./lib/deploy-table.mjs";
import { decode as bs58Decode, encode as bs58Encode } from "./lib/bs58.mjs";

const TUSDC = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");

const [tableIdArg, payerArg, amountArg, sigArg] = process.argv.slice(2);
if (!tableIdArg || !payerArg || !amountArg || !sigArg) {
  console.error("用法: node scripts/x402-refund.mjs <tableId> <payerPubkey> <amountTusdc> <paymentSig>");
  process.exit(1);
}
const tableId = Number(tableIdArg);
const payer = new PublicKey(payerArg);
const amount = BigInt(Math.round(Number(amountArg) * 1e6));
const sigBytes = bs58Decode(sigArg);
if (sigBytes.length !== 64) {
  console.error(`付款签名解码后应为 64 字节，实际 ${sigBytes.length}`);
  process.exit(1);
}

const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const l1 = new Connection(L1_RPC, {
  commitment: "confirmed",
  fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(30000) }),
});
const program = new anchor.Program(idl, new anchor.AnchorProvider(l1, new anchor.Wallet(deployer), { commitment: "confirmed" }));

const p = tablePdas(programId, tableId);
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const vault = getAssociatedTokenAddressSync(TUSDC, p.vaultAuth, true);
const payerAta = getAssociatedTokenAddressSync(TUSDC, payer, true);
const sigLo = Array.from(sigBytes.slice(0, 32));
const sigHi = Array.from(sigBytes.slice(32, 64));
const [refundRecord] = PublicKey.findProgramAddressSync(
  [Buffer.from("x402refund"), Buffer.from(sigLo), Buffer.from(sigHi)],
  programId
);

const bal = async (ata) => (await l1.getTokenAccountBalance(ata).catch(() => null))?.value.uiAmountString ?? "(无 ATA)";
const before = { vault: await bal(vault), payer: await bal(payerAta) };
console.log(`退款前：vault=${before.vault} tUSDC  付款人 ATA=${before.payer} tUSDC`);

const ix = await program.methods
  .refundX402Deposit(new BN(amount.toString()), sigLo, sigHi)
  .accounts({
    config, table: p.table, game: p.game, vaultAuth: p.vaultAuth, vault, mint: TUSDC,
    payer, payerAta,
    refundRecord, gateway: deployer.publicKey,
  })
  .remainingAccounts(

    Array.from({ length: 9 }, (_, i) => ({ pubkey: p.seat(i), isWritable: false, isSigner: false }))

  )

  .instruction();
const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
tx.feePayer = deployer.publicKey;
tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
tx.sign(deployer);
try {
  const sig = await l1.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await l1.confirmTransaction(sig, "confirmed");
  console.log(`退款交易: ${sig}`);
} catch (e) {
  console.log(`退款失败: ${String(e.message).slice(0, 300)}`);
  process.exit(1);
}

const after = { vault: await bal(vault), payer: await bal(payerAta) };
const rec = await l1.getAccountInfo(refundRecord);
console.log(`退款后：vault=${after.vault} tUSDC  付款人 ATA=${after.payer} tUSDC`);
console.log(`RefundRecord ${refundRecord.toBase58().slice(0, 10)}…: ${rec ? `${rec.data.length}B` : "不存在"}`);
if (rec) {
  const d = rec.data;
  const sigBack = bs58Encode(d.slice(8 + 32 + 32 + 8 + 8, 8 + 32 + 32 + 8 + 8 + 64));
  console.log(`  记录: payer=${new PublicKey(d.slice(8, 40)).toBase58().slice(0, 8)}… amount=${d.readBigUInt64LE(72)}`);
  console.log(`  记录签名回编 == 付款签名: ${sigBack === sigArg}`);
}
const ok =
  after.vault !== before.vault &&
  Number(after.payer) - Number(before.payer) === Number(amount) / 1e6;
console.log(ok ? "X402_REFUND_OK" : "X402_REFUND_MISMATCH");
