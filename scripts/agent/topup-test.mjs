// top_up 全链路测试：给已入座的 agent 补码，验证 crank 的 apply_deposits
// 把 L1 入金计入 ER 筹码。用法: node scripts/agent/topup-test.mjs <name> <table> <usdc>
import fs from "node:fs";
import { l1Connection, erConnection, programFor, sendAndConfirm, loadAgent,
  tablePda, gamePda, seatPda, decodeGame, ixTopUp, getAssociatedTokenAddressSync, TUSDC_MINT, sleep } from "./client.mjs";

const NAME = process.argv[2] ?? "bob";
const TABLE = Number(process.argv[3] ?? 11);
const USDC = Number(process.argv[4] ?? 4);
const agent = loadAgent(NAME);
const table = tablePda(TABLE);

// 找座位
const l1 = l1Connection();
let seat = -1;
for (let i = 0; i < 9; i++) {
  const acc = await l1.getAccountInfo(seatPda(table, i));
  if (acc && !acc.data.subarray(41, 73).every((b) => b === 0)) {
    const occ = acc.data.subarray(41, 73);
    // 只用 occupant 前缀粗匹配不合适——直接比对完整 base58
    const { PublicKey } = await import("@solana/web3.js");
    if (new PublicKey(occ).toBase58() === agent.keypair.publicKey.toBase58()) { seat = i; break; }
  }
}
if (seat < 0) { console.error(`${NAME} 未在桌 #${TABLE} 入座`); process.exit(1); }
console.log(`${NAME} 在座 ${seat}`);

// 记录补码前 ER 筹码
const er = await erConnection(agent);
const before = decodeGame((await er.getAccountInfo(gamePda(table))).data).seats[seat].stack;
const ata = getAssociatedTokenAddressSync(TUSDC_MINT, agent.keypair.publicKey);
const bal = await l1.getTokenAccountBalance(ata);
console.log(`补码前 ER 筹码=${Number(before) / 1e6}，ATA 余额=${bal.value.uiAmount}`);
if (Number(bal.value.uiAmount) < USDC) { console.error("ATA 余额不足"); process.exit(1); }

const program = programFor(l1, agent.keypair);
const sig = await sendAndConfirm(l1, [await ixTopUp(program, { table, seat, amountMicro: Math.round(USDC * 1e6) })], [agent.keypair], "top_up");
console.log("top_up L1 已确认:", sig);

// 等 crank apply_deposits → ER 筹码 +USDC
const t0 = Date.now();
for (;;) {
  const s = decodeGame((await er.getAccountInfo(gamePda(table))).data).seats[seat].stack;
  if (Number(s) / 1e6 === Number(before) / 1e6 + USDC) {
    console.log(`✔ ER 筹码 ${Number(before) / 1e6} → ${Number(s) / 1e6}（apply_deposits 生效，${Date.now() - t0}ms）`);
    break;
  }
  if (Date.now() - t0 > 90000) { console.error(`超时：ER 筹码仍为 ${Number(s) / 1e6}`); process.exit(1); }
  await sleep(1500);
}
console.log("TOPUP_TEST_OK");
