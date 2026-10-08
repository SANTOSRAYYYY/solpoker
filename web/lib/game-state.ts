// Raw decoders for on-chain state. anchor-ts cannot decode zero-copy nested
// enums (VrfSlot inside Game returns undefined), so Game is read by raw
// offsets — the layout is pinned in programs/solpoker/src/state.rs and in
// scripts/stage6-local-repro.mjs. Keep all three in sync.

import { PublicKey } from "@solana/web3.js";
import { MAX_SEATS, PHASES } from "./config";

// ---- Game (1552B, zero_copy) ----
// disc(8) table(32) transcript(32) hand_id(72) pot(80) current_bet(88)
// last_full_raise(96) action_deadline(104) phase_deadline(112) rake_total(120)
// last_commit_at(128) vrf.requested_at(136) vrf.state(144) vrf.target(145)
// vrf.attempt(146) pad(147..152) seats[9]@152 (152B each) action_seq@1520
// occupied@1524 hand@1526 live@1528 actionable@1530 pending@1532 board@1534
// board_src@1539 phase@1544 street@1545 button@1546 button_init@1547
// board_len@1548 to_act@1549 hands_since_commit@1550 maintenance@1551
export interface SeatView {
  occupant: PublicKey;
  saltCommit: Uint8Array;
  occupancyId: bigint;
  stack: bigint;
  /** 已释放、等待 L1 兑付的累计（只增；与 L1 账本 paid_total 相减即待兑现额） */
  owedTotal: bigint;
  inHand: bigint;
  streetBet: bigint;
  kind: number;
  status: number; // 0=Empty 1=Seated 2=Left
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  strikes: number;
  leaveRequested: boolean;
}

export interface GameView {
  table: PublicKey;
  transcript: Uint8Array;
  handId: bigint;
  pot: bigint;
  currentBet: bigint;
  lastFullRaise: bigint;
  actionDeadline: bigint;
  rakeTotal: bigint;
  vrfState: number;
  vrfTarget: number;
  vrfAttempt: number;
  seats: SeatView[];
  actionSeq: number;
  occupiedMask: number;
  handMask: number;
  liveMask: number;
  actionableMask: number;
  pendingMask: number;
  board: number[];
  boardSrc: number[];
  phase: number;
  street: number;
  button: number;
  boardLen: number;
  toAct: number;
}

const SEAT_SIZE = 152;
const SEATS_OFF = 152;

export function decodeGame(data: Uint8Array): GameView {
  const u64 = (o: number) => {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[o + i]);
    return v;
  };
  const i64 = (o: number) => {
    const v = u64(o);
    return v & (1n << 63n) ? v - (1n << 64n) : v;
  };
  const u16 = (o: number) => data[o] | (data[o + 1] << 8);
  const u32 = (o: number) =>
    (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)) >>> 0;

  const seats: SeatView[] = [];
  for (let i = 0; i < MAX_SEATS; i++) {
    const o = SEATS_OFF + i * SEAT_SIZE;
    seats.push({
      occupant: new PublicKey(data.slice(o, o + 32)),
      saltCommit: data.slice(o + 32, o + 64),
      occupancyId: u64(o + 96),
      stack: u64(o + 104),
      owedTotal: u64(o + 120),
      inHand: u64(o + 128),
      streetBet: u64(o + 136),
      kind: data[o + 144],
      status: data[o + 145],
      folded: data[o + 146] !== 0,
      allIn: data[o + 147] !== 0,
      acted: data[o + 148] !== 0,
      strikes: data[o + 149],
      leaveRequested: data[o + 150] !== 0,
    });
  }
  return {
    table: new PublicKey(data.slice(8, 40)),
    transcript: data.slice(40, 72),
    handId: u64(72),
    pot: u64(80),
    currentBet: u64(88),
    lastFullRaise: u64(96),
    actionDeadline: i64(104),
    rakeTotal: u64(120),
    vrfState: data[144],
    vrfTarget: data[145],
    vrfAttempt: data[146],
    seats,
    actionSeq: u32(1520),
    occupiedMask: u16(1524),
    handMask: u16(1526),
    liveMask: u16(1528),
    actionableMask: u16(1530),
    pendingMask: u16(1532),
    board: Array.from(data.slice(1534, 1539)),
    boardSrc: Array.from(data.slice(1539, 1544)),
    phase: data[1544],
    street: data[1545],
    button: data[1546],
    boardLen: data[1548],
    toAct: data[1549],
  };
}

export function phaseName(phase: number): string {
  return PHASES[phase] ?? `#${phase}`;
}

// ---- PlayerHand (58B, borsh) ----
// disc(8) hand_id(8..16 LE) cards(16..18) salt(18..50) salt_hand_id(50..58)
export interface HandView {
  handId: bigint;
  cards: number[];
  saltHandId: bigint;
}

export function decodePlayerHand(data: Uint8Array): HandView {
  const u64 = (o: number) => {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[o + i]);
    return v;
  };
  return {
    handId: u64(8),
    cards: [data[16], data[17]],
    saltHandId: u64(50),
  };
}

// ---- cards ----
// card = rank * 4 + suit; rank 0..12 = 2..A; suit 0=♠ 1=♥ 2=♦ 3=♣; 0xFF = 无牌
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["♠", "♥", "♦", "♣"];

export function cardText(card: number): string {
  if (card >= 52) return "🂠";
  return `${RANKS[card >> 2]}${SUITS[card & 3]}`;
}

export function cardColor(card: number): string {
  if (card >= 52) return "#666";
  const s = card & 3;
  return s === 1 || s === 2 ? "#ff6b6b" : "#e8e8e8";
}

// ---- amounts: base units (6 decimals), CENT = 10_000 ----
export function fmtUsdc(base: bigint): string {
  const neg = base < 0n;
  const v = neg ? -base : base;
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export const isZero32 = (b: Uint8Array) => b.every((x) => x === 0);
