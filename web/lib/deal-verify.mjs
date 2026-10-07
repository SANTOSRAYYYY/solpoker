// 发牌协议复算器（reference/solpoker_deal.py 的 JS 移植，逐字节对齐）
//
// 单一实现，两处使用：
//   - 浏览器（验证器页面）：crypto 用 WebCrypto（async）
//   - Node（verify_hand MCP 工具 / 自测）：crypto 用 node:crypto（async 包装）
// 所以所有函数都是 async —— 顺序逻辑与参考实现一致。
//
// 移植对照（Python → 这里）：
//   salt_commitment / salt_digest / street_seed / first_button
//   encode_event（13 种事件，tag(u8) ‖ 固定宽度大端字段）
//   transcript_init / transcript_append
//   draw_card（HMAC 拒绝采样）
//   deal_hand（底牌两轮 → script 逐街/runout）
//
// 自测：node scripts/agent/deal-verify-selftest.mjs（跑 vectors/v1/*.json）

const enc = new TextEncoder();

// ---------------------------------------------------------------- 编码助手（全大端）
export function cat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
export const u8 = (x) => new Uint8Array([x & 0xff]);
export function u16(x) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, x, false);
  return b;
}
export function u64(x) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(x), false);
  return b;
}
export function i64(x) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(x), false);
  return b;
}
export const hex = (b) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const str = (s) => enc.encode(s);

// ---------------------------------------------------------------- 牌 / 位掩码
export const newDeck = () => Array.from({ length: 52 }, (_, i) => i);
export const cardId = (rank, suit) => rank * 4 + suit;
export function popcount(mask) {
  let n = 0;
  for (let i = 0; i < 9; i++) if ((mask >> i) & 1) n++;
  return n;
}
export function setBits(mask) {
  const out = [];
  for (let i = 0; i < 9; i++) if ((mask >> i) & 1) out.push(i);
  return out;
}
export function nextClockwise(seat, mask) {
  const seats = setBits(mask);
  for (const s of seats) if (s > seat) return s;
  return seats[0];
}

// ---------------------------------------------------------------- crypto 接口
/**
 * @typedef {{ sha256: (...parts: Uint8Array[]) => Promise<Uint8Array>,
 *             hmacSha256: (key: Uint8Array, msg: Uint8Array) => Promise<Uint8Array> }} Crypto
 */

/** 浏览器：WebCrypto（HMAC-SHA256 需要先 importKey，这里每次调用都建 key——次数有限，够快） */
export const webCrypto = {
  async sha256(...parts) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", cat(...parts)));
  },
  async hmacSha256(key, msg) {
    const k = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
  },
};

// Node 版 crypto 在单独文件 web/lib/deal-verify-node.mjs —— 本文件要能进浏览器包，
// 不能出现对 node:crypto 的引用（webpack 会因 UnhandledScheme 直接构建失败）。

// ---------------------------------------------------------------- 盐 / 种子
/** C_i = sha256("solpoker/salt/v1" ‖ table ‖ hand_id(u64) ‖ player ‖ salt) */
export async function saltCommitment(crypto, table, handId, player, salt) {
  return crypto.sha256(str("solpoker/salt/v1"), table, u64(handId), player, salt);
}

/** sha256("solpoker/salts/v1" ‖ table ‖ hand_id ‖ hand_mask ‖ 每座(seat|occ_id|occupant|salt)) */
export async function saltDigest(crypto, table, handId, handMask, occupants, occupancyIds, salts) {
  const parts = [str("solpoker/salts/v1"), table, u64(handId), u16(handMask)];
  for (const s of setBits(handMask)) {
    if (!occupants[s]) throw new Error(`座位 ${s} 在 hand_mask 中但 occupant 为空`);
    parts.push(u8(s), u64(occupancyIds[s]), occupants[s], salts[s]);
  }
  return crypto.sha256(...parts);
}

/** seed_k = sha256("solpoker/seed/v1" ‖ VRF_k ‖ salt_digest) */
export async function streetSeed(crypto, vrfK, digest) {
  return crypto.sha256(str("solpoker/seed/v1"), vrfK, digest);
}

