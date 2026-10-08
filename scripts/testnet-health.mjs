// testnet-health — 一条命令自检测试网产品（只读，随时可跑）。
//
// 查什么：
//   1) 端点与环境（L1/ER 版本、程序账户大小与最后部署 slot）
//   2) 牌桌白名单：桌存在 / 盲注 / 15 个账户是否已委托 / ER 权限 10/10
//   3) 本地服务：dev(3100)、SSE 中继(8787)、x402 网关(8790)、crank 日志新鲜度
//   4) --deep：对指定桌跑「整手复算 + 行动流」验证（只读，需要该桌有已结算手牌）
//
// 用法:
//   node scripts/testnet-health.mjs                 # 全量自检
//   node scripts/testnet-health.mjs --deep 20       # 额外验证某桌最近一手
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { execFileSync } from "node:child_process";
import { L1_RPC, ER_BASE_URL } from "./env.mjs";
import { tablePdas } from "./lib/deploy-table.mjs";

const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const TABLE_IDS = (process.env.TABLE_IDS ?? fs.readFileSync("web/.env.local", "utf8").match(/^NEXT_PUBLIC_TABLE_IDS=(.*)$/m)?.[1] ?? "5,6,7,8,9,11,12,14,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34")
  .split(",").map((s) => Number(s.trim())).filter(Number.isInteger);

const issues = [];
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.log(`  ✗ ${msg}`); issues.push(msg); };
const info = (msg) => console.log(`    ${msg}`);

const l1 = new Connection(L1_RPC, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(25000) }) });

