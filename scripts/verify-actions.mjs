// 行动流验证的端到端测试（Node）：
//   1) 读 #14 的 HandReplay（ER）→ 找一手 v2（有 street_end）
//   2) 读该桌的 HandProof（ER/L1）+ HandSecrets（ER）→ 取 delta/rake/盐/VRF
//   3) 从 ER 交易日志抓该手的规范行动事件（act-log.mjs）
//   4) verifyActionStream：逐街对到 street_end，最后对到 transcript_final
//
// 用法: L1_URL=https://devnet-tee.magicblock.app node scripts/verify-actions.mjs <tableId> [handId]
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { nodeCrypto } from "../web/lib/deal-verify-node.mjs";
import { verifyActionStream, unhex, hex } from "../web/lib/deal-verify.mjs";
import { fetchHandEvents } from "../web/lib/act-log.mjs";

const ER_URL = process.env.L1_URL ?? "https://devnet-tee.magicblock.app";
const L1_URL = "https://rpc.magicblock.app/devnet";
const TABLE_ID = Number(process.argv[2] ?? 14);
const WANT_HAND = process.argv[3] ? BigInt(process.argv[3]) : null;

const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const table = pda([Buffer.from("table"), u32le(TABLE_ID)]);
const replayPda = pda([Buffer.from("replay"), table.toBuffer()]);
const proofPda = pda([Buffer.from("proof"), table.toBuffer()]);
const secretsPda = pda([Buffer.from("secrets"), table.toBuffer()]);

const er = new Connection(ER_URL, "confirmed");
const l1 = new Connection(L1_URL, "confirmed");
const crypto = nodeCrypto;

const RING = 8, RE = 504, PE = 232, SE = 456;
const readU64 = (d, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]); return v; };
const readI64 = (d, o) => { const v = readU64(d, o); return v & (1n << 63n) ? v - (1n << 64n) : v; };

const rAcc = await er.getAccountInfo(replayPda);
if (!rAcc) { console.log("HandReplay 不存在"); process.exit(1); }

// 找目标手（默认：最新一条 v2 条目）
let slot = -1, handId = 0n;
for (let i = 0; i < RING; i++) {
  const b = 8 + i * RE;
  const hid = readU64(rAcc.data, b);
  if (hid === 0n && rAcc.data[b + 494] === 0 && rAcc.data[b + 493] === 0) continue;
  if (rAcc.data[b + 495] !== 2) continue; // 只要 v2
  if (WANT_HAND !== null && hid !== WANT_HAND) continue;
  slot = i; handId = hid;
}
if (slot < 0) { console.log("没有 v2 条目（先让 v2 程序打完一手）"); process.exit(1); }
const b = 8 + slot * RE;
const streetEnd = Array.from({ length: 4 }, (_, k) => hex(rAcc.data.subarray(b + 8 + k * 32, b + 8 + k * 32 + 32)));
const streetsEnded = rAcc.data[b + 136];
const saltDigest = hex(rAcc.data.subarray(b + 296, b + 328));
const drawDigest = Array.from({ length: 5 }, (_, k) => hex(rAcc.data.subarray(b + 328 + k * 32, b + 328 + k * 32 + 32)));
const attempts = Array.from(rAcc.data.subarray(b + 488, b + 493));
console.log(`手 #${handId}（槽 ${slot}）streets_ended=0b${streetsEnded.toString(2).padStart(4, "0")}`);

// proof（ER 优先）+ secrets（ER 优先）
const pSrc = (await er.getAccountInfo(proofPda)) ?? (await l1.getAccountInfo(proofPda));
const sSrc = (await er.getAccountInfo(secretsPda)) ?? (await l1.getAccountInfo(secretsPda));
if (!pSrc || !sSrc) { console.log("缺 proof/secrets"); process.exit(1); }
let pb = -1;
for (let i = 0; i < 16; i++) { const o = 8 + i * PE; if (readU64(pSrc.data, o) === handId) pb = o; }
if (pb < 0) { console.log("proof 里没有这一手（环外？）"); process.exit(1); }
const handMask = pSrc.data[pb + 218] | (pSrc.data[pb + 219] << 8);
const button = pSrc.data[pb + 226];
const deltas = Array.from({ length: 9 }, (_, k) => readI64(pSrc.data, pb + 96 + k * 8).toString());
const rake = readU64(pSrc.data, pb + 8).toString();
const transcriptFinal = hex(pSrc.data.subarray(pb + 168, pb + 200));
const sSlot = (pb - 8) / PE;
const salts = Array.from({ length: 9 }, (_, k) => hex(sSrc.data.subarray(8 + sSlot * SE + k * 32, 8 + sSlot * SE + k * 32 + 32)));
const vrfOut = Array.from({ length: 5 }, (_, k) => hex(sSrc.data.subarray(8 + sSlot * SE + 288 + k * 32, 8 + sSlot * SE + 288 + k * 32 + 32)));

// 行动事件流（ER 交易日志）
const gamePda = pda([Buffer.from("game"), table.toBuffer()]);
const { events, scanned } = await fetchHandEvents(crypto, er, gamePda, handId, { limit: 500 });
console.log(`扫了 ${scanned} 笔交易，解出 ${events.length} 条规范事件`);

const res = await verifyActionStream(crypto, {
  table: hex(table.toBytes()),
  handId: handId.toString(),
  handMask,
  button,
  saltDigest,
  drawDigest,
  streetEnd,
  streetsUsed: rAcc.data[b + 494],
  vrfOut,
  vrfAttemptUsed: attempts,
  events,
  deltas,
  rake,
  transcriptFinal,
});
console.log(JSON.stringify(res.perStreet));
if (res.ok) console.log("ACTION_STREAM_OK（逐街锚点 + transcript_final 全部匹配）");
else { console.log("ACTION_STREAM_FAILED"); for (const d of res.diffs) console.log("  " + d); process.exit(1); }
