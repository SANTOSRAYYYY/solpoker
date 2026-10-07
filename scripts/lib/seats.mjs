// 全桌各座位账本账户映射（Stage 8 sit_down 新增 other0..7 参数）。
// 供各脚本共用：others = 除 idx 外的 8 个座位账本，升序。
import { PublicKey } from "@solana/web3.js";

export function seatPdaFor(programId, table, i) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("seat"), table.toBuffer(), Buffer.from([i])],
    programId
  )[0];
}

export function othersFor(programId, table, idx) {
  const out = {};
  let n = 0;
  for (let i = 0; i < 9; i++) {
    if (i === idx) continue;
    out[`other${n}`] = seatPdaFor(programId, table, i);
    n++;
  }
  return out;
}