/** button_pick = BE_u64(HMAC-SHA256(seed_0, "solpoker-v1/button" ‖ table ‖ hand_id)[0..8]) mod popcount */
export async function firstButton(crypto, seed0, table, handId, handMask) {
  const d = await crypto.hmacSha256(seed0, cat(str("solpoker-v1/button"), table, u64(handId)));
  let pick = 0n;
  for (let i = 0; i < 8; i++) pick = (pick << 8n) | BigInt(d[i]);
  const seats = setBits(handMask);
  return seats[Number(pick % BigInt(popcount(handMask)))];
}

// ---------------------------------------------------------------- 事件编码
export function encodeEvent(ev) {
  switch (ev.type) {
    case "HandStart":
      return cat(
        u8(0x01),
        u64(ev.hand_id),
        u8(ev.button),
        u16(ev.hand_mask),
        ...ev.stacks.map((x) => u64(x)),
        ...ev.occupancy_ids.map((x) => u64(x))
      );
    case "SaltCommitted":
      return cat(u8(0x02), u8(ev.seat), ev.commitment);
    case "VrfFulfilled":
      return cat(u8(0x03), u8(ev.target), u8(ev.attempt));
    case "ForcedBet":
      return cat(u8(0x04), u8(ev.seat), u8(ev.kind), u64(ev.amount));
    case "HoleDealt":
      return cat(u8(0x05), u8(ev.seat), u16(ev.draw_no));
    case "StreetStart":
      return cat(u8(0x06), u8(ev.street));
    case "Action":
      return cat(u8(0x07), u8(ev.seat), u8(ev.kind), u64(ev.amount));
    case "Timeout":
      return cat(u8(0x08), u8(ev.seat), u8(ev.auto_kind));
    case "BoardDealt":
      return cat(u8(0x09), u8(ev.street), u8(ev.card), u16(ev.draw_no), u8(ev.vrf_src));
    case "RunoutStarted":
      return u8(0x0a);
    case "StreetSkipped":
      return cat(u8(0x0b), u8(ev.street));
    case "HandEnd":
      return cat(u8(0x0c), u8(ev.result), ...ev.deltas.map((x) => i64(x)), u64(ev.rake));
    case "HandVoid":
      return cat(u8(0x0d), u8(ev.reason));
    default:
      throw new Error(`未知事件类型: ${ev.type}`);
  }
}

/** transcript_0 = sha256("solpoker/transcript/v1" ‖ program_id ‖ table ‖ hand_id) */
export async function transcriptInit(crypto, programId, table, handId) {
  return crypto.sha256(str("solpoker/transcript/v1"), programId, table, u64(handId));
}
/** transcript_{n+1} = sha256(transcript_n ‖ encode(event_n)) */
export async function transcriptAppend(crypto, transcript, eventBytes) {
  return crypto.sha256(transcript, eventBytes);
}

// ---------------------------------------------------------------- 抽牌
/**
 * msg = "solpoker-v1" ‖ table ‖ hand_id(u64) ‖ draw_no(u16) ‖ retry(u16) ‖ transcript_digest(32)
 * v   = BE_u64(HMAC-SHA256(key=seed_k, msg)[0..8])
 * 若 v < (2^64 mod n) 则 retry++ 重算；否则取 deck[v mod n]（就地删除）。
 */
export async function drawCard(crypto, seedK, table, handId, drawNo, transcriptDigest, deck, forceRejections = 0) {
  let retry = 0;
  const TWO64 = 1n << 64n;
  for (;;) {
    const msg = cat(str("solpoker-v1"), table, u64(handId), u16(drawNo), u16(retry), transcriptDigest);
    const d = await crypto.hmacSha256(seedK, msg);
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(d[i]);
    const n = BigInt(deck.length);
    let reject = v < TWO64 % n;
    if (retry < forceRejections) reject = true;
    if (reject) {
      retry++;
      continue;
    }
    const idx = Number(v % n);
    return { card: deck.splice(idx, 1)[0], retry };
  }
}

