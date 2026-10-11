// Agent 自动补位看门狗（2026-10-11）——让 22 号桌的 AI 队伍一直满员。
//
// 背景：bob/carol/dave/eve/frank 在 #22 打现金桌，弱的三位每隔一两个小时就会被
// bob/frank 赢光出局；runner 不会自动重买，之前要人工 fund+sit 三次。现在自动化：
// 每 60 秒检查一次，谁不在座（游戏座位里没有他的钱包）就：
//   1) 找一张「ER 游戏座 + L1 账本」双空位的座位；
//   2) 钱包余额不足 BUY_IN 就先补铸差额（tUSDC，测试网）；
//   3) 调 agent.mjs sit 入座（等 crank take_seat 接座，runner 自动接管打牌）。
//
// 用法（仓库根目录）：
//   L1_URL=https://rpc.magicblock.app/devnet node scripts/agent-rebuy-watchdog.mjs
// 可调环境变量：TABLE_ID=22 ROSTER=bob,carol,dave,eve,frank BUY_IN=100 INTERVAL_S=60
// 日志：logs/agent-rebuy.log（gitignored）。
import fs from "node:fs";
import { spawn } from "node:child_process";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as env from "./env.mjs";

const PROGRAM_ID = new PublicKey("EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf");
const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const TABLE_ID = Number(process.env.TABLE_ID ?? 22);
const ROSTER = (process.env.ROSTER ?? "bob,carol,dave,eve,frank").split(",").map((s) => s.trim());
const BUY_IN = Number(process.env.BUY_IN ?? 100);
const INTERVAL_S = Number(process.env.INTERVAL_S ?? 60);

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const tablePda = pda([Buffer.from("table"), u32(TABLE_ID)]);

const l1 = new Connection(env.L1_RPC, { commitment: "confirmed" });
const er = new Connection(env.ER_BASE_URL, { commitment: "confirmed" }); // game 是公开账户，无需 token

const LOG = "logs/agent-rebuy.log";
fs.mkdirSync("logs", { recursive: true });
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
function log(line) {
  const l = `[${ts()}] ${line}`;
  console.log(l);
  try { fs.appendFileSync(LOG, l + "\n"); } catch { /* ignore */ }
}

function loadAgentPub(name) {
  const cfg = JSON.parse(fs.readFileSync(`keys/agents/${name}.json`, "utf8"));
  return { name, pub: Keypair.fromSecretKey(Uint8Array.from(cfg.secretKey)).publicKey };
}

const cooldown = new Map(); // name -> ts，失败/刚入座后的冷却

function runAgentCmd(args, label) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["scripts/agent/agent.mjs", ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => {
      for (const line of out.split(/\r?\n/)) {
        if (/funded|上链|失败|Error|error/.test(line)) log(`  ${label}> ${line.slice(0, 140)}`);
      }
      resolve(code);
    });
  });
}

async function gameSnapshot() {
  const acc = await er.getAccountInfo(pda([Buffer.from("game"), tablePda.toBuffer()]));
  if (!acc) return null;
  const d = acc.data;
  const seats = [];
  for (let i = 0; i < 9; i++) {
    const off = 152 + i * 152;
    seats.push({
      idx: i,
      occupant: new PublicKey(d.slice(off, off + 32)),
      status: d[off + 145],
    });
  }
  return seats;
}

async function l1SeatFree(idx) {
  const acc = await l1.getAccountInfo(pda([Buffer.from("seat"), tablePda.toBuffer(), Buffer.from([idx])]));
  if (!acc || acc.data.length < 203) return true;
  return new PublicKey(acc.data.slice(41, 73)).equals(PublicKey.default);
}

async function walletUsdc(pub) {
  const ata = getAssociatedTokenAddressSync(TUSDC_MINT, pub);
  const acc = await l1.getTokenAccountBalance(ata).catch(() => null);
  return acc ? Number(acc.value.uiAmount ?? 0) : 0;
}

for (;;) {
  try {
    const seats = await gameSnapshot();
    if (!seats) { log("game 账户读不到（ER 抖动？）→ 下一轮"); }
    else {
      const seated = new Set(seats.filter((s) => !s.occupant.equals(PublicKey.default)).map((s) => s.occupant.toBase58()));
      const agents = ROSTER.map(loadAgentPub);
      const missing = agents.filter((a) => !seated.has(a.pub.toBase58()));
      if (missing.length === 0) {
        log(`巡检 #${TABLE_ID}：${ROSTER.length}/${ROSTER.length} 在座 ✓`);
      } else {
        log(`巡检 #${TABLE_ID}：在座 ${ROSTER.length - missing.length}/${ROSTER.length}，缺 ${missing.map((m) => m.name).join(",")}`);
        for (const m of missing) {
          if ((cooldown.get(m.name) ?? 0) > Date.now()) continue;
          // 找双空位（ER 游戏座 + L1 账本都空）
          let seat = null;
          for (const s of seats) {
            if (s.status === 1 || !s.occupant.equals(PublicKey.default)) continue;
            if (await l1SeatFree(s.idx)) { seat = s.idx; break; }
          }
          if (seat === null) { log(`  ${m.name}: 没有双空位，本轮跳过`); continue; }
          // 补币（不足才铸差额）
          const bal = await walletUsdc(m.pub);
          if (bal < BUY_IN) {
            const delta = Math.max(0.01, Math.round((BUY_IN - bal) * 100) / 100);
            log(`  ${m.name}: 余额 ${bal} < ${BUY_IN} → fund +${delta}`);
            const code = await runAgentCmd(["fund", m.name, "0.02", String(delta)], `fund ${m.name}`);
            if (code !== 0) { log(`  ${m.name}: fund 失败（exit ${code}），冷却 10 分钟`); cooldown.set(m.name, Date.now() + 600_000); continue; }
          }
          log(`  ${m.name}: sit #${TABLE_ID} 座 ${seat}（buy-in ${BUY_IN}）`);
          const code = await runAgentCmd(["sit", m.name, String(TABLE_ID), String(seat), String(BUY_IN)], `sit ${m.name}`);
          cooldown.set(m.name, Date.now() + (code === 0 ? 180_000 : 600_000)); // 成功等接座 3 分钟
          if (code !== 0) log(`  ${m.name}: sit 失败（exit ${code}），冷却 10 分钟`);
          await new Promise((r) => setTimeout(r, 25_000)); // 给 crank 一轮接座的时间，再处理下一个
        }
      }
    }
  } catch (e) {
    log(`本轮失败（继续）：${String(e.message ?? e).slice(0, 140)}`);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
}
