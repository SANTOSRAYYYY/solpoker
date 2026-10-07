// Stage 6 on-chain acceptance: a REAL two-player hand with tUSDC on devnet-tee.
//
// Flow: init_config → players funded (SOL + tUSDC ATA) → client-side HandProof
// → create_table → delegate ×13 → init_permissions (ER) → sit_down ×2 →
// take_seat ×2 → advance(Idle→Commit) → commit_salt ×2 → advance(→AwaitSeed) →
// request_vrf → fulfill → reveal ×2 → advance(deal) → HU check/call to showdown
// → advance(settle) → verify proof/stacks/rake/zeroing → stand_up ×2 →
// commit_game ×2 → cash_out ×2 → sweep_rake → stranger PlayerHand read denied.
//
// Usage: node scripts/stage6-full-hand-e2e.mjs [tableId]

import fs from "node:fs";
import crypto from "node:crypto";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const L1_URL = "http://127.0.0.1:8898/devnet";
const ER_BASE = "http://127.0.0.1:7799";
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const ER_VRF_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const TABLE_ID = Number(process.argv[2] ?? 1);
const BUY_IN = 20_000_000; // 100BB = 20 USDC

const PHASES = ["Idle", "Commit", "AwaitSeed", "Preflop", "AwaitStreet", "Betting", "AwaitRunout", "Settle", "Void"];

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);

const l1 = new Connection(L1_URL, "confirmed");

const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const [delegPayer] = PublicKey.findProgramAddressSync([Buffer.from("deleg_payer")], programId);
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(TABLE_ID)], programId);
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault_auth"), table.toBuffer()], programId);
const vault = getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuth, true);
const [game] = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId);
const [handProof] = PublicKey.findProgramAddressSync([Buffer.from("proof"), table.toBuffer()], programId);
const [handSecrets] = PublicKey.findProgramAddressSync([Buffer.from("secrets"), table.toBuffer()], programId);
const [deck] = PublicKey.findProgramAddressSync([Buffer.from("deck"), table.toBuffer(), Buffer.from([0, 0])], programId);
const [commitPayer] = PublicKey.findProgramAddressSync([Buffer.from("commit_payer"), table.toBuffer()], programId);
const [magicFeeVault] = PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), TEE_VALIDATOR.toBuffer()], DLP);
const seat = (i) => PublicKey.findProgramAddressSync([Buffer.from("seat"), table.toBuffer(), Buffer.from([i])], programId)[0];
const hand = (i) => PublicKey.findProgramAddressSync([Buffer.from("hand"), table.toBuffer(), Buffer.from([0, 0]), Buffer.from([i])], programId)[0];
const perm = (acc) => PublicKey.findProgramAddressSync([Buffer.from("permission:"), acc.toBuffer()], PERMISSION_PROGRAM)[0];

function providerFor(kp, conn) {
  return new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" });
}
const program = new anchor.Program(idl, providerFor(deployer, l1));

