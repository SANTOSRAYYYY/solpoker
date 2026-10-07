// 牌桌大厅：扫描链上 Table 账户，列出可加入的桌。
// Table 账户 145B 布局（programs/solpoker/src/state.rs）：
// disc(8) table_id(4)@8 admin(32)@12 kind(1)@44 max_seats(1)@45 status(1)@46
// mint(32)@47 sb(8)@79 bb(8)@87 ante(8)@95 …

import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, TABLE_IDS_FILTER, TUSDC_MINT } from "./config";
import { fmtUsdc } from "./game-state";

export interface TableInfo {
  id: number;
  pubkey: PublicKey;
  kind: number;
  maxSeats: number;
  status: number; // 0=Active
  sb: bigint;
  bb: bigint;
  ante: bigint;
  blindsText: string;
}

const u32le = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

const SCAN_MAX_TABLE_ID = 64;

export async function scanTables(conn: Connection): Promise<TableInfo[]> {
  const addrs = Array.from(
    { length: SCAN_MAX_TABLE_ID + 1 },
    (_, id) => PublicKey.findProgramAddressSync([u8s("table"), u32le(id)], PROGRAM_ID)[0]
  );
  const infos = await conn.getMultipleAccountsInfo(addrs);
  const out: TableInfo[] = [];
  for (let id = 0; id < addrs.length; id++) {
    const acc = infos[id];
    if (!acc || acc.data.length < 145 || !acc.owner.equals(PROGRAM_ID)) continue;
    // 大厅白名单：设置了 NEXT_PUBLIC_TABLE_IDS 就只显示列表内的桌。
    if (TABLE_IDS_FILTER.length > 0 && !TABLE_IDS_FILTER.includes(id)) continue;
    const d = acc.data;
    const u64 = (o: number) => {
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
      return v;
    };
    const mint = new PublicKey(d.slice(47, 79));
    if (!mint.equals(TUSDC_MINT)) continue;
    const sb = u64(79);
    const bb = u64(87);
    const ante = u64(95);
    out.push({
      id,
      pubkey: addrs[id],
      kind: d[44],
      maxSeats: d[45],
      status: d[46],
      sb,
      bb,
      ante,
      blindsText: `${fmtUsdc(sb)} / ${fmtUsdc(bb)}${ante > 0n ? ` (ante ${fmtUsdc(ante)})` : ""}`,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

function u8s(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
