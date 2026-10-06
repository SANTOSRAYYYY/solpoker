import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const ER_BASE = "http://127.0.0.1:7799";
const TABLE_ID = 45;
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const tableIdBuf = Buffer.alloc(4);
tableIdBuf.writeUInt32LE(TABLE_ID);
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), tableIdBuf], programId);
const [deck] = PublicKey.findProgramAddressSync([Buffer.from("deck"), table.toBuffer(), Buffer.from([0, 0])], programId);
const [permission] = PublicKey.findProgramAddressSync(
  [Buffer.from("permission:"), deck.toBuffer()],
  new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1")
);
const [commitPayer] = PublicKey.findProgramAddressSync(
  [Buffer.from("commit_payer"), table.toBuffer()],
  programId
);

const { token } = await getAuthToken(ER_BASE, deployer.publicKey, async (msg) => {
  const nacl = (await import("tweetnacl")).default;
  return nacl.sign.detached(msg, deployer.secretKey);
});
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");

for (const [name, pk] of Object.entries({ table, deck, permission, commitPayer })) {
  const acc = await er.getAccountInfo(pk);
  console.log(name.padEnd(14), acc ? `owner=${acc.owner.toBase58().slice(0, 8)}… lamports=${acc.lamports} len=${acc.data.length}` : "MISSING");
}

// delegation status of commit_payer from the router
const router = new Connection("http://127.0.0.1:8898", "confirmed");
try {
  const st = await router._rpcRequest("getDelegationStatus", [commitPayer.toBase58()]);
  console.log("commit_payer delegation status:", JSON.stringify(st.result ?? st).slice(0, 200));
} catch (e) {
  console.log("getDelegationStatus failed:", String(e).slice(0, 120));
}

const erProgram = new anchor.Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(deployer), { commitment: "confirmed" }));
const ix = await erProgram.methods
  .initPermissions()
  .accounts({ table, deck, permission, commitPayer, admin: deployer.publicKey })
  .instruction();
const tx = new Transaction().add(ix);
tx.feePayer = deployer.publicKey;
tx.recentBlockhash = (await er.getLatestBlockhash("confirmed")).blockhash;
tx.sign(deployer);
const sim = await er.simulateTransaction(tx, undefined, true);
console.log("simulation err:", JSON.stringify(sim.value.err));
console.log("logs:", sim.value.logs);
