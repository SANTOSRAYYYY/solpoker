// 让测试玩家（keys/test-players.json 的 idx）在指定桌的指定座位重新买入入座，
// 这样真人玩家坐下后立刻有对手可以开局。crank 会完成 take_seat。
// 用法: node scripts/sit-test-opponent.mjs <tableId> <seatIdx> [playerIdx=1] [buyIn=20]
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";

const L1_URL = process.env.L1_URL ?? "http://127.0.0.1:8898/devnet";
const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const TABLE_ID = Number(process.argv[2] ?? 9);
const SEAT_IDX = Number(process.argv[3] ?? 1);
const PLAYER_IDX = Number(process.argv[4] ?? 1);
const BUY_IN = BigInt(Math.round(Number(process.argv[5] ?? 20) * 1e6));

const players = JSON.parse(fs.readFileSync("keys/test-players.json", "utf8")).map((s) =>
  Keypair.fromSecretKey(Uint8Array.from(s))
);
const p = players[PLAYER_IDX];
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(TABLE_ID)], programId);
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault_auth"), table.toBuffer()], programId);
const vault = getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuth, true);
const [seat] = PublicKey.findProgramAddressSync([Buffer.from("seat"), table.toBuffer(), Buffer.from([SEAT_IDX])], programId);

const l1 = new Connection(L1_URL, "confirmed");
const program = new anchor.Program(idl, new anchor.AnchorProvider(l1, new anchor.Wallet(p), { commitment: "confirmed" }));
const ata = getAssociatedTokenAddressSync(TUSDC_MINT, p.publicKey);

const tx = new Transaction();
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
tx.add(
  await program.methods
    .sitDown(SEAT_IDX, new BN(BUY_IN.toString()), p.publicKey, new BN(Math.floor(Date.now() / 1000) + 7 * 24 * 3600))
    .accounts({
      table, seat,
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, k) => k).filter((k) => k !== SEAT_IDX).map((k, n) => [
          `other${n}`,
          PublicKey.findProgramAddressSync([Buffer.from("seat"), table.toBuffer(), Buffer.from([k])], programId)[0],
        ])
      ),
      agentProfile: null,
      vaultAuth, vault, mint: TUSDC_MINT, playerAta: ata, payer: p.publicKey,
    })
    .instruction()
);
tx.feePayer = p.publicKey;
tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
tx.sign(p);
const sig = await l1.sendRawTransaction(tx.serialize(), { skipPreflight: true });
console.log(`sit_down ${p.publicKey.toBase58().slice(0, 8)}… → table ${TABLE_ID} seat ${SEAT_IDX}, ${Number(BUY_IN) / 1e6} USDC`);
console.log("sig:", sig.toString());
for (let i = 0; i < 30; i++) {
  const st = await l1.getSignatureStatuses([sig]);
  const s = st.value[0];
  if (s?.err) { console.log("FAILED:", JSON.stringify(s.err)); process.exit(1); }
  if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
    console.log("confirmed ✓（crank 稍后计入座位）");
    break;
  }
  await new Promise((r) => setTimeout(r, 800));
}
