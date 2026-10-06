import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const ER_BASE = "http://127.0.0.1:7799";
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const table = new PublicKey("APLFjrCNUXAZpUafwA4SYUfXUjkbHsXE1EvbHJR9TTQC");
const game = new PublicKey("GZTqShyLCpWVxMv6XJhFrPmf5jdPFDcDKRM7Gq6gY8DG");
const deck = new PublicKey("7YV6EgT9mt9GSPSEYB5Ew6fEpMnZyWzVc4SLJmJWmfGh");

const { token } = await getAuthToken(ER_BASE, deployer.publicKey, async (msg) => {
  const nacl = (await import("tweetnacl")).default;
  return nacl.sign.detached(msg, deployer.secretKey);
});
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");

const acc = await er.getAccountInfo(game);
const o = 8 + 32 + 8 + 5 + 1;
const states = ["Idle", "Ready", "Pending", "Fulfilled", "Void"];
console.log("game state:", states[acc.data.readUInt8(o)], "target:", acc.data.readUInt8(o + 1), "attempt:", acc.data.readUInt8(o + 2), "requested_at:", Number(acc.data.readBigInt64LE(o + 3)));
console.log("now (er clock ~):", Math.floor(Date.now() / 1000));

const sigs = await er.getSignaturesForAddress(game, { limit: 10 });
console.log("recent game txs on ER:");
for (const s of sigs) console.log(" ", s.signature.slice(0, 24) + "…", s.err ? `ERR ${JSON.stringify(s.err)}` : "ok");

const dsigs = await er.getSignaturesForAddress(deck, { limit: 10 });
console.log("recent deck txs on ER:");
for (const s of dsigs) console.log(" ", s.signature.slice(0, 24) + "…", s.err ? `ERR ${JSON.stringify(s.err)}` : "ok");
