// SolPoker Agent 共享客户端层：连接/解码/指令构建/档案持久化。
// 由 CLI runner（agent.mjs）与 MCP 服务（mcp-server.mjs）共用。
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

// L1/ER 端点统一从 scripts/env.mjs 取：L1_URL > web/.env.local 的 Helius > MagicBlock 路由。
// 本地栈请显式 set L1_URL/ER_BASE（见 scripts/env.mjs 顶部说明）。
import { L1_RPC, ER_BASE_URL } from "../env.mjs";
export const L1_URL = L1_RPC;
export const ER_BASE = ER_BASE_URL;
export const ER_CU = 1_400_000;
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
export const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
export const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
export const CENT = 10000n;

export const IDL = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
export const PROGRAM_ID = new PublicKey(IDL.address);

export const fetchWithTimeout = (input, init = {}) =>
  fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(20000) });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- PDAs ----------
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const tablePda = (id) => pda([Buffer.from("table"), u32le(id)]);
export const gamePda = (t) => pda([Buffer.from("game"), t.toBuffer()]);
export const vaultAuthPda = (t) => pda([Buffer.from("vault_auth"), t.toBuffer()]);
export const seatPda = (t, i) => pda([Buffer.from("seat"), t.toBuffer(), Buffer.from([i])]);
export const handPda = (t, i) => pda([Buffer.from("hand"), t.toBuffer(), Buffer.from([0, 0]), Buffer.from([i])]);
export const commitPayerPda = (t) => pda([Buffer.from("commit_payer"), t.toBuffer()]);
export const proofPda = (t) => pda([Buffer.from("proof"), t.toBuffer()]);
export const secretsPda = (t) => pda([Buffer.from("secrets"), t.toBuffer()]);
export const profilePda = (agent) => pda([Buffer.from("agent"), agent.toBuffer()]);
export const permPda = (acc) =>
  PublicKey.findProgramAddressSync([Buffer.from("permission:"), acc.toBuffer()], PERMISSION_PROGRAM)[0];

// ---------- connections ----------
export function l1Connection() {
  return new Connection(L1_URL, { commitment: "confirmed", fetch: fetchWithTimeout });
}
export async function erConnection(agent) {
  const nacl = (await import("tweetnacl")).default;
  const { token } = await getAuthToken(ER_BASE, agent.keypair.publicKey, async (msg) =>
    nacl.sign.detached(msg, agent.keypair.secretKey)
  );
  return new Connection(`${ER_BASE}?token=${token}`, { commitment: "confirmed", fetch: fetchWithTimeout });
}
export function programFor(conn, keypair) {
  return new anchor.Program(IDL, new anchor.AnchorProvider(conn, new anchor.Wallet(keypair), { commitment: "confirmed" }));
}

// ---------- tx ----------
export async function sendAndConfirm(conn, ixs, signers, label, cu = null) {
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
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return sig.toString();
      if (Date.now() - t0 > 90000) throw new Error(`${label}: confirmation timeout`);
      await sleep(700);
    }
  }
}

