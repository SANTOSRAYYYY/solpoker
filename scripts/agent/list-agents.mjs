import fs from "node:fs";
import { Keypair } from "@solana/web3.js";
for (const name of ["alice", "bob", "carol"]) {
  try {
    const cfg = JSON.parse(fs.readFileSync(`keys/agents/${name}.json`, "utf8"));
    const kp = Keypair.fromSecretKey(Uint8Array.from(cfg.secretKey));
    console.log(name, kp.publicKey.toBase58());
  } catch (e) {
    console.log(name, "ERR", e.message);
  }
}
