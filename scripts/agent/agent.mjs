import { L1_RPC as ENV_L1, ER_BASE_URL as ENV_ER } from "../env.mjs";
// SolPoker Agent Runner — 把「机器人上桌打牌」做成一条命令。
//
// 一个 agent = 一个密钥对 + 这个 runner：
//   new/fund/sit/run/stand/status 六个子命令覆盖全生命周期。
// ER 动作（commit_salt/reveal_salt/act/stand_up）由 agent 私钥直接签名
// （设计 §2.2：agent 的入座交易由 agent 密钥直接签名）；发牌/结算由 crank
// 驱动，runner 只做「轮到我时决策」。
//
// 用法:
//   node scripts/agent/agent.mjs new   alice
//   node scripts/agent/agent.mjs fund  alice 0.05 25
//   node scripts/agent/agent.mjs sit   alice 9 0 20
//   node scripts/agent/agent.mjs run   alice --hands 5
//   node scripts/agent/agent.mjs run   alice --strategy ./my-strategy.mjs
//   node scripts/agent/agent.mjs stand alice
//   node scripts/agent/agent.mjs status [alice]
import fs from "node:fs";
import path from "node:path";
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createMintToInstruction,
} from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { loadStrategy } from "./strategy.mjs";
import { cardsStr, rankText, evaluateBest } from "./eval.mjs";

const L1_URL = process.env.L1_URL ?? ENV_L1;
const ER_BASE = process.env.ER_BASE ?? ENV_ER;
const ER_CU = 1_400_000;
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const CENT = 10000n;

const fetchWithTimeout = (input, init = {}) =>
  fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(20000) });

const IDL = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const PROGRAM_ID = new PublicKey(IDL.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const tablePda = (id) => pda([Buffer.from("table"), u32le(id)]);
const gamePda = (t) => pda([Buffer.from("game"), t.toBuffer()]);
const vaultAuthPda = (t) => pda([Buffer.from("vault_auth"), t.toBuffer()]);
const seatPda = (t, i) => pda([Buffer.from("seat"), t.toBuffer(), Buffer.from([i])]);
const handPda = (t, i) => pda([Buffer.from("hand"), t.toBuffer(), Buffer.from([0, 0]), Buffer.from([i])]);
const commitPayerPda = (t) => pda([Buffer.from("commit_payer"), t.toBuffer()]);
const permPda = (acc) => PublicKey.findProgramAddressSync([Buffer.from("permission:"), acc.toBuffer()], PERMISSION_PROGRAM)[0];

// ---------------------------------------------------------------------------
// agent 档案与持久化
// ---------------------------------------------------------------------------
const AGENTS_DIR = "keys/agents";
function agentFile(name) { return path.join(AGENTS_DIR, `${name}.json`); }
function saltsFile(name) { return path.join(AGENTS_DIR, `${name}.salts.json`); }

function loadAgent(name) {
  const cfg = JSON.parse(fs.readFileSync(agentFile(name), "utf8"));
  return { ...cfg, keypair: Keypair.fromSecretKey(Uint8Array.from(cfg.secretKey)) };
}
function saveAgent(cfg) {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(agentFile(cfg.name), JSON.stringify(cfg, null, 1));
}
function loadSalts(name) {
  try { return JSON.parse(fs.readFileSync(saltsFile(name), "utf8")); } catch { return {}; }
}
function saveSalt(name, handId, salt) {
  const all = loadSalts(name);
  all[handId.toString()] = Buffer.from(salt).toString("hex");
  // 只保留最近 4 手
  const keys = Object.keys(all).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  while (keys.length > 4) delete all[keys.shift()];
  fs.writeFileSync(saltsFile(name), JSON.stringify(all));
}

// ---------------------------------------------------------------------------
// 链上读写
// ---------------------------------------------------------------------------
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
          await sleep(1200);
          break;
        }
        throw new Error(`${label}: ${errStr}`);
      }
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return sig;
      if (Date.now() - t0 > 90000) throw new Error(`${label}: confirmation timeout`);
      await sleep(700);
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeGame(data) {
  const u64 = (o) => data.readBigUInt64LE(o);
  const seats = [];
  for (let i = 0; i < 9; i++) {
    const o = 152 + i * 152;
    seats.push({
      occupant: new PublicKey(data.subarray(o, o + 32)).toBase58(),
      saltCommit: data.subarray(o + 32, o + 64),
      nextSaltCommit: data.subarray(o + 64, o + 96),
      stack: u64(o + 104),
      inHand: u64(o + 128),
      streetBet: u64(o + 136),
      status: data[o + 145],
      folded: data[o + 146] !== 0,
      allIn: data[o + 147] !== 0,
      strikes: data[o + 149],
    });
  }
  return {
    handId: u64(72),
    pot: u64(80),
    currentBet: u64(88),
    lastFullRaise: u64(96),
    actionDeadline: data.readBigInt64LE(104),
    vrfState: data[144],
    seats,
    actionSeq: data.readUInt32LE(1520),
    occupiedMask: data.readUInt16LE(1524),
    handMask: data.readUInt16LE(1526),
    liveMask: data.readUInt16LE(1528),
    board: Array.from(data.subarray(1534, 1539)),
    phase: data[1544],
    street: data[1545],
    button: data[1546],
    boardLen: data[1548],
    toAct: data[1549],
  };
}
function decodeTable(data) {
  return {
    sb: data.readBigUInt64LE(79),
    bb: data.readBigUInt64LE(87),
    ante: data.readBigUInt64LE(95),
  };
}
const popcount = (x) => { let n = 0; while (x) { n += x & 1; x >>= 1; } return n; };

