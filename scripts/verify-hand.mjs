// verify-hand — 命令行版「整手复算」（与 /history 页「整手复算（52 张逐张比对）」同一套引擎）。
//
// 数据来源：HandProof（账本条目：hole/board/deltas/transcript_final）+ HandSecrets
// （salts + VRF 输出）+ HandReplay（salt_digest + 每条街首张牌前的 transcript 摘要）。
// 三者都在 L1，但 HandProof/HandSecrets/HandReplay 是**委托账户**，数据写在 ER 上，
// 所以优先读 ER、回落 L1（与页面一致）。
//
// 判据：① occupants + salts 复算的 salt_digest 命中链上；② 从 VRF 与逐街摘要出发
// 重新推导每一张牌（含拒绝采样重抽），与链上 proof 的 hole/board **逐张相等**。
//
// 用法: node scripts/verify-hand.mjs <tableId> [handId]     # handId 省略 = 最新的手
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { L1_RPC, ER_BASE_URL } from "./env.mjs";
import { tablePdas } from "./lib/deploy-table.mjs";
import { dealFromReplay, saltDigest, hex } from "../web/lib/deal-verify.mjs";
import { nodeCrypto } from "../web/lib/deal-verify-node.mjs";

const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const tableId = Number(process.argv[2] ?? 20);
const wantHand = process.argv[3] ? BigInt(process.argv[3]) : null;

const l1 = new Connection(L1_RPC, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(25000) }) });
const er = new Connection(ER_BASE_URL, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(25000) }) });

const p = tablePdas(programId, tableId);
const readLive = async (addr) => (await er.getAccountInfo(addr).catch(() => null)) ?? (await l1.getAccountInfo(addr));

// ---------- 解码（偏移与 web/lib/chain-read.ts 一致） ----------
const readU64 = (d, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]); return v; };
const PROOF_ENTRY = 232;
const SECRETS_ENTRY = 456;
const REPLAY_ENTRY = 504;

function decodeProof(d) {
  const out = [];
  for (let i = 0; i < 16; i++) {
    const b = 8 + i * PROOF_ENTRY;
    if (b + PROOF_ENTRY > d.length) { out.push(null); continue; }
    const handId = readU64(d, b);
    if (handId === 0n && d[b + 225] === 0) { out.push(null); continue; }
    out.push({
      slot: i,
      handId,
      occupancyIds: Array.from({ length: 9 }, (_, k) => readU64(d, b + 24 + k * 8)),
      deltas: Array.from({ length: 9 }, (_, k) => {
        const v = readU64(d, b + 96 + k * 8);
        return v >= 1n << 63n ? v - (1n << 64n) : v;
      }),
      transcriptFinal: d.slice(b + 168, b + 200),
      hole: Array.from({ length: 9 }, (_, k) => [d[b + 200 + k * 2], d[b + 200 + k * 2 + 1]]),
      handMask: d[b + 218] | (d[b + 219] << 8),
      board: [d[b + 220], d[b + 221], d[b + 222], d[b + 223], d[b + 224]],
      status: d[b + 225],
      button: d[b + 226],
    });
  }
  return out;
}
function decodeSecrets(d) {
  return Array.from({ length: 16 }, (_, i) => {
    const b = 8 + i * SECRETS_ENTRY;
    if (b + SECRETS_ENTRY > d.length) return null;
    return {
      salts: Array.from({ length: 9 }, (_, k) => d.slice(b + k * 32, b + k * 32 + 32)),
      vrfOut: Array.from({ length: 5 }, (_, k) => d.slice(b + 288 + k * 32, b + 288 + k * 32 + 32)),
    };
  });
}
function decodeReplay(d) {
  return Array.from({ length: 8 }, (_, i) => {
    const b = 8 + i * REPLAY_ENTRY;
    if (b + REPLAY_ENTRY > d.length) return null;
    const handId = readU64(d, b);
    const status = d[b + 493];
    const streetsUsed = d[b + 494];
    if (handId === 0n && status === 0 && streetsUsed === 0) return null;
    const v2 = d[b + 495] === 2;
    return {
      handId,
      layoutVer: d[b + 495],
      // v2 条目这一段存的是 street_end[4]，不再存 occupants
      // （与 web/lib/chain-read.ts 一致：v2 给空数组，v1 给 9 个 occupant）
      occupants: v2
        ? []
        : Array.from({ length: 9 }, (_, s) => {
            const o = d.slice(b + 8 + s * 32, b + 8 + s * 32 + 32);
            return o.every((x) => x === 0) ? null : new PublicKey(o);
          }),
      saltDigest: d.slice(b + 296, b + 328),
      drawDigest: Array.from({ length: 5 }, (_, k) => d.slice(b + 328 + k * 32, b + 328 + k * 32 + 32)),
      streetsUsed,
    };
  });
}

