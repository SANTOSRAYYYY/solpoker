// 读取某桌某座位的 SeatLedger 关键字段（验证 agent 身份写入）。
// 用法: node scripts/check-seat-ledger.mjs <tableId> <seatIdx>
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";

const TABLE_ID = Number(process.argv[2] ?? 11);
const SEAT = Number(process.argv[3] ?? 0);
const L1_URL = process.env.L1_URL ?? "http://127.0.0.1:8898/devnet";
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const pid = new PublicKey(idl.address);
const l1 = new Connection(L1_URL, "confirmed");
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32(TABLE_ID)], pid);
const [seat] = PublicKey.findProgramAddressSync([Buffer.from("seat"), table.toBuffer(), Buffer.from([SEAT])], pid);
const acc = await l1.getAccountInfo(seat);
if (!acc) { console.log("座位账本不存在"); process.exit(1); }
const d = acc.data;
// 布局：disc8 table32 idx1 occupant32(@41) occupancy_id8(@73) kind1(@81)
//       agent_owner32(@82) session_key32(@114) session_expires8(@146)
//       payout32(@154) deposited8(@186) paid8(@194) bump1(@202)
console.log(`table #${TABLE_ID} seat ${SEAT}:`);
console.log("  occupant   :", new PublicKey(d.subarray(41, 73)).toBase58());
console.log("  kind       :", d[81], "(0=Human 1=Agent)");
console.log("  agent_owner:", new PublicKey(d.subarray(82, 114)).toBase58());
console.log("  payout     :", new PublicKey(d.subarray(154, 186)).toBase58());
console.log("  deposited  :", Number(d.readBigUInt64LE(186)) / 1e6, "tUSDC");
