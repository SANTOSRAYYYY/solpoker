// watch-table — 逐秒观测一张桌的相位机节奏（诊断「每手/每街等多久」用）。
//
//   node scripts/watch-table.mjs 22            默认观察 300 秒
//   WATCH_S=900 node scripts/watch-table.mjs 22
//
// 打印内容：状态变化时刻（相对启动秒）+ hand# + 相位名 + vrf 状态 + hand_mask +
// 每座位 salt_commit(S)/next_salt_commit(pre) 是否非零 + 上一状态持续秒数 +
// 手号切换标记。判读：
//   vrf: 0=Idle 1=Ready(待请求) 2=Pending(已请求) 3=Fulfilled 4=Void
//   相位: 0=Idle 1=Commit 2=AwaitSeed 3=Preflop 4=AwaitStreet 5=Betting
//         6=AwaitRunout 7=Settle
//   手与手之间 = Settle → 下一手 Preflop 的间隔；每街 = AwaitStreet/Betting 循环。
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import * as env from "./env.mjs";

const tableId = Number(process.argv[2] ?? 22);
const DUR = Number(process.env.WATCH_S ?? 300);
const pid = new PublicKey("EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf");
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const table = PublicKey.findProgramAddressSync([Buffer.from("table"), u32(tableId)], pid)[0];
const game = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], pid)[0];
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const { token } = await getAuthToken(env.ER_BASE_URL, deployer.publicKey, async (msg) =>
  (await import("tweetnacl")).default.sign.detached(msg, deployer.secretKey)
);
const er = new Connection(`${env.ER_BASE_URL}?token=${token}`, { commitment: "confirmed" });

const NAMES = ["Idle", "Commit", "AwaitSeed", "Preflop", "AwaitStreet", "Betting", "AwaitRunout", "Settle"];
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
let prevKey = "";
let prevAt = Date.now();
let prevHand = -1n;

console.log(`watch table #${tableId} for ${DUR}s — game ${game.toBase58()}`);
for (;;) {
  if ((Date.now() - t0) / 1000 > DUR) break;
  try {
    const a = await er.getAccountInfo(game);
    if (a) {
      const d = a.data;
      const phase = d[1544];
      const vrf = d[144];
      const mask = d.readUInt16LE(1526);
      const hand = d.readBigUInt64LE(72);
      const flags = Array.from({ length: 9 }, (_, i) => {
        const o = 152 + i * 152;
        const s = d.subarray(o + 32, o + 64).some((b) => b !== 0) ? 1 : 0;
        const n = d.subarray(o + 64, o + 96).some((b) => b !== 0) ? 1 : 0;
        return `${i}:${s}${n}`;
      }).join(" ");
      const key = `${hand}|${phase}|${vrf}|${mask}|${flags}`;
      if (key !== prevKey) {
        const gap = ((Date.now() - prevAt) / 1000).toFixed(1);
        const handNote = prevHand >= 0n && hand !== prevHand ? `  <<<<<< 手 ${prevHand} -> ${hand}` : "";
        console.log(
          `[${ts()}] hand#${hand} ${NAMES[phase]} vrf=${vrf} mask=${mask.toString(2).padStart(9, "0")} ` +
          `盐[S/pre] ${flags} 上一状态 ${gap}s${handNote}`
        );
        prevKey = key;
        prevAt = Date.now();
        prevHand = hand;
      }
    }
  } catch (e) {
    console.log(`[${ts()}] ERR ${String(e.message ?? e).slice(0, 120)}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log("watch done");
process.exit(0);
