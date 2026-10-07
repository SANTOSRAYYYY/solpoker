// Stage 7 纯玩家模拟：两名玩家只做「玩家签名」的动作——sit_down、commit/
// reveal、act、stand_up、cash_out——其余一切（take_seat、advance、
// request_vrf、claim_timeout、commit_game）都等 crank 完成。这正是浏览器
// 前端与 crank 的职责划分，用脚本先把这条链路打穿，再让真人走 UI。
//
// 前置：crank 在跑（node scripts/crank.mjs 9）。
// 用法：node scripts/stage7-player-sim.mjs [tableId]
import fs from "node:fs";
import crypto from "node:crypto";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const L1_URL = process.env.L1_URL ?? "http://127.0.0.1:8898/devnet";
const ER_BASE = process.env.ER_BASE ?? "http://127.0.0.1:7799";
const ER_CU = 1_400_000;
const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const TABLE_ID = Number(process.argv[2] ?? 9);
const BUY_IN = 20_000_000;
const PHASES = ["Idle", "Commit", "AwaitSeed", "Preflop", "AwaitStreet", "Betting", "AwaitRunout", "Settle", "Void"];

const players = JSON.parse(fs.readFileSync("keys/test-players.json", "utf8")).map((s) =>
  Keypair.fromSecretKey(Uint8Array.from(s))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(TABLE_ID)], programId);
const [game] = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId);
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault_auth"), table.toBuffer()], programId);
const vault = getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuth, true);
const [commitPayer] = PublicKey.findProgramAddressSync([Buffer.from("commit_payer"), table.toBuffer()], programId);
const seat = (i) => PublicKey.findProgramAddressSync([Buffer.from("seat"), table.toBuffer(), Buffer.from([i])], programId)[0];
const hand = (i) => PublicKey.findProgramAddressSync([Buffer.from("hand"), table.toBuffer(), Buffer.from([0, 0]), Buffer.from([i])], programId)[0];
const perm = (acc) => PublicKey.findProgramAddressSync([Buffer.from("permission:"), acc.toBuffer()], PERMISSION_PROGRAM)[0];

const l1 = new Connection(L1_URL, "confirmed");
const tokenFor = async (kp) => {
  const { token } = await getAuthToken(ER_BASE, kp.publicKey, async (msg) => {
    const nacl = (await import("tweetnacl")).default;
    return nacl.sign.detached(msg, kp.secretKey);
  });
  return token;
};

