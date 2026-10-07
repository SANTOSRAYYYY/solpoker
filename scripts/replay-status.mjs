// replay-status — 读 HandReplay 账户（§8.7 整手复算输入）+ 统计「僵尸座位」
// （已离座但账本里还有钱：座位被占着不能用，钱也没回到主人手里）。
//
// 用法: node scripts/replay-status.mjs 13          # 只看某桌
//       node scripts/replay-status.mjs 5,9,11,13   # 多桌
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";

const L1_URL = process.env.L1_URL ?? "https://rpc.magicblock.app/devnet";
const ids = (process.argv[2] ?? "13").split(",").map((s) => Number(s.trim())).filter(Number.isInteger);

const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];

const conn = new Connection(L1_URL, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(20000) }) });
const hex = (b) => Buffer.from(b).toString("hex");

const RING = 8;
const ENTRY = 504;
const short = (h, n = 6) => h.slice(0, n) + "…" + h.slice(-4);

for (const id of ids) {
  const table = pda([Buffer.from("table"), u32le(id)]);
  const replayPda = pda([Buffer.from("replay"), table.toBuffer()]);
  console.log(`\n=== 桌 #${id} ===`);

  // --- HandReplay ---
  const acc = await conn.getAccountInfo(replayPda);
  if (!acc) {
    console.log("  HandReplay: 不存在（未 init_replay）");
  } else {
    const d = acc.data;
    const head = d[8 + RING * ENTRY];
    console.log(`  HandReplay: ${d.length}B  head=${head}`);
    for (let i = 0; i < RING; i++) {
      const b = 8 + i * ENTRY;
      const handId = d.readBigUInt64LE(b);
      if (handId === 0n && d[b + 494] === 0 && d[b + 493] === 0) continue; // 空槽 = hand_id/streets/status 全零（hand_id 0 是合法的一手）
      const occupants = [];
      for (let s = 0; s < 9; s++) {
        const o = d.slice(b + 8 + s * 32, b + 8 + s * 32 + 32);
        if (o.some((x) => x !== 0)) occupants.push(new PublicKey(o).toBase58().slice(0, 8) + "…");
      }
      const saltDigest = hex(d.slice(b + 296, b + 328));
      const digests = Array.from({ length: 5 }, (_, k) => hex(d.slice(b + 328 + k * 32, b + 328 + k * 32 + 32)));
      const attempts = Array.from(d.slice(b + 488, b + 493));
      const status = d[b + 493];
      const streets = d[b + 494];
      const layoutVer = d[b + 495];
      const streetsEnded = layoutVer === 2 ? d[b + 136] : 0;
      const streetEnd = Array.from({ length: 4 }, (_, k) =>
        hex(d.slice(b + 8 + k * 32, b + 8 + k * 32 + 32))
      );
      console.log(
        `   槽${i} 手#${handId} status=${status} layout=v${layoutVer}` +
          ` streets=0b${streets.toString(2).padStart(4, "0")} ended=0b${streetsEnded.toString(2).padStart(4, "0")}` +
          ` attempts=[${attempts.join(",")}]`
      );
      console.log(
        `        draw_digest: ${digests.map((x, k) => `k${k}=${streets & (1 << k) ? short(x, 4) : "—"}`).join(" ")}`
      );
      if (layoutVer === 2) {
        console.log(
          `        street_end : ${streetEnd.map((x, k) => `k${k}=${streetsEnded & (1 << k) ? short(x, 4) : "—"}`).join(" ")}`
        );
        console.log(`        salt_digest=${short(saltDigest)}`);
      } else {
        console.log(`        salt_digest=${short(saltDigest)} occupants: ${occupants.join(" ") || "(无)"}`);
      }
    }
  }

  // --- 僵尸座位统计（Game 说 Left/Empty 但账本还有 occupant）---
  const game = await conn.getAccountInfo(pda([Buffer.from("game"), table.toBuffer()]));
  const seatAddrs = Array.from({ length: 9 }, (_, i) => pda([Buffer.from("seat"), table.toBuffer(), Buffer.from([i])]));
  const seats = await conn.getMultipleAccountsInfo(seatAddrs);
  let zombies = 0;
  for (let i = 0; i < 9; i++) {
    const sa = seats[i];
    if (!sa) continue;
    const occ = sa.data.slice(41, 73);
    const empty = occ.every((b) => b === 0);
    if (empty) continue;
    const status = game ? game.data[152 + i * 152 + 145] : -1;
    const payout = new PublicKey(sa.data.slice(154, 186)).toBase58();
    const deposited = sa.data.readBigUInt64LE(186);
    const paid = sa.data.readBigUInt64LE(194);
    if (status !== 1) {
      zombies++;
      console.log(
        `  ⚠ 僵尸座位 ${i}: status=${status} 锁定 ${Number(deposited - paid) / 1e6} tUSDC → payout ${payout.slice(0, 8)}…`
      );
    }
  }
  console.log(`  僵尸座位: ${zombies} 个（cash_out 无需许可即可清掉并退款给主人）`);
}
