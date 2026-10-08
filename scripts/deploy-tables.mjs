// 批量建桌（产品线：15 桌部署）。
//   预检（余额/桌号占用/ER 可达）→ 逐桌 create_table → create_seats → create_hands
//   → init_replay → delegate×15 → ER init_permissions → 汇总 + 白名单输出。
// 单桌逻辑与 scripts/create-table.mjs 共用 scripts/lib/deploy-table.mjs（同一份代码）。
//
// 用法:
//   node scripts/deploy-tables.mjs --check          # 只预检（余额/占用/估算），不写链
//   node scripts/deploy-tables.mjs                  # 部署默认 15 桌（id 20..34 的预设矩阵）
//   node scripts/deploy-tables.mjs --ids 20-24      # 自定义桌号（支持 20-24 或 20,21,22）
//   node scripts/deploy-tables.mjs --topup 1.0      # 先给 DelegPayer 转 1 SOL 再部署
//   node scripts/deploy-tables.mjs --dry-run        # 与 --check 同义（保留别名）
//
// 余额估算依据（CHANGELOG Stage 2 实测）：每次 delegate 锁 2,331,640 lamports
// （委托记录/元数据租金，undelegate 时退约 1,926,640），每桌 15 个账户。
// 建桌本身的账户租金由 deployer 付（约 0.03 SOL/桌，含 9 个 Hand 账户）。
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { L1_RPC, ER_BASE_URL } from "./env.mjs";
import { deployTable, tablePdas, PER_DELEGATION_LAMPORTS } from "./lib/deploy-table.mjs";

// 默认 15 桌矩阵：盲注档 × 桌型（0=真人 1=AI 2=混合）。ante = bb/10。
const PRESET = [
  { id: 20, sb: 0.05, bb: 0.1, kind: 0 },
  { id: 21, sb: 0.05, bb: 0.1, kind: 0 },
  { id: 22, sb: 0.05, bb: 0.1, kind: 2 },
  { id: 23, sb: 0.05, bb: 0.1, kind: 1 },
  { id: 24, sb: 0.1, bb: 0.2, kind: 0 },
  { id: 25, sb: 0.1, bb: 0.2, kind: 0 },
  { id: 26, sb: 0.1, bb: 0.2, kind: 2 },
  { id: 27, sb: 0.1, bb: 0.2, kind: 1 },
  { id: 28, sb: 0.25, bb: 0.5, kind: 0 },
  { id: 29, sb: 0.25, bb: 0.5, kind: 2 },
  { id: 30, sb: 0.5, bb: 1.0, kind: 0 },
  { id: 31, sb: 0.5, bb: 1.0, kind: 2 },
  { id: 32, sb: 0.1, bb: 0.2, kind: 0 },
  { id: 33, sb: 0.25, bb: 0.5, kind: 0 },
  { id: 34, sb: 0.5, bb: 1.0, kind: 0 },
];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
const checkOnly = has("--check") || has("--dry-run");
const topup = val("--topup") ? Number(val("--topup")) : null;

function parseIds(spec) {
  const ids = [];
  for (const part of spec.split(",")) {
    const m = /^(\d+)-(\d+)$/.exec(part.trim());
    if (m) {
      for (let i = Number(m[1]); i <= Number(m[2]); i++) ids.push(i);
    } else if (/^\d+$/.test(part.trim())) ids.push(Number(part.trim()));
  }
  return ids;
}
const idsArg = val("--ids");
const PLAN = idsArg
  ? (() => {
      const ids = parseIds(idsArg);
      const byId = new Map(PRESET.map((p) => [p.id, p]));
      return ids.map((id) => byId.get(id) ?? { id, sb: 0.1, bb: 0.2, kind: 0 });
    })()
  : PRESET;

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const [delegPayer] = PublicKey.findProgramAddressSync([Buffer.from("deleg_payer")], programId);
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);

const l1 = new Connection(L1_RPC, {
  commitment: "confirmed",
  fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(30000) }),
});

