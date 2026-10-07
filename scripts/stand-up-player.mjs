// 让测试玩家（keys/test-players.json 的 idx）在某桌某座位站起（ER）。
// 与 sit-test-opponent.mjs 配对；站起后等 crank commit，再用 cash-out-seat.mjs 兑付。
// 用法: node scripts/stand-up-player.mjs <tableId> <seatIdx> <playerIdx>
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const ER_BASE = "http://127.0.0.1:7799";
const ER_CU = 1_400_000;
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const TABLE_ID = Number(process.argv[2] ?? 7);
const SEAT = Number(process.argv[3] ?? 1);
const PLAYER_IDX = Number(process.argv[4] ?? 1);

const players = JSON.parse(fs.readFileSync("keys/test-players.json", "utf8")).map((s) =>
  Keypair.fromSecretKey(Uint8Array.from(s))
);
const p = players[PLAYER_IDX];
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(TABLE_ID)], programId);
const [game] = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId);
const seatPda = PublicKey.findProgramAddressSync([Buffer.from("seat"), table.toBuffer(), Buffer.from([SEAT])], programId)[0];
const handPda = PublicKey.findProgramAddressSync([Buffer.from("hand"), table.toBuffer(), Buffer.from([0, 0]), Buffer.from([SEAT])], programId)[0];
const permPda = PublicKey.findProgramAddressSync([Buffer.from("permission:"), handPda.toBuffer()], PERMISSION_PROGRAM)[0];
const [commitPayer] = PublicKey.findProgramAddressSync([Buffer.from("commit_payer"), table.toBuffer()], programId);

const nacl = (await import("tweetnacl")).default;
const { token } = await getAuthToken(ER_BASE, p.publicKey, async (msg) =>
  nacl.sign.detached(msg, p.secretKey)
);
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");
const program = new anchor.Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(p), { commitment: "confirmed" }));

const ix = await program.methods
  .standUp(SEAT)
  .accounts({
    table, game, seatLedger: seatPda, playerHand: handPda,
    permission: permPda, commitPayer, vault: EPHEMERAL_VAULT,
    signer: p.publicKey,
  })
  .instruction();

const tx = new Transaction();
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: ER_CU }));
tx.add(ix);
tx.feePayer = p.publicKey;
tx.recentBlockhash = (await er.getLatestBlockhash("confirmed")).blockhash;
tx.sign(p);
const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
console.log(`stand_up table #${TABLE_ID} seat ${SEAT} by ${p.publicKey.toBase58().slice(0, 8)}…: ${sig}`);
for (let i = 0; i < 60; i++) {
  const st = await er.getSignatureStatuses([sig]);
  const s = st.value[0];
  if (s?.err) { console.log("FAILED:", JSON.stringify(s.err)); process.exit(1); }
  if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
    console.log("stand_up confirmed ✓（crank 稍后 commit，再跑 cash-out-seat.mjs 兑付）");
    break;
  }
  await new Promise((r) => setTimeout(r, 700));
}
