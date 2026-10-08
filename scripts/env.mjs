// 统一环境读取：优先进程环境变量，其次读 web/.env.local。
// 目的：Helius 的 API key 只存在 web/.env.local（已 gitignore），脚本不必到处复制。
//
// 用法：
//   import { L1_RPC, ER_BASE_URL } from "../env.mjs";
//   const l1 = new Connection(L1_RPC, "confirmed");
//
// 分工（2026-10-08 实测）：Helius 是 **L1** 索引器 —— 账户、gPA、L1 历史（sit/cash_out/
// commit/delegate）都快且全；但 **看不到 ER 上的交易**（ER 执行不逐笔上 L1），
// 所以行动事件日志（act/timeout 的 emit）只能从 ER（devnet-tee）的交易历史里读。

import fs from "node:fs";
import path from "node:path";

const ENV_FILE = path.resolve(process.cwd(), "web/.env.local");

const fileEnv = (() => {
  const out = {};
  try {
    const text = fs.readFileSync(ENV_FILE, "utf8").replace(/^\uFEFF/, "");
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {
    /* 没有该文件就只用进程环境变量 */
  }
  return out;
})();

export function envValue(key, fallback) {
  const v = process.env[key] ?? fileEnv[key];
  return v === undefined || v === "" ? fallback : v;
}

/** L1 RPC：L1_URL > HELIUS_RPC（带 key，服务端）> NEXT_PUBLIC_L1_RPC（浏览器用 Secure）> MagicBlock 路由 */
export const L1_RPC = envValue(
  "L1_URL",
  envValue(
    "HELIUS_RPC",
    envValue("NEXT_PUBLIC_L1_RPC", "https://rpc.magicblock.app/devnet")
  )
);

/** ER：TEE 端点（ER 读写 + 行动事件日志的唯一来源） */
export const ER_BASE_URL = envValue("ER_BASE", "https://devnet-tee.magicblock.app");