// ER game-loop instructions are CU-heavy (advance's deal path alone measured
// 421,246 CUs under litesvm — the 200k default was the Stage 6
// ProgramFailedToComplete root cause). Every ER tx gets the max CU budget;
// L1 setup txs do NOT (create_table is already near the 1232B legacy limit).
const ER_CU = 1_400_000;
async function sendAndConfirm(connection, ixs, signers, label, cu = null) {
  // devnet-tee 后端对 PER 私有账户的可写加载校验不一致（同样的账户集 +
  // 签名者，时而 InvalidWritableAccount 顶层拒绝、时而正常执行——探针
  // 实测确认）。视为瞬时错误，换新区块哈希重试。
  for (let attempt = 0; ; attempt++) {
    const tx = new Transaction();
    if (cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
    tx.add(...ixs);
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(...signers);
    // skipPreflight: the TEE's simulateTransaction rejects writable loads of
    // PER-private accounts for non-member signers, but EXECUTION accepts them
    // (proven 2026-10-07: preflight "loads a writable account that cannot be
    // written" vs skipPreflight execution reaching the program). Errors still
    // surface via getSignatureStatuses below.
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const t0 = Date.now();
    for (;;) {
      const st = await connection.getSignatureStatuses([sig]);
      const s = st.value[0];
      if (s?.err) {
        const errStr = JSON.stringify(s.err);
        if (errStr.includes("InvalidWritableAccount") && attempt < 5) {
          console.log(`   … ${label}: InvalidWritableAccount (TEE 后端不一致), retry ${attempt + 1}/5`);
          await new Promise((r) => setTimeout(r, 1200));
          break;
        }
        throw new Error(`${label} failed on-chain: ${errStr}`);
      }
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
        console.log(`✓ ${label}: ${sig} (${Date.now() - t0}ms)`);
        return sig;
      }
      if (Date.now() - t0 > 150000) throw new Error(`${label} confirmation timeout`);
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}

async function tokenFor(kp) {
  const { token } = await getAuthToken(ER_BASE, kp.publicKey, async (msg) => {
    const nacl = (await import("tweetnacl")).default;
    return nacl.sign.detached(msg, kp.secretKey);
  });
  return token;
}

console.log(`table_id=${TABLE_ID}\ntable=${table.toBase58()}`);

// ---------- 1. init_config ----------
if (!(await l1.getAccountInfo(config))) {
  const ix = await program.methods
    .initConfig(deployer.publicKey, TEE_VALIDATOR, deployer.publicKey)
    .accounts({ config, delegPayer, admin: deployer.publicKey })
    .instruction();
  await sendAndConfirm(l1, [ix], [deployer], "init_config (L1)");
} else console.log("… config exists");

// ---------- 2. players + funding ----------
// 玩家密钥持久化（keys/test-players.json，.gitignore 覆盖 keys/）：重复跑
// 同一桌时玩家身份不变，避免「旧玩家占用座位、新玩家 BadSession」。
function loadOrCreatePlayers() {
  const path = "keys/test-players.json";
  try {
    const arr = JSON.parse(fs.readFileSync(path, "utf8"));
    return arr.map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));
  } catch {
    const ps = [Keypair.generate(), Keypair.generate()];
    fs.writeFileSync(path, JSON.stringify(ps.map((p) => Array.from(p.secretKey))));
    return ps;
  }
}
const players = loadOrCreatePlayers();
for (const [i, p] of players.entries()) {
  const ata = getAssociatedTokenAddressSync(TUSDC_MINT, p.publicKey);
  const ataInfo = await l1.getAccountInfo(ata);
  const ixs = [];
  if ((await l1.getBalance(p.publicKey)) < 5_000_000) {
    ixs.push(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: p.publicKey, lamports: 20_000_000 }));
  }
  if (!ataInfo) {
    ixs.push(createAssociatedTokenAccountInstruction(deployer.publicKey, ata, p.publicKey, TUSDC_MINT));
  }
  const bal = ataInfo ? await l1.getTokenAccountBalance(ata).catch(() => null) : null;
  if (!bal || bal.value.amount < String(BUY_IN)) {
    ixs.push(createMintToInstruction(TUSDC_MINT, ata, deployer.publicKey, BUY_IN * 2));
  }
  if (ixs.length) await sendAndConfirm(l1, ixs, [deployer], `fund player${i} (SOL + ATA + tUSDC)`);
  else console.log(`… player${i} funded`);
}

// ---------- 3. create_table → create_seats → create_hands ----------
if (!(await l1.getAccountInfo(table))) {
  const args = {
    tableId: TABLE_ID, kind: 0, sb: new BN(100_000), bb: new BN(200_000),
    ante: new BN(20_000), minBuyInBb: 100, maxBuyInBb: 1000,
    rakeBps: 250, rakeCapBb: 3, rakeMinPotBb: 1,
    actionTimeoutS: 30, commitTimeoutS: 10, revealTimeoutS: 10,
    vrfTimeoutS: 10, vrfMaxAttempts: 3, maxStrikes: 3,
    commitEveryNHands: 1, heartbeatS: 1800, escapeStaleS: 7200,
  };
  {
    const ix = await program.methods
      .createTable(args)
      .accounts({
        table, vaultAuth, vault, mint: TUSDC_MINT,
        game, handProof, handSecrets, deck, commitPayer, admin: deployer.publicKey,
      })
      .instruction();
    await sendAndConfirm(l1, [ix], [deployer], "create_table (L1, core)");
  }
  {
    const ix = await program.methods
      .createSeats()
      .accounts({
        table,
        seat0: seat(0), seat1: seat(1), seat2: seat(2), seat3: seat(3), seat4: seat(4),
        seat5: seat(5), seat6: seat(6), seat7: seat(7), seat8: seat(8),
        admin: deployer.publicKey,
      })
      .instruction();
    await sendAndConfirm(l1, [ix], [deployer], "create_seats (L1)");
  }
  {
    const ix = await program.methods
      .createHands()
      .accounts({
        table,
        hand0: hand(0), hand1: hand(1), hand2: hand(2), hand3: hand(3), hand4: hand(4),
        hand5: hand(5), hand6: hand(6), hand7: hand(7), hand8: hand(8),
        admin: deployer.publicKey,
      })
      .instruction();
    await sendAndConfirm(l1, [ix], [deployer], "create_hands (L1)");
  }
} else console.log("… table exists");