// ---------- decoders ----------
export function decodeGame(data) {
  const u64 = (o) => data.readBigUInt64LE(o);
  const seats = [];
  for (let i = 0; i < 9; i++) {
    const o = 152 + i * 152;
    seats.push({
      occupant: new PublicKey(data.subarray(o, o + 32)).toBase58(),
      saltCommit: data.subarray(o + 32, o + 64),
      stack: u64(o + 104),
      inHand: u64(o + 128),
      streetBet: u64(o + 136),
      kind: data[o + 144],
      status: data[o + 145],
      folded: data[o + 146] !== 0,
      allIn: data[o + 147] !== 0,
      acted: data[o + 148] !== 0,
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

export function decodeTable(data) {
  return {
    tableId: data.readUInt32LE(8),
    admin: new PublicKey(data.subarray(12, 44)).toBase58(),
    kind: data[44],
    maxSeats: data[45],
    status: data[46],
    sb: data.readBigUInt64LE(79),
    bb: data.readBigUInt64LE(87),
    ante: data.readBigUInt64LE(95),
    minBuyInBb: data.readUInt16LE(103),
    maxBuyInBb: data.readUInt16LE(105),
  };
}

/** PlayerHand（borsh）：disc8 hand_id8 cards2 salt32 salt_hand_id8。 */
export function decodePlayerHand(data) {
  return {
    handId: data.readBigUInt64LE(8),
    cards: [data[16], data[17]],
    salt: data.subarray(18, 50),
    saltHandId: data.readBigUInt64LE(50),
  };
}

/** SeatLedger 关键字段（含 payout）。 */
export function decodeLedger(data) {
  return {
    occupant: new PublicKey(data.subarray(41, 73)).toBase58(),
    occupancyId: data.readBigUInt64LE(73),
    kind: data[81],
    agentOwner: new PublicKey(data.subarray(82, 114)).toBase58(),
    sessionKey: new PublicKey(data.subarray(114, 146)).toBase58(),
    payout: new PublicKey(data.subarray(154, 186)).toBase58(),
    deposited: data.readBigUInt64LE(186),
    paid: data.readBigUInt64LE(194),
  };
}

export const popcount = (x) => { let n = 0; while (x) { n += x & 1; x >>= 1; } return n; };

// ---------- agent 档案 ----------
export const AGENTS_DIR = "keys/agents";
const agentFile = (name) => path.join(AGENTS_DIR, `${name}.json`);
const saltsFile = (name) => path.join(AGENTS_DIR, `${name}.salts.json`);

export function loadAgent(name) {
  const cfg = JSON.parse(fs.readFileSync(agentFile(name), "utf8"));
  return { ...cfg, keypair: Keypair.fromSecretKey(Uint8Array.from(cfg.secretKey)) };
}
export function saveAgent(cfg) {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(agentFile(cfg.name), JSON.stringify(cfg, null, 1));
}
export function agentExists(name) {
  return fs.existsSync(agentFile(name));
}
export function loadSalts(name) {
  try { return JSON.parse(fs.readFileSync(saltsFile(name), "utf8")); } catch { return {}; }
}
export function saveSalt(name, handId, salt) {
  const all = loadSalts(name);
  all[handId.toString()] = Buffer.from(salt).toString("hex");
  const keys = Object.keys(all).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  while (keys.length > 4) delete all[keys.shift()];
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(saltsFile(name), JSON.stringify(all));
}

export function cryptoRandom32() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Buffer.from(b);
}

/** 盐承诺：sha256("solpoker/salt/v1" ‖ table ‖ hand_id(BE8) ‖ player ‖ salt)。 */
export async function saltCommitmentOf(table, handId, player, salt) {
  const crypto = await import("node:crypto");
  const handIdBe = Buffer.alloc(8);
  handIdBe.writeBigUInt64BE(handId);
  return crypto.createHash("sha256")
    .update(Buffer.from("solpoker/salt/v1"))
    .update(table.toBuffer())
    .update(handIdBe)
    .update(player.toBuffer())
    .update(salt)
    .digest();
}

// ---------- instruction builders ----------
export async function ixSitDown(program, { table, seat, agentProfile, seller }) {
  const vaultAuth = vaultAuthPda(table);
  const vault = getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuth, true);
  const others = Object.fromEntries(
    Array.from({ length: 9 }, (_, k) => k).filter((k) => k !== seat).map((k, n) => [`other${n}`, seatPda(table, k)])
  );
  const [buyInMicro, sessionExpires] = seller;
  return program.methods
    .sitDown(seat, new BN(buyInMicro), program.provider.wallet.publicKey, new BN(sessionExpires))
    .accounts({
      table, seat: seatPda(table, seat), ...others, agentProfile, vaultAuth, vault,
      mint: TUSDC_MINT,
      playerAta: getAssociatedTokenAddressSync(TUSDC_MINT, program.provider.wallet.publicKey),
      payer: program.provider.wallet.publicKey,
    })
    .instruction();
}

export async function ixCommitSalt(program, table, seat, handId, commitment, signer) {
  return program.methods
    .commitSalt(seat, new BN(handId.toString()), Array.from(commitment))
    .accounts({ table, game: gamePda(table), seatLedger: seatPda(table, seat), signer })
    .instruction();
}

export async function ixRevealSalt(program, table, seat, handId, salt, signer) {
  return program.methods
    .revealSalt(seat, new BN(handId.toString()), Array.from(salt))
    .accounts({ table, seatLedger: seatPda(table, seat), playerHand: handPda(table, seat), signer })
    .instruction();
}

export function actionArg(action, amount) {
  const bn = amount === undefined ? null : new BN(amount.toString());
  switch (action) {
    case "fold": return { fold: {} };
    case "check": return { check: {} };
    case "call": return { call: {} };
    case "allIn": return { allIn: {} };
    case "bet": return { bet: [bn] };
    case "raiseTo": return { raiseTo: [bn] };
    default: throw new Error(`未知动作 ${action}`);
  }
}

export async function ixAct(program, table, seat, handId, actionSeq, action, amount, signer) {
  return program.methods
    .act(seat, new BN(handId.toString()), actionSeq, actionArg(action, amount))
    .accounts({ table, game: gamePda(table), seatLedger: seatPda(table, seat), signer })
    .instruction();
}

export async function ixStandUp(program, table, seat, signer) {
  return program.methods
    .standUp(seat)
    .accounts({
      table, game: gamePda(table), seatLedger: seatPda(table, seat), playerHand: handPda(table, seat),
      permission: permPda(handPda(table, seat)), commitPayer: commitPayerPda(table),
      vault: EPHEMERAL_VAULT, signer,
    })
    .instruction();
}

export async function ixTopUp(program, { table, seat, amountMicro }) {
  const vaultAuth = vaultAuthPda(table);
  return program.methods
    .topUp(seat, new BN(amountMicro))
    .accounts({
      table, seat: seatPda(table, seat), vaultAuth,
      vault: getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuth, true),
      mint: TUSDC_MINT,
      playerAta: getAssociatedTokenAddressSync(TUSDC_MINT, program.provider.wallet.publicKey),
      payer: program.provider.wallet.publicKey,
    })
    .instruction();
}

export async function ixCashOut(program, table, seat, payoutAta, caller, game) {
  const vaultAuth = vaultAuthPda(table);
  return program.methods
    .cashOut(seat)
    .accounts({
      table, game, seat: seatPda(table, seat), vaultAuth,
      vault: getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuth, true),
      mint: TUSDC_MINT, payoutAta, caller,
    })
    .instruction();
}

export { anchor, BN, SystemProgram, ComputeBudgetProgram, createAssociatedTokenAccountInstruction, createMintToInstruction, getAssociatedTokenAddressSync };
