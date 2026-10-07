// deal-verify.mjs 的类型声明（实现是纯 ESM，浏览器与 Node 共用一份）。

export interface Crypto {
  sha256(...parts: Uint8Array[]): Promise<Uint8Array>;
  hmacSha256(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array>;
}

export const webCrypto: Crypto;
export function nodeCrypto(): Promise<Crypto>;

export function cat(...parts: Uint8Array[]): Uint8Array;
export function u8(x: number): Uint8Array;
export function u16(x: number): Uint8Array;
export function u64(x: number | bigint): Uint8Array;
export function i64(x: number | bigint): Uint8Array;
export function hex(b: Uint8Array): string;
export function unhex(s: string): Uint8Array;

export function newDeck(): number[];
export function cardId(rank: number, suit: number): number;
export function popcount(mask: number): number;
export function setBits(mask: number): number[];
export function nextClockwise(seat: number, mask: number): number;

export function saltCommitment(
  crypto: Crypto,
  table: Uint8Array,
  handId: number | bigint,
  player: Uint8Array,
  salt: Uint8Array
): Promise<Uint8Array>;
export function saltDigest(
  crypto: Crypto,
  table: Uint8Array,
  handId: number | bigint,
  handMask: number,
  occupants: (Uint8Array | null)[],
  occupancyIds: bigint[],
  salts: Uint8Array[]
): Promise<Uint8Array>;
export function streetSeed(
  crypto: Crypto,
  vrfK: Uint8Array,
  digest: Uint8Array
): Promise<Uint8Array>;
export function firstButton(
  crypto: Crypto,
  seed0: Uint8Array,
  table: Uint8Array,
  handId: number | bigint,
  handMask: number
): Promise<number>;

export interface DealEvent {
  type: string;
  [k: string]: unknown;
}
export function encodeEvent(ev: DealEvent): Uint8Array;
export function transcriptInit(
  crypto: Crypto,
  programId: Uint8Array,
  table: Uint8Array,
  handId: number | bigint
): Promise<Uint8Array>;
export function transcriptAppend(
  crypto: Crypto,
  transcript: Uint8Array,
  eventBytes: Uint8Array
): Promise<Uint8Array>;

export interface DrawRecord {
  draw_no: number;
  retry: number;
  card: number;
}
export function drawCard(
  crypto: Crypto,
  seedK: Uint8Array,
  table: Uint8Array,
  handId: number | bigint,
  drawNo: number,
  transcriptDigest: Uint8Array,
  deck: number[],
  forceRejections?: number
): Promise<{ card: number; retry: number }>;

export interface DealInputs {
  program_id: string;
  table: string;
  hand_id: number | string;
  hand_mask: number;
  button_initialized: boolean;
  prev_button: number | null;
  occupants: (string | null)[];
  occupancy_ids: (number | string)[];
  stacks: (number | string)[];
  salts: Record<string, string>;
  vrf_outputs: Record<string, string>;
  forced: { seat: number; kind: number; amount: number | string }[];
  script: ({ type: "street"; street: number } | { type: "runout" })[];
  force_retry?: number[];
}

export interface DealResult {
  salt_commitments: Record<string, string>;
  salt_digest: string;
  seed_preflop: string;
  seed_flop: string;
  seed_turn: string;
  seed_river: string;
  seed_runout: string;
  button: number;
  hole: Record<string, number[]>;
  board: number[];
  board_src: number[];
  transcript_final: string;
  draws: DrawRecord[];
}

export function dealHand(crypto: Crypto, inputs: DealInputs): Promise<DealResult>;
export interface ReplayVerifyInput {
  table: string; // hex32
  handId: string | number | bigint;
  handMask: number;
  button: number;
  occupancyIds: (string | number | bigint)[];
  occupants: (string | null)[]; // hex32 或 null
  saltDigest: string; // hex32（链上 replay entry）
  drawDigest: string[]; // 5 × hex32
  streetsUsed: number;
  vrfOut: string[]; // 5 × hex32（HandSecrets）
  salts: string[]; // 9 × hex32（HandSecrets）
  board: number[];
  hole: number[][];
}

export interface ReplayVerifyResult {
  ok: boolean;
  draws: { card: number; expected: number; street: number; seat?: number }[];
  diffs: string[];
}

export function dealFromReplay(
  crypto: Crypto,
  v: ReplayVerifyInput
): Promise<ReplayVerifyResult>;
export function holeOrderOf(button: number, handMask: number): number[];

export interface ActionStreamEvent {
  seq?: number;
  /** 0 = 主动行动（Action）1 = 超时自动（Timeout） */
  tag: number;
  seat: number;
  /** Action: 0..5（fold/check/call/bet/raise/allin）；Timeout: 0=fold 1=check */
  kind: number;
  amount: number | bigint;
}

export interface ActionStreamInput {
  table: string;
  handId: string | number | bigint;
  handMask: number;
  button: number;
  saltDigest: string;
  drawDigest: string[];
  streetEnd: string[]; // 4 × hex32
  streetsUsed: number;
  vrfOut: string[];
  vrfAttemptUsed: number[];
  events: ActionStreamEvent[];
  /** HandEnd 复算需要：deltas（proof 的 9 个）与 rake */
  deltas?: (string | number | bigint)[];
  rake?: string | number | bigint;
  transcriptFinal?: string;
}

export function verifyActionStream(
  crypto: Crypto,
  v: ActionStreamInput
): Promise<{
  ok: boolean;
  perStreet: { street: number; actions: number; closed: boolean }[];
  diffs: string[];
  consumed: number;
}>;

export function verifyVector(
  crypto: Crypto,
  vector: { name?: string; inputs: DealInputs; expected: Record<string, unknown> }
): Promise<{ diffs: string[]; got: DealResult; want: Record<string, unknown> }>;
