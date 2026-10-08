// program-parity — 链上程序数据 vs 本地 .so 逐字节比对（发布后复验用）。
//
// 为什么需要：2026-10-08 踩过「部署成功但跑的是旧 .so」的坑（新指令报 Custom:101）。
// 部署后跑一下本脚本，确认链上字节就是刚构建的那份。
//
// 用法: node scripts/program-parity.mjs
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { L1_RPC } from "./env.mjs";

const PROGRAM_ID = new PublicKey("EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf");
const SO_PATH = "target/deploy/solpoker.so";

const l1 = new Connection(L1_RPC, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(25000) }) });
const prog = await l1.getAccountInfo(PROGRAM_ID);
if (!prog) {
  console.error("程序账户不存在");
  process.exitCode = 1;
} else {
  const pd = await l1.getAccountInfo(new PublicKey(prog.data.slice(4, 36)));
  const onchain = pd.data.slice(45);
  let local = null;
  try {
    local = fs.readFileSync(SO_PATH);
  } catch {
    console.error(`找不到本地 ${SO_PATH}（先 anchor build --ignore-keys -p solpoker）`);
  }
  console.log(`链上 ${onchain.length}B  lastSlot=${pd.data.readBigUInt64LE(4)}`);
  if (local) {
    const n = Math.min(onchain.length, local.length);
    let firstDiff = -1;
    for (let i = 0; i < n; i++) {
      if (onchain[i] !== local[i]) { firstDiff = i; break; }
    }
    console.log(`本地 ${local.length}B`);
    if (firstDiff === -1) {
      console.log("PROGRAM_PARITY_OK —— 前 %d 字节逐字节一致（链上多出的部分是程序扩容的空位）", n);
    } else {
      console.log(`不一致：首个差异 @ ${firstDiff}`);
      console.log("  链上:", Buffer.from(onchain.slice(Math.max(0, firstDiff - 8), firstDiff + 8)).toString("hex"));
      console.log("  本地:", Buffer.from(local.slice(Math.max(0, firstDiff - 8), firstDiff + 8)).toString("hex"));
      process.exitCode = 1;
    }
  }
}
