// 诊断：Connection + 超时 fetch 包装在中继上是否正常（读 #7 的 game 账户）。
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const ER_BASE = "http://127.0.0.1:7799";
const fetchWithTimeout = (input, init = {}) =>
  fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(20000) });

const deployer = JSON.parse(fs.readFileSync("keys/deployer.json", "utf8"));
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);

const nacl = (await import("tweetnacl")).default;
import { Keypair } from "@solana/web3.js";
const kp = Keypair.fromSecretKey(Uint8Array.from(deployer));
const t0 = Date.now();
const { token } = await getAuthToken(ER_BASE, kp.publicKey, async (msg) =>
  nacl.sign.detached(msg, kp.secretKey)
);
console.log("token in", Date.now() - t0, "ms");

const er = new Connection(`${ER_BASE}?token=${token}`, { commitment: "confirmed", fetch: fetchWithTimeout });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(7)], programId);
const [game] = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId);

for (let i = 0; i < 3; i++) {
  const t = Date.now();
  try {
    const acc = await er.getAccountInfo(game);
    console.log(`getAccountInfo #${i}: ${Date.now() - t}ms, ${acc ? acc.data.length + "B phase=" + acc.data[1544] : "null"}`);
  } catch (e) {
    console.log(`getAccountInfo #${i}: ${Date.now() - t}ms ERROR ${e.message}`);
  }
}
