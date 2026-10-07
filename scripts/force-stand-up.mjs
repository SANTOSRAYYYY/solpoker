// 管理员清座：回收弃置座位（密钥丢失等）。筹码全额转入该座位自己的 owed，
// 只有其 payout 地址能通过 cash_out 领取——管理员碰不到任何资金。
// 用法: node scripts/force-stand-up.mjs <tableId> <seatIdx>
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const ER_BASE = "http://127.0.0.1:7799";
const L1_URL = process.env.L1_URL ?? "http://127.0.0.1:8898/devnet";
const ER_CU = 1_400_000;
const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const TABLE_ID = Number(process.argv[2] ?? 5);
const SEAT = Number(process.argv[3] ?? 0);

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(TABLE_ID)], programId);
const [game] = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId);

const nacl = (await import("tweetnacl")).default;
const { token } = await getAuthToken(ER_BASE, deployer.publicKey, async (msg) =>
  nacl.sign.detached(msg, deployer.secretKey)
);
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");
const program = new anchor.Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(deployer), { commitment: "confirmed" }));

const ix = await program.methods
  .adminForceStandUp(SEAT)
  .accounts({ table, game, admin: deployer.publicKey })
  .instruction();
const tx = new Transaction();
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: ER_CU }));
tx.add(ix);
tx.feePayer = deployer.publicKey;
tx.recentBlockhash = (await er.getLatestBlockhash("confirmed")).blockhash;
tx.sign(deployer);
const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
console.log(`admin_force_stand_up #${TABLE_ID} seat ${SEAT}: ${sig}`);
for (let i = 0; i < 60; i++) {
  const st = await er.getSignatureStatuses([sig]);
  const s = st.value[0];
  if (s?.err) { console.log("FAILED:", JSON.stringify(s.err)); process.exit(1); }
  if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
    console.log("confirmed ✓（资金已转入该座位的 owed，等待 crank commit 后可 cash_out）");
    break;
  }
  await new Promise((r) => setTimeout(r, 700));
}

// 顺带确保 payout ATA 存在（cash_out 需要），由 deployer 付租金
const seatPda = PublicKey.findProgramAddressSync([Buffer.from("seat"), table.toBuffer(), Buffer.from([SEAT])], programId)[0];
const l1 = new Connection(L1_URL, "confirmed");
const ledger = await l1.getAccountInfo(seatPda);
const payout = new PublicKey(ledger.data.slice(8 + 32 + 1 + 32 + 8 + 1 + 32 + 32 + 8, 8 + 32 + 1 + 32 + 8 + 1 + 32 + 32 + 8 + 32));
const payoutAta = getAssociatedTokenAddressSync(TUSDC_MINT, payout);
if (!(await l1.getAccountInfo(payoutAta))) {
  const tx2 = new Transaction().add(createAssociatedTokenAccountInstruction(deployer.publicKey, payoutAta, payout, TUSDC_MINT));
  tx2.feePayer = deployer.publicKey;
  tx2.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
  tx2.sign(deployer);
  const s2 = await l1.sendRawTransaction(tx2.serialize(), { skipPreflight: true });
  console.log(`payout ATA 已创建（owner=${payout.toBase58().slice(0, 8)}…）: ${s2.toString().slice(0, 12)}…`);
} else {
  console.log("payout ATA 已存在");
}
