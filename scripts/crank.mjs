// SolPoker crank service (Stage 7): drives the deterministic phase machine on
// devnet-tee so browser players only ever sign their own actions.
//
// Loop per table (default: NEXT_PUBLIC-style env TABLE_IDS or argv):
//   1. take_seat for any SeatLedger whose occupancy_id moved past the game seat
//   2. advance whenever the phase machine can move (Idle/Commit/AwaitSeed/
//      AwaitStreet/AwaitRunout/Settle; 下注街 3/5 仅在「pending==0 的死状态」
//      时推进做自愈)
//   3. request_vrf / retry_vrf when the slot is armed or timed out
//   4. claim_timeout when action_deadline passed
//   5. commit_game when hands_since_commit >= commit_every_n_hands
//
// Also: `node scripts/crank.mjs fund <wallet> [sol] [tusdc]` tops up a wallet
// from the deployer (devnet demo onboarding).
//
// All ER sends carry the 1.4M compute budget and skipPreflight (Stage 6
// lessons; see CHANGELOG).
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createMintToInstruction, createTransferInstruction,
} from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

// L1 走 env.mjs：L1_URL > web/.env.local 的 NEXT_PUBLIC_L1_RPC（Helius）> MagicBlock 路由。
// 本地栈请显式 set L1_URL/ER_BASE。
import { L1_RPC as L1_URL, ER_BASE_URL as ER_BASE } from "./env.mjs";
const ER_CU = 1_400_000;
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const ER_VRF_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);

const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

// RPC 请求超时保护（2026-10-07 实测：本地中继的 keep-alive 连接会假死，
// 无超时的 fetch 会让整个 crank 循环永久挂起）。20 秒即抛，下一轮用新连接重试。
const fetchWithTimeout = (input, init = {}) =>
  fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(20000) });
const tablePda = (id) => PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(id)], programId)[0];
const gamePda = (table) => PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId)[0];
const seatPda = (table, i) => PublicKey.findProgramAddressSync([Buffer.from("seat"), table.toBuffer(), Buffer.from([i])], programId)[0];
const handPda = (table, i) => PublicKey.findProgramAddressSync([Buffer.from("hand"), table.toBuffer(), Buffer.from([0, 0]), Buffer.from([i])], programId)[0];
const permPda = (acc) => PublicKey.findProgramAddressSync([Buffer.from("permission:"), acc.toBuffer()], PERMISSION_PROGRAM)[0];
const commitPayerPda = (table) => PublicKey.findProgramAddressSync([Buffer.from("commit_payer"), table.toBuffer()], programId)[0];
const proofPda = (table) => PublicKey.findProgramAddressSync([Buffer.from("proof"), table.toBuffer()], programId)[0];
const secretsPda = (table) => PublicKey.findProgramAddressSync([Buffer.from("secrets"), table.toBuffer()], programId)[0];
// HandReplay（§8.7 整手复算输入，2026-10-08）：advance 的必填账户；
// 老桌需先跑 scripts/init-replay.mjs <tableId> 创建 + 委托。
const replayPda = (table) => PublicKey.findProgramAddressSync([Buffer.from("replay"), table.toBuffer()], programId)[0];
const sweepTried = new Set(); // sweep: remember failed attempts keyed by (table, seat, deposited, paid)
const sweepWaitLog = new Set(); // sweep: dedupe "等快照" 日志（key 含快照值，刷新后会重新评估）
const commitFailUntil = new Map(); // table -> ts：commit_game 失败后的冷却（避免刷屏，且不阻塞阶段机）
const zombieTables = new Set(); // tables whose sweep hit a stuck seat -> force a commit_game to refresh the L1 snapshot
const vaultAuthPda = (table) => PublicKey.findProgramAddressSync([Buffer.from("vault_auth"), table.toBuffer()], programId)[0];
const deckPda = (table) => PublicKey.findProgramAddressSync([Buffer.from("deck"), table.toBuffer(), Buffer.from([0, 0])], programId)[0];

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
        throw new Error(`${label}: ${errStr}`);
      }
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return sig;
      if (Date.now() - t0 > 90000) throw new Error(`${label}: confirmation timeout`);
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}

