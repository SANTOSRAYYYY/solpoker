// agent 默认策略 + 策略钩子。
//
// 决策模式（设计 §5.3 的「scripted」档）：纯函数 decide(ctx) → 动作。
// ctx 由 runner 提供（全部资金量为 BigInt base units；CENT = 10000）：
//   hole        [c, c]        自家底牌
//   board       [c...]        已发公共牌（0/3/4/5 张）
//   street      0翻前 1翻牌 2转牌 3河牌
//   pot, toCall, streetBet, stack, currentBet, lastFullRaise, minRaiseTo, bb  BigInt
//   liveCount   本手仍在场的玩家数
//   rng         () => [0,1)
// 返回 { action: "fold"|"check"|"call"|"bet"|"raiseTo"|"allIn", amount?: BigInt }。
// 约定：bet/raiseTo 的 amount 是「投入后的本街总额」（与链上语义一致）。

import { cardRank, cardSuit, evaluateBest } from "./eval.mjs";

const CENT = 10000n;

const floorCent = (x) => (x / CENT) * CENT;

/** a*100 <= b*pct 的 BigInt 安全比较（避免除法）。 */
const ratioLe = (a, b, pct) => a * 100n <= b * BigInt(pct);

/** 翻前牌力分级 0..4（粗粒度、保守偏紧）。 */
function preflopScore(hole) {
  const r1 = cardRank(hole[0]);
  const r2 = cardRank(hole[1]);
  const high = Math.max(r1, r2);
  const low = Math.min(r1, r2);
  const suited = cardSuit(hole[0]) === cardSuit(hole[1]);
  if (r1 === r2) {
    if (high >= 10) return 4; // TT+
    if (high >= 6) return 3; // 66-99
    return 2; // 22-55
  }
  if (high === 12 && low >= 10) return 4; // AK/AQ
  if (high === 12 && low >= 8) return 3; // AJ/AT
  if (high >= 10 && low >= 9) return 2; // KQ/KJ/QJ
  if (suited && high - low <= 1 && high >= 7) return 2; // 同花连张 98s+
  if (suited && high === 12 && low >= 4) return 2; // Ax 同花
  if (high >= 10 && low >= 6) return 1;
  return 0;
}

/** 下注/加注尺寸：约 halfPot（跨灯区间），取 CENT、夹到 [minTarget, 全下]。 */
function sizeRaise(ctx, fracPct) {
  const { pot, currentBet, lastFullRaise, streetBet, stack, minRaiseTo, bb } = ctx;
  const maxTo = streetBet + stack; // 全下时本街总额
  const raw = currentBet + (pot * BigInt(fracPct)) / 100n;
  let target = floorCent(raw);
  if (target < minRaiseTo) target = floorCent(minRaiseTo);
  if (currentBet === 0n && target < bb) target = bb;
  if (target >= maxTo) return { action: "allIn" };
  return { action: currentBet === 0n ? "bet" : "raiseTo", amount: target };
}

export function makeDefaultStrategy(opts = {}) {
  const rng = opts.rng ?? Math.random;
  return {
    name: opts.name ?? "default-heuristic",
    decide(ctx) {
      const { hole, board, street, toCall, stack, bb, rng: ctxRng } = ctx;
      const rand = ctxRng ?? rng;

      // ---------- 翻前 ----------
      if (board.length === 0) {
        const score = preflopScore(hole);
        if (toCall === 0n) {
          // 无人下注：强牌主动加注（BB 面对溜入），其余过牌。
          if (score >= 3) {
            const amount = floorCent(ctx.minRaiseTo);
            if (amount >= ctx.streetBet + ctx.stack) return { action: "allIn" };
            return rand() < 0.8
              ? { action: ctx.currentBet === 0n ? "bet" : "raiseTo", amount }
              : { action: "check" };
          }
          return { action: "check" };
        }
        // 面对下注：按牌力与代价分层。
        if (score === 4) {
          if (rand() < 0.6) {
            const s = sizeRaise(ctx, 25);
            return s;
          }
          return { action: "call" };
        }
        if (score === 3) return ratioLe(toCall, stack, 20) ? { action: "call" } : { action: "fold" };
        if (score === 2) return ratioLe(toCall, stack, 12) ? { action: "call" } : { action: "fold" };
        if (score === 1) return ratioLe(toCall, stack, 6) ? { action: "call" } : { action: "fold" };
        // score 0：只有极便宜（≤1BB）才跟（如大盲补看）。
        return toCall <= bb ? { action: "call" } : { action: "fold" };
      }

      // ---------- 翻后（board>=3）----------
      const rank = evaluateBest([...hole, ...board]);
      const cat = rank.category; // 0高牌 1一对 2两对 3三条 4顺 5花 6葫芦 7四条 8同花顺

      if (toCall === 0n) {
        if (cat >= 4) return rand() < 0.85 ? sizeRaise(ctx, 66) : { action: "check" };
        if (cat === 3) return rand() < 0.75 ? sizeRaise(ctx, 60) : { action: "check" };
        if (cat === 2) return rand() < 0.6 ? sizeRaise(ctx, 50) : { action: "check" };
        if (cat === 1) return rand() < 0.2 ? sizeRaise(ctx, 40) : { action: "check" };
        return { action: "check" };
      }

      // 面对下注：按成手强度 vs 底池赔率。
      if (cat >= 4) {
        if (rand() < 0.7) {
          const s = sizeRaise(ctx, 70);
          return s;
        }
        return { action: "call" };
      }
      if (cat === 3) {
        if (rand() < 0.5) return sizeRaise(ctx, 60);
        return toCall <= ctx.pot ? { action: "call" } : { action: "fold" };
      }
      if (cat === 2) return ratioLe(toCall, ctx.pot, 75) ? { action: "call" } : { action: "fold" };
      if (cat === 1) return ratioLe(toCall, ctx.pot, 40) ? { action: "call" } : { action: "fold" };
      return ratioLe(toCall, ctx.pot, 15) ? { action: "call" } : { action: "fold" };
    },
  };
}

/** 载入策略：默认启发式，或 `--strategy <path.mjs>` 自定义模块（导出 decide(ctx)）。 */
export async function loadStrategy(spec) {
  if (!spec || spec === "default") return makeDefaultStrategy();
  const mod = await import(new URL(spec, `file:///${process.cwd().replace(/\\/g, "/")}/`).href);
  if (typeof mod.decide !== "function") {
    throw new Error(`${spec} 必须导出 decide(ctx)`);
  }
  return {
    name: mod.name ?? spec,
    decide: (ctx) => {
      const out = mod.decide(ctx);
      if (!out?.action) throw new Error("策略返回非法动作");
      return out;
    },
  };
}
