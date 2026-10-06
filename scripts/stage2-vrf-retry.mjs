import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const ER_BASE = "http://127.0.0.1:7799";
const ER_VRF_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const TABLE_ID = 42;

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const tableIdBuf = Buffer.alloc(4);
tableIdBuf.writeUInt32LE(TABLE_ID);
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), tableIdBuf], programId);
const [game] = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId);
const [deck] = PublicKey.findProgramAddressSync(
  [Buffer.from("deck"), table.toBuffer(), Buffer.from([0, 0])],
  programId
);

const { token } = await getAuthToken(ER_BASE, deployer.publicKey, async (msg) => {
  const nacl = (await import("tweetnacl")).default;
  return nacl.sign.detached(msg, deployer.secretKey);
});
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");
const provider = new anchor.AnchorProvider(er, new anchor.Wallet(deployer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

async function sendAndConfirm(ixs, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = deployer.publicKey;
  tx.recentBlockhash = (await er.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(deployer);
  const sig = await er.sendRawTransaction(tx.serialize());
  const t0 = Date.now();
  for (;;) {
    const st = await er.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) throw new Error(`${label} failed: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
      console.log(`✓ ${label}: ${sig} (${Date.now() - t0}ms)`);
      return sig;
    }
    if (Date.now() - t0 > 60000) throw new Error(`${label} timeout`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const o = 8 + 32 + 8 + 5 + 1;
const states = ["Idle", "Ready", "Pending", "Fulfilled", "Void"];
function gameState(d) {
  return { state: states[d.readUInt8(o)], target: d.readUInt8(o + 1), attempt: d.readUInt8(o + 2) };
}

const before = gameState((await er.getAccountInfo(game)).data);
console.log("before:", JSON.stringify(before));

const tRequest = Date.now();
const ix = await program.methods
  .retryVrf()
  .accounts({ table, game, payer: deployer.publicKey, vrf: { oracleQueue: ER_VRF_QUEUE } })
  .instruction();
await sendAndConfirm([ix], "retry_vrf (ER)");

for (let i = 0; i < 90; i++) {
  const acc = await er.getAccountInfo(game);
  const g = gameState(acc.data);
  if (g.state === "Fulfilled") {
    console.log(`✓ VRF fulfilled in ${Date.now() - tRequest}ms (attempt=${g.attempt})`);
    const deckAcc = await er.getAccountInfo(deck);
    const rnd = deckAcc.data.subarray(8 + 8 + 32, 8 + 8 + 64); // vrf_out[1] (Flop)
    console.log(`✓ Deck.vrf_out[Flop] non-zero: ${!rnd.every((b) => b === 0)} (${Buffer.from(rnd.slice(0, 8)).toString("hex")}…)`);
    console.log("RETRY_FULFILL_OK");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.error("✗ fulfillment timeout");
process.exit(1);
