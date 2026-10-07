// Byte-compare: probe-style advance (wrong hand_id) vs e2e-style advance
// (correct hand_id via the same helper shape), then send the e2e-style one.
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const ER_BASE = "http://127.0.0.1:7799";
const TABLE_ID = 8;
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(TABLE_ID)], programId);
const [game] = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId);
const [handProof] = PublicKey.findProgramAddressSync([Buffer.from("proof"), table.toBuffer()], programId);
const [handSecrets] = PublicKey.findProgramAddressSync([Buffer.from("secrets"), table.toBuffer()], programId);
const [deck] = PublicKey.findProgramAddressSync([Buffer.from("deck"), table.toBuffer(), Buffer.from([0, 0])], programId);
const hand = (i) => PublicKey.findProgramAddressSync([Buffer.from("hand"), table.toBuffer(), Buffer.from([0, 0]), Buffer.from([i])], programId)[0];

const { token } = await getAuthToken(ER_BASE, deployer.publicKey, async (msg) => {
  const nacl = (await import("tweetnacl")).default;
  return nacl.sign.detached(msg, deployer.secretKey);
});
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");
const erProgram = new anchor.Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(deployer), { commitment: "confirmed" }));

const g0 = await erProgram.account.game.fetch(game);
console.log("phase:", g0.phase, "hand_id:", g0.handId.toString(), "handId type:", typeof g0.handId);

const mkIx = (hid) =>
  erProgram.methods
    .advance(hid)
    .accounts({
      table, game, deck, handProof, handSecrets,
      hand0: hand(0), hand1: hand(1), hand2: hand(2), hand3: hand(3), hand4: hand(4),
      hand5: hand(5), hand6: hand(6), hand7: hand(7), hand8: hand(8),
      caller: deployer.publicKey,
    })
    .instruction();

const ixWrong = await mkIx(g0.handId.add(new BN(999)));
const ixRight = await mkIx(g0.handId);
console.log("keys equal:", JSON.stringify(ixWrong.keys) === JSON.stringify(ixRight.keys));
console.log("data wrong:", ixWrong.data.toString("hex"));
console.log("data right:", ixRight.data.toString("hex"));
console.log("writable count:", ixRight.keys.filter((k) => k.isWritable).length);

// Send the CORRECT one (e2e would do exactly this)
const tx = new Transaction();
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
tx.add(ixRight);
tx.feePayer = deployer.publicKey;
tx.recentBlockhash = (await er.getLatestBlockhash("confirmed")).blockhash;
tx.sign(deployer);
const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
console.log("sent:", sig);
await new Promise((r) => setTimeout(r, 3000));
const info = await er.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
console.log("err:", JSON.stringify(info?.meta?.err));
const g1 = await erProgram.account.game.fetch(game);
console.log("phase after:", g1.phase);
