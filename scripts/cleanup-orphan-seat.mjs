// 一次性清理：用会话密钥让 #9 座0 的孤儿测试座位站起（其钱包私钥已丢失，
// 但 sit_down 授权过的 session key 仍在，可以签 ER 的 stand_up）。
// 之后 crank 会在下一次 commit_game 把 owed 带上 L1，cash_out 即可兑付。
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const ER_BASE = "http://127.0.0.1:7799";
const ER_CU = 1_400_000;
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const TABLE_ID = Number(process.argv[2] ?? 9);
const SEAT = Number(process.argv[3] ?? 0);

const sessionKey = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/.tmp-orphan-session.json", "utf8")))
);
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
const { token } = await getAuthToken(ER_BASE, sessionKey.publicKey, async (msg) =>
  nacl.sign.detached(msg, sessionKey.secretKey)
);
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");
const program = new anchor.Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(sessionKey), { commitment: "confirmed" }));

const ix = await program.methods
  .standUp(SEAT)
  .accounts({
    table, game, seatLedger: seatPda, playerHand: handPda,
    permission: permPda, commitPayer, vault: EPHEMERAL_VAULT,
    signer: sessionKey.publicKey,
  })
  .instruction();

const tx = new Transaction();
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: ER_CU }));
tx.add(ix);
tx.feePayer = sessionKey.publicKey;
tx.recentBlockhash = (await er.getLatestBlockhash("confirmed")).blockhash;
tx.sign(sessionKey);
const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
console.log("stand_up sent:", sig);
for (let i = 0; i < 60; i++) {
  const st = await er.getSignatureStatuses([sig]);
  const s = st.value[0];
  if (s?.err) { console.log("FAILED:", JSON.stringify(s.err)); process.exit(1); }
  if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
    console.log("stand_up confirmed ✓");
    break;
  }
  await new Promise((r) => setTimeout(r, 700));
}
fs.rmSync("keys/.tmp-orphan-session.json", { force: true });
console.log("session key file removed");