async function erConnection(agent) {
  const nacl = (await import("tweetnacl")).default;
  const { token } = await getAuthToken(ER_BASE, agent.keypair.publicKey, async (msg) =>
    nacl.sign.detached(msg, agent.keypair.secretKey)
  );
  return new Connection(`${ER_BASE}?token=${token}`, { commitment: "confirmed", fetch: fetchWithTimeout });
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------
async function cmdNew(name) {
  if (fs.existsSync(agentFile(name))) { console.log(`agent ${name} 已存在`); return; }
  const keypair = Keypair.generate();
  saveAgent({ name, secretKey: Array.from(keypair.secretKey) });
  console.log(`agent ${name} 已创建: ${keypair.publicKey.toBase58()}`);
  console.log(`下一步: node scripts/agent/agent.mjs fund ${name}`);
}

async function cmdFund(name, sol = 0.05, tusdc = 25) {
  const agent = loadAgent(name);
  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
  );
  const l1 = new Connection(L1_URL, { commitment: "confirmed", fetch: fetchWithTimeout });
  const ixs = [
    SystemProgram.transfer({
      fromPubkey: deployer.publicKey,
      toPubkey: agent.keypair.publicKey,
      lamports: Math.round(sol * 1e9),
    }),
  ];
  const ata = getAssociatedTokenAddressSync(TUSDC_MINT, agent.keypair.publicKey);
  if (!(await l1.getAccountInfo(ata))) {
    ixs.push(createAssociatedTokenAccountInstruction(deployer.publicKey, ata, agent.keypair.publicKey, TUSDC_MINT));
  }
  ixs.push(createMintToInstruction(TUSDC_MINT, ata, deployer.publicKey, BigInt(Math.round(tusdc * 1e6))));
  const sig = await sendAndConfirm(l1, ixs, [deployer], `fund ${name} (${sol} SOL + ${tusdc} tUSDC)`);
  console.log(`funded: ${sig}`);
}

