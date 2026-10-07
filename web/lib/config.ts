// Chain/program constants for the SolPoker web client.
// Mirrors scripts/stage6-full-hand-e2e.mjs — keep in sync.
// Design refs: docs/design/stage1-design.md §13.

import { PublicKey } from "@solana/web3.js";
import idl from "./idl/solpoker.json";

export const PROGRAM_ID = new PublicKey(idl.address);
export const IDL = idl;

// The one demo table for Stage 7 (created + delegated + permissions on-chain).
export const TABLE_ID = Number(process.env.NEXT_PUBLIC_TABLE_ID ?? 9);

// 大厅白名单（2026-10-07）：逗号分隔的桌号列表；设置后大厅只显示这些桌
// （在跑的活桌）。留空 = 显示全部（含历史测试桌，会混入无法游玩的旧桌）。
export const TABLE_IDS_FILTER: number[] = (process.env.NEXT_PUBLIC_TABLE_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

// RPC endpoints. The browser uses the system proxy transparently, so it can
// reach MagicBlock directly (no local relay needed).
export const L1_RPC =
  process.env.NEXT_PUBLIC_L1_RPC ?? "https://rpc.magicblock.app/devnet";
export const ER_RPC =
  process.env.NEXT_PUBLIC_ER_RPC ?? "https://devnet-tee.magicblock.app";

export const TEE_VALIDATOR = new PublicKey(
  "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"
);
export const ER_VRF_QUEUE = new PublicKey(
  "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc"
);
export const PERMISSION_PROGRAM = new PublicKey(
  "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
);
export const EPHEMERAL_VAULT = new PublicKey(
  "MagicVau1t999999999999999999999999999999999"
);
export const TUSDC_MINT = new PublicKey(
  "9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH"
);

// Stage 6 实测：advance 发牌路径 421k CU，ER 游戏循环指令一律带满预算。
export const ER_CU = 1_400_000;
export const MAX_SEATS = 9;
// X10: session key 预充（付 ER 手续费）。
export const SESSION_KEY_LAMPORTS = 1_000_000;
export const SESSION_TTL_S = 7 * 24 * 3600;

export const PHASES = [
  "Idle",
  "Commit",
  "AwaitSeed",
  "Preflop",
  "AwaitStreet",
  "Betting",
  "AwaitRunout",
  "Settle",
  "Void",
] as const;
