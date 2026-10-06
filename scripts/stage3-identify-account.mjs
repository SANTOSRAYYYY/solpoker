import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const target = new PublicKey("58fCwJJdq6nTZM9jnPCfN39soqcgSzCD16F3dy3UteNn");

for (const [label, base, withToken] of [
  ["L1", "http://127.0.0.1:8898/devnet", false],
  ["ER", "http://127.0.0.1:7799", true],
]) {
  let url = base;
  if (withToken) {
    const { token } = await getAuthToken(base, deployer.publicKey, async (msg) => {
      const nacl = (await import("tweetnacl")).default;
      return nacl.sign.detached(msg, deployer.secretKey);
    });
    url = `${base}?token=${token}`;
  }
  const conn = new Connection(url, "confirmed");
  const acc = await conn.getAccountInfo(target);
  console.log(label, acc ? `owner=${acc.owner.toBase58()} lamports=${acc.lamports} len=${acc.data.length}` : "MISSING");
}