async function cmdRegister(name, opts) {
  const agent = loadAgent(name);
  const owner = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(opts.ownerPath ?? "keys/deployer.json", "utf8")))
  );
  const l1 = new Connection(L1_URL, { commitment: "confirmed", fetch: fetchWithTimeout });
  const program = new anchor.Program(IDL, new anchor.AnchorProvider(l1, new anchor.Wallet(owner), { commitment: "confirmed" }));
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const [profile] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agent.keypair.publicKey.toBuffer()], PROGRAM_ID
  );
  const nameBytes = Buffer.alloc(32);
  nameBytes.write((opts.displayName ?? name).slice(0, 32), "utf8");
  const metaBytes = Buffer.alloc(96);

  const ix = await program.methods
    .registerAgent(Array.from(nameBytes), Array.from(metaBytes), !!opts.payoutAgent)
    .accounts({
      config,
      profile,
      agent: agent.keypair.publicKey,
      owner: owner.publicKey,
      allowlist: null,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const sig = await sendAndConfirm(l1, [ix], [agent.keypair, owner], `register_agent ${name} (owner=${owner.publicKey.toBase58().slice(0, 8)}…)`);
  saveAgent({
    ...JSON.parse(fs.readFileSync(agentFile(name), "utf8")),
    registered: true,
    owner: owner.publicKey.toBase58(),
  });
  console.log(`agent ${name} 已注册（profile=${profile.toBase58()}）: ${sig}`);
  console.log(`下一步: node scripts/agent/agent.mjs sit ${name} <tableId> <seat> —— 之后将以 agent 身份入座（kind=Agent）`);
}

async function cmdSit(name, tableId, seat, buyIn = 20) {
  const agent = loadAgent(name);
  const table = tablePda(tableId);
  const l1 = new Connection(L1_URL, { commitment: "confirmed", fetch: fetchWithTimeout });
  const program = new anchor.Program(IDL, new anchor.AnchorProvider(l1, new anchor.Wallet(agent.keypair), { commitment: "confirmed" }));
  const ata = getAssociatedTokenAddressSync(TUSDC_MINT, agent.keypair.publicKey);
  const vaultAuth = vaultAuthPda(table);
  const vault = getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuth, true);
  const ixs = [];
  if (!(await l1.getAccountInfo(ata))) {
    ixs.push(createAssociatedTokenAccountInstruction(agent.keypair.publicKey, ata, agent.keypair.publicKey, TUSDC_MINT));
  }
  // Stage 8：其余 8 个座位账本（全桌身份扫描）+ 可选 agentProfile。
  const others = Object.fromEntries(
    Array.from({ length: 9 }, (_, k) => k).filter((k) => k !== seat).map((k, n) => [`other${n}`, seatPda(table, k)])
  );
  let agentProfile = null;
  if (agent.registered) {
    agentProfile = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent.keypair.publicKey.toBuffer()], PROGRAM_ID
    )[0];
  }
  ixs.push(
    await program.methods
      .sitDown(seat, new BN(Math.round(buyIn * 1e6)), agent.keypair.publicKey, new BN(Math.floor(Date.now() / 1000) + 7 * 24 * 3600))
      .accounts({
        table, seat: seatPda(table, seat), ...others, agentProfile, vaultAuth, vault,
        mint: TUSDC_MINT, playerAta: ata, payer: agent.keypair.publicKey,
      })
      .instruction()
  );
  const sig = await sendAndConfirm(l1, ixs, [agent.keypair], `sit_down ${name} (桌#${tableId} 座${seat}, ${buyIn} USDC${agent.registered ? ", agent 身份" : ""})`);
  saveAgent({ ...JSON.parse(fs.readFileSync(agentFile(name), "utf8")), tableId, seat, buyIn });
  console.log(`入座交易已上链: ${sig}\n下一步: node scripts/agent/agent.mjs run ${name} --hands 5`);
}

