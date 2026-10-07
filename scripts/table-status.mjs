// 全桌体检：读取每张桌的 Game 快照，打印座位占用/筹码/超时计数/阶段。
// 用于诊断「人为什么不离开」：auto-leave 只在有人打牌（有超时/手牌开始）时触发。
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const ER_BASE = process.env.ER_BASE ?? "http://127.0.0.1:7799";
const TABLE_IDS = (process.argv[2] ?? "2,5,6,7,8,9").split(",").map(Number);
const STRIKE_LIMIT = 3;

const deployer = JSON.parse(fs.readFileSync("keys/deployer.json", "utf8"));
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

const nacl = (await import("tweetnacl")).default;
import { Keypair } from "@solana/web3.js";
const kp = Keypair.fromSecretKey(Uint8Array.from(deployer));
const { token } = await getAuthToken(ER_BASE, kp.publicKey, async (msg) =>
  nacl.sign.detached(msg, kp.secretKey)
);
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");

const PHASES = ["Idle", "Commit", "AwaitSeed", "Preflop", "AwaitStreet", "Betting", "AwaitRunout", "Settle", "Void"];
const STATUS = ["Empty", "Seated", "Left"];

for (const id of TABLE_IDS) {
  const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(id)], programId);
  const [game] = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId);
  const acc = await er.getAccountInfo(game);
  if (!acc) { console.log(`#${id}: Game 不存在`); continue; }
  const g = acc.data;
  const phase = g[1544];
  const handId = g.readBigUInt64LE(72);
  const handMask = g.readUInt16LE(1526);
  const occ = g.readUInt16LE(1524);
  const now = Math.floor(Date.now() / 1000);
  const deadline = Number(g.readBigInt64LE(104));
  console.log(`\n#${id}: phase=${PHASES[phase]} hand#${handId} handMask=${handMask.toString(2).padStart(9, "0")} occupied=${occ.toString(2).padStart(9, "0")}${deadline > 0 ? ` deadline=${deadline - now}s` : ""}`);
  for (let i = 0; i < 9; i++) {
    const o = 152 + i * 152;
    const status = g[o + 145];
    if (status === 0) continue;
    const occupant = new PublicKey(g.slice(o, o + 32)).toBase58().slice(0, 8);
    const stack = Number(g.readBigUInt64LE(o + 104)) / 1e6;
    const inHand = g.readBigUInt64LE(o + 128);
    const strikes = g[o + 149];
    const inHandNow = (handMask & (1 << i)) !== 0;
    console.log(
      `   seat${i}: ${occupant}… status=${STATUS[status]} stack=${stack} strikes=${strikes}/${STRIKE_LIMIT}` +
        (inHandNow ? ` [在手牌中,已投${Number(inHand) / 1e6}]` : "") +
        (stack === 0 ? " （0 筹码→下个手牌开始时自动离座）" : "")
    );
  }
}