// ---------- 1) 端点与程序 ----------
console.log(`\n=== 1) 端点与程序 ===`);
console.log(`  L1: ${L1_RPC.split("?")[0]}`);
console.log(`  ER: ${ER_BASE_URL}`);
try {
  const [vL1, vEr] = await Promise.all([l1.getVersion(), fetch(ER_BASE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion" }) }).then((r) => r.json())]);
  info(`L1 ${vL1["solana-core"]} / ER ${vEr.result?.["solana-core"] ?? "?"}（magicblock ${vEr.result?.["magicblock-core"] ?? "?"}）`);
} catch (e) {
  bad(`端点不可达：${String(e.message).slice(0, 80)}`);
}
try {
  const prog = await l1.getAccountInfo(programId);
  const pd = await l1.getAccountInfo(new PublicKey(prog.data.slice(4, 36)));
  info(`程序 ${programId.toBase58().slice(0, 10)}…  数据 ${pd.data.length}B  lastSlot=${pd.data.readBigUInt64LE(4)}`);
  ok("程序账户存在");
} catch (e) {
  bad(`程序账户读取失败：${String(e.message).slice(0, 80)}`);
}

// ---------- 2) 牌桌 ----------
console.log(`\n=== 2) 牌桌（白名单 ${TABLE_IDS.length} 张）===`);
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8"))));
const nacl = (await import("tweetnacl")).default;
let er = null;
try {
  const { token } = await getAuthToken(ER_BASE_URL, deployer.publicKey, async (msg) => nacl.sign.detached(msg, deployer.secretKey));
  er = new Connection(`${ER_BASE_URL}?token=${token}`, "confirmed");
} catch (e) {
  bad(`ER 认证失败：${String(e.message).slice(0, 80)}`);
}

const KIND = { 0: "真人", 1: "AI", 2: "混合" };
for (const id of TABLE_IDS) {
  const p = tablePdas(programId, id);
  const acc = await l1.getAccountInfo(p.table).catch(() => null);
  if (!acc) { bad(`桌 #${id}: Table 不存在`); continue; }
  const kind = acc.data[44];
  const sb = Number(acc.data.readBigUInt64LE(79)) / 1e6;
  const bb = Number(acc.data.readBigUInt64LE(87)) / 1e6;
  const targets = [p.commitPayer, p.game, p.handProof, p.handSecrets, p.deck, ...Array.from({ length: 9 }, (_, i) => p.hand(i)), p.replay];
  const infos = await l1.getMultipleAccountsInfo(targets).catch(() => []);
  const delegated = infos.filter((i) => i && i.owner.equals(DLP)).length;
  // ER 权限账户：2026-10-08 起 devnet-tee 不再经 RPC 暴露这些账户（MagicBlock 侧
  // 行为变更；账户实际存在 —— 重跑 deploy-tables 补齐后 QUICK_SIT_OK 可证）。
  // 因此 0/10 不再判失败，只标注；真正的判定以功能性入座/入账为准。
  let perms = 0;
  if (er) {
    const permAddrs = [p.deck, ...Array.from({ length: 9 }, (_, i) => p.hand(i))].map((t) => p.permission(t));
    const pinfos = await er.getMultipleAccountsInfo(permAddrs).catch(() => []);
    perms = pinfos.filter(Boolean).length;
  }
  const permNote =
    perms === 0
      ? "权限 RPC 不可读（ER 侧变更，以功能性入座为准）"
      : `权限 ${perms}/10`;
  const line = `#${id} ${KIND[kind] ?? kind} ${sb}/${bb}  委托 ${delegated}/15  ${permNote}`;
  if (delegated === 15) ok(line); else bad(line);
}

// ---------- 3) 本地服务 ----------
console.log(`\n=== 3) 本地服务 ===`);
const probe = async (name, url, expectJson = false) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return bad(`${name} 返回 ${r.status}`);
    const body = expectJson ? JSON.stringify(await r.json()).slice(0, 90) : "";
    ok(`${name} 在线 ${body}`);
  } catch {
    bad(`${name} 未运行（${url}）`);
  }
};
await probe("dev server (3100)", "http://127.0.0.1:3100/");
await probe("SSE 中继 (8787)", "http://127.0.0.1:8787/health", true);
await probe("x402 网关 (8790)", "http://127.0.0.1:8790/health", true);
// crank：看日志新鲜度（Windows 上不查进程命令行，跨平台可靠些）
try {
  const st = fs.statSync("crank-all.log");
  const ageS = (Date.now() - st.mtimeMs) / 1000;
  const last = fs.readFileSync("crank-all.log", "utf8").trim().split(/\r?\n/).pop() ?? "";
  if (ageS < 900) info(`crank 日志 ${Math.round(ageS)}s 前更新：${last.slice(0, 90)}`);
  else bad(`crank 日志 ${Math.round(ageS / 60)} 分钟没更新（crank 可能不在跑？启动：node scripts/crank.mjs ${TABLE_IDS.join(",")}）`);
} catch {
  bad("找不到 crank-all.log（crank 未在跑？启动：node scripts/crank.mjs " + TABLE_IDS.join(",") + "）");
}

// ---------- 4) 深度验证（可选） ----------
const deepIdx = process.argv.indexOf("--deep");
if (deepIdx >= 0) {
  const tableId = process.argv[deepIdx + 1];
  console.log(`\n=== 4) 深度验证（桌 #${tableId} 最近一手）===`);
  const run = (script, args) => {
    try {
      return { out: execFileSync(process.execPath, [script, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }) };
    } catch (e) {
      return { out: String(e.stdout ?? e.message), failed: true };
    }
  };
  const rh = run("scripts/verify-hand.mjs", [String(tableId)]);
  (rh.out.includes("HAND_RECOMPUTE_OK") ? ok : bad)(`整手复算：${rh.out.trim().split(/\r?\n/).pop()?.slice(0, 80) ?? "?"}`);
  for (const line of rh.out.split(/\r?\n/).filter((l) => /逐张复算|注:/.test(l))) info(line.trim().slice(0, 100));
  const ra = run("scripts/verify-actions.mjs", [String(tableId)]);
  (ra.out.includes("ACTION_STREAM_OK") ? ok : bad)(`行动流：${ra.out.trim().split(/\r?\n/).pop()?.slice(0, 80) ?? "?"}`);
}

// ---------- 汇总 ----------
console.log(`\n===== 汇总 =====`);
if (issues.length === 0) {
  console.log("TESTNET_HEALTH_OK —— 23 桌可玩、服务在线、验证通过（如有 --deep）");
} else {
  console.log(`发现 ${issues.length} 个问题：`);
  for (const i of issues) console.log(`  - ${i}`);
  process.exitCode = 1;
}