// ---------------------------------------------------------------- 整手发牌
/**
 * inputs（与 vectors JSON 的 inputs 同形，字符串为小写 hex）：
 *   program_id / table / hand_id / hand_mask / button_initialized / prev_button
 *   occupants[9]（hex 或 null）/ occupancy_ids[9] / stacks[9]
 *   salts{seat: hex} / vrf_outputs{"0".."4": hex}
 *   forced[{seat,kind,amount}] / script[{"type":"street","street":n}|{"type":"runout"}]
 *   force_retry[draw_no...]（测试钩子）
 */
export async function dealHand(crypto, inputs) {
  const programId = unhex(inputs.program_id);
  const table = unhex(inputs.table);
  const handId = BigInt(inputs.hand_id);
  const handMask = inputs.hand_mask;
  const occupants = inputs.occupants.map((x) => (x ? unhex(x) : null));
  const occupancyIds = inputs.occupancy_ids.map((x) => BigInt(x));
  const stacks = inputs.stacks.map((x) => BigInt(x));
  const salts = {};
  for (const [k, v] of Object.entries(inputs.salts)) salts[Number(k)] = unhex(v);
  const vrfOutputs = {};
  for (const [k, v] of Object.entries(inputs.vrf_outputs)) vrfOutputs[Number(k)] = unhex(v);
  const forceRetry = new Set((inputs.force_retry ?? []).map(Number));

  const seats = setBits(handMask);
  const n = seats.length;
  if (n < 2 || n > 9) throw new Error("hand_mask 置位数必须为 2..9");
  for (const s of seats) {
    if (!salts[s]) throw new Error(`缺少座位 ${s} 的盐`);
    if (!occupants[s]) throw new Error(`座位 ${s} 在 hand_mask 中但 occupant 为空`);
  }

  // 盐承诺 / 盐摘要 / 逐街种子
  const commitments = {};
  for (const s of seats) {
    commitments[s] = await saltCommitment(crypto, table, handId, occupants[s], salts[s]);
  }
  const digest = await saltDigest(crypto, table, handId, handMask, occupants, occupancyIds, salts);
  const seeds = {};
  for (let k = 0; k < 5; k++) {
    seeds[k] = await streetSeed(crypto, vrfOutputs[k], digest);
  }

  // 庄位
  let button;
  if (inputs.button_initialized) {
    if (inputs.prev_button === null || inputs.prev_button === undefined) {
      throw new Error("button_initialized=true 时必须给出 prev_button");
    }
    button = nextClockwise(Number(inputs.prev_button), handMask);
  } else {
    button = await firstButton(crypto, seeds[0], table, handId, handMask);
  }

  // 事件流
  let transcript = await transcriptInit(crypto, programId, table, handId);
  const emit = async (ev) => {
    transcript = await transcriptAppend(crypto, transcript, encodeEvent(ev));
  };

  await emit({
    type: "HandStart",
    hand_id: handId,
    button,
    hand_mask: handMask,
    stacks,
    occupancy_ids: occupancyIds,
  });
  for (const s of seats) await emit({ type: "SaltCommitted", seat: s, commitment: commitments[s] });
  await emit({ type: "VrfFulfilled", target: 0, attempt: 1 });
  for (const f of inputs.forced) {
    await emit({
      type: "ForcedBet",
      seat: Number(f.seat),
      kind: Number(f.kind),
      amount: BigInt(f.amount),
    });
  }
  await emit({ type: "StreetStart", street: 0 });

  // 抽牌
  const deck = newDeck();
  const draws = [];
  let drawNo = 0;
  const doDraw = async (seedK) => {
    const fr = forceRetry.has(drawNo) ? 1 : 0;
    const { card, retry } = await drawCard(
      crypto,
      seedK,
      table,
      handId,
      drawNo,
      transcript,
      deck,
      fr
    );
    const thisDrawNo = drawNo;
    draws.push({ draw_no: thisDrawNo, retry, card });
    drawNo += 1;
    return { card, retry, drawNo: thisDrawNo };
  };

  // 底牌：从 button 左侧第一位开始，顺时针两轮
  const start = (seats.indexOf(button) + 1) % n;
  const order = [...seats.slice(start), ...seats.slice(0, start)];
  const hole = {};
  for (const s of seats) hole[s] = [];
  for (let round = 0; round < 2; round++) {
    for (const s of order) {
      const { card, drawNo: dn } = await doDraw(seeds[0]);
      hole[s].push(card);
      await emit({ type: "HoleDealt", seat: s, draw_no: dn });
    }
  }

  // 公共牌：按 script 逐街 / runout
  const board = [];
  const boardSrc = [];
  const dealBoard = async (seedK, street, count, vrfSrc) => {
    for (let i = 0; i < count; i++) {
      const { card, drawNo: dn } = await doDraw(seedK);
      await emit({
        type: "BoardDealt",
        street,
        card,
        draw_no: dn,
        vrf_src: vrfSrc,
      });
      board.push(card);
      boardSrc.push(vrfSrc);
    }
  };

  for (const step of inputs.script) {
    if (step.type === "street") {
      const s = Number(step.street);
      if (![1, 2, 3].includes(s)) throw new Error("street 必须为 1..3");
      await emit({ type: "VrfFulfilled", target: s, attempt: 1 });
      await emit({ type: "StreetStart", street: s });
      await dealBoard(seeds[s], s, s === 1 ? 3 : 1, s);
    } else if (step.type === "runout") {
      await emit({ type: "RunoutStarted" });
      await emit({ type: "VrfFulfilled", target: 4, attempt: 1 });
      while (board.length < 5) {
        if (board.length < 3) await dealBoard(seeds[4], 1, 3 - board.length, 4);
        else if (board.length === 3) await dealBoard(seeds[4], 2, 1, 4);
        else await dealBoard(seeds[4], 3, 1, 4);
      }
    } else {
      throw new Error(`未知 script 步骤: ${JSON.stringify(step)}`);
    }
  }

  const out = {
    salt_commitments: Object.fromEntries(seats.map((s) => [String(s), hex(commitments[s])])),
    salt_digest: hex(digest),
    seed_preflop: hex(seeds[0]),
    seed_flop: hex(seeds[1]),
    seed_turn: hex(seeds[2]),
    seed_river: hex(seeds[3]),
    seed_runout: hex(seeds[4]),
    button,
    hole: Object.fromEntries(seats.map((s) => [String(s), hole[s]])),
    board,
    board_src: boardSrc,
    transcript_final: hex(transcript),
    draws,
  };
  return out;
}

