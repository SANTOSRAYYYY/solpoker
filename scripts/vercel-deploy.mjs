// 一键部署到 Vercel（需先 `npx vercel login`）。
//
// 做什么：
//   1) 在 web/ 下 link 项目（--project solpoker；项目根目录即 web/，monorepo 的正确姿势）
//   2) 把 Production 环境变量写好：公开 3 个 + 服务端 2 个（值从本地文件读，**不回显**）
//   3) `vercel --prod` 生产部署并打印 URL
//
// 用法（仓库根目录）：
//   npx vercel login        # 一次性：浏览器里完成授权
//   node scripts/vercel-deploy.mjs
//
// 可选：DEPLOY_L1_RPC=https://<你的 Helius Secure URL> node scripts/vercel-deploy.mjs
//   （默认用无密钥的 https://rpc.magicblock.app/devnet）
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encode } from "./lib/bs58.mjs";

const web = path.resolve("web");
const VERCEL = "npx --yes vercel@latest";

const runCapture = (cmd, cwd = web) => {
  try {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    return (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
  }
};
const runCaptureIn = runCapture;

const who = runCapture(`${VERCEL} whoami 2>&1`);
if (/Logged out/i.test(who)) {
  console.error("✗ 还没登录 Vercel。先运行：  npx vercel login");
  process.exit(1);
}
console.log(`✓ 已登录：${who.trim().split(/\r?\n/).pop()}`);

console.log("… link 项目（根目录 = web，项目名 solpoker）");
const link = spawnSync(`${VERCEL} link --yes --project solpoker`, { shell: true, cwd: web, stdio: "inherit" });
if (link.status !== 0) process.exit(link.status ?? 1);

// ---- 环境变量（值只从本地读，不打印） ----
const envLocal = fs.readFileSync(path.join(web, ".env.local"), "utf8");
const get = (k) =>
  (envLocal.split(/\r?\n/).find((l) => l.startsWith(`${k}=`)) ?? "")
    .split("=")
    .slice(1)
    .join("=")
    .trim();

const deployerRaw = JSON.parse(fs.readFileSync(path.resolve("keys/deployer.json"), "utf8"));

const VARS = {
  NEXT_PUBLIC_PRIVY_APP_ID: get("NEXT_PUBLIC_PRIVY_APP_ID"),
  NEXT_PUBLIC_TABLE_IDS: get("NEXT_PUBLIC_TABLE_IDS"),
  NEXT_PUBLIC_L1_RPC: process.env.DEPLOY_L1_RPC ?? "https://rpc.magicblock.app/devnet",
  HELIUS_RPC: get("HELIUS_RPC"),
  SOLPOKER_DEPLOYER_KEYPAIR: encode(Uint8Array.from(deployerRaw)),
};
const missing = Object.entries(VARS).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`✗ 缺少值：${missing.join(", ")}（检查 web/.env.local 与 keys/deployer.json）`);
  process.exit(1);
}

for (const [k, v] of Object.entries(VARS)) {
  spawnSync(`${VERCEL} env rm ${k} production -y`, { shell: true, cwd: web, stdio: "ignore" });
  const r = spawnSync(`${VERCEL} env add ${k} production`, {
    shell: true,
    cwd: web,
    input: v + "\n",
    stdio: ["pipe", "ignore", "inherit"],
  });
  console.log(r.status === 0 ? `✓ env ${k}` : `✗ env ${k}（可稍后在仪表盘手填）`);
}

console.log("… 生产部署（首次构建约 2-4 分钟）");

// 关键：从「不含 .git 的干净副本」部署。直接从 git 仓库目录发 CLI 部署会把本地提交作者
// 带给 Vercel，而作者邮箱不在团队里 → 部署被 Blocked（2026-10-08 实测两次）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solpoker-deploy-"));
const EXCLUDE = new Set(["node_modules", ".next", ".vercel", ".git"]);
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDE.has(e.name) || e.name === ".env.local" || e.name.endsWith(".log")) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
};
copyDir(web, tmp);
console.log(`… 已复制干净副本：${tmp}`);
const dl = spawnSync(`${VERCEL} link --project solpoker --yes`, { shell: true, cwd: tmp, stdio: "inherit" });
if (dl.status !== 0) process.exit(dl.status ?? 1);

const out = runCaptureIn(`${VERCEL} --prod --yes 2>&1`, tmp);
const lines = out.trim().split(/\r?\n/);
const url = lines.find((l) => /^https?:\/\//.test(l.trim()))?.trim() ?? "(未解析到 URL，见上方输出)";
console.log("\n=== 部署结果 ===");
console.log(lines.slice(-8).join("\n"));
console.log(`\nURL: ${url}`);
console.log("提醒：① 把该域名加入 Privy 控制台的 allowed origins；② 项目设置里确认 Deployment Protection 已关闭。");
