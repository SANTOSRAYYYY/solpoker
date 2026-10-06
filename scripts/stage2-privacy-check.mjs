// 隐私现状取证：当前 Deck/Game 在 ER 和 L1 上分别能不能被随便读。
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const L1 = "http://127.0.0.1:8898/devnet";
const ER_BASE = "http://127.0.0.1:7799";
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const game = new PublicKey("C59YCSar9c2ecrm6KgKh9dECarcwdkvY5n3A1n34WxaS"); // table 43
const deck = new PublicKey("BV63PXKR2wtMGr59xsXmoaQXR3LWMffAHpdbMW3Hzu4J");

// 1) L1 侧：委托中的账户归委托程序所有，数据是最后一次 commit 的快照
const l1 = new Connection(L1, "confirmed");
const g1 = await l1.getAccountInfo(game);
const d1 = await l1.getAccountInfo(deck);
console.log("L1 game owner:", g1.owner.toBase58());
console.log("L1 game data[0..16] all-zero:", g1.data.subarray(0, 16).every((b) => b === 0), "(len", g1.data.length + ")");
console.log("L1 deck data all-zero:", d1.data.every((b) => b === 0), "(len", d1.data.length + ")");

// 2) ER 侧：任意钱包拿个 token 就能读 Deck 里的随机数？（用一个全新随机钱包）
const stranger = Keypair.generate();
const { token } = await getAuthToken(ER_BASE, stranger.publicKey, async (msg) => {
  const nacl = (await import("tweetnacl")).default;
  return nacl.sign.detached(msg, stranger.secretKey);
});
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");
try {
  const d2 = await er.getAccountInfo(deck);
  const rnd = d2.data.subarray(16, 48); // vrf_out[0]
  console.log("ER deck readable by a STRANGER wallet:", true);
  console.log("ER deck vrf_out[0] non-zero:", !rnd.every((b) => b === 0), "(", Buffer.from(rnd.slice(0, 8)).toString("hex"), "…)");
} catch (e) {
  console.log("ER deck readable by a STRANGER wallet:", false, "-", String(e).slice(0, 120));
}