// ---------------------------------------------------------------- 从链上 replay 复算
/**
 * 用 HandReplay（draw_digest / salt_digest / vrf_attempt_used / occupants）
 * + HandSecrets（vrf_out / salts）+ HandProof（board / hole / hand_mask / button）
 * 把一手牌**逐张**重新抽出来，并与 proof 里记录的牌比对。
 *
 * 这是规范测试 `replay_entry_rebuilds_every_drawn_card`（Rust）的 JS 对应实现：
 * 两边的抽取顺序、事件顺序、draw_no 编号必须完全一致。
 *
 * @returns {{ ok: boolean, draws: {card:number, expected:number, street:number, seat?:number}[], diffs: string[] }}
 */
export async function dealFromReplay(crypto, v) {
  const table = unhex(v.table);
  const handId = BigInt(v.handId);
  const seats = setBits(v.handMask);
  const n = seats.length;
  const diffs = [];

  // 1) salt_digest 独立复算（occupants 来自 replay，盐来自 HandSecrets）
  const occupants = v.occupants.map((x) => (x ? unhex(x) : null));
  const salts = v.salts.map((x) => unhex(x));
  const recomputedDigest = await saltDigest(
    crypto,
    table,
    handId,
    v.handMask,
    occupants,
    v.occupancyIds.map((x) => BigInt(x)),
    salts
  );
  if (hex(recomputedDigest) !== hex(unhex(v.saltDigest))) {
    diffs.push(
      `salt_digest 不一致：复算 ${hex(recomputedDigest).slice(0, 12)}… 链上 ${v.saltDigest.slice(0, 12)}…`
    );
  }

  // 2) 逐街重放
  const draws = [];
  let used = 0n; // 牌的位图：必须是 BigInt（用 Number 0 起步会在 |= 1n<<… 时混型报错）
  let drawNo = 0;
  const deckHas = (card) => (used & (1n << BigInt(card))) !== 0n;
  const take = (card) => {
    used |= 1n << BigInt(card);
  };

  // 内部：从给定街首摘要出发，抽 count 张牌（每张抽完追加对应的事件）
  const rebuild = async (seed, digestStart, count, makeEvent, label) => {
    let digest = unhex(digestStart);
    const out = [];
    for (let i = 0; i < count; i++) {
      const deck = newDeck().filter((c) => !deckHas(c));
      const { card, retry } = await drawCard(crypto, seed, table, handId, drawNo, digest, deck, 0);
      out.push({ card, retry });
      digest = await transcriptAppend(crypto, digest, encodeEvent(makeEvent(card, drawNo, retry)));
      drawNo += 1;
    }
    return out;
  };

  // --- preflop：2n 张底牌（HoleDealt），从 draw_digest[0] 出发 ---
  const has = (k) => (v.streetsUsed & (1 << k)) !== 0;
  if (!has(0)) {
    diffs.push("该手没有 preflop 摘要（作废手或发牌前结束）");
    return { ok: false, draws, diffs };
  }
  const seed = (k) => streetSeed(crypto, unhex(v.vrfOut[k]), unhex(v.saltDigest));
  const seed0 = await seed(0);
  const order = v.button >= 0 ? holeOrderOf(v.button, v.handMask) : seats;
  const holeExpected = v.hole.map((pair) =>
    pair.map((c) => (c >= 52 ? null : c))
  );
  {
    let digest = unhex(v.drawDigest[0]);
    for (let k = 0; k < 2 * n; k++) {
      const seat = order[k % n];
      const slot = Math.floor(k / n);
      const deck = newDeck().filter((c) => !deckHas(c));
      const { card } = await drawCard(crypto, seed0, table, handId, drawNo, digest, deck, 0);
      take(card);
      digest = await transcriptAppend(
        crypto,
        digest,
        encodeEvent({ type: "HoleDealt", seat, draw_no: drawNo })
      );
      drawNo += 1;
      const want = holeExpected[seat][slot];
      draws.push({ card, expected: want, street: 0, seat });
      if (want !== null && want !== card) {
        diffs.push(`底牌 座${seat}/第${slot + 1}张：复算 ${card} ≠ 链上 ${want}`);
      }
    }
  }

  // --- 公共牌：由 streets_used 推出每个板位属于哪条街（不需要链上另存 board_src）---
  // 规则：正常街 1 发 3 张、街 2/3 各 1 张；runout（k=4）覆盖剩下的所有板位。
  const normalCount =
    (has(1) ? 3 : 0) + (has(2) ? 1 : 0) + (has(3) ? 1 : 0);
  const srcOf = (pos) => {
    if (pos >= normalCount) return 4; // runout
    if (pos < 3) return 1;
    return pos === 3 ? 2 : 3;
  };
  let boardPos = 0;
  const boardExpected = v.board;
  for (const k of [1, 2, 3, 4]) {
    if (!has(k)) continue;
    let count = 0;
    for (let p = 0; p < 5; p++) if (srcOf(p) === k) count++;
    if (count === 0) continue;
    const seedK = await seed(k);
    let digest = unhex(v.drawDigest[k]);
    const startPos = boardPos;
    for (let i = 0; i < count; i++) {
      const pos = startPos + i;
      const street = pos < 3 ? 1 : pos === 3 ? 2 : 3; // 该板位实际所属街
      const deck = newDeck().filter((c) => !deckHas(c));
      const { card } = await drawCard(crypto, seedK, table, handId, drawNo, digest, deck, 0);
      take(card);
      digest = await transcriptAppend(
        crypto,
        digest,
        encodeEvent({
          type: "BoardDealt",
          street,
          card,
          draw_no: drawNo,
          vrf_src: k,
        })
      );
      drawNo += 1;
      const want = boardExpected[pos];
      draws.push({ card, expected: want, street });
      if (want !== undefined && want !== card) {
        diffs.push(`公共牌 第${pos + 1}张（街${street}）：复算 ${card} ≠ 链上 ${want}`);
      }
    }
    boardPos += count;
  }

  return { ok: diffs.length === 0, draws, diffs };
}

