// 通用兑付：cash_out（permissionless，deployer 签名）把某桌某座位的 owed 付到
// 其固定 payout ATA，条件满足时释放座位。用法:
//   node scripts/cash-out-seat.mjs <tableId> <seatIdx>
import { L1_RPC } from "./env.mjs";
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";

const L1_URL = L1_RPC;
const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const TABLE_ID = Number(process.argv[2] ?? 9);
const SEAT = Number(process.argv[3] ?? 0);

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(TABLE_ID)], programId);
const [game] = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId);
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault_auth"), table.toBuffer()], programId);
const vault = getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuth, true);
const seat = PublicKey.findProgramAddressSync([Buffer.from("seat"), table.toBuffer(), Buffer.from([SEAT])], programId)[0];

const l1 = new Connection(L1_URL, "confirmed");

// SeatLedger 的 payout @ offset 8+32+1+32+8+1+32+32+8+8 = 162? 直接用 borsh 解析：
const ledger = await l1.getAccountInfo(seat);
if (!ledger) { console.log("seat ledger 不存在"); process.exit(1); }
// disc(8) table(32) idx(1) occupant(32) occupancy_id(8) kind(1) agent_owner(32)
// session_key(32) session_expires_at(8) payout(32) deposited(8) paid(8) bump(1)
const payout = new PublicKey(ledger.data.slice(8 + 32 + 1 + 32 + 8 + 1 + 32 + 32 + 8, 8 + 32 + 1 + 32 + 8 + 1 + 32 + 32 + 8 + 32));
const payoutAta = getAssociatedTokenAddressSync(TUSDC_MINT, payout);
console.log(`table #${TABLE_ID} seat ${SEAT}: payout=${payout.toBase58().slice(0, 8)}… ata=${payoutAta.toBase58().slice(0, 8)}…`);
// 2026-10-10（审计 M5）：破坏性操作需显式确认——没带 --yes 只打印计划。
if (!process.argv.includes("--yes")) {
  console.log(`将对该座发 cash_out（资金只进上面钉死的 payout）。确认无误后加 --yes 执行。`);
  process.exit(0);
}

const program = new anchor.Program(idl, new anchor.AnchorProvider(l1, new anchor.Wallet(deployer), { commitment: "confirmed" }));
const tx = new Transaction();
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
tx.add(
  await program.methods
    .cashOut(SEAT)
    .accounts({ table, game, seat, vaultAuth, vault, mint: TUSDC_MINT, payoutAta, caller: deployer.publicKey })
    .instruction()
);
tx.feePayer = deployer.publicKey;
tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
tx.sign(deployer);
try {
  const sig = await l1.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  console.log("cash_out sent:", sig);
  for (let i = 0; i < 60; i++) {
    const st = await l1.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) { console.log("FAILED:", JSON.stringify(s.err), "（快照可能还没带上 L1，等 crank commit 后重试）"); process.exit(1); }
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
      const bal = await l1.getTokenAccountBalance(payoutAta).catch(() => null);
      const led = await l1.getAccountInfo(seat);
      console.log(`confirmed ✓  payout ATA 余额=${bal?.value.uiAmount ?? "?"}  座位状态字节@73=${led.data[8 + 32 + 1 + 32 + 8]}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
} catch (e) {
  console.log("send error:", e.message);
}
