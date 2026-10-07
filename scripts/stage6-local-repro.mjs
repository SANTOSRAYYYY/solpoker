// Local repro of the ER advance(AwaitSeed) ProgramFailedToComplete — v3.
//
// deck/hands are PER-private with members=[], so NOBODY can read them via
// RPC. v3 fetches only the public accounts (table/game/proof/secrets) and
// SYNTHESIZES the private ones: the game's seat salt_commitments are patched
// to match freshly chosen salts (the commitment formula is public), so the
// AwaitSeed salt verification passes and the exact deal-path code runs with
// the same account sizes/owners as on the ER. The .so is the same build that
// traps on devnet-tee. Local Agave returns full logs for the trap.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const ER_BASE = "http://127.0.0.1:7799";
const LOCAL = "http://127.0.0.1:8899";
const TV = "C:\\Users\\Administration\\solana-cli\\solana-release\\bin\\solana-test-validator.exe";
const TABLE_ID = 7;

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

const sha256 = (...parts) => crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
const disc = (name) => sha256(Buffer.from("account:" + name)).subarray(0, 8);
const saltCommitment = (tableB, handId, playerB, salt) =>
  sha256(Buffer.from("solpoker/salt/v1"), tableB, handId.toBuffer("be", 8), playerB, salt);

const { token } = await getAuthToken(ER_BASE, deployer.publicKey, async (msg) => {
  const nacl = (await import("tweetnacl")).default;
  return nacl.sign.detached(msg, deployer.secretKey);
});
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");

const ledger = path.resolve("ledger-local-repro");
// NOTE: must live OUTSIDE the ledger dir — test-validator --reset wipes the
// whole ledger directory at startup (including any accounts/ placed inside).
const acctDir = path.resolve("local-repro-accounts");
fs.rmSync(ledger, { recursive: true, force: true });
fs.rmSync(acctDir, { recursive: true, force: true });
fs.mkdirSync(acctDir, { recursive: true });

const writeAcct = (pk, data, owner = programId) =>
  fs.writeFileSync(path.join(acctDir, pk.toBase58() + ".json"), JSON.stringify({
    pubkey: pk.toBase58(),
    account: {
      lamports: 1_000_000_000,
      data: [Buffer.from(data).toString("base64"), "base64"],
      owner: owner.toBase58(),
      executable: false,
      rentEpoch: 0,
    },
  }));

// Public accounts: fetch as-is.
for (const [name, pk] of [["table", table], ["proof", handProof], ["secrets", handSecrets]]) {
  const info = await er.getAccountInfo(pk);
  if (!info) { console.log("MISSING public account:", name); process.exit(1); }
  writeAcct(pk, info.data, info.owner);
  console.log(`fetched ${name}: ${info.data.length}B`);
}

// Game: fetch, then patch seat salt commitments to match our fresh salts.
const gi = await er.getAccountInfo(game);
if (!gi) { console.log("MISSING game"); process.exit(1); }
const g = Buffer.from(gi.data);
const handIdLE = g.readBigUInt64LE(72);
const handId = new BN(handIdLE.toString());
const handMask = g.readUInt16LE(1526);
console.log("hand_id:", handId.toString(), "hand_mask:", handMask.toString(2), "phase:", g[1544], "vrf.state:", g[144]);
const SEATS_OFF = 152, SEAT_SIZE = 152;
const salts = [];
for (let i = 0; i < 9; i++) {
  if (!(handMask & (1 << i))) continue;
  const occupant = g.subarray(SEATS_OFF + i * SEAT_SIZE, SEATS_OFF + i * SEAT_SIZE + 32);
  const salt = crypto.randomBytes(32);
  salts[i] = salt;
  const commit = saltCommitment(table.toBuffer(), handId, occupant, salt);
  commit.copy(g, SEATS_OFF + i * SEAT_SIZE + 32);
  console.log(`patched seat ${i}: occupant=${new PublicKey(occupant).toBase58().slice(0, 8)} commit ok`);
}
writeAcct(game, g);