console.log(`L1  ${L1_RPC.split("?")[0]}`);
console.log(`ER  ${ER_BASE_URL}`);
console.log(`计划 ${PLAN.length} 桌: ${PLAN.map((p) => p.id).join(",")}\n`);

// ---------------- 预检 ----------------
if (!(await l1.getAccountInfo(config))) {
  console.error("⛔ ProgramConfig 不存在（先跑一次 create-table.mjs 完成 init_config）");
  process.exit(1);
}
const [deployerBal, payerInfoInit] = await Promise.all([
  l1.getBalance(deployer.publicKey),
  l1.getAccountInfo(delegPayer),
]);
let payerBal = payerInfoInit?.lamports ?? 0;

// 逐桌算「缺口」：新建 / 缺多少委托 / ER 权限是否缺 —— 已存在但步骤没走完的桌
// 也要进本次队列（长批次会因 token 过期/余额耗尽中途失败，重跑即续）。
const naclTop = (await import("tweetnacl")).default;
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
async function mkErTop() {
  const { token } = await getAuthToken(ER_BASE_URL, deployer.publicKey, async (msg) =>
    naclTop.sign.detached(msg, deployer.secretKey)
  );
  return new Connection(`${ER_BASE_URL}?token=${token}`, "confirmed");
}
const erTop = await mkErTop().catch((e) => {
  console.error(`⛔ ER 不可达/认证失败：${e.message}`);
  process.exit(1);
});
const todo = [];
const complete = [];
let newDelegations = 0;
for (const p of PLAN) {
  const pd = tablePdas(programId, p.id);
  const exists = await l1.getAccountInfo(pd.table);
  if (!exists) {
    todo.push({ ...p, missingDelegations: 15, needsEr: true });
    newDelegations += 15;
    continue;
  }
  const targets = [
    pd.commitPayer, pd.game, pd.handProof, pd.handSecrets, pd.deck,
    ...Array.from({ length: 9 }, (_, i) => pd.hand(i)), pd.replay,
  ];
  const infos = await l1.getMultipleAccountsInfo(targets);
  const missingDelegations = infos.filter((i) => !i || !i.owner.equals(DLP)).length;
  const needsEr = !(await erTop.getAccountInfo(pd.permission(pd.deck)));
  if (missingDelegations > 0 || needsEr) {
    todo.push({ ...p, missingDelegations, needsEr });
    newDelegations += missingDelegations;
  } else complete.push(p.id);
}
const needLamports = newDelegations * PER_DELEGATION_LAMPORTS;

// --topup：在余额门禁之前补币（否则永远过不了检查）
if (topup != null) {
  const lamports = Math.round(topup * 1e9);
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: delegPayer, lamports })
  );
  tx.feePayer = deployer.publicKey;
  tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(deployer);
  const sig = await l1.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await l1.confirmTransaction(sig, "confirmed");
  console.log(`✓ DelegPayer 补币 ${topup} SOL (${sig.slice(0, 12)}…)\n`);
  payerBal = (await l1.getAccountInfo(delegPayer))?.lamports ?? payerBal;
}

