// 链上读层（大厅 / Agent 页 / 历史页用）：只读，不签任何东西。
//
// 关键事实（2026-10-08 实测核对）：
// - SeatLedger（L1，未委托）203B：disc8 table@8 idx@40 occupant@41 occupancy_id@73
//   kind@81 agent_owner@82 session_key@114 expires@146 payout@154
//   deposited@186 paid@194 bump@202
// - AgentProfile（L1）211B：agent@8 owner@40 payout_kind@72 status@73
//   name[32]@74 meta_uri[96]@106 registered_at@202
// - HandProof（L1 快照）3728B：entries[16]×232B @8，head@3720
// - Game 委托后 L1 上是「最近一次 commit 的快照」（可能落后几手），
//   所以大厅标注「L1 快照」，实时对局要走 ER + TEE token（见 use-game.ts）。

import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, TABLE_IDS_FILTER } from "./config";
import { pdasFor } from "./solpoker-client";
import { decodeGame, type GameView } from "./game-state";
import { scanTables, type TableInfo } from "./tables";

const SEAT_LEDGER_SIZE = 203;
const AGENT_PROFILE_SIZE = 211;
const HAND_PROOF_SIZE = 3728;
const HAND_PROOF_ENTRY = 232;
const HAND_PROOF_ENTRIES = 16;

function readU64(d: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
  return v;
}
function readI64(d: Uint8Array, o: number): bigint {
  const v = readU64(d, o);
  return v & (1n << 63n) ? v - (1n << 64n) : v;
}
const isZero = (d: Uint8Array, a: number, b: number) => {
  for (let i = a; i < b; i++) if (d[i] !== 0) return false;
  return true;
};
const pk = (d: Uint8Array, o: number) => new PublicKey(d.slice(o, o + 32));
const pkOrNull = (d: Uint8Array, o: number) =>
  isZero(d, o, o + 32) ? null : pk(d, o);
const utf8z = (d: Uint8Array, o: number, len: number) => {
  let end = o;
  while (end < o + len && d[end] !== 0) end++;
  return new TextDecoder().decode(d.slice(o, end));
};

// ---------------------------------------------------------------- SeatLedger
export interface SeatLedgerView {
  idx: number;
  occupant: PublicKey | null;
  occupancyId: bigint;
  kind: number; // 0=Human 1=Agent
  agentOwner: PublicKey | null;
  sessionExpiresAt: bigint;
  payout: PublicKey | null;
  depositedTotal: bigint;
  paidTotal: bigint;
}

export function decodeSeatLedger(d: Uint8Array): SeatLedgerView {
  return {
    idx: d[40],
    occupant: pkOrNull(d, 41),
    occupancyId: readU64(d, 73),
    kind: d[81],
    agentOwner: pkOrNull(d, 82),
    sessionExpiresAt: readI64(d, 146),
    payout: pkOrNull(d, 154),
    depositedTotal: readU64(d, 186),
    paidTotal: readU64(d, 194),
  };
}

export async function readSeatLedgers(
  l1: Connection,
  tableId: number
): Promise<(SeatLedgerView | null)[]> {
  const p = pdasFor(tableId);
  const addrs = Array.from({ length: 9 }, (_, i) => p.seat(i));
  const infos = await l1.getMultipleAccountsInfo(addrs);
  return infos.map((acc) =>
    acc && acc.data.length >= SEAT_LEDGER_SIZE ? decodeSeatLedger(acc.data) : null
  );
}

/** 我在哪些桌有座位（一次 gPA）：memcmp occupant@41。 */
export async function findMySeats(
  l1: Connection,
  me: PublicKey
): Promise<{ tableId: number; idx: number }[]> {
  try {
    const res = await l1.getProgramAccounts(PROGRAM_ID, {
      filters: [
        { dataSize: SEAT_LEDGER_SIZE },
        { memcmp: { offset: 41, bytes: me.toBase58() } },
      ],
      dataSlice: { offset: 0, length: 48 }, // table@8 + idx@40
    });
    const out: { tableId: number; idx: number }[] = [];
    for (const { account } of res) {
      const table = pk(account.data, 8);
      const idx = account.data[40];
      const tableId = await tableIdOf(l1, table);
      if (tableId !== null) out.push({ tableId, idx });
    }
    return out;
  } catch {
    return [];
  }
}