async function cmdRun(name, opts) {
  const agent = loadAgent(name);
  if (agent.tableId === undefined) throw new Error(`agent ${name} 还没入座过（先跑 sit）`);
  const { tableId, seat } = agent;
  const table = tablePda(tableId);
  const game = gamePda(table);
  const myHand = handPda(table, seat);
  const strategy = await loadStrategy(opts.strategy);

  let er = await erConnection(agent);
  let program = new anchor.Program(IDL, new anchor.AnchorProvider(er, new anchor.Wallet(agent.keypair), { commitment: "confirmed" }));
  console.log(`[${name}] online — 桌#${tableId} 座${seat}，策略: ${strategy.name}${opts.hands ? `，目标 ${opts.hands} 手` : ""}`);

  let lastActed = -1;
  let curHand = -1n;
  let completed = 0;
  let consecutiveErrors = 0;

  for (;;) {
    try {
      const [gAcc, tAcc] = await Promise.all([er.getAccountInfo(game), er.getAccountInfo(table)]);
      if (!gAcc) { await sleep(1000); continue; }
      const g = decodeGame(gAcc.data);
      const t = decodeTable(tAcc.data);
      const me = g.seats[seat];
      consecutiveErrors = 0;

      if (g.handId !== curHand) {
        if (curHand >= 0n) {
          completed++;
          console.log(`[${name}] 第 ${completed} 手结束（hand#${curHand}）→ 当前筹码 ${Number(me.stack) / 1e6}`);
          if (opts.hands && completed >= opts.hands) break;
        }
        curHand = g.handId;
        lastActed = -1;
      }

      if (me.status !== 1) { await sleep(1500); continue; } // 等 crank take_seat

      const inHand = (g.handMask & (1 << seat)) !== 0;

      // ---- Commit 阶段：提交盐承诺 ----
      if (inHand && g.phase === 1 && me.saltCommit.every((b) => b === 0)) {
        const key = g.handId.toString();
        const fromMem = opts._salts[key] ?? loadSalts(name)[key] ?? null;
        const useSalt = fromMem ? Buffer.from(fromMem, "hex") : cryptoRandom32();
        if (!fromMem) {
          saveSalt(name, g.handId, useSalt);
          // 立即回写内存映射——否则本进程的 reveal 步骤读不到（血泪教训）。
          opts._salts[key] = Buffer.from(useSalt).toString("hex");
        }
        const handIdBe = Buffer.alloc(8);
        handIdBe.writeBigUInt64BE(g.handId);
        const commitment = (await import("node:crypto")).createHash("sha256")
          .update(Buffer.from("solpoker/salt/v1"))
          .update(table.toBuffer())
          .update(handIdBe)
          .update(agent.keypair.publicKey.toBuffer())
          .update(useSalt)
          .digest();
        const ix = await program.methods
          .commitSalt(seat, new BN(g.handId.toString()), Array.from(commitment))
          .accounts({ table, game, seatLedger: seatPda(table, seat), signer: agent.keypair.publicKey })
          .instruction();
        await sendAndConfirm(er, [ix], [agent.keypair], `commit_salt`, ER_CU);
        console.log(`[${name}] hand#${g.handId} 盐承诺已提交`);
        continue;
      }

      // ---- AwaitSeed：揭示 ----
      if (inHand && g.phase === 2) {
        const hAcc = await er.getAccountInfo(myHand);
        const saltHandId = hAcc ? hAcc.data.readBigUInt64LE(50) : 0n;
        if (saltHandId !== g.handId) {
          // 内存优先，其次磁盘（崩溃重启后从持久化恢复）。
          const saltHex = opts._salts[g.handId.toString()] ?? loadSalts(name)[g.handId.toString()];
          if (!saltHex) { await sleep(1000); continue; }
          const ix = await program.methods
            .revealSalt(seat, new BN(g.handId.toString()), Array.from(Buffer.from(saltHex, "hex")))
            .accounts({ table, seatLedger: seatPda(table, seat), playerHand: myHand, signer: agent.keypair.publicKey })
            .instruction();
          await sendAndConfirm(er, [ix], [agent.keypair], `reveal_salt`, ER_CU);
          console.log(`[${name}] hand#${g.handId} 盐已揭示`);
          await sleep(600);
          continue;
        }
        // 已揭示：不 continue —— 落到下面走 §6.4 预提交分支（手牌进行中为下一手承诺盐）。
      }

      // ---- §6.4 预提交：手牌进行中，为下一手提交盐承诺 ----
      // 程序侧（commit_salt.rs）phase ≥ 2 时 hand_id == current+1 会写入
      // next_salt_commit，advance 冻结下一手时提升为 salt_commit —— 下一手的
      // Commit 阶段在冻结瞬间就「全员已承诺」，crank 可立即推进（省掉最长
      // commit_timeout_s 的干等）。盐先落盘再发交易，崩溃重启也能在下一手揭示。
      // 不在手牌中的座位同样适用（just sat / 本轮出局，下轮就轮到它）。
      if (g.phase >= 2 && me.stack > 0n && me.nextSaltCommit.every((b) => b === 0)) {
        const nextHandId = g.handId + 1n;
        const nextKey = nextHandId.toString();
        const fromMemNext = opts._salts[nextKey] ?? loadSalts(name)[nextKey] ?? null;
        const nextSalt = fromMemNext ? Buffer.from(fromMemNext, "hex") : cryptoRandom32();
        if (!fromMemNext) {
          saveSalt(name, nextHandId, nextSalt);
          opts._salts[nextKey] = Buffer.from(nextSalt).toString("hex");
        }
        const nextHandIdBe = Buffer.alloc(8);
        nextHandIdBe.writeBigUInt64BE(nextHandId);
        const nextCommitment = (await import("node:crypto")).createHash("sha256")
          .update(Buffer.from("solpoker/salt/v1"))
          .update(table.toBuffer())
          .update(nextHandIdBe)
          .update(agent.keypair.publicKey.toBuffer())
          .update(nextSalt)
          .digest();
        const ixNext = await program.methods
          .commitSalt(seat, new BN(nextKey), Array.from(nextCommitment))
          .accounts({ table, game, seatLedger: seatPda(table, seat), signer: agent.keypair.publicKey })
          .instruction();
        await sendAndConfirm(er, [ixNext], [agent.keypair], `commit_salt(next)`, ER_CU);
        console.log(`[${name}] hand#${nextKey} 盐预承诺已提交`);
        continue;
      }

      // ---- 行动阶段 ----
      if ((g.phase === 3 || g.phase === 5) && inHand && g.toAct === seat && g.actionSeq !== lastActed) {
        // 读自家底牌（PER 成员可读）
        const hAcc = await er.getAccountInfo(myHand);
        if (!hAcc) { await sleep(800); continue; }
        const hole = [hAcc.data[16], hAcc.data[17]];
        if (hole[0] >= 52 || hole[1] >= 52) { await sleep(800); continue; } // 还没发到

        const board = g.board.slice(0, g.boardLen);
        const toCall = g.currentBet - me.streetBet;
        const minRaiseTo = g.currentBet > 0n ? g.currentBet + g.lastFullRaise : g.lastFullRaise;
        const ctx = {
          hole, board, street: g.street,
          pot: g.pot, toCall, streetBet: me.streetBet, stack: me.stack,
          currentBet: g.currentBet, lastFullRaise: g.lastFullRaise,
          minRaiseTo, bb: t.bb,
          liveCount: popcount(g.handMask & g.liveMask),
          rng: Math.random,
        };
        let decision;
        try {
          decision = strategy.decide(ctx);
        } catch (e) {
          console.log(`[${name}] 策略异常，保守跟注: ${e.message}`);
          decision = toCall > 0n ? { action: "call" } : { action: "check" };
        }
        const arg = actionArg(decision);
        const handDesc = board.length >= 3
          ? rankText(evaluateBest([...hole, ...board]))
          : `翻前 ${cardsStr(hole)}`;
        const ix = await program.methods
          .act(seat, new BN(g.handId.toString()), g.actionSeq, arg)
          .accounts({ table, game, seatLedger: seatPda(table, seat), signer: agent.keypair.publicKey })
          .instruction();
        await sendAndConfirm(er, [ix], [agent.keypair], `${decision.action}`, ER_CU);
        lastActed = g.actionSeq;
        const amt = decision.amount ? ` ${Number(decision.amount) / 1e6}` : "";
        console.log(`[${name}] hand#${g.handId} ${decision.action}${amt}   [${handDesc}]  筹码 ${Number(me.stack) / 1e6}`);
        continue;
      }

      await sleep(900);
    } catch (e) {
      consecutiveErrors++;
      console.log(`[${name}] 错误(${consecutiveErrors}): ${String(e.message ?? e).slice(0, 160)}`);
      if (consecutiveErrors % 5 === 0) {
        try { er = await erConnection(agent); program = new anchor.Program(IDL, new anchor.AnchorProvider(er, new anchor.Wallet(agent.keypair), { commitment: "confirmed" })); console.log(`[${name}] 已重新鉴权`); } catch {}
      }
      await sleep(1500);
    }
  }
  console.log(`[${name}] 完成 ${completed} 手，退出。可执行 stand 兑现。`);
}

