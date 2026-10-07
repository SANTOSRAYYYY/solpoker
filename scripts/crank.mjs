// SolPoker crank service (Stage 7): drives the deterministic phase machine on
// devnet-tee so browser players only ever sign their own actions.
//
// Loop per table (default: NEXT_PUBLIC-style env TABLE_IDS or argv):
//   1. take_seat for any SeatLedger whose occupancy_id moved past the game seat
//   2. advance whenever the phase machine can move (Idle/Commit/AwaitSeed/
//      AwaitStreet/AwaitRunout/Settle) — the handler no-ops when nothing is due
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

const L1_URL = process.env.L1_URL ?? "http://127.0.0.1:8898/devnet";
const ER_BASE = process.env.ER_BASE ?? "http://127.0.0.1:7799";
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
  for (;;) {
    for (const tableId of tableIds) {
      const table = tablePda(tableId);
      const game = gamePda(table);
      try {
        await crankTable(tableId, table, game);
      } catch (e) {
        console.log(`[t${tableId}] ${String(e.message ?? e).slice(0, 160)}`);
      }
    }
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
    const now = Math.floor(Date.now() / 1000);

    // 0) sweep: clear "left but not cashed out" zombie seats. cash_out is
    // permissionless (design X7) and the program pins the payout ATA recorded at
    // sit_down, so the crank can only ever send the money back to its owner.
    // This frees the seat for the next player instead of leaving it locked.
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
      const deposited = ledAcc.data.readBigUInt64LE(186);
      const paid = ledAcc.data.readBigUInt64LE(194);
      if (deposited <= paid) continue; // nothing to pay out
      // 同一个（已存/已付）快照只尝试一次：程序拒绝过的座位不要每轮重试
      const sweepKey = `${tableId}:${i}:${deposited}:${paid}`;
      if (sweepTried.has(sweepKey)) continue;
      const payout = new PublicKey(ledAcc.data.subarray(154, 186));
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
        // Program-rejected seat (e.g. the dead state: ledger clean but the Game seat
        // still Left): remember it for this snapshot so we do not retry every pass
        // (each retry burns a fee and spams the log).
        sweepTried.add(sweepKey);
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
        return;
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

    // 3) 行动超时 → claim_timeout
    if ((phase === 3 || phase === 5) && actionDeadline > 0n && BigInt(now) > actionDeadline) {
      const toAct = g[1549];
      const ix = await program.methods
        .claimTimeout(new BN(handId.toString()))
        .accounts({ table, game, caller: deployer.publicKey })
        .instruction();
      const sig = await sendAndConfirm(er, [ix], [deployer], `t${tableId} claim_timeout`, ER_CU);
      console.log(`[t${tableId}] claim_timeout (seat ${toAct}): ${sig.slice(0, 12)}…`);
      return;
    }

    // 4) commit：hands_since_commit 达到阈值且不在手牌中
    if (phase === 0 && handsSinceCommit > 0) {
      // Table 布局：commit_every_n_hands @123（state.rs 字段序；145B 账户）。
      const tableAcc = await l1.getAccountInfo(table);
      const commitEvery = tableAcc ? tableAcc.data[123] : 255;
      if (handsSinceCommit >= commitEvery) {
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
        return;
      }
    }

    // 5) advance：可推进的阶段（handler 内部对不可推进情形 no-op/报错，报错即跳过）
    if ([0, 1, 2, 4, 6, 7].includes(phase)) {
      // VRF 街阶段：vrfState 1=Ready（先由上面的 request 步骤发出）或
      // 2=Pending（等 oracle 履行）时不要无谓推进；0=Idle 时 advance 负责
      // arm（AwaitStreet/AwaitRunout 的 VRF 就是这样启动的），3=Fulfilled
      // 时 advance 负责发牌。
      if ([2, 4, 6].includes(phase) && (vrfState === 1 || vrfState === 2)) return;
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