/** 底牌发放顺序：button 左侧第一位起，顺时针（与程序 deal::hole_order 同义）。 */
export function holeOrderOf(button, handMask) {
  const seats = setBits(handMask);
  const start = (seats.indexOf(button) + 1) % seats.length;
  return [...seats.slice(start), ...seats.slice(0, start)];
}

// ---------------------------------------------------------------- 行动流验证（§7）
/**
 * 用链下/交易日志里拿到的**规范行动事件**验证每一街：
 *   从 draw_digest[k] 出发 → 追加该街的发牌事件（由 proof 的牌确定性给出）
 *   → 逐条追加行动事件 → 当摘要等于 street_end[k] 时该街闭合，进入下一街；
 * 最后追加 HandEnd{result, deltas, rake} → 应等于 transcript_final。
 *
 * 事件来源见 web/lib/act-log.mjs（程序把规范事件 emit 成 ER 交易日志）。
 * `event_tag`：0 = 主动行动（Event::Action），1 = 超时自动（Event::Timeout）。
 */
export async function verifyActionStream(crypto, v) {
  const table = unhex(v.table);
  const handId = BigInt(v.handId);
  const seats = setBits(v.handMask);
  const n = seats.length;
  const diffs = [];
  const has = (k) => (v.streetsUsed & (1 << k)) !== 0;
  const seed = (k) => streetSeed(crypto, unhex(v.vrfOut[k]), unhex(v.saltDigest));

  // 事件列表（顺序即发生顺序）
  const evs = v.events.map((e) => ({ ...e }));
  let ei = 0;
  let used = 0n;
  let drawNo = 0;
  const take = (card) => (used |= 1n << BigInt(card));
  const deckHas = (card) => (used & (1n << BigInt(card))) !== 0n;

  const encodeActionEvent = (e) =>
    e.tag === 1
      ? encodeEvent({ type: "Timeout", seat: e.seat, auto_kind: e.kind })
      : encodeEvent({ type: "Action", seat: e.seat, kind: e.kind, amount: e.amount });

  // --- 0 号街（preflop）：底牌 + 该街行动 ---
  let digest = unhex(v.drawDigest[0]);
  if (!has(0)) {
    diffs.push("该手没有 preflop 首抽摘要，无法验证行动流");
    return { ok: false, perStreet: [], diffs, consumed: 0 };
  }
  const seed0 = await seed(0);
  const order = holeOrderOf(v.button, v.handMask);
  for (let k = 0; k < 2 * n; k++) {
    const seat = order[k % n];
    const deck = newDeck().filter((c) => !deckHas(c));
    const { card } = await drawCard(crypto, seed0, table, handId, drawNo, digest, deck, 0);
    take(card);
    digest = await transcriptAppend(
      crypto,
      digest,
      encodeEvent({ type: "HoleDealt", seat, draw_no: drawNo })
    );
    drawNo += 1;
  }
  const perStreet = [];
  {
    const before = ei;
    let closed = false;
    while (ei < evs.length) {
      digest = await transcriptAppend(crypto, digest, encodeActionEvent(evs[ei]));
      ei += 1;
      if (hex(digest) === hex(unhex(v.streetEnd[0]))) {
        closed = true;
        break;
      }
    }
    perStreet.push({ street: 0, actions: ei - before, closed });
    if (!closed) diffs.push(`街 0：追加 ${ei - before} 条行动后仍未匹配 street_end[0]`);
  }

  // --- 1..3 街 ---
  for (let k = 1; k <= 3; k++) {
    if (!has(k)) break;
    // 街头事件：VrfFulfilled(k, attempt) + StreetStart(k)（与程序发牌前追加的一致）
    const attempt = v.vrfAttemptUsed[k] || 1;
    const target = ["Preflop", "Flop", "Turn", "River", "Runout"][k];
    if (ei > evs.length) break;
    // 从上一条街的锚点继续：追加 VRF + 街头，再发牌
    let d = hex(digest) === hex(unhex(v.streetEnd[k - 1])) ? digest : digest; // 已在锚点上
    d = await transcriptAppend(crypto, d, encodeEvent({ type: "VrfFulfilled", target: k, attempt }));
    d = await transcriptAppend(crypto, d, encodeEvent({ type: "StreetStart", street: k }));
    const seedK = await seed(k);
    const count = k === 1 ? 3 : 1;
    for (let i = 0; i < count; i++) {
      const deck = newDeck().filter((c) => !deckHas(c));
      const { card } = await drawCard(crypto, seedK, table, handId, drawNo, d, deck, 0);
      take(card);
      const street = k === 1 ? 1 : k === 2 ? 2 : 3;
      d = await transcriptAppend(
        crypto,
        d,
        encodeEvent({ type: "BoardDealt", street, card, draw_no: drawNo, vrf_src: k })
      );
      drawNo += 1;
    }
    digest = d;
    const before = ei;
    let closed = false;
    while (ei < evs.length) {
      digest = await transcriptAppend(crypto, digest, encodeActionEvent(evs[ei]));
      ei += 1;
      if (hex(digest) === hex(unhex(v.streetEnd[k]))) {
        closed = true;
        break;
      }
    }
    perStreet.push({ street: k, actions: ei - before, closed });
    if (!closed) diffs.push(`街 ${k}：追加 ${ei - before} 条行动后仍未匹配 street_end[${k}]`);
  }

  // --- 收尾：HandEnd（deltas 由 proof 给出，rake 同理）→ transcript_final ---
  if (v.transcriptFinal && v.deltas) {
    const end = await transcriptAppend(
      crypto,
      digest,
      encodeEvent({ type: "HandEnd", result: 0, deltas: v.deltas.map((x) => BigInt(x)), rake: BigInt(v.rake ?? 0) })
    );
    if (hex(end) !== hex(unhex(v.transcriptFinal))) {
      diffs.push(
        `事件流 → transcript_final 不一致（复算 ${hex(end).slice(0, 12)}… 链上 ${v.transcriptFinal.slice(0, 12)}…）`
      );
    }
  }

  const leftover = evs.length - ei;
  if (leftover > 0) diffs.push(`还有 ${leftover} 条事件未被任何街消费（可能是下一手的）`);

  return { ok: diffs.length === 0, perStreet, diffs, consumed: ei };
}