async function cmdStand(name) {
  const agent = loadAgent(name);
  const { tableId, seat } = agent;
  if (tableId === undefined) throw new Error("还没入座过");
  const table = tablePda(tableId);
  const game = gamePda(table);
  const er = await erConnection(agent);
  const program = new anchor.Program(IDL, new anchor.AnchorProvider(er, new anchor.Wallet(agent.keypair), { commitment: "confirmed" }));
  // 幂等：座位可能已被 A7 自动离座（agent 退出后无人提交承诺 → commit 超时
  // → 3 strikes 自动释放并记 owed）。此时跳过 stand_up 直接兑现。
  const preGame = await er.getAccountInfo(game);
  const seatStatus = preGame ? preGame.data[152 + seat * 152 + 145] : 0;
  if (seatStatus === 2) {
    console.log(`[${name}] 座位已处于「已离」状态（自动离座），直接兑现`);
  } else {
    const ix = await program.methods
      .standUp(seat)
      .accounts({
        table, game, seatLedger: seatPda(table, seat), playerHand: handPda(table, seat),
        permission: permPda(handPda(table, seat)), commitPayer: commitPayerPda(table),
        vault: EPHEMERAL_VAULT, signer: agent.keypair.publicKey,
      })
      .instruction();
    await sendAndConfirm(er, [ix], [agent.keypair], `stand_up`, ER_CU);
    console.log(`[${name}] 已站起（等待 crank commit 后兑付，通常 ≤ 1 分钟）`);
  }

  // 等 L1 快照（Left + owed）→ cash_out
  const l1 = new Connection(L1_URL, { commitment: "confirmed", fetch: fetchWithTimeout });
  const ledger = await l1.getAccountInfo(seatPda(table, seat));
  const occ = ledger.data.readBigUInt64LE(73);
  const t0 = Date.now();
  for (;;) {
    const lg = await l1.getAccountInfo(game);
    if (lg && lg.data[152 + seat * 152 + 145] === 2 && lg.data.readBigUInt64LE(152 + seat * 152 + 96) === occ) break;
    if (Date.now() - t0 > 180000) throw new Error("等 L1 快照超时（crank 在跑吗？）");
    await sleep(1500);
  }
  const ata = getAssociatedTokenAddressSync(TUSDC_MINT, agent.keypair.publicKey);
  // X7：兑付目标是入座时固定的 payout（agent 默认 = 主人钱包），不是 agent 自己。
  // 从账本读 payout（@154）派生 ATA，并确保其存在。
  const ledger2 = await l1.getAccountInfo(seatPda(table, seat));
  const payout = new PublicKey(ledger2.data.subarray(154, 186));
  const payoutAta = getAssociatedTokenAddressSync(TUSDC_MINT, payout);
  const l1Program = new anchor.Program(IDL, new anchor.AnchorProvider(l1, new anchor.Wallet(agent.keypair), { commitment: "confirmed" }));
  const pre = [];
  if (!(await l1.getAccountInfo(payoutAta))) {
    pre.push(createAssociatedTokenAccountInstruction(agent.keypair.publicKey, payoutAta, payout, TUSDC_MINT));
  }
  const before = await l1.getTokenAccountBalance(payoutAta).catch(() => null);
  const cix = await l1Program.methods
    .cashOut(seat)
    .accounts({
      table, game, seat: seatPda(table, seat), vaultAuth: vaultAuthPda(table),
      vault: getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuthPda(table), true),
      mint: TUSDC_MINT, payoutAta, caller: agent.keypair.publicKey,
    })
    .instruction();
  await sendAndConfirm(l1, [...pre, cix], [agent.keypair], "cash_out");
  const after = await l1.getTokenAccountBalance(payoutAta).catch(() => null);
  console.log(`[${name}] 已兑现到 payout(${payout.toBase58().slice(0, 8)}…): ${before?.value.uiAmount ?? "?"} → ${after?.value.uiAmount ?? "?"} tUSDC`);
}

