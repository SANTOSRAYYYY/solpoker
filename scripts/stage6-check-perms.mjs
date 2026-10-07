// Decode the PER permission accounts for table 8's deck + hand0 to verify
// admin_set_members actually landed (layout: disc(1) bump(1) account(32)
// private(1) then Member{flags(1), pubkey(32)}[]).
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const ER_BASE = "http://127.0.0.1:7799";
const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(8)], programId);
const [deck] = PublicKey.findProgramAddressSync([Buffer.from("deck"), table.toBuffer(), Buffer.from([0, 0])], programId);
const hand = (i) => PublicKey.findProgramAddressSync([Buffer.from("hand"), table.toBuffer(), Buffer.from([0, 0]), Buffer.from([i])], programId)[0];
const perm = (acc) => PublicKey.findProgramAddressSync([Buffer.from("permission:"), acc.toBuffer()], PERMISSION_PROGRAM)[0];

const { token } = await getAuthToken(ER_BASE, deployer.publicKey, async (msg) => {
  const nacl = (await import("tweetnacl")).default;
  return nacl.sign.detached(msg, deployer.secretKey);
});
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");

for (const [name, pk] of [["deck", deck], ["hand0", hand(0)], ["hand1", hand(1)], ["hand5", hand(5)]]) {
  const info = await er.getAccountInfo(perm(pk));
  if (!info) { console.log(name, "permission MISSING"); continue; }
  const d = info.data;
  const members = [];
  for (let off = 35; off + 33 <= d.length; off += 33) {
    members.push({ flags: d[off], pubkey: new PublicKey(d.subarray(off + 1, off + 33)).toBase58().slice(0, 8) });
  }
  console.log(name, "len:", d.length, "private:", d[34], "members:", JSON.stringify(members));
}
console.log("deployer:", deployer.publicKey.toBase58().slice(0, 8));
