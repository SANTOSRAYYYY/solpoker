import fs from "node:fs";
import { Keypair } from "@solana/web3.js";
fs.mkdirSync("keys/agents", { recursive: true });
if (fs.existsSync("keys/agents/bob-owner.json")) {
  console.log("bob-owner exists");
} else {
  const kp = Keypair.generate();
  fs.writeFileSync("keys/agents/bob-owner.json", JSON.stringify(Array.from(kp.secretKey)));
  console.log("bob-owner:", kp.publicKey.toBase58());
}