/** 我的 agent 在哪些桌有座位（一次 gPA）：memcmp agent_owner@82。 */
export async function findAgentSeats(
  l1: Connection,
  owner: PublicKey
): Promise<{ tableId: number; idx: number; agent: PublicKey }[]> {
  try {
    const res = await l1.getProgramAccounts(PROGRAM_ID, {
      filters: [
        { dataSize: SEAT_LEDGER_SIZE },
        { memcmp: { offset: 82, bytes: owner.toBase58() } },
      ],
      dataSlice: { offset: 0, length: 114 }, // table@8 + idx@40 + occupant@41
    });
    const out: { tableId: number; idx: number; agent: PublicKey }[] = [];
    for (const { account } of res) {
      const tableId = await tableIdOf(l1, pk(account.data, 8));
      if (tableId !== null) {
        out.push({ tableId, idx: account.data[40], agent: pk(account.data, 41) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** table_id 存在账户里（u32@8），直接读回来即可（不必反推 PDA）。 */
async function tableIdOf(l1: Connection, table: PublicKey): Promise<number | null> {
  try {
    const acc = await l1.getAccountInfo(table);
    if (!acc || acc.data.length < 12) return null;
    const d = acc.data;
    return d[8] | (d[9] << 8) | (d[10] << 16) | (d[11] << 24);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- Game
/**
 * L1 上的 Game 快照（= 最近一次 commit）。委托期间 owner 是 DLP，data 仍可读。
 * 注意：快照几乎总是 Idle（commit 只在 pot=0 时发生），要看实时状态用 readGameLive。
 */
export async function readGameSnapshot(
  l1: Connection,
  tableId: number
): Promise<GameView | null> {
  try {
    const acc = await l1.getAccountInfo(pdasFor(tableId).game);
    if (!acc || acc.data.length < 1552) return null;
    return decodeGame(acc.data);
  } catch {
    return null;
  }
}

/**
 * 实时 Game 状态：ER 公开账户**无需 TEE token** 即可读（2026-10-08 实测：
 * game 账户 tokenless 200，PER 私有的 PlayerHand 无 token 返回 null）。
 * ER 失败时回落到 L1 快照。
 */
export async function readGameLive(
  er: Connection,
  l1: Connection,
  tableId: number
): Promise<{ game: GameView; source: "er" | "l1" } | null> {
  try {
    const acc = await er.getAccountInfo(pdasFor(tableId).game);
    if (acc && acc.data.length >= 1552) {
      return { game: decodeGame(acc.data), source: "er" };
    }
  } catch {
    /* 回落 L1 */
  }
  const snap = await readGameSnapshot(l1, tableId);
  return snap ? { game: snap, source: "l1" } : null;
}

// --------------------------------------------------------------- AgentProfiles
export interface AgentProfileView {
  pubkey: PublicKey;
  agent: PublicKey;
  owner: PublicKey;
  payoutKind: number; // 0=owner(默认) 1=agent
  status: number; // 0=Active 1=Paused 2=Revoked 3=Banned
  name: string;
  metaUri: string;
  registeredAt: bigint;
}

export function decodeAgentProfile(pubkey: PublicKey, d: Uint8Array): AgentProfileView {
  return {
    pubkey,
    agent: pk(d, 8),
    owner: pk(d, 40),
    payoutKind: d[72],
    status: d[73],
    name: utf8z(d, 74, 32),
    metaUri: utf8z(d, 106, 96),
    registeredAt: readI64(d, 202),
  };
}

export const AGENT_STATUS = ["Active", "Paused", "Revoked", "Banned"] as const;

export async function readAgentProfiles(
  l1: Connection,
  owner?: PublicKey
): Promise<AgentProfileView[]> {
  const filters: Array<
    { dataSize: number } | { memcmp: { offset: number; bytes: string } }
  > = owner
    ? [
        { dataSize: AGENT_PROFILE_SIZE },
        { memcmp: { offset: 40, bytes: owner.toBase58() } },
      ]
    : [{ dataSize: AGENT_PROFILE_SIZE }];
  try {
    const res = await l1.getProgramAccounts(PROGRAM_ID, { filters });
    return res
      .filter((r) => r.account.data.length === AGENT_PROFILE_SIZE)
      .map((r) => decodeAgentProfile(r.pubkey, r.account.data))
      .sort((a, b) => Number(a.registeredAt - b.registeredAt));
  } catch {
    return [];
  }
}

// --------------------------------------------------------------- Table 汇总
export interface TableLive {
  info: TableInfo;
  game: GameView | null;
  /** 游戏状态来源：er=实时（公开账户，无需 token）/ l1=最近 commit 快照 */
  source: "er" | "l1" | null;
  seats: (SeatLedgerView | null)[];
  /** 真正在座（Game.status === 1）；无游戏状态时退化为「账本有人」 */
  seated: number;
  /** 账本还有人但已离座/空座 = 待兑现（僵尸态），需要 cash_out */
  pendingPayout: number;
  agentSeated: number;
  /** 有手牌在推进（Commit..Settle 之间） */
  live: boolean;
}

export async function readTablesLive(
  er: Connection,
  l1: Connection
): Promise<TableLive[]> {
  const infos = await scanTables(l1);
  const out: TableLive[] = [];
  for (const info of infos) {
    const [seats, live] = await Promise.all([
      readSeatLedgers(l1, info.id).catch(() => [] as (SeatLedgerView | null)[]),
      readGameLive(er, l1, info.id).catch(() => null),
    ]);
    const game = live?.game ?? null;
    let seated = 0;
    let pendingPayout = 0;
    let agentSeated = 0;
    for (let i = 0; i < 9; i++) {
      const led = seats[i];
      if (!led?.occupant) continue;
      const status = game ? game.seats[i].status : 1;
      if (status === 1) {
        seated++;
        if (led.kind === 1) agentSeated++;
      } else {
        pendingPayout++;
      }
    }
    out.push({
      info,
      game,
      source: live?.source ?? null,
      seats,
      seated,
      pendingPayout,
      agentSeated,
      live:
        game !== null && game.handId > 0n && game.phase !== 0 && game.phase !== 8,
    });
  }
  return out;
}

// --------------------------------------------------------------- HandProof
export interface ProofEntryView {
  handId: bigint;
  rake: bigint;
  settledAt: bigint;
  deltas: bigint[];
  occupancyIds: bigint[];
  transcriptFinal: Uint8Array;
  hole: [number, number][]; // 每座两张牌（0xFF = 未亮）
  handMask: number;
  board: number[];
  status: number; // 0=Settled 1=Void
  button: number;
}

export interface HandProofView {
  entries: (ProofEntryView | null)[];
  head: number;
}

export function decodeHandProof(d: Uint8Array): HandProofView {
  const entries: (ProofEntryView | null)[] = [];
  let head = 0;
  if (d.length >= HAND_PROOF_SIZE) head = d[8 + HAND_PROOF_ENTRIES * HAND_PROOF_ENTRY];
  for (let i = 0; i < HAND_PROOF_ENTRIES; i++) {
    const b = 8 + i * HAND_PROOF_ENTRY;
    const handId = readU64(d, b);
    if (handId === 0n && readU64(d, b + 8) === 0n) {
      entries.push(null);
      continue;
    }
    entries.push({
      handId,
      rake: readU64(d, b + 8),
      settledAt: readI64(d, b + 16),
      occupancyIds: Array.from({ length: 9 }, (_, k) => readU64(d, b + 24 + k * 8)),
      deltas: Array.from({ length: 9 }, (_, k) => readI64(d, b + 96 + k * 8)),
      transcriptFinal: d.slice(b + 168, b + 200),
      hole: Array.from({ length: 9 }, (_, k) => [
        d[b + 200 + k * 2],
        d[b + 201 + k * 2],
      ]) as [number, number][],
      handMask: d[b + 218] | (d[b + 219] << 8),
      board: Array.from(d.slice(b + 220, b + 225)),
      status: d[b + 225],
      button: d[b + 226],
    });
  }
  return { entries, head };
}

export async function readHandProof(
  l1: Connection,
  tableId: number
): Promise<HandProofView | null> {
  try {
    const acc = await l1.getAccountInfo(pdasFor(tableId).handProof);
    if (!acc || acc.data.length < HAND_PROOF_SIZE) return null;
    return decodeHandProof(acc.data);
  } catch {
    return null;
  }
}

/** 读 HandProof：委托账户 → 优先 ER（实时），回落 L1（commit 后的快照）。 */
export async function readHandProofLive(
  er: Connection,
  l1: Connection,
  tableId: number
): Promise<HandProofView | null> {
  try {
    const acc = await er.getAccountInfo(pdasFor(tableId).handProof);
    if (acc && acc.data.length >= HAND_PROOF_SIZE) return decodeHandProof(acc.data);
  } catch {
    /* 回落 L1 */
  }
  return readHandProof(l1, tableId);
}

// --------------------------------------------------------------- HandSecrets
export interface SecretsEntryView {
  salts: Uint8Array[]; // 9 × 32
  vrfOut: Uint8Array[]; // 5 × 32
  vrfMask: number;
}

const SECRETS_ENTRY = 456;
const SECRETS_ENTRIES = 16;

export function decodeHandSecrets(d: Uint8Array): (SecretsEntryView | null)[] {
  const out: (SecretsEntryView | null)[] = [];
  for (let i = 0; i < SECRETS_ENTRIES; i++) {
    const b = 8 + i * SECRETS_ENTRY;
    if (b + SECRETS_ENTRY > d.length) {
      out.push(null);
      continue;
    }
    const salts = Array.from({ length: 9 }, (_, k) =>
      d.slice(b + k * 32, b + k * 32 + 32)
    );
    const vrfOut = Array.from({ length: 5 }, (_, k) =>
      d.slice(b + 288 + k * 32, b + 288 + k * 32 + 32)
    );
    out.push({ salts, vrfOut, vrfMask: d[b + 448] });
  }
  return out;
}

export async function readHandSecrets(
  l1: Connection,
  tableId: number
): Promise<(SecretsEntryView | null)[] | null> {
  try {
    const acc = await l1.getAccountInfo(pdasFor(tableId).handSecrets);
    if (!acc) return null;
    return decodeHandSecrets(acc.data);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- HandReplay
/**
 * 整手复算输入（§8.7，2026-10-08）。**委托账户**：数据写在 ER 上；
 * 目前 commit_game 还没把它一起 commit 回 L1，所以要从 ER 读
 * （公开账户免 token，实测可行）。每个 entry 504 字节，ring = 8，
 * 槽位 = hand_id % 8。空槽的判据是 hand_id/streets/status 全零 ——
 * 注意 **hand_id 0 是合法的一手**。
 */
export interface ReplayEntryView {
  handId: bigint;
  /** v1：9 个 occupant（v2 起不再存，历史条目仍有） */
  occupants: (PublicKey | null)[];
  saltDigest: Uint8Array;
  drawDigest: Uint8Array[]; // 5 × 32
  /** v2：每条街**结束**时的 transcript 锚点（§7 事件流存证；v1 条目为空） */
  streetEnd: Uint8Array[]; // 4 × 32
  /** v2：bit k = streetEnd[k] 有效 */
  streetsEnded: number;
  /** 0 = v1（occupants 版），2 = v2（street_end 版） */
  layoutVer: number;
  vrfAttemptUsed: number[];
  status: number; // 0=Settled 1=Void
  streetsUsed: number; // bit k = draw_digest[k] 有效
}

export const REPLAY_RING = 8;
const REPLAY_ENTRY = 504;

export function replayPdaFor(tableId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("replay"), pdasFor(tableId).table.toBytes()],
    PROGRAM_ID
  )[0];
}

export function decodeHandReplay(d: Uint8Array): (ReplayEntryView | null)[] {
  const out: (ReplayEntryView | null)[] = [];
  for (let i = 0; i < REPLAY_RING; i++) {
    const b = 8 + i * REPLAY_ENTRY;
    if (b + REPLAY_ENTRY > d.length) {
      out.push(null);
      continue;
    }
    const handId = readU64(d, b);
    const status = d[b + 493];
    const streetsUsed = d[b + 494];
    if (handId === 0n && status === 0 && streetsUsed === 0) {
      out.push(null); // 空槽
      continue;
    }
    out.push({
      handId,
      // v1：occupants 在 b+8..b+296；v2：这一段是 street_end[4] + mask + 填充。
      // 两者靠尾部的 layout_ver（b+495）区分：0 = v1，2 = v2。
      occupants:
        d[b + 495] === 2
          ? []
          : Array.from({ length: 9 }, (_, s) =>
              isZero(d, b + 8 + s * 32, b + 8 + s * 32 + 32)
                ? null
                : pk(d, b + 8 + s * 32)
            ),
      streetEnd:
        d[b + 495] === 2
          ? Array.from({ length: 4 }, (_, k) =>
              d.slice(b + 8 + k * 32, b + 8 + k * 32 + 32)
            )
          : [],
      streetsEnded: d[b + 495] === 2 ? d[b + 136] : 0,
      layoutVer: d[b + 495],
      saltDigest: d.slice(b + 296, b + 328),
      drawDigest: Array.from({ length: 5 }, (_, k) =>
        d.slice(b + 328 + k * 32, b + 328 + k * 32 + 32)
      ),
      vrfAttemptUsed: Array.from(d.slice(b + 488, b + 493)),
      status,
      streetsUsed,
    });
  }
  return out;
}

/** 读 HandReplay：优先 ER（数据实时），回落 L1（commit 后才有）。 */
export async function readHandReplay(
  er: Connection,
  l1: Connection,
  tableId: number
): Promise<{ entries: (ReplayEntryView | null)[]; source: "er" | "l1" } | null> {
  try {
    const acc = await er.getAccountInfo(replayPdaFor(tableId));
    if (acc && acc.data.length > 8) {
      return { entries: decodeHandReplay(acc.data), source: "er" };
    }
  } catch {
    /* 回落 L1 */
  }
  try {
    const acc = await l1.getAccountInfo(replayPdaFor(tableId));
    if (acc && acc.data.length > 8) {
      return { entries: decodeHandReplay(acc.data), source: "l1" };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 读 HandSecrets：委托账户 → 优先 ER，回落 L1。 */
export async function readHandSecretsLive(
  er: Connection,
  l1: Connection,
  tableId: number
): Promise<(SecretsEntryView | null)[] | null> {
  try {
    const acc = await er.getAccountInfo(pdasFor(tableId).handSecrets);
    if (acc) return decodeHandSecrets(acc.data);
  } catch {
    /* 回落 L1 */
  }
  return readHandSecrets(l1, tableId);
}

export { TABLE_IDS_FILTER };