// ---------- 读取 ----------
const [proofAcc, secretsAcc, replayAcc] = await Promise.all([
  readLive(p.handProof),
  readLive(p.handSecrets),
  readLive(p.replay),
]);
if (!proofAcc || !secretsAcc || !replayAcc) {
  console.error("账户缺失：proof/secrets/replay（先确认已 init_replay 且桌存在）");
  process.exitCode = 1;
}
const proofs = decodeProof(proofAcc.data);
const secrets = decodeSecrets(secretsAcc.data);
const replays = decodeReplay(replayAcc.data);

const live = proofs.filter((x) => x);
const entry = wantHand !== null ? live.find((x) => x.handId === wantHand) : live.sort((a, b) => Number(b.handId - a.handId))[0];
if (!entry) {
  console.error(`没有找到手牌 ${wantHand ?? "(最新)"} 的 HandProof 条目`);
  process.exitCode = 1;
}
const secret = secrets[entry.slot];
const replayEntry = replays.find((r) => r && r.handId === entry.handId);
console.log(`桌 #${tableId} 手 #${entry.handId}（proof 槽 ${entry.slot}）status=${entry.status === 0 ? "已结算" : "作废"} button=${entry.button} handMask=0b${entry.handMask.toString(2).padStart(9, "0")}`);
console.log(`  replay 条目: ${replayEntry ? `有（layout v${replayEntry.layoutVer}，streets=0b${replayEntry.streetsUsed.toString(2).padStart(4, "0")}）` : "无（该手在 replay 环之外）"}`);
if (!secret || !replayEntry) {
  console.error("缺少 HandSecrets 或 HandReplay 条目 —— 无法整手复算");
  process.exitCode = 1;
}

// ---------- ① salt_digest 复算 ----------
if (replayEntry.occupants && replayEntry.layoutVer !== 2) {
  // v1 条目自带 occupants：可独立复算
  const recomputed = await saltDigest(
    nodeCrypto,
    [...p.table.toBytes()].map((b) => b.toString(16).padStart(2, "0")).join(""),
    entry.handId.toString(),
    entry.handMask,
    replayEntry.occupants.map((o) => (o ? hex(o.toBytes()) : null)),
    entry.occupancyIds.map((x) => x.toString()),
    secret.salts.map((s) => hex(s))
  );
  console.log(`  salt_digest 复算: ${hex(new Uint8Array(recomputed)) === hex(replayEntry.saltDigest) ? "命中 ✓" : "不一致 ✗"}`);
} else {
  console.log(`  salt_digest: v2 条目不含 occupants（用链上值参与复算）`);
}

// ---------- ② 逐张牌复算 ----------
const r = await dealFromReplay(nodeCrypto, {
  table: hex(p.table.toBytes()),
  handId: entry.handId.toString(),
  handMask: entry.handMask,
  button: entry.button,
  occupancyIds: entry.occupancyIds.map((x) => x.toString()),
  occupants: (replayEntry.occupants ?? []).map((o) => (o ? hex(o.toBytes()) : null)),
  saltDigest: hex(replayEntry.saltDigest),
  drawDigest: replayEntry.drawDigest.map((d) => hex(d)),
  streetsUsed: replayEntry.streetsUsed,
  vrfOut: secret.vrfOut.map((d) => hex(d)),
  salts: secret.salts.map((s) => hex(s)),
  board: entry.board,
  hole: entry.hole,
  // v2 条目不含 occupants → salt_digest 无法独立复算（如实标注，不误报失败）
  skipSaltDigestCheck: !(replayEntry.occupants ?? []).some(Boolean),
});
const matched = r.draws.filter((d) => d.expected === undefined || d.expected === d.card).length;
for (const n of r.notes ?? []) console.log("  注:", n);
console.log(`  逐张复算: ${matched}/${r.draws.length} 张与链上一致`);
if (!r.ok) {
  console.log("  差异（前 5 条）:");
  for (const d of r.diffs.slice(0, 5)) console.log("   ", String(d).slice(0, 160));
}
console.log(r.ok && matched === r.draws.length ? "HAND_RECOMPUTE_OK" : "HAND_RECOMPUTE_FAIL");
process.exitCode = r.ok && matched === r.draws.length ? 0 : 1;