// ---------------------------------------------------------------- 向量校验
/** 深层规范化：对象按 key 排序后再序列化（与参考实现比对时不受字段顺序影响）。 */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** 与 vectors/v1/*.json 的 expected 逐字段比对，返回差异列表（空 = 一致）。 */
export async function verifyVector(crypto, vector) {
  const got = await dealHand(crypto, vector.inputs);
  const want = vector.expected;
  const diffs = [];
  const cmp = (path, a, b) => {
    const ca = canon(a);
    const cb = canon(b);
    if (ca !== cb) diffs.push(`${path}: got ${ca}  want ${cb}`);
  };
  cmp("button", got.button, want.button);
  cmp("board", got.board, want.board);
  cmp("board_src", got.board_src, want.board_src);
  cmp("transcript_final", got.transcript_final, want.transcript_final);
  cmp("draws", got.draws, want.draws);
  if (want.hole !== undefined) cmp("hole", got.hole, want.hole);
  if (want.salt_digest !== undefined) cmp("salt_digest", got.salt_digest, want.salt_digest);
  if (want.salt_commitments !== undefined)
    cmp("salt_commitments", got.salt_commitments, want.salt_commitments);
  for (const k of ["seed_preflop", "seed_flop", "seed_turn", "seed_river", "seed_runout"]) {
    if (want[k] !== undefined) cmp(k, got[k], want[k]);
  }
  return { diffs, got, want };
}