async function cmdStatus(name) {
  const agents = name
    ? [name]
    : fs.existsSync(AGENTS_DIR)
      ? fs
          .readdirSync(AGENTS_DIR)
          .filter((f) => f.endsWith(".json") && !f.includes("salts"))
          .map((f) => f.replace(".json", ""))
          // 目录里可能混着裸密钥文件（如 bob-owner.json：64 字节数组，不是 agent 档案）
          .filter((n) => {
            try {
              const j = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, n + ".json"), "utf8"));
              return !Array.isArray(j) && typeof j.secretKey !== "undefined";
            } catch {
              return false;
            }
          })
      : [];
  for (const n of agents) {
    const agent = loadAgent(n);
    const line = [`${n} (${agent.keypair.publicKey.toBase58().slice(0, 8)}…)`];
    if (agent.tableId !== undefined) {
      const er = await erConnection(agent);
      const gAcc = await er.getAccountInfo(gamePda(tablePda(agent.tableId)));
      if (gAcc) {
        const g = decodeGame(gAcc.data);
        const me = g.seats[agent.seat];
        line.push(`桌#${agent.tableId} 座${agent.seat} status=${["空", "在座", "已离"][me.status]} 筹码=${Number(me.stack) / 1e6} 手#${g.handId} phase=${g.phase}`);
      } else line.push("桌状态未知");
    }
    console.log(line.join("  "));
  }
}