// ---------------------------------------------------------------------------
// fund 子命令：给新钱包发 SOL + tUSDC（devnet 演示 onboarding）
// ---------------------------------------------------------------------------
async function fund(walletStr, sol = 0.05, tusdc = 25) {
  const wallet = new PublicKey(walletStr);
  const l1 = new Connection(L1_URL, { commitment: "confirmed", fetch: fetchWithTimeout });
  const ixs = [
    SystemProgram.transfer({
      fromPubkey: deployer.publicKey,
      toPubkey: wallet,
      lamports: Math.round(sol * 1e9),
    }),
  ];
  const ata = getAssociatedTokenAddressSync(TUSDC_MINT, wallet);
  if (!(await l1.getAccountInfo(ata))) {
    ixs.push(createAssociatedTokenAccountInstruction(deployer.publicKey, ata, wallet, TUSDC_MINT));
  }
  ixs.push(createMintToInstruction(TUSDC_MINT, ata, deployer.publicKey, BigInt(Math.round(tusdc * 1e6))));
  const sig = await sendAndConfirm(l1, ixs, [deployer], `fund ${walletStr.slice(0, 8)}`);
  console.log(`funded ${walletStr}: ${sol} SOL + ${tusdc} tUSDC (${sig})`);
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
async function main() {
  if (process.argv[2] === "fund") {
    await fund(process.argv[3], Number(process.argv[4] ?? 0.05), Number(process.argv[5] ?? 25));
    return;
  }

  const tableIds = (process.env.TABLE_IDS ?? process.argv[2] ?? "9")
    .split(",")
    .map((s) => Number(s.trim()));
  const l1 = new Connection(L1_URL, { commitment: "confirmed", fetch: fetchWithTimeout });
  const { token } = await getAuthToken(ER_BASE, deployer.publicKey, async (msg) => {
    const nacl = (await import("tweetnacl")).default;
    return nacl.sign.detached(msg, deployer.secretKey);
  });
  const er = new Connection(`${ER_BASE}?token=${token}`, { commitment: "confirmed", fetch: fetchWithTimeout });
  const program = new anchor.Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(deployer), { commitment: "confirmed" }));
  const l1Program = new anchor.Program(idl, new anchor.AnchorProvider(l1, new anchor.Wallet(deployer), { commitment: "confirmed" }));
  console.log(`crank online — tables ${tableIds.join(",")}, deployer ${deployer.publicKey.toBase58().slice(0, 8)}`);

  const vrfWaitUntil = new Map(); // table -> ts，等待 VRF 履行期间不重复 request
  const vrfRetryUntil = new Map(); // table -> ts，Pending 超时后 retry 的冷却

  // 桌与桌彼此独立：串行跑 24 桌时，一轮里每桌要花 1 次 game 读 + 两批座位读
  // （每批 9 个并行 RPC），24 桌串起来就是 25-30 次 RTT —— 实测轮次延迟 ~17s，
  // 而这个延迟就是「每个阶段动作之间的等待」（VRF 本身履行只要 ~1s）。
  // 6 路并发（与 web 端 readTablesLive 同策略）把一轮压到 ~4s；同一桌内部仍串行
  // （advance/commit_game 的连锁语义不变）。
  const mapLimit = async (items, limit, fn) => {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]);
      }
    });
    await Promise.all(workers);
  };

  for (;;) {
    await mapLimit(tableIds, 6, async (tableId) => {
      const table = tablePda(tableId);
      const game = gamePda(table);
      try {
        // 阶段性动作（advance / commit_game）成功后立刻用新鲜状态再跑一轮：
        // 一手收尾往往是 close→commit_game→freeze→arm→request 这样一串，
        // 每步都等下一轮会把「下一手开始」白拖几十秒。其他动作
        // （sweep/入座/入账/超时）不连锁 —— 它们不会立刻解锁下一个阶段。
        for (let i = 0; i < 6; i++) {
          if (!(await crankTable(tableId, table, game))) break;
        }
      } catch (e) {
        console.log(`[t${tableId}] ${String(e.message ?? e).slice(0, 160)}`);
      }
    });
    await new Promise((r) => setTimeout(r, 1200));
  }

  async function crankTable(tableId, table, game) {
    const gAcc = await er.getAccountInfo(game);
    if (!gAcc) return;
    const g = gAcc.data;
    const phase = g[1544];
    const handId = g.readBigUInt64LE(72);
    const handMask = g.readUInt16LE(1526);
    const actionDeadline = g.readBigInt64LE(104);
    const vrfState = g[144];
    const handsSinceCommit = g[1550];
    const pendingToAct = g.readUInt16LE(1532); // 死状态检测（stand_up 折断脚本，2026-10-08）
    const now = Math.floor(Date.now() / 1000);
    // 本次 pass 内刚等到 VRF 履行（第 2 步原地等待）→ 允许第 5 步越过
    // 「Pending 不推进」的门槛，立刻发牌（2026-10-09 提速）。
    let vrfFulfilledNow = false;

    // 0) sweep: clear "left but not cashed out" zombie seats. cash_out is
    // permissionless (design X7) and the program pins the payout ATA recorded at
    // sit_down, so the crank can only ever send the money back to its owner.
    // This frees the seat for the next player instead of leaving it locked.
    //
    // 注意：cash_out 的"释放座位"分支依赖 **L1 快照**（snap_seat.status==Left 且
    // credited/owed 全部结清）。快照陈旧时座位会卡住（死态：账本还有 occupant，
    // sit_down 报 6008）。所以发现僵尸候选而快照又陈旧时，先催一次 commit_game
    // （就在手与手之间做，正好符合 §10 的时机要求），下一轮再清。
    // 座位账本一次并行读完（9 个串行 RPC 是每轮延迟的主要来源）
    const sweepAccs = await Promise.all(
      Array.from({ length: 9 }, (_, i) => l1.getAccountInfo(seatPda(table, i)))
    );
    for (let i = 0; i < 9; i++) {
      const ledAcc = sweepAccs[i];
      if (!ledAcc) continue;
      const occ = ledAcc.data.subarray(41, 73);
      if (occ.every((b) => b === 0)) continue; // empty seat
      const seatStatus = g[152 + i * 152 + 145];
      // ONLY the Left(2) state is sweepable: a fresh sit_down still shows 0
      // (Empty) until take_seat flips it to 1, and sweeping that would evict a
      // player who just paid in.
      if (seatStatus !== 2) continue;
      // 而且必须是**同一任占用者**：账本的 occupancy_id == Game 座位的 occupancy_id。
      // 否则就是"新人刚坐下、Game 座位还停在上一任的 Left"——那不是僵尸，不能动。
      const gameOcc = g.readBigUInt64LE(152 + i * 152 + 96);
      const ledOcc = ledAcc.data.readBigUInt64LE(73);
      if (gameOcc !== ledOcc) continue;
      const deposited = ledAcc.data.readBigUInt64LE(186);
      const paid = ledAcc.data.readBigUInt64LE(194);
      if (deposited <= paid) continue; // nothing to pay out
      // 同一个（已存/已付）快照只尝试一次：程序拒绝过的座位不要每轮重试
      const sweepKey = `${tableId}:${i}:${deposited}:${paid}`;
      if (sweepTried.has(sweepKey)) continue;
      const payout = new PublicKey(ledAcc.data.subarray(154, 186));
      // 快照门（2026-10-08）：cash_out 的付款/释放全部以 **L1 快照**（最后一次
      // commit 的 Game）为准。快照陈旧时发出去只会是 no-op 成功交易，而
      // 「成功就 return」会永久挤掉同一轮里的 commit_game，快照永远刷不新
      // （table #22 实测：连发 7 笔 no-op cash_out，21.6 tUSDC 兑付被卡住，
      // 座 6/7 的释放也永远到不了）。所以先读快照：确实有付款可付
      // （owed > paid）或确实能释放（Left）才发交易；否则跳过并催一次 commit。
      // 注意不要把这种「等快照」写进 sweepTried —— 那个 key 不含快照值，
      // 会把快照刷新后的重试一起挡掉。
      const snapInfo = await l1.getAccountInfo(game);
      if (!snapInfo) continue;
      const snapOff = 152 + i * 152;
      const snapStatus = snapInfo.data[snapOff + 145];
      const snapOwed = snapInfo.data.readBigUInt64LE(snapOff + 120);
      if (snapStatus !== 2 && snapOwed <= paid) {
        const waitKey = `${tableId}:${i}:${snapStatus}:${snapOwed}:${paid}`;
        if (!sweepWaitLog.has(waitKey)) {
          sweepWaitLog.add(waitKey);
          console.log(`[t${tableId}] sweep wait[${i}]: L1 快照未反映释放（status=${snapStatus} owed=${Number(snapOwed) / 1e6}）→ 催 commit`);
        }
        zombieTables.add(tableId);
        continue;
      }
      const payoutAta = getAssociatedTokenAddressSync(TUSDC_MINT, payout);
      const ixs = [];
      if (!(await l1.getAccountInfo(payoutAta))) {
        ixs.push(createAssociatedTokenAccountInstruction(deployer.publicKey, payoutAta, payout, TUSDC_MINT));
      }
      ixs.push(
        await program.methods
          .cashOut(i)
          .accounts({
            table, game, seat: seatPda(table, i), vaultAuth: vaultAuthPda(table),
            vault: getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuthPda(table), true),
            mint: TUSDC_MINT, payoutAta, caller: deployer.publicKey,
          })
          .instruction()
      );
      try {
        const sig = await sendAndConfirm(l1, ixs, [deployer], `t${tableId} sweep cash_out[${i}]`);
        console.log(`[t${tableId}] sweep cash_out[${i}]: ${sig.slice(0, 12)}...`);
      } catch (e) {
        // Program-rejected seat (e.g. the dead state: ledger still occupied because the
        // L1 snapshot is stale, so cash_out refuses to release): remember it for this
        // snapshot and, if a hand is not in progress, force a commit so the next pass
        // sees a fresh snapshot and can release it.
        sweepTried.add(sweepKey);
        zombieTables.add(tableId);
        console.log(`[t${tableId}] sweep skip[${i}]: ${String(e.message ?? e).slice(0, 90)}`);
      }
      return; // one action per pass
    }
    // 1) take_seat：比较每个座位 L1 账本与 game 里的 occupancy_id
    // 座位账本一次并行读完（9 个串行 RPC 是每轮延迟的主要来源）
    const seatAccs = await Promise.all(
      Array.from({ length: 9 }, (_, i) => er.getAccountInfo(seatPda(table, i)))
    );
    for (let i = 0; i < 9; i++) {
      const seatOff = 152 + i * 152;
      const gameOcc = g.readBigUInt64LE(seatOff + 96);
      const seatStatus = g[seatOff + 145];
      if (seatStatus === 1) continue; // 已 Seated
      const ledgerAcc = seatAccs[i];
      if (!ledgerAcc) continue;
      // SeatLedger: disc(8) table(32) idx(1) occupant(32) occupancy_id(8)@73
      const ledgerOcc = ledgerAcc.data.readBigUInt64LE(73);
      const ledgerEmpty = ledgerAcc.data.subarray(41, 73).every((b) => b === 0);
      if (!ledgerEmpty && ledgerOcc > gameOcc) {
        const ix = await program.methods
          .takeSeat(i)
          .accounts({
            table, game, seatLedger: seatPda(table, i), playerHand: handPda(table, i),
            permission: permPda(handPda(table, i)), commitPayer: commitPayerPda(table),
            vault: EPHEMERAL_VAULT, caller: deployer.publicKey,
          })
          .instruction();
        const sig = await sendAndConfirm(er, [ix], [deployer], `t${tableId} take_seat[${i}]`, ER_CU);
        console.log(`[t${tableId}] take_seat[${i}]: ${sig.slice(0, 12)}…`);
        return; // 一轮一个动作，保持节奏清晰
      }
    }

    // 1b) apply_deposits：Seated 座位的 L1 入金（top_up）计入 ER 筹码
    //     （§5.2.4；仅在座位不在当前手牌中时安全计入）。
    for (let i = 0; i < 9; i++) {
      const seatOff = 152 + i * 152;
      if (g[seatOff + 145] !== 1) continue; // 只处理 Seated
      const credited = g.readBigUInt64LE(seatOff + 112);
      if ((g.readUInt16LE(1526) & (1 << i)) !== 0) continue; // 在手牌中，等手间
      const ledgerAcc = await er.getAccountInfo(seatPda(table, i));
      if (!ledgerAcc) continue;
      const deposited = ledgerAcc.data.readBigUInt64LE(186);
      if (deposited > credited) {
        const ix = await program.methods
          .applyDeposits(i)
          .accounts({ table, game, seatLedger: seatPda(table, i), caller: deployer.publicKey })
          .instruction();
        const sig = await sendAndConfirm(er, [ix], [deployer], `t${tableId} apply_deposits[${i}]`, ER_CU);
        console.log(`[t${tableId}] apply_deposits[${i}] (+${Number(deposited - credited) / 1e6}): ${sig.slice(0, 12)}…`);
        return;
      }
    }

    // 2) VRF：armed(state==1) → request；Pending 超时 → retry（简化：armed 才管，
    //    履行由 oracle 自动回调，等待即可）
    if (vrfState === 1) {
      const until = vrfWaitUntil.get(tableId) ?? 0;
      if (Date.now() > until) {
        const ix = await program.methods
          .requestVrf()
          .accounts({ table, game, payer: deployer.publicKey, vrf: { oracleQueue: ER_VRF_QUEUE } })
          .instruction();
        const sig = await sendAndConfirm(er, [ix], [deployer], `t${tableId} request_vrf`, ER_CU);
        console.log(`[t${tableId}] request_vrf: ${sig.slice(0, 12)}…`);
        vrfWaitUntil.set(tableId, Date.now() + 4000);
        // 原地等履行（≤2s，实测 ~1.1s，2026-10-09）：等到就直接落到第 5 步发牌，
        // 省掉一整轮轮询（每街 ~2.5–3.5s）。等不到保持旧时序（return，下一轮发牌）。
        // 边界：有上限、只发生在本桌刚发出请求之后；活跃桌多时自然退化为旧节奏。
        // 安全前提：揭示已提前到 Commit 阶段（agent/网页同日改动）——发牌变快
        // 也不会撞上「缺盐作废」窗口。
        const waitDeadline = Date.now() + 2000;
        for (;;) {
          await new Promise((r) => setTimeout(r, 700));
          const fresh = await er.getAccountInfo(game);
          const st = fresh ? fresh.data[144] : 1;
          if (st !== 1 && st !== 2) {
            vrfFulfilledNow = st === 3; // 3=Fulfilled；4=Void 也落到第 5 步走作废路径
            break;
          }
          if (Date.now() > waitDeadline) break;
        }
        if (!vrfFulfilledNow) return;
      }
    }

    // 2b) VRF Pending 超时 → retry_vrf（§6.3：vrf_timeout_s 之后重试，最多 vrf_max_attempts 次）。
    //     不重试的话，oracle 一慢这一手必然作废（devnet 实测连续两手都是这样废掉的）。
    if (vrfState === 2) {
      const until = vrfRetryUntil.get(tableId) ?? 0;
      if (Date.now() > until) {
        const requestedAt = Number(g.readBigInt64LE(136));
        const tAcc = await l1.getAccountInfo(table);
        const vrfTimeoutS = tAcc ? tAcc.data[119] | (tAcc.data[120] << 8) : 10;
        if (requestedAt > 0 && now - requestedAt >= vrfTimeoutS) {
          try {
            const ix = await program.methods
              .retryVrf()
              .accounts({ table, game, payer: deployer.publicKey, vrf: { oracleQueue: ER_VRF_QUEUE } })
              .instruction();
            const sig = await sendAndConfirm(er, [ix], [deployer], `t${tableId} retry_vrf`, ER_CU);
            console.log(`[t${tableId}] retry_vrf: ${sig.slice(0, 12)}…`);
          } catch (e) {
            console.log(`[t${tableId}] retry_vrf skip: ${String(e.message ?? e).slice(0, 80)}`);
          }
          vrfRetryUntil.set(tableId, Date.now() + 15000);
          return;
        }
        vrfRetryUntil.set(tableId, Date.now() + 3000);
      }
    }

    // 3) 行动超时 → claim_timeout（只有真的有人欠行动时才发；死状态由第 5 步自愈）
    if ((phase === 3 || phase === 5) && pendingToAct !== 0 && actionDeadline > 0n && BigInt(now) > actionDeadline) {
      const toAct = g[1549];
      const ix = await program.methods
        .claimTimeout(new BN(handId.toString()))
        .accounts({ table, game, caller: deployer.publicKey })
        .instruction();
      const sig = await sendAndConfirm(er, [ix], [deployer], `t${tableId} claim_timeout`, ER_CU);
      console.log(`[t${tableId}] claim_timeout (seat ${toAct}): ${sig.slice(0, 12)}…`);
      return;
    }

    // 4) commit：hands_since_commit 达到阈值且不在手牌中；
    //    另外——如果本轮在 sweep 里碰到卡住的座位（zombieCandidate），也催一次 commit：
    //    cash_out 释放座位依赖 L1 快照，快照刷新后下一轮就能把座位真正清出来。
    if (phase === 0 && (handsSinceCommit > 0 || zombieTables.has(tableId))) {
      // Table 布局：commit_every_n_hands @123（state.rs 字段序；145B 账户）。
      const tableAcc = await l1.getAccountInfo(table);
      const commitEvery = tableAcc ? tableAcc.data[123] : 255;
      if (
        (handsSinceCommit >= commitEvery || zombieTables.has(tableId)) &&
        Date.now() > (commitFailUntil.get(tableId) ?? 0)
      ) {
        try {
          const [magicFeeVault] = PublicKey.findProgramAddressSync(
            [Buffer.from("magic-fee-vault"), TEE_VALIDATOR.toBuffer()], DLP
          );
          const ix = await program.methods
            .commitGame()
            .accounts({
              table, game, handProof: proofPda(table), handSecrets: secretsPda(table),
              handReplay: replayPda(table),
              commitPayer: commitPayerPda(table), magicContext: MAGIC_CONTEXT,
              magicProgram: MAGIC_PROGRAM, magicFeeVault,
            })
            .instruction();
          const sig = await sendAndConfirm(er, [ix], [deployer], `t${tableId} commit_game`, ER_CU);
          console.log(`[t${tableId}] commit_game: ${sig.slice(0, 12)}…`);
          // 快照刷新完成：清掉该桌的 zombie 标记与 sweepTried 键，让下一轮真正去释放座位
          zombieTables.delete(tableId);
          for (const k of [...sweepTried]) {
            if (k.startsWith(`${tableId}:`)) sweepTried.delete(k);
          }
          return true; // 连锁：下一轮直接尝试 freeze
        } catch (e) {
          // 2026-10-08 教训：commit_game 失败（如提交费账户 InsufficientFundsForRent）曾经
          // 让整个 pass 在这里抛出 → 永远走不到 advance → 整桌冻死几个小时。
          // 现在只降级：冷却 60 秒不重试，然后继续往下走（牌局优先，快照稍后补）。
          commitFailUntil.set(tableId, Date.now() + 60_000);
          console.log(
            `[t${tableId}] commit_game 失败（60s 内不重试，牌局继续）：${String(e.message ?? e).slice(0, 120)}`
          );
        }
      }
    }

    // 5) advance：可推进的阶段（handler 内部对不可推进情形 no-op/报错，报错即跳过）
    //    3/5（下注街）正常等玩家行动，不空转；唯一例外是「下注轮已结束但阶段未
    //    推进」的死状态（pending==0 —— 2026-10-08 stand_up 旧路径把行动者折叠后
    //    pending 归零却没人关街，table #22 因此卡死）：交给 advance 自愈关街。
    if ([0, 1, 2, 3, 4, 5, 6, 7].includes(phase)) {
      if (phase === 3 || phase === 5) {
        if (pendingToAct !== 0) return;
        console.log(`[t${tableId}] 检测到死状态：下注轮已结束但阶段未推进（pending=0, phase=${phase}）→ advance 自愈`);
      }
      // VRF 街阶段：vrfState 1=Ready（先由上面的 request 步骤发出）或
      // 2=Pending（等 oracle 履行）时不要无谓推进；0=Idle 时 advance 负责
      // arm（AwaitStreet/AwaitRunout 的 VRF 就是这样启动的），3=Fulfilled
      // 时 advance 负责发牌。
      if ([2, 4, 6].includes(phase) && !vrfFulfilledNow && (vrfState === 1 || vrfState === 2)) return;
      // Idle 无手可开（有筹码的 Seated 座位 < 2）时不要空转发交易——
      // advance 会静默 no-op，每秒一发的交易纯烧手续费（2026-10-07 发现）。
      if (phase === 0) {
        let eligible = 0;
        for (let i = 0; i < 9; i++) {
          const o = 152 + i * 152;
          if (g[o + 145] === 1 && g.readBigUInt64LE(o + 104) > 0n) eligible++;
        }
        if (eligible < 2) return;
      }
      // Commit 阶段：缺承诺时才守 Game.phase_deadline(@112)（到期敲 strike、缺盐
      // 座位按 max_strikes 释放 —— §6.3）；每秒空转会白烧手续费（2026-10-08 实测
      // 无揭示的手牌白烧 ~180 笔）。
      //
      // 但 hand_mask 全体都已承诺时不能等：程序侧 commit_to_await_seed 对
      // missing==0 会立刻 arm Preflop VRF 并进入 AwaitSeed（hand.rs），
      // commit_timeout_s（建桌 60s！）只是给缺承诺座位留的窗口。§6.4 预提交让
      // 「全体已承诺」在冻结瞬间成立 —— 一到齐就推进，这是每手最大的一笔死时间。
      if (phase === 1) {
        // SeatState 在 Game 里的布局：座位基址 152，步长 152，salt_commit @+32
        // （state.rs；与 runner decodeGame / 程序 verify_seat_salt 同源）。
        let allCommitted = true;
        for (let i = 0; i < 9; i++) {
          if ((handMask & (1 << i)) === 0) continue;
          const off = 152 + i * 152 + 32;
          let nz = false;
          for (let b = 0; b < 32; b++) if (g[off + b] !== 0) { nz = true; break; }
          if (!nz) { allCommitted = false; break; }
        }
        if (!allCommitted) {
          const phaseDeadline = g.readBigInt64LE(112);
          if (phaseDeadline > 0n && BigInt(now) < phaseDeadline) return;
        }
      }

      // Commit 阶段需要所有座位提交盐承诺（未齐时 advance 会报错——吞掉）
      try {
        const handAccounts = Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [`hand${i}`, handPda(table, i)])
        );
        const ix = await program.methods
          .advance(new BN(handId.toString()))
          .accounts({
            table, game, deck: deckPda(table), handProof: proofPda(table),
            handSecrets: secretsPda(table), handReplay: replayPda(table), ...handAccounts,
            caller: deployer.publicKey,
          })
          .instruction();
        const sig = await sendAndConfirm(er, [ix], [deployer], `t${tableId} advance`, ER_CU);
        console.log(`[t${tableId}] advance (phase ${phase}): ${sig.slice(0, 12)}…`);
        return true; // 连锁：推进可能立刻解锁下一阶段（arm→request、close→freeze…）
      } catch (e) {
        const msg = String(e.message ?? e);
        // 6019/6022/6023 等「还不可推进」是常态，静默；其他错误外抛
        if (!/"Custom":60(19|22|23|24|25|26)/.test(msg)) throw e;
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