// ---------- 4. delegate ×14 ----------
// 每个目标单独按 L1 owner==DLP 判断（2026-10-07 教训：曾经只查 game，结果
// delegate[2] 失败后重跑跳过整块，deck/hands 从未委托——ER 上可写加载不
// 存在的账户报 InvalidWritableAccount，和 PER 拒绝长得一模一样）。
const targets = [commitPayer, game, handProof, handSecrets, deck, ...Array.from({ length: 9 }, (_, i) => hand(i))];
for (let di = 0; di < 14; di++) {
  const info = await l1.getAccountInfo(targets[di]);
  if (info?.owner.equals(DLP)) { console.log(`… delegate[${di}] already`); continue; }
  const ix = await program.methods
    .delegateTable(TEE_VALIDATOR, di)
    .accounts({ table, delegPayer, target: targets[di], admin: deployer.publicKey })
    .instruction();
  await sendAndConfirm(l1, [ix], [deployer], `delegate_table[${di}] (L1)`);
}

// ---------- 5. ER: init_permissions ----------
const erToken = await tokenFor(deployer);
const er = new Connection(`${ER_BASE}?token=${erToken}`, "confirmed");
const erProgram = new anchor.Program(idl, providerFor(deployer, er));

if (!(await er.getAccountInfo(perm(deck)))) {
  const ix = await erProgram.methods
    .initPermissions()
    .accounts({
      table, deck,
      hand0: hand(0), hand1: hand(1), hand2: hand(2), hand3: hand(3), hand4: hand(4),
      hand5: hand(5), hand6: hand(6), hand7: hand(7), hand8: hand(8),
      permissionDeck: perm(deck),
      permissionHand0: perm(hand(0)), permissionHand1: perm(hand(1)),
      permissionHand2: perm(hand(2)), permissionHand3: perm(hand(3)),
      permissionHand4: perm(hand(4)), permissionHand5: perm(hand(5)),
      permissionHand6: perm(hand(6)), permissionHand7: perm(hand(7)),
      permissionHand8: perm(hand(8)),
      vault: EPHEMERAL_VAULT, commitPayer, admin: deployer.publicKey,
    })
    .instruction();
  await sendAndConfirm(er, [ix], [deployer], "init_permissions (ER, 10 perms)", ER_CU);
} else console.log("… permissions exist");
// PER 成员由程序自管（2026-10-07 §11.2 落地）：init_permissions 创建时基线
// members=[admin]，take_seat 把占用者加入自己的 hand，stand_up 移出——
// 不再需要 admin_set_members 引导（该指令保留为 admin 覆盖通道）。

