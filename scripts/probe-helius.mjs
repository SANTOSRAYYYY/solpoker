// 探针：Helius devnet RPC 能力 + 能否看到 ER 上的交易（act）—— **key 从 env 读，不进仓库**
// 用法: node scripts/probe-helius.mjs
//
// 2026-10-08 实测结论（本探针的输出）：
//   helius getVersion ✓ / 账户读 ✓ / gPA(AgentProfile) ✓
//   **helius ∩ er = 0** —— Helius 是 L1 索引器，看不到 ER（devnet-tee）上的交易；
//   所以行动事件日志（act/timeout 的 emit）只能从 ER 的交易历史里取。
//   分工：Helius = L1（账户/gPA/L1 历史，快且全）；ER = ER 读写 + 行动事件日志。
import { Connection, PublicKey } from "@solana/web3.js";
import { L1_RPC, ER_BASE_URL } from "./env.mjs";

const HELIUS = L1_RPC;
const ER = ER_BASE_URL;

const idl = JSON.parse((await import("node:fs")).readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const table = pda([Buffer.from("table"), u32le(14)]);
const game = pda([Buffer.from("game"), table.toBuffer()]);

const helius = new Connection(HELIUS, "confirmed");
const mb = new Connection(MB, "confirmed");
const er = new Connection(ER, "confirmed");

// 1) 基本可用性
try {
  const v = await helius.getVersion();
  console.log("helius getVersion:", JSON.stringify(v).slice(0, 80));
} catch (e) {
  console.log("helius getVersion 失败:", String(e.message ?? e).slice(0, 120));
}

// 2) 账户读（L1 上的 Game 快照 / 程序账户）
try {
  const acc = await helius.getAccountInfo(game);
  console.log("helius game 账户:", acc ? `len=${acc.data.length}` : "null");
} catch (e) {
  console.log("helius getAccountInfo 失败:", String(e.message ?? e).slice(0, 120));
}

// 3) gPA（扫 AgentProfile）—— MagicBlock 路由可能不支持
for (const [name, conn] of [["helius", helius], ["magicblock", mb]]) {
  try {
    const res = await conn.getProgramAccounts(programId, {
      filters: [{ dataSize: 211 }],
      dataSlice: { offset: 0, length: 0 },
    });
    console.log(`${name} gPA(AgentProfile 211B): ${res.length} 个`);
  } catch (e) {
    console.log(`${name} gPA 失败: ${String(e.message ?? e).slice(0, 100)}`);
  }
}

// 4) 关键问题：谁能看到 hand #3 的 act 交易？
//    取一边的最近签名，看另一边的交集
const [hSigs, erSigs, mbSigs] = await Promise.all([
  helius.getSignaturesForAddress(game, { limit: 40 }).catch((e) => ({ err: String(e).slice(0, 80) })),
  er.getSignaturesForAddress(game, { limit: 40 }).catch((e) => ({ err: String(e).slice(0, 80) })),
  mb.getSignaturesForAddress(game, { limit: 40 }).catch((e) => ({ err: String(e).slice(0, 80) })),
]);
const setOf = (x) => (Array.isArray(x) ? new Set(x.map((s) => s.signature)) : new Set());
const h = setOf(hSigs), e = setOf(erSigs), m = setOf(mbSigs);
console.log(`签名数: helius=${h.size} er=${e.size} magicblock=${m.size}`);
console.log(`helius ∩ er = ${[...h].filter((s) => e.has(s)).length}`);
console.log(`magicblock ∩ er = ${[...m].filter((s) => e.has(s)).length}`);
const onlyEr = [...e].filter((s) => !h.has(s));
console.log(`只在 ER 上（helius 看不到）的签名数: ${onlyEr.length}`);
if (onlyEr.length > 0) {
  const tx = await er.getTransaction(onlyEr[0], { maxSupportedTransactionVersion: 0 }).catch(() => null);
  const logs = tx?.meta?.logMessages ?? [];
  const hasEvent = logs.some((l) => l.includes("Program data: "));
  console.log(`样本交易 ${onlyEr[0].slice(0, 16)}… 日志 ${logs.length} 行，含 Program data: ${hasEvent}`);
}