async function sendAndConfirm(conn, ixs, signers, label, cu = null) {
  for (let attempt = 0; ; attempt++) {
    const tx = new Transaction();
    if (cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
    tx.add(...ixs);
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(...signers);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const t0 = Date.now();
    for (;;) {
      const st = await conn.getSignatureStatuses([sig]);
      const s = st.value[0];
      if (s?.err) {
        const errStr = JSON.stringify(s.err);
        if (errStr.includes("InvalidWritableAccount") && attempt < 4) {
          await new Promise((r) => setTimeout(r, 1200));
          break;
        }
        throw new Error(`${label} failed on-chain: ${errStr}`);
      }
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
        console.log(`  ✓ ${label} (${Date.now() - t0}ms)`);
        return sig;
      }
      if (Date.now() - t0 > 120000) throw new Error(`${label} confirmation timeout`);
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}

// 轮询 Game 原始字节直到谓词满足（crank 推进的阶段变化）。
async function waitGame(er, pred, label, timeoutMs = 240000) {
  const t0 = Date.now();
  for (;;) {
    const acc = await er.getAccountInfo(game);
    if (acc) {
      const g = acc.data;
      const view = {
        phase: g[1544],
        handId: g.readBigUInt64LE(72),
        toAct: g[1549],
        actionSeq: g.readUInt32LE(1520),
        pot: g.readBigUInt64LE(80),
        currentBet: g.readBigUInt64LE(88),
        lastFullRaise: g.readBigUInt64LE(96),
        boardLen: g[1548],
        handMask: g.readUInt16LE(1526),
        vrfState: g[144],
        seat: (i) => ({
          status: g[152 + i * 152 + 145],
          stack: g.readBigUInt64LE(152 + i * 152 + 104),
          streetBet: g.readBigUInt64LE(152 + i * 152 + 136),
          saltCommit: g.subarray(152 + i * 152 + 32, 152 + i * 152 + 64),
        }),
      };
      if (pred(view)) return view;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitGame timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 1200));
  }
}

const salts = [crypto.randomBytes(32), crypto.randomBytes(32)];
const playerConns = [];
console.log(`table_id=${TABLE_ID} — 纯玩家流程（crank 驱动阶段机）`);

// ---------- 0. 续跑清理：上次中断留下的 Left+占用 座位先 cash_out 释放 ----------
for (const [i, p] of players.entries()) {
  const conn = new Connection(`${ER_BASE}?token=${await tokenFor(p)}`, "confirmed");
  playerConns.push(conn);
  const ledger = await l1.getAccountInfo(seat(i));
  const occupied = ledger && !ledger.data.subarray(41, 73).every((b) => b === 0);
  const gAcc = await conn.getAccountInfo(game);
  const seatStatus = gAcc ? gAcc.data[152 + i * 152 + 145] : 0;
  if (occupied && seatStatus === 2) {
    // 快照已覆盖（crank 刚 commit 过）才能 cash_out；否则等 commit。
    const occ = ledger.data.readBigUInt64LE(73);
    const t0 = Date.now();
    for (;;) {
      const lg = await l1.getAccountInfo(game);
      if (
        lg && lg.data[152 + i * 152 + 145] === 2 &&
        lg.data.readBigUInt64LE(152 + i * 152 + 96) === occ
      ) break;
      if (Date.now() - t0 > 180000) throw new Error(`resume cash_out snapshot timeout player${i}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    const prog = new anchor.Program(idl, new anchor.AnchorProvider(l1, new anchor.Wallet(p), { commitment: "confirmed" }));
    const ata = getAssociatedTokenAddressSync(TUSDC_MINT, p.publicKey);
    const before = await l1.getTokenAccountBalance(ata);
    const ix = await prog.methods
      .cashOut(i)
      .accounts({ table, game, seat: seat(i), vaultAuth, vault, mint: TUSDC_MINT, payoutAta: ata, caller: p.publicKey })
      .instruction();
    await sendAndConfirm(l1, [ix], [p], `resume cash_out player${i}`);
    const after = await l1.getTokenAccountBalance(ata);
    console.log(`  ✓ resume cash_out player${i}: ${before.value.uiAmount} → ${after.value.uiAmount}`);
  }
}

// ---------- 1. sit_down（玩家签名；座位空才坐） ----------
for (const [i, p] of players.entries()) {
  const conn = new Connection(`${ER_BASE}?token=${await tokenFor(p)}`, "confirmed");
  playerConns.push(conn);
  const ledger = await l1.getAccountInfo(seat(i));
  const occupied = ledger && !ledger.data.subarray(41, 73).every((b) => b === 0);
  if (occupied) { console.log(`  … player${i} seated (L1 ledger)`); continue; }
  const prog = new anchor.Program(idl, new anchor.AnchorProvider(l1, new anchor.Wallet(p), { commitment: "confirmed" }));
  const ata = getAssociatedTokenAddressSync(TUSDC_MINT, p.publicKey);
  const ixs = [];
  if (!(await l1.getAccountInfo(ata))) {
    ixs.push(createAssociatedTokenAccountInstruction(p.publicKey, ata, p.publicKey, TUSDC_MINT));
  }
  ixs.push(
    await prog.methods
      .sitDown(i, new BN(BUY_IN), p.publicKey, new BN(Math.floor(Date.now() / 1000) + 7 * 24 * 3600))
      .accounts({
        table, seat: seat(i),
        ...Object.fromEntries(
          Array.from({ length: 9 }, (_, k) => k).filter((k) => k !== i).map((k, n) => [`other${n}`, seat(k)])
        ),
        agentProfile: null,
        vaultAuth, vault, mint: TUSDC_MINT, playerAta: ata, payer: p.publicKey,
      })
      .instruction()
  );
  await sendAndConfirm(l1, ixs, [p], `sit_down player${i}`);
}

// ---------- 2. 等 crank take_seat（两个座位都 Seated） ----------
console.log("等待 crank take_seat…");
await waitGame(playerConns[0], (g) => g.seat(0).status === 1 && g.seat(1).status === 1, "take_seat");
console.log("  ✓ 两个座位已 Seated（crank 也更新了 PER 成员）");

// ---------- 3. 等 crank 开手（phase Commit），提交盐 ----------
let gv = await waitGame(playerConns[0], (g) => g.phase >= 1, "hand start");
console.log(`  ✓ 手 #${gv.handId} 开始（phase=${PHASES[gv.phase]}）`);
if (gv.phase === 1) {
  for (const [i, p] of players.entries()) {
    const prog = new anchor.Program(idl, new anchor.AnchorProvider(playerConns[i], new anchor.Wallet(p), {}));
    const g0 = await waitGame(playerConns[i], () => true, "peek");
    if (!g0.seat(i).saltCommit.every((b) => b === 0)) continue;
    const handIdBe = Buffer.alloc(8);
    handIdBe.writeBigUInt64BE(g0.handId);
    const commitment = crypto.createHash("sha256")
      .update(Buffer.from("solpoker/salt/v1"))
      .update(table.toBuffer())
      .update(handIdBe)
      .update(p.publicKey.toBuffer())
      .update(salts[i])
      .digest();
    const ix = await prog.methods
      .commitSalt(i, new BN(g0.handId.toString()), Array.from(commitment))
      .accounts({ table, game, seatLedger: seat(i), signer: p.publicKey })
      .instruction();
    await sendAndConfirm(playerConns[i], [ix], [p], `commit_salt player${i}`, ER_CU);
  }
}

// ---------- 4. 等 crank 进入 AwaitSeed 且 VRF 履行，揭示（重跑时若已过此阶段则跳过） ----------
gv = await waitGame(playerConns[0], (g) => (g.phase === 2 && g.vrfState === 3) || g.phase >= 3, "VRF_0 fulfilled or dealt");
if (gv.phase === 2) {
  console.log("  ✓ AwaitSeed + VRF_0 fulfilled（crank 请求）");
  for (const [i, p] of players.entries()) {
    const prog = new anchor.Program(idl, new anchor.AnchorProvider(playerConns[i], new anchor.Wallet(p), {}));
    const handAcc = await playerConns[i].getAccountInfo(hand(i));
    const saltHandId = handAcc ? handAcc.data.readBigUInt64LE(50) : 0n;
    if (saltHandId === gv.handId) { console.log(`  … player${i} revealed`); continue; }
    const ix = await prog.methods
      .revealSalt(i, new BN(gv.handId.toString()), Array.from(salts[i]))
      .accounts({ table, seatLedger: seat(i), playerHand: hand(i), signer: p.publicKey })
      .instruction();
    await sendAndConfirm(playerConns[i], [ix], [p], `reveal_salt player${i}`, ER_CU);
  }
}

// ---------- 5. 等 crank 发牌，然后 HU check/call 到摊牌 ----------
gv = await waitGame(playerConns[0], (g) => g.phase === 3 || g.phase === 5, "deal");
console.log(`  ✓ 已发牌（pot=${Number(gv.pot) / 1e6}）`);
for (let step = 0; step < 40; step++) {
  gv = await waitGame(playerConns[0], () => true, "peek");
  if (gv.phase === 0 || gv.phase === 7) break;
  if (gv.phase === 3 || gv.phase === 5) {
    const actor = gv.toAct;
    const me = players[actor];
    const prog = new anchor.Program(idl, new anchor.AnchorProvider(playerConns[actor], new anchor.Wallet(me), {}));
    const toCall = gv.currentBet - gv.seat(actor).streetBet;
    const ix = await prog.methods
      .act(actor, new BN(gv.handId.toString()), gv.actionSeq, toCall > 0n ? { call: {} } : { check: {} })
      .accounts({ table, game, seatLedger: seat(actor), signer: me.publicKey })
      .instruction();
    await sendAndConfirm(playerConns[actor], [ix], [me], `act seat${actor} ${toCall > 0n ? "call" : "check"}`, ER_CU);
    continue;
  }
  // AwaitStreet/AwaitRunout/Settle：等 crank
  await waitGame(
    playerConns[0],
    (g) => g.phase !== gv.phase || g.phase === 0,
    `crank drives phase ${PHASES[gv.phase]}`
  );
}

// ---------- 6. 结算后站起（玩家签名） ----------
gv = await waitGame(playerConns[0], (g) => g.phase === 0, "settle→Idle", 300000);
console.log(`  ✓ 结算完成：p0=${Number(gv.seat(0).stack) / 1e6} p1=${Number(gv.seat(1).stack) / 1e6}`);
for (const [i, p] of players.entries()) {
  const prog = new anchor.Program(idl, new anchor.AnchorProvider(playerConns[i], new anchor.Wallet(p), {}));
  const g0 = await waitGame(playerConns[i], () => true, "peek");
  if (g0.seat(i).status !== 1) { console.log(`  … player${i} already left`); continue; }
  const ix = await prog.methods
    .standUp(i)
    .accounts({
      table, game, seatLedger: seat(i), playerHand: hand(i),
      permission: perm(hand(i)), commitPayer, vault: EPHEMERAL_VAULT,
      signer: p.publicKey,
    })
    .instruction();
  await sendAndConfirm(playerConns[i], [ix], [p], `stand_up player${i}`, ER_CU);
}

// ---------- 7. 等 crank commit_game，然后 cash_out ----------
console.log("等待 crank commit_game + L1 快照…");
{
  // 快照时效按 occupancy_id 判定（2026-10-07：上一手的快照同样是 Left，
  // 单看 status 会误判）。seat ledger 的 occupancy_id @73（L1）。
  const occ = [];
  for (const [i] of players.entries()) {
    const ledger = await l1.getAccountInfo(seat(i));
    occ.push(ledger ? ledger.data.readBigUInt64LE(73) : -1n);
  }
  const t0 = Date.now();
  for (;;) {
    const lg = await l1.getAccountInfo(game);
    const match = (i) =>
      lg && lg.data[152 + i * 152 + 145] === 2 &&
      lg.data.readBigUInt64LE(152 + i * 152 + 96) === occ[i];
    if (match(0) && match(1)) { console.log(`  ✓ L1 快照已更新（${Date.now() - t0}ms）`); break; }
    if (Date.now() - t0 > 180000) throw new Error("commit_game snapshot timeout");
    await new Promise((r) => setTimeout(r, 1500));
  }
}
for (const [i, p] of players.entries()) {
  const prog = new anchor.Program(idl, new anchor.AnchorProvider(l1, new anchor.Wallet(p), { commitment: "confirmed" }));
  const ata = getAssociatedTokenAddressSync(TUSDC_MINT, p.publicKey);
  const before = await l1.getTokenAccountBalance(ata);
  const ix = await prog.methods
    .cashOut(i)
    .accounts({ table, game, seat: seat(i), vaultAuth, vault, mint: TUSDC_MINT, payoutAta: ata, caller: p.publicKey })
    .instruction();
  await sendAndConfirm(l1, [ix], [p], `cash_out player${i}`);
  const after = await l1.getTokenAccountBalance(ata);
  console.log(`  ✓ player${i}: ${before.value.uiAmount} → ${after.value.uiAmount} tUSDC`);
}
console.log("STAGE7_PLAYER_SIM_OK");