function cryptoRandom32() {
  const b = new Uint8Array(32);
  (globalThis.crypto ?? require("node:crypto").webcrypto).getRandomValues(b);
  return Buffer.from(b);
}

function actionArg(d) {
  const bn = (v) => new BN(v.toString());
  switch (d.action) {
    case "fold": return { fold: {} };
    case "check": return { check: {} };
    case "call": return { call: {} };
    case "allIn": return { allIn: {} };
    case "bet": return { bet: [bn(d.amount)] };
    case "raiseTo": return { raiseTo: [bn(d.amount)] };
    default: throw new Error(`未知动作 ${d.action}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const [cmd, name, ...rest] = process.argv.slice(2);
const flag = (key, def) => {
  const i = rest.indexOf(`--${key}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : def;
};
try {
  if (cmd === "new") await cmdNew(name);
  else if (cmd === "register")
    await cmdRegister(name, {
      ownerPath: flag("owner"),
      payoutAgent: rest.includes("--payout-agent"),
      displayName: flag("display-name"),
    });
  else if (cmd === "fund") await cmdFund(name, Number(rest[0] ?? 0.05), Number(rest[1] ?? 25));
  else if (cmd === "sit") await cmdSit(name, Number(rest[0]), Number(rest[1]), Number(rest[2] ?? 20));
  else if (cmd === "run") await cmdRun(name, { hands: Number(flag("hands", 0)) || 0, strategy: flag("strategy"), _salts: loadSalts(name) });
  else if (cmd === "stand") await cmdStand(name);
  else if (cmd === "status") await cmdStatus(name);
  else {
    console.log(`SolPoker Agent Runner
  new      <name>                    创建 agent 密钥
  register <name> [--owner path] [--payout-agent] [--display-name 名字]
                                     注册 AgentProfile（agent+主人双签，Stage 8）
  fund     <name> [sol] [tusdc]      发测试币（默认 0.05 SOL + 25 tUSDC）
  sit      <name> <tableId> <seat> [buyIn=20]
  run      <name> [--hands N] [--strategy path.mjs]
  stand    <name>
  status   [name]`);
  }
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}