console.log(
  `Deployer   ${(deployerBal / 1e9).toFixed(4)} SOL  ${deployerBal < 0.35 ? "⚠ 建桌租金可能不够（约 0.03 SOL/桌）" : ""}`
);
console.log(
  `DelegPayer ${(payerBal / 1e9).toFixed(4)} SOL  （${
    newDelegations > 0 ? `本次委托 ${newDelegations} 次 ≈ ${(needLamports / 1e9).toFixed(3)} SOL` : "无新委托"
  }）`
);
if (newDelegations > 0 && payerBal < needLamports) {
  const short = ((needLamports - payerBal) / 1e9 + 0.02).toFixed(3);
  console.error(
    `⛔ DelegPayer 不足：缺 ≈ ${((needLamports - payerBal) / 1e9).toFixed(3)} SOL。补币：`
  );
  console.error(`   node scripts/deploy-tables.mjs --topup ${short}     # 或`);
  console.error(`   solana transfer ${delegPayer.toBase58()} ${short} --url <L1_RPC> --from <钱包>`);
  if (!has("--force")) process.exit(1);
} else if (newDelegations > 0) {
  console.log(`   → 余额足够，预计剩余 ${((payerBal - needLamports) / 1e9).toFixed(3)} SOL`);
}
console.log(`\n已完整（跳过）: ${complete.join(",") || "无"}`);
console.log(
  `本次要处理: ${
    todo.map((p) => `#${p.id}(${p.missingDelegations ? `缺${p.missingDelegations}委托` : ""}${p.needsEr ? `${p.missingDelegations ? "+" : ""}缺ER权限` : ""})`).join("  ") || "无"
  }`
);
if (checkOnly) {
  console.log("\n--check：只预检，未写链。");
  process.exit(0);
}

// ---------------- 逐桌部署 ----------------
const nacl = (await import("tweetnacl")).default;
/** ER 连接会因 token 过期而失效 → 每桌/重试时换新 token。 */
async function mkEr() {
  const { token } = await getAuthToken(ER_BASE_URL, deployer.publicKey, async (msg) =>
    nacl.sign.detached(msg, deployer.secretKey)
  );
  const conn = new Connection(`${ER_BASE_URL}?token=${token}`, "confirmed");
  return { conn, program: prog(conn) };
}
const prog = (conn) =>
  new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" }));

const results = [];
const payerBefore = (await l1.getAccountInfo(delegPayer))?.lamports ?? 0;
for (const p of todo) {
  try {
    const er0 = await mkEr();
    const r = await deployTable({
      id: p.id, sb: p.sb, bb: p.bb, ante: +(p.bb / 10).toFixed(6), kind: p.kind,
      conns: { l1, er: er0.conn },
      programs: { l1: prog(l1), er: er0.program },
      refreshEr: mkEr,
      programId, deployer, idl, log: (s) => console.log(s),
    });
    results.push({ id: p.id, ok: r.erOk, ...r });
  } catch (e) {
    console.error(`✗ 桌 #${p.id} 失败：${e.message}`);
    results.push({ id: p.id, ok: false, err: e.message });
  }
}
const payerAfter = (await l1.getAccountInfo(delegPayer))?.lamports ?? 0;
const spent = payerBefore - payerAfter;
const delegatedNow = results.reduce((n, r) => n + (r.delegated ?? 0), 0);

// ---------------- 汇总 + 白名单 ----------------
const okIds = results.filter((r) => r.ok).map((r) => r.id);
const failed = results.filter((r) => !r.ok);
console.log(`\n===== 汇总 =====`);
console.log(`本次就绪 ${okIds.length}/${todo.length}：${okIds.join(",") || "无"}`);
if (failed.length)
  console.log(`未完成：${failed.map((f) => `#${f.id}${f.err ? `(${String(f.err).slice(0, 60)})` : "(ER 权限未建)"}`).join(" ")}`);
console.log(`白名单覆盖 ${complete.length + okIds.length} 桌（已完整 ${complete.length} + 本次就绪 ${okIds.length}）`);
if (delegatedNow > 0) {
  console.log(
    `DelegPayer 实测消耗 ${(spent / 1e9).toFixed(4)} SOL / ${delegatedNow} 次委托 = ${(spent / delegatedNow).toFixed(0)} lamports/次`
  );
}

// 白名单 = 现有 NEXT_PUBLIC_TABLE_IDS ∪ 已完整 ∪ 本次就绪
const envPath = "web/.env.local";
const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const cur = (/^NEXT_PUBLIC_TABLE_IDS=(.*)$/m.exec(envText)?.[1] ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const merged = [...new Set([...cur, ...complete, ...okIds])].sort((a, b) => a - b);
console.log(`\n白名单（把这一行写进 ${envPath}）：`);
console.log(`  NEXT_PUBLIC_TABLE_IDS=${merged.join(",")}`);
console.log(`crank 启动参数：`);
console.log(`  node scripts/crank.mjs ${merged.join(",")}`);
console.log(`\n（web dev server 与 crank 需重启才读到新白名单。）`);