// Deck (synthesized): hand_id + empty draw state + one fake VRF_0 output.
const deckBody = Buffer.alloc(472);
deckBody.writeBigUInt64LE(handIdLE, 0);
sha256(Buffer.from("fake-vrf0")).copy(deckBody, 18); // vrf_out[0]
deckBody[466] = 1; // vrf_attempt_used[0]
writeAcct(deck, Buffer.concat([disc("Deck"), deckBody]));

// PlayerHands (synthesized): hand seats get our salts; empty seats zeroed.
for (let i = 0; i < 9; i++) {
  const body = Buffer.alloc(50);
  if (salts[i]) {
    body.writeBigUInt64LE(handIdLE, 0);
    body[8] = 0xff; body[9] = 0xff;
    salts[i].copy(body, 10);
    body.writeBigUInt64LE(handIdLE, 42);
  }
  writeAcct(hand(i), Buffer.concat([disc("PlayerHand"), body]));
}
// Funded deployer for fees.
writeAcct(deployer.publicKey, Buffer.alloc(0), new PublicKey("11111111111111111111111111111111"));

// Refuse to start if something else (relay, zombie validator) holds 8899 —
// otherwise the health poll silently talks to the wrong process (learned the
// hard way: a relay on 8899 made "local" runs hit L1 devnet).
{
  const probe = await fetch("http://127.0.0.1:8899/health").then((r) => r.status).catch(() => null);
  if (probe !== null) {
    console.log("ABORT: port 8899 already in use (status " + probe + "). Kill the relay/zombie first.");
    process.exit(1);
  }
}
const args = [
  "--reset", "--quiet",
  "--ledger", ledger,
  "--bpf-program", programId.toBase58(), path.resolve("target/deploy/solpoker.so"),
  "--account-dir", acctDir,
  "--bind-address", "127.0.0.1",
  "--rpc-port", "8899",
];
console.log("starting test-validator...");
const tv = spawn(TV, args, { stdio: ["ignore", "pipe", "pipe"] });
let tvOut = "";
tv.stdout.on("data", (d) => { tvOut += d; });
tv.stderr.on("data", (d) => { tvOut += d; });

const local = new Connection(LOCAL, "confirmed");
let up = false;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try { await local.getVersion(); up = true; break; } catch {}
  if (tv.exitCode !== null) break;
}
if (!up) {
  console.log("validator failed to start. output tail:");
  console.log(tvOut.slice(-3000));
  tv.kill();
  process.exit(1);
}
console.log("validator up");
{
  const info = await local.getAccountInfo(game);
  if (!info || info.owner.toBase58() !== programId.toBase58()) {
    console.log("ABORT: local game owner mismatch:", info ? info.owner.toBase58() : "MISSING");
    tv.kill();
    process.exit(1);
  }
  console.log("local game owner verified:", info.owner.toBase58().slice(0, 8), info.data.length + "B");
}

const provider = new anchor.AnchorProvider(local, new anchor.Wallet(deployer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const ix = await program.methods
  .advance(handId)
  .accounts({
    table, game, deck, handProof, handSecrets,
    hand0: hand(0), hand1: hand(1), hand2: hand(2), hand3: hand(3), hand4: hand(4),
    hand5: hand(5), hand6: hand(6), hand7: hand(7), hand8: hand(8),
    caller: deployer.publicKey,
  })
  .instruction();
const tx = new Transaction().add(ix);
tx.feePayer = deployer.publicKey;
tx.recentBlockhash = (await local.getLatestBlockhash("confirmed")).blockhash;
tx.sign(deployer);
let sendSig;
try {
  sendSig = await local.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  console.log("sent:", sendSig);
} catch (e) {
  console.log("send error:", e.message);
  if (e.logs) { console.log("--- logs ---"); for (const l of e.logs) console.log(l); }
  tv.kill();
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 2000));
const txInfo = await local.getTransaction(sendSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
console.log("meta err:", JSON.stringify(txInfo?.meta?.err));
console.log("--- logs ---");
for (const l of txInfo?.meta?.logMessages ?? []) console.log(l);
tv.kill();
process.exit(0);
