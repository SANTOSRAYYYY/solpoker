// 自动补币看门狗（2026-10-09）——代替人工盯 ER 余额。
//
// 背景：commit 的费用从「已委托副本」的 lamports 实时扣（live debits），而大账户有
// 免租下限（handSecrets ≈0.0508 SOL / handReplay ≈0.028 / handProof ≈0.026）——
// 余额垫底时 commit_game 整包失败 → L1 快照停更 → 座位释放/兑现（cash_out 6019）卡住。
// 2026-10-09 座位 2 就是这么卡的：牌局本身正常，但快照落后 131 手，用户换不回座位。
//
// 策略：每 INTERVAL 秒巡检一次——只挑「有占用（Seated/Left 未清）或有待提交
// （hands_since_commit > 0）」的桌，调用 scripts/topup-delegated.mjs 把 5 个委托账户
// 补到 TARGET（默认 0.12）。空闲桌不碰：避免一次性把二十几桌全部补满的白花销。
//
// 用法（仓库根目录）：
//   node scripts/topup-watchdog.mjs                    # 默认全桌、600s 一轮
//   node scripts/topup-watchdog.mjs 22,23 300          # 只盯 22/23，5 分钟一轮
//   TARGET_SOL=0.12 MIN_SOL=0.10 node scripts/topup-watchdog.mjs
// 注意：和 crank 一样必须带 L1_URL=https://rpc.magicblock.app/devnet（漏带会回落
// Helius 直连，在此网络环境下全挂）。
import fs from "node:fs";
import { spawn } from "node:child_process";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import * as env from "./env.mjs";

const pid = new PublicKey("EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf");
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (s) => PublicKey.findProgramAddressSync(s, pid)[0];

const DEFAULT_IDS = "5,6,7,8,9,11,12,14,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,41";
const ids = (process.argv[2] ?? DEFAULT_IDS).split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
const INTERVAL_S = Number(process.argv[3] ?? 600);

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const LOG = "logs/topup-watchdog.log";
fs.mkdirSync("logs", { recursive: true });

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
function log(line) {
  const l = `[${ts()}] ${line}`;
  console.log(l);
  try { fs.appendFileSync(LOG, l + "\n"); } catch { /* ignore */ }
}

// 跑一次 topup-delegated（子进程复用现成逻辑：MIN 阈值、lamports PDA 流程、对账日志）
function runTopup(list) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["scripts/topup-delegated.mjs", list.join(",")], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => {
      try { fs.appendFileSync(LOG, out); } catch { /* ignore */ }
      for (const line of out.split(/\r?\n/)) {
        if (/完成：|失败|错误|Error/.test(line)) log(`  topup> ${line}`);
      }
      resolve(code);
    });
  });
}

async function cycle(er) {
  const need = [];
  for (const id of ids) {
    const table = pda([Buffer.from("table"), u32(id)]);
    const game = pda([Buffer.from("game"), table.toBuffer()]);
    const acc = await er.getAccountInfo(game).catch(() => null);
    if (!acc) continue; // ER 上没有（未初始化/未委托）：跳过
    const d = acc.data;
    let occupied = false;
    for (let i = 0; i < 9; i++) {
      const off = 152 + i * 152 + 145; // SeatState.status：0=空 1=在座 2=已离未清
      if (off < d.length && d[off] !== 0) { occupied = true; break; }
    }
    const pendingCommit = d.length > 1550 && d[1550] > 0; // hands_since_commit @1550
    if (occupied || pendingCommit) need.push(id);
  }
  if (need.length === 0) return log("巡检：无占用桌、无待提交 → 跳过补充");
  log(`巡检：${need.join(",")} 需要检查 → 调 topup-delegated（${need.length} 桌）`);
  const code = await runTopup(need);
  log(`topup-delegated 退出码 ${code}`);
}

log(
  `看门狗启动：桌 ${ids.join(",")}，间隔 ${INTERVAL_S}s（TARGET=${process.env.TARGET_SOL ?? "0.12"} MIN=${process.env.MIN_SOL ?? "0.10"}）`
);

for (;;) {
  try {
    const { token } = await getAuthToken(env.ER_BASE_URL, deployer.publicKey, async (m) =>
      (await import("tweetnacl")).default.sign.detached(m, deployer.secretKey)
    );
    const er = new Connection(`${env.ER_BASE_URL}?token=${token}`, "confirmed");
    await cycle(er);
  } catch (e) {
    log(`本轮失败（继续下一轮）：${String(e.message ?? e).slice(0, 160)}`);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
}