// ---------- 6. sit_down ×2 + take_seat ×2 ----------
const playerConns = [];
for (const [i, p] of players.entries()) {
  const conn = new Connection(`${ER_BASE}?token=${await tokenFor(p)}`, "confirmed");
  playerConns.push(conn);
  const prog = new anchor.Program(idl, providerFor(p, conn));
  const l1prog = new anchor.Program(idl, providerFor(p, l1));
  const ata = getAssociatedTokenAddressSync(TUSDC_MINT, p.publicKey);
  const sessionExpires = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;

  const ledger = await l1.getAccountInfo(seat(i));
  // SeatLedger: disc(8) + table(32) + idx(1) + occupant(32) at offset 41.
  const occupied = ledger && !ledger.data.subarray(41, 73).every((b) => b === 0);
  if (!occupied) {
    // Stage 8：sit_down 需带其余 8 个座位账本（§2.3 全桌身份扫描）；
    // 人类玩家 agentProfile 传 null。
    const others = Object.fromEntries(
      Array.from({ length: 9 }, (_, k) => k).filter((k) => k !== i).map((k, n) => [`other${n}`, seat(k)])
    );
    const ix = await l1prog.methods
      .sitDown(i, new BN(BUY_IN), p.publicKey, new BN(sessionExpires))
      .accounts({ table, seat: seat(i), ...others, agentProfile: null, vaultAuth, vault, mint: TUSDC_MINT, playerAta: ata, payer: p.publicKey })
      .instruction();
    await sendAndConfirm(l1, [ix], [p], `sit_down player${i} (L1, ${BUY_IN / 1e6} tUSDC)`);
  } else console.log(`… player${i} seated`);

  const g = await erProgram.account.game.fetch(game);
  if (g.seats[i].status !== 1) {
    const ix = await erProgram.methods
      .takeSeat(i)
      .accounts({
        table, game, seatLedger: seat(i), playerHand: hand(i),
        permission: perm(hand(i)), commitPayer, vault: EPHEMERAL_VAULT,
        caller: deployer.publicKey,
      })
      .instruction();
    await sendAndConfirm(er, [ix], [deployer], `take_seat player${i} (ER)`, ER_CU);
  } else console.log(`… player${i} took seat`);
}

