// 7 选 5 牌力评估器（JS 移植版，对照 crates/solpoker-core/src/eval.rs）。
// 语义与 Rust 版逐条一致：类别优先、kicker 降序、花色不参与比较（同 rank
// 严格相等）、轮顺 A2345 高牌为 5(rank 3)、皇家同花顺归同花顺。
// 用于 agent 策略；摊牌结算仍以链上 Rust 实现为准（此移植只作决策参考）。

const RANK_CHARS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUIT_CHARS = ["c", "d", "h", "s"];

export const CATEGORY_ZH = [
  "高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺",
];

export const cardRank = (c) => c >> 2;
export const cardSuit = (c) => c & 3;

export function cardStr(card) {
  if (card >= 52) return "??";
  return RANK_CHARS[cardRank(card)] + SUIT_CHARS[cardSuit(card)];
}

export function cardsStr(cards) {
  return cards.map(cardStr).join(" ");
}

// 轮顺（A-2-3-4-5）的 rank 位掩码：A(12) + 5..2(3..0)。
const WHEEL_MASK = (1 << 12) | (1 << 3) | (1 << 2) | (1 << 1) | 1;

function straightHigh(bits) {
  for (let high = 12; high >= 4; high--) {
    if (((bits >> (high - 4)) & 0b11111) === 0b11111) return high;
  }
  if ((bits & WHEEL_MASK) === WHEEL_MASK) return 3;
  return -1;
}

/** 恰好 5 张牌的牌力：{ category: 0..8, kickers: [数5] }。 */
export function evaluate5(cards) {
  const count = new Array(13).fill(0);
  let bits = 0;
  for (const c of cards) {
    const r = cardRank(c);
    count[r]++;
    bits |= 1 << r;
  }
  const suit0 = cardSuit(cards[0]);
  const flush = cards.every((c) => cardSuit(c) === suit0);
  const straight = straightHigh(bits);

  const kickers = [0, 0, 0, 0, 0];
  if (straight >= 0) {
    kickers[0] = straight;
    return { category: flush ? 8 : 4, kickers };
  }

  const groups = [];
  for (let r = 12; r >= 0; r--) {
    if (count[r] > 0) groups.push([count[r], r]);
  }
  groups.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (let i = 0; i < groups.length; i++) kickers[i] = groups[i][1];

  let category;
  const top = groups[0][0];
  if (top === 4) category = 7;
  else if (top === 3 && groups.length === 2) category = 6;
  else if (top === 3) category = 3;
  else if (top === 2 && groups.length === 3) category = 2;
  else if (top === 2) category = 1;
  else category = flush ? 5 : 0;
  return { category, kickers };
}

/** 比较两个 HandRank：>0 表示 a 强。 */
export function cmpRank(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < 5; i++) {
    if (a.kickers[i] !== b.kickers[i]) return a.kickers[i] - b.kickers[i];
  }
  return 0;
}

function combos5(n) {
  const out = [];
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) out.push([a, b, c, d, e]);
  return out;
}

/** 5..7 张牌取最优 5 张的牌力（2..4 张不适用，调用方须先补足）。 */
export function evaluateBest(cards) {
  if (cards.length < 5) {
    throw new Error(`evaluateBest 需要 ≥5 张牌，收到 ${cards.length}`);
  }
  let best = null;
  for (const idx of combos5(cards.length)) {
    const r = evaluate5(idx.map((i) => cards[i]));
    if (!best || cmpRank(r, best) > 0) best = r;
  }
  return best;
}

export function rankText(rank) {
  const n = [5, 5, 5, 5, 1, 5, 2, 2, 1][rank.category];
  const ks = rank.kickers
    .slice(0, n)
    .map((k) => RANK_CHARS[k])
    .join(" ");
  return `${CATEGORY_ZH[rank.category]}(${ks})`;
}

// ---------------------------------------------------------------------------
// 自测（node scripts/agent/eval.mjs --test）：对拍 Rust 测试里的关键语义。
// ---------------------------------------------------------------------------
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--test")) {
  const s = (txt) => {
    const map = { "2": 0, "3": 1, "4": 2, "5": 3, "6": 4, "7": 5, "8": 6, "9": 7, T: 8, J: 9, Q: 10, K: 11, A: 12 };
    const su = { c: 0, d: 1, h: 2, s: 3 };
    return txt.split(/\s+/).map((t) => map[t[0]] * 4 + su[t[1]]);
  };
  let pass = 0;
  const eq = (name, got, want) => {
    if (got === want) { pass++; return; }
    console.error(`FAIL ${name}: got ${got}, want ${want}`);
    process.exitCode = 1;
  };

  // 轮顺 A2345 高牌为 5，小于 6-high 顺子
  const wheel = evaluateBest(s("Ah 2c 3d 4s 5h"));
  eq("wheel category", wheel.category, 4);
  eq("wheel high", wheel.kickers[0], 3);
  const sixHigh = evaluateBest(s("2c 3d 4s 5h 6c"));
  eq("sixHigh > wheel", cmpRank(sixHigh, wheel) > 0, true);

  // 皇家同花顺 = 同花顺（A 高）
  const royal = evaluateBest(s("As Ks Qs Js Ts 2c 3d"));
  eq("royal category", royal.category, 8);
  eq("royal high", royal.kickers[0], 12);

  // 同花 vs 顺子：同花更大
  const flush = evaluateBest(s("As 9s 7s 4s 2s Kd Qh"));
  const straight = evaluateBest(s("9c 8d 7h 6s 5c 2d 3h"));
  eq("flush > straight", cmpRank(flush, straight) > 0, true);

  // 花色不参与：同 rank 不同 suit 严格相等
  const a = evaluateBest(s("As Kd Qc Jh 9s 3d 2c"));
  const b = evaluateBest(s("Ah Kc Qd Js 9h 3c 2d"));
  eq("suit-blind tie", cmpRank(a, b), 0);

  // kicker：一对 A + K kicker 胜一对 A + Q kicker
  const kk = evaluateBest(s("As Ad Kc 5h 3s 9d 2c"));
  const qq = evaluateBest(s("As Ad Qc 5h 3s 9d 2c"));
  eq("kicker compare", cmpRank(kk, qq) > 0, true);

  // 葫芦 vs 同花
  const full = evaluateBest(s("9c 9d 9h 5s 5c 2d 3h"));
  eq("fullhouse > flush", cmpRank(full, flush) > 0, true);

  console.log(`eval.mjs self-test: ${pass} passed${process.exitCode ? ", WITH FAILURES" : ""}`);
}