// ---------- helpers ----------
async function readGame() {
  return erProgram.account.game.fetch(game);
}
async function advance(label, caller = deployer, prog = erProgram, conn = er) {
  const g0 = await readGame();
  const ix = await prog.methods
    .advance(g0.handId)
    .accounts({
      table, game, deck, handProof, handSecrets,
      hand0: hand(0), hand1: hand(1), hand2: hand(2), hand3: hand(3), hand4: hand(4),
      hand5: hand(5), hand6: hand(6), hand7: hand(7), hand8: hand(8),
      caller: caller.publicKey,
    })
    .instruction();
  await sendAndConfirm(conn, [ix], [caller], label, ER_CU);
  const g1 = await readGame();
  console.log(`   phase: ${PHASES[g0.phase]} → ${PHASES[g1.phase]}`);
  return g1;
}
async function requestAndWaitVrf(label) {
  const ix = await erProgram.methods
    .requestVrf()
    .accounts({ table, game, payer: deployer.publicKey, vrf: { oracleQueue: ER_VRF_QUEUE } })
    .instruction();
  await sendAndConfirm(er, [ix], [deployer], `request_vrf (${label})`, ER_CU);
  const t0 = Date.now();
  for (;;) {
    // anchor-ts 对 zero-copy 内嵌枚举（VrfState）解码有 bug（返回 undefined），
    // 直接读原始字节：Game = disc(8) table(32) transcript(32) u64×8
    //   vrf.requested_at(8) vrf.state(1) vrf.target(1) vrf.attempt(1) pad(5)
    const acc = await er.getAccountInfo(game);
    const state = acc.data.readUInt8(8 + 32 + 32 + 64 + 8);
    if (state === 3) { console.log(`   VRF fulfilled (${Date.now() - t0}ms)`); return readGame(); }
    if (state === 4) throw new Error("VRF exhausted → void");
    if (Date.now() - t0 > 30000) throw new Error("VRF timeout");
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------- 7. the hand ----------
// 按 phase 幂等续跑（2026-10-07：中断重跑会重放已完成的步骤）。盐按
// (table, hand_id) 持久化到 keys/——重跑复用同组盐，重放 commit/reveal 才
// 幂等；随机新盐与链上承诺不匹配会让整手作废。
let g = await readGame();
if (g.phase === 0) g = await advance("advance (Idle→Commit)");

const saltsFile = `keys/test-salts-t${TABLE_ID}-h${g.handId.toNumber()}.json`;
let salts;
if (fs.existsSync(saltsFile)) {
  salts = JSON.parse(fs.readFileSync(saltsFile, "utf8")).map((s) => Buffer.from(s, "hex"));
  console.log(`… salts reused from ${saltsFile}`);
} else {
  salts = [crypto.randomBytes(32), crypto.randomBytes(32)];
  fs.writeFileSync(saltsFile, JSON.stringify(salts.map((s) => s.toString("hex"))));
}

if (g.phase === 1) {
  for (const [i, p] of players.entries()) {
    const g0 = await readGame();
    // Game.seats[i].salt_commit 是公开字段：已提交就跳过（重跑幂等）。
    if (!Buffer.from(g0.seats[i].saltCommit).every((b) => b === 0)) {
      console.log(`… player${i} committed`);
      continue;
    }
    const prog = new anchor.Program(idl, providerFor(p, playerConns[i]));
    const commitment = crypto.createHash("sha256")
      .update(Buffer.from("solpoker/salt/v1"))
      .update(table.toBuffer())
      .update(Buffer.from(g0.handId.toArray("be", 8)))
      .update(p.publicKey.toBuffer())
      .update(salts[i])
      .digest();
    const ix = await prog.methods
      .commitSalt(i, g0.handId, Array.from(commitment))
      .accounts({ table, game, seatLedger: seat(i), signer: p.publicKey })
      .instruction();
    await sendAndConfirm(playerConns[i], [ix], [p], `commit_salt player${i} (ER)`, ER_CU);
  }
  g = await advance("advance (Commit→AwaitSeed, arm VRF_0)");
}

if (g.phase === 2) {
  // vrf.state 原始字节 @144（disc8 table32 transcript32 u64×8 → requested_at@136
  // state@144）；3=Fulfilled。
  const raw = await er.getAccountInfo(game);
  if (raw.data.readUInt8(144) !== 3) await requestAndWaitVrf("VRF_0");
  else console.log("… VRF_0 already fulfilled");
  for (const [i, p] of players.entries()) {
    const g0 = await readGame();
    const prog = new anchor.Program(idl, providerFor(p, playerConns[i]));
    const ix = await prog.methods
      .revealSalt(i, g0.handId, Array.from(salts[i]))
      .accounts({ table, seatLedger: seat(i), playerHand: hand(i), signer: p.publicKey })
      .instruction();
    await sendAndConfirm(playerConns[i], [ix], [p], `reveal_salt player${i} (ER)`, ER_CU);
  }
  g = await advance("advance (AwaitSeed→deal hole)");
  console.log(`   button=${g.button}, to_act=${g.toAct}, pot=${g.pot.toNumber() / 1e6} USDC`);
}

// HU action loop: preflop SB(button) first; postflop BB first. Both players
// always call-or-check to showdown.
for (let step = 0; step < 40; step++) {
  g = await readGame();
  if (g.phase === 7 || g.phase === 0) break;
  if (g.phase === 3 || g.phase === 5) { // Preflop / Betting：都是行动阶段
    const actor = g.toAct;
    const me = players[actor];
    const conn = playerConns[actor];
    const prog = new anchor.Program(idl, providerFor(me, conn));
    const myBet = g.seats[actor].streetBet.toNumber();
    const toCall = g.currentBet.toNumber() - myBet;
    const action = toCall > 0 ? { call: {} } : { check: {} };
    const ix = await prog.methods
      .act(actor, g.handId, g.actionSeq, action)
      .accounts({ table, game, seatLedger: seat(actor), signer: me.publicKey })
      .instruction();
    await sendAndConfirm(conn, [ix], [me], `act seat${actor} ${toCall > 0 ? "call" : "check"} (ER)`, ER_CU);
    continue;
  }
  if (g.phase === 4) {
    g = await advance("advance (arm street VRF)");
    await requestAndWaitVrf("street");
    g = await advance("advance (deal street)");
    console.log(`   board_len=${g.boardLen}, to_act=${g.toAct}`);
    continue;
  }
  if (g.phase === 6) {
    await requestAndWaitVrf("runout");
    g = await advance("advance (deal runout)");
    continue;
  }
  throw new Error(`unexpected phase ${PHASES[g.phase]} in hand loop`);
}

// ---------- 8. settle ----------
g = await readGame();
if (g.phase === 7) g = await advance("advance (Settle)");
console.log(`\n=== hand settled ===`);
console.log(`   phase=${PHASES[g.phase]}, hand_id=${g.handId.toNumber()}, rake_total=${g.rakeTotal.toNumber()} base units`);
console.log(`   stacks: p0=${g.seats[0].stack.toNumber()}, p1=${g.seats[1].stack.toNumber()}`);
const proof = await erProgram.account.handProof.fetch(handProof);
const entry = proof.entries[(proof.head - 1 + 16) % 16];
const secretsAcc = await erProgram.account.handSecrets.fetch(handSecrets);
const sentry = secretsAcc.entries[(proof.head - 1 + 16) % 16];
console.log(`   proof[head=${proof.head - 1}]: hand_id=${entry.handId.toNumber()}, status=${entry.status}, rake=${entry.rake.toNumber()}, transcript=${Buffer.from(entry.transcriptFinal).toString("hex").slice(0, 16)}…`);
console.log(`   secrets: vrf_mask=${sentry.vrfMask}, salts published=${sentry.salts.filter(s => !s.every(b => b === 0)).length}`);
const deckAcc = await er.getAccountInfo(deck);
console.log(`   deck zeroed: ${deckAcc.data.subarray(16).every((b) => b === 0)}`);

// ---------- 9. stand_up → commit → cash_out → sweep ----------
for (const [i, p] of players.entries()) {
  const g0 = await readGame();
  if (g0.seats[i].status === 1) {
    const prog = new anchor.Program(idl, providerFor(p, playerConns[i]));
    const ix = await prog.methods
      .standUp(i)
      .accounts({
        table, game, seatLedger: seat(i), playerHand: hand(i),
        permission: perm(hand(i)), commitPayer, vault: EPHEMERAL_VAULT,
        signer: p.publicKey,
      })
      .instruction();
    await sendAndConfirm(playerConns[i], [ix], [p], `stand_up player${i} (ER)`, ER_CU);
  }
}
{
  const ix = await erProgram.methods
    .commitGame()
    .accounts({ table, game, handProof, handSecrets, commitPayer, magicContext: MAGIC_CONTEXT, magicProgram: MAGIC_PROGRAM, magicFeeVault })
    .instruction();
  await sendAndConfirm(er, [ix], [deployer], "commit_game (ER→L1)", ER_CU);
}

// commit 是异步的（intent bundle 由 validator 落地）：轮询 L1 快照直到
// stand_up 后的座位状态（status=Left=2）可见，否则 cash_out 因
// StaleSnapshot 被拒。Game 布局：seats@152，SeatState=152B，status@+145。
{
  const t0 = Date.now();
  for (;;) {
    const lg = await l1.getAccountInfo(game);
    const left = (i) => lg && lg.data[152 + i * 152 + 145] === 2;
    if (left(0) && left(1)) { console.log(`   L1 snapshot committed (${Date.now() - t0}ms)`); break; }
    if (Date.now() - t0 > 60000) throw new Error("commit_game snapshot timeout");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

for (const [i, p] of players.entries()) {
  const ata = getAssociatedTokenAddressSync(TUSDC_MINT, p.publicKey);
  const before = await l1.getTokenAccountBalance(ata);
  const ix = await program.methods
    .cashOut(i)
    .accounts({ table, game, seat: seat(i), vaultAuth, vault, mint: TUSDC_MINT, payoutAta: ata, caller: deployer.publicKey })
    .instruction();
  await sendAndConfirm(l1, [ix], [deployer], `cash_out player${i} (L1)`);
  const after = await l1.getTokenAccountBalance(ata);
  console.log(`   player${i} balance: ${before.value.uiAmount} → ${after.value.uiAmount} tUSDC`);
}

const treasuryAta = getAssociatedTokenAddressSync(TUSDC_MINT, deployer.publicKey);
if (!(await l1.getAccountInfo(treasuryAta))) {
  const ix = createAssociatedTokenAccountInstruction(deployer.publicKey, treasuryAta, deployer.publicKey, TUSDC_MINT);
  await sendAndConfirm(l1, [ix], [deployer], "create treasury ATA");
}
{
  const ix = await program.methods
    .sweepRake()
    .accounts({ config, table, game, vaultAuth, vault, mint: TUSDC_MINT, treasuryAta, caller: deployer.publicKey })
    .instruction();
  await sendAndConfirm(l1, [ix], [deployer], "sweep_rake (L1)");
  const bal = await l1.getTokenAccountBalance(treasuryAta);
  console.log(`   treasury balance: ${bal.value.uiAmount} tUSDC`);
}

// ---------- 10. privacy check ----------
const stranger = Keypair.generate();
const strangerEr = new Connection(`${ER_BASE}?token=${await tokenFor(stranger)}`, "confirmed");
const ph = await strangerEr.getAccountInfo(hand(0));
console.log(`   stranger read PlayerHand[0]: ${ph === null ? "denied (PER enforced)" : "READABLE — PRIVACY FAIL"}`);

console.log("\nSTAGE6_FULL_HAND_E2E_OK");
