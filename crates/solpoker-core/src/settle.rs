//! Stage 5 结算与 rake（主设计文档 §7.2 伪代码的定稿实现）。
//!
//! 结算顺序（与本模块 [`settle`] 的代码段落一一对应）：
//!
//! 1. **贡献快照**：`contributions[i] = seats[i].in_hand`（folded 玩家也计入）；
//! 2. **未跟注退回**（§7.1）：唯一最高贡献者退回 `highest - second_highest`，
//!    在建池与 rake **之前**完成；
//! 3. **贡献分层建池**：每个不同的正贡献层级 `L_j`（升序）：
//!    `gross_j = (L_j - L_{j-1}) * count(contribution >= L_j)`，
//!    `eligible_j = live_mask ∩ {contribution >= L_j}`（第一个为主池）；
//! 4. **rake**：`flop_dealt && gross_total > 1BB` 时
//!    `min(floor_cent(gross_total * 2.5%), 3BB)`，否则 0；从主池起按层级升序扣，
//!    单池不为负（`rake <= 2.5% * gross_total < gross_total`，扣得完）；
//! 5. **分配**：每个净池在 eligible 中比 7 选 5（folded 永不 eligible）；
//!    均分到 CENT，余数 0.01 从 button 左侧第一位该池赢家起顺时针逐个发放（§7.1）；
//! 6. **fold 结束**（`board_len < 5`、live 只剩一人）：唯一 live 玩家赢下全部池，
//!    不做牌型评估。
//!
//! 评估函数以泛型闭包注入（`R: Ord`），与 [`crate::eval`] 的
//! `evaluate7(&[u8; 7]) -> HandRank` 直接兼容（`HandRank: Ord`）。
//!
//! 守恒断言（debug）：`Σ awards + rake == gross_total`，且
//! `Σ refunds + Σ awards + rake == 结算前 pot`（§7.2 `assert I-ER`）。
//!
//! 作废手牌走 [`void_hand`]：每人的 `in_hand` 全额退回 stack，不收 rake。

use crate::engine::{Engine, CENT};
use crate::seats::{next_clockwise, popcount, seat_bit, MAX_SEATS};

/// 无效底牌哨兵：`hole[i]` 中任一张 >= 52 视为「无有效底牌」，不参与比牌
/// （牌编号 `rank * 4 + suit`，合法值 0..=51，见 [`crate::deal::card_id`]）。
pub const NO_CARD: u8 = 0xFF;

/// 单个池（主池或边池）的结算信息。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PotInfo {
    /// 建池总额（rake 前）。
    pub gross: u64,
    /// rake 后的可分配额。
    pub net: u64,
    /// 有资格赢该池的玩家（`live ∩ {contribution >= 层级}`）。
    pub eligible_mask: u16,
    /// 该池的赢家（`⊆ eligible_mask`）。
    pub winner_mask: u16,
}

/// 一手牌的结算结果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Settlement {
    /// 未跟注退回（建池前返还给唯一最高贡献者）。
    pub refunds: [u64; MAX_SEATS as usize],
    /// 主池 + 边池，按贡献层级升序（第一个是主池）。
    pub pots: Vec<PotInfo>,
    /// 每个座位的获奖总额（已含奇数筹码）。
    pub awards: [u64; MAX_SEATS as usize],
    /// 本手 rake（CENT 整数倍，`<= 3BB`，见模块文档第 4 条）。
    pub rake: u64,
}

/// 结算一手已结束的牌局，并把结果写回引擎座位
/// （`stack += refund + award`、`in_hand` 清零、`pot` 清零、`finished = true`）。
///
/// - `hole`：九席底牌；只有 live 玩家需要有效底牌（folded 可用 [`NO_CARD`]）；
/// - `board` / `board_len`：公共牌与已发张数；`board_len < 5` 时表示本手由
///   fold 结束（此时 `live_mask` 必为单人），不做牌型评估；
/// - `evaluate`：7 选 5 牌型评估（`[hole0, hole1, board0..5]`），大者胜；
///   与 [`crate::eval::evaluate7`] 签名兼容。
///
/// 守恒：`Σ awards + rake == Σ pots.gross`（debug_assert）。
pub fn settle<R, F>(
    engine: &mut Engine,
    hole: &[[u8; 2]; MAX_SEATS as usize],
    board: &[u8; 5],
    board_len: u8,
    evaluate: F,
) -> Settlement
where
    R: Ord,
    F: Fn(&[u8; 7]) -> R,
{
    debug_assert!(board_len <= 5);
    debug_assert_eq!(
        engine.pot,
        engine.seats.iter().map(|s| s.in_hand).sum::<u64>(),
        "pot 必须等于 Σ in_hand"
    );

    // ---- 1) 贡献快照（folded 也计入）--------------------------------------
    let hand_mask = engine.hand_mask;
    let live_mask = engine.live_mask;
    let mut contrib = [0u64; MAX_SEATS as usize];
    for s in 0..MAX_SEATS {
        if hand_mask & seat_bit(s) != 0 {
            contrib[s as usize] = engine.seats[s as usize].in_hand;
        }
    }

    // ---- 2) 未跟注退回（§7.1：结算与 rake 之前先退唯一未跟注差额）----------
    let mut refunds = [0u64; MAX_SEATS as usize];
    let mut max_c = 0u64;
    let mut second = 0u64;
    let mut max_count = 0u8;
    let mut max_seat = 0u8;
    for s in 0..MAX_SEATS {
        let c = contrib[s as usize];
        if c > max_c {
            second = max_c;
            max_c = c;
            max_count = 1;
            max_seat = s;
        } else if c == max_c {
            max_count += 1;
        } else if c > second {
            second = c;
        }
    }
    if max_count == 1 && max_c > second {
        refunds[max_seat as usize] = max_c - second;
        contrib[max_seat as usize] = second;
    }

    // ---- 3) 贡献分层建池（§7.2：层级升序，第一层为主池）--------------------
    let mut levels: Vec<u64> = Vec::with_capacity(MAX_SEATS as usize);
    for s in 0..MAX_SEATS {
        let c = contrib[s as usize];
        if c > 0 && !levels.contains(&c) {
            levels.push(c);
        }
    }
    levels.sort_unstable();
    let mut pots: Vec<PotInfo> = Vec::with_capacity(levels.len());
    let mut prev = 0u64;
    for &level in &levels {
        let mut count = 0u64;
        let mut eligible = 0u16;
        for s in 0..MAX_SEATS {
            if contrib[s as usize] >= level {
                count += 1;
                if live_mask & seat_bit(s) != 0 {
                    eligible |= seat_bit(s);
                }
            }
        }
        let gross = (level - prev) * count;
        pots.push(PotInfo {
            gross,
            net: gross,
            eligible_mask: eligible,
            winner_mask: 0,
        });
        prev = level;
    }
    let gross_total: u64 = pots.iter().map(|p| p.gross).sum();

    // ---- 3.5) 并入无 eligible 的死层（2026-10-07 proptest 发现的漏洞修复）----
    // eligible 掩码随层级嵌套：live 玩家 contrib ≥ L_{i+1} ⟹ contrib ≥ L_i，
    // 即 elig(T_{i+1}) ⊆ elig(T_i)，所以无 eligible 的层只可能构成顶部后缀——
    // 典型场景：深筹码在前几条街重注后在后街 check-fold（能 check 时 fold 是
    // 合法动作），其超过所有 live 玩家投入的层级里全是 folded 的钱。真实扑克
    // 没有 all-in 边界就没有边池：这些钱归仍在场的玩家，绝不归 fold 者。
    // 修复前该后缀会落入下方的贡献者兜底分支，把池分给 folded 座位（proptest
    // `rake_total_monotone_across_hands` 种子 cc 0654468554… 抓到：contrib
    // [20000,100000,·,140000,·,·,·,140000], live={1}，两个 folded 深筹码
    // "赢下" 80000）。把死层并入最高的有 eligible 的层，与真实扑克一致。
    if let Some(first_dead) = pots.iter().position(|p| p.eligible_mask == 0) {
        debug_assert!(
            pots[first_dead..].iter().all(|p| p.eligible_mask == 0),
            "eligible 嵌套：无 eligible 的层必为连续顶部后缀"
        );
        if first_dead > 0 {
            let mut carry = 0u64;
            for pot in pots.drain(first_dead..) {
                carry += pot.gross;
            }
            let top = pots.last_mut().unwrap();
            top.gross += carry;
            top.net += carry; // 此时 net == gross（rake 尚未扣）。
        }
        // first_dead == 0（所有层都无 eligible）在本引擎不可达：盲注强制
        // 投入，live 的非盲注玩家也必然跟过 BB，live ≥ 1 总有人 contrib > 0。
        // 真到达时下方 live 兜底分支保证守恒。
    }

    // ---- 4) rake（§7.2：no-flop-no-drop；2.5%，3BB 封顶，向下取整到 CENT）----
    let rake = if engine.flop_dealt && gross_total > engine.bb {
        let pct = ((gross_total as u128 * 25 / 1000) as u64) / CENT * CENT;
        pct.min(3 * engine.bb)
    } else {
        0
    };
    // 从主池起按层级升序扣；单池扣到 0 为止，不为负
    // （rake <= 2.5% * gross_total < gross_total，必然扣得完）。
    let mut remaining = rake;
    for pot in pots.iter_mut() {
        let deduct = remaining.min(pot.gross);
        pot.net = pot.gross - deduct;
        remaining -= deduct;
    }
    debug_assert_eq!(remaining, 0, "rake 必然能被各池扣完");

    // ---- 5/6) 定赢家并分配 -------------------------------------------------
    let live_count = popcount(live_mask);
    let showdown = live_count >= 2;
    debug_assert!(
        !showdown || board_len == 5,
        "摊牌结算需要完整公共牌（runout 之后 board_len == 5）"
    );
    // 奇数筹码起点：button 左侧第一位（§7.1）。
    let anchor = next_clockwise(engine.button, hand_mask).unwrap_or(engine.button);
    let mut awards = [0u64; MAX_SEATS as usize];
    for pot in pots.iter_mut() {
        let winners: Vec<u8> = if showdown {
            // eligible 中持有有效底牌者比 7 选 5；folded 玩家永不 eligible。
            let mut best: Option<R> = None;
            let mut winners: Vec<u8> = Vec::new();
            for s in 0..MAX_SEATS {
                if pot.eligible_mask & seat_bit(s) == 0 {
                    continue;
                }
                let h = hole[s as usize];
                if h[0] >= 52 || h[1] >= 52 {
                    continue; // 无有效底牌，不参与比牌
                }
                let seven = [h[0], h[1], board[0], board[1], board[2], board[3], board[4]];
                let rank = evaluate(&seven);
                match &best {
                    None => {
                        best = Some(rank);
                        winners.push(s);
                    }
                    Some(b) => {
                        if rank > *b {
                            best = Some(rank);
                            winners.clear();
                            winners.push(s);
                        } else if rank == *b {
                            winners.push(s);
                        }
                    }
                }
            }
            winners
        } else {
            // fold 结束（§7.2：live 只剩一人，无需评估，赢下所有池）。
            let mut winners = Vec::new();
            for s in 0..MAX_SEATS {
                if pot.eligible_mask & seat_bit(s) != 0 {
                    winners.push(s);
                }
            }
            winners
        };
        // 死层并入后每层必有 eligible（见 3.5 节）；eligible 兜底理论上不再
        // 触发。最后的 live 兜底只在本不该出现的 first_dead == 0 情形保证守恒，
        // 且绝不把池分给 folded 座位。
        let mut winners = winners;
        if winners.is_empty() {
            for s in 0..MAX_SEATS {
                if pot.eligible_mask & seat_bit(s) != 0 {
                    winners.push(s);
                }
            }
        }
        if winners.is_empty() {
            for s in 0..MAX_SEATS {
                if live_mask & seat_bit(s) != 0 {
                    winners.push(s);
                }
            }
        }
        debug_assert!(
            !winners.is_empty(),
            "每池必有赢家（live >= 1 时层级内必有 live）"
        );

        let n = winners.len() as u64;
        let per = (pot.net / n) / CENT * CENT;
        let remainder_cents = (pot.net - per * n) / CENT;
        debug_assert!(remainder_cents < n, "余数 cent 数必然小于赢家数");
        for &w in &winners {
            pot.winner_mask |= seat_bit(w);
        }
        // 从 anchor 起顺时针排赢家，前 remainder_cents 位各多得 1 CENT（§7.1）。
        let mut ordered: Vec<u8> = Vec::with_capacity(winners.len());
        let mut s = anchor;
        for _ in 0..MAX_SEATS {
            if pot.winner_mask & seat_bit(s) != 0 {
                ordered.push(s);
            }
            s = if s + 1 == MAX_SEATS { 0 } else { s + 1 };
        }
        for (i, &w) in ordered.iter().enumerate() {
            let odd = if (i as u64) < remainder_cents {
                CENT
            } else {
                0
            };
            awards[w as usize] += per + odd;
        }
    }

    // ---- 写回座位并校验守恒 --------------------------------------------------
    let mut sum_awards = 0u64;
    for s in 0..MAX_SEATS {
        if hand_mask & seat_bit(s) == 0 {
            continue;
        }
        let seat = &mut engine.seats[s as usize];
        seat.stack += refunds[s as usize] + awards[s as usize];
        seat.in_hand = 0;
        sum_awards += awards[s as usize];
    }
    debug_assert_eq!(
        sum_awards + rake,
        gross_total,
        "Σ awards + rake == gross_total"
    );
    engine.pot = 0;
    engine.finished = true;
    engine.runout_needed = false;

    Settlement {
        refunds,
        pots,
        awards,
        rake,
    }
}

/// 作废手牌（§6.1 Void / §7.2）：每位参与者的 `in_hand` 全额退回 stack，
/// 不收 rake，返回各座位退回额。
pub fn void_hand(engine: &mut Engine) -> [u64; MAX_SEATS as usize] {
    let mut refunds = [0u64; MAX_SEATS as usize];
    for s in 0..MAX_SEATS {
        if engine.hand_mask & seat_bit(s) == 0 {
            continue;
        }
        let seat = &mut engine.seats[s as usize];
        refunds[s as usize] = seat.in_hand;
        seat.stack += seat.in_hand;
        seat.in_hand = 0;
    }
    engine.pot = 0;
    engine.finished = true;
    engine.runout_needed = false;
    refunds
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deal::card_id;
    use crate::engine::{Action, EngineSeat};

    /// 测试用评估器：7 张牌 rank 之和（rank 越大越强），天然支持并列。
    fn eval_sum(cards: &[u8; 7]) -> u64 {
        cards.iter().map(|&c| (c / 4) as u64).sum()
    }

    fn hole(r1: u8, r2: u8) -> [u8; 2] {
        [card_id(r1, 0).unwrap(), card_id(r2, 1).unwrap()]
    }

    fn board5() -> [u8; 5] {
        // rank 2..6 各一张（suit 2），不与上面 hole 的 suit 0/1 冲突。
        [
            card_id(0, 2).unwrap(),
            card_id(1, 2).unwrap(),
            card_id(2, 2).unwrap(),
            card_id(3, 2).unwrap(),
            card_id(4, 2).unwrap(),
        ]
    }

    /// 直接构造结算输入：`contribs` = (座位, in_hand)，`folded` 中的座位不 live。
    fn direct_engine(
        contribs: &[(u8, u64)],
        folded: &[u8],
        button: u8,
        bb: u64,
        flop_dealt: bool,
    ) -> Engine {
        let mut seats = [EngineSeat::default(); MAX_SEATS as usize];
        let mut hand_mask = 0u16;
        let mut live_mask = 0u16;
        let mut pot = 0u64;
        for &(s, c) in contribs {
            hand_mask |= seat_bit(s);
            seats[s as usize].in_hand_mask = true;
            seats[s as usize].in_hand = c;
            pot += c;
            if folded.contains(&s) {
                seats[s as usize].folded = true;
            } else {
                live_mask |= seat_bit(s);
            }
        }
        Engine {
            seats,
            button,
            occupied_mask: hand_mask,
            hand_mask,
            live_mask,
            actionable_mask: 0,
            pending_to_act_mask: 0,
            pot,
            current_bet: 0,
            last_full_raise: bb,
            to_act: 0,
            street: 3,
            sb: bb / 2,
            bb,
            ante: 0,
            flop_dealt,
            runout_needed: false,
            finished: false,
        }
    }

    fn hole_cards_for(seats_holes: &[(u8, [u8; 2])]) -> [[u8; 2]; 9] {
        let mut hole = [[NO_CARD; 2]; 9];
        for &(s, h) in seats_holes {
            hole[s as usize] = h;
        }
        hole
    }

    // --- 未跟注退回与 rake 边界 ----------------------------------------------

    #[test]
    fn uncalled_refund_before_rake() {
        // 单挑：button(座位0) 全下 10BB，BB(座位1) 短码跟注 5BB → runout。
        let mask = 0b11;
        let mut stacks = [0u64; 9];
        stacks[0] = 1000 * CENT; // 10BB
        stacks[1] = 500 * CENT; // 5BB
        let mut e = Engine::new(&stacks, mask, mask, 0, 50 * CENT, 100 * CENT, 0).unwrap();
        e.act(0, Action::AllIn).unwrap();
        let out = e.act(1, Action::AllIn).unwrap();
        assert!(out.runout_started);
        // 链上 runout advance 补发公共牌（含翻牌）→ 收 rake。
        e.flop_dealt = true;
        let hole = hole_cards_for(&[(0, hole(12, 11)), (1, hole(9, 8))]);
        let s = settle(&mut e, &hole, &board5(), 5, eval_sum);
        // 退回 5BB 差额后才建池：gross = 10BB。
        assert_eq!(s.refunds[0], 500 * CENT);
        assert_eq!(s.pots.len(), 1);
        assert_eq!(s.pots[0].gross, 1000 * CENT);
        // rake = min(floor_cent(10BB * 2.5%), 3BB) = 0.25BB。
        assert_eq!(s.rake, 25 * CENT);
        // 座位 0 牌大：赢净池 10BB - 0.25BB。
        assert_eq!(s.awards[0], 975 * CENT);
        assert_eq!(s.awards[1], 0);
        // 守恒：Σ stack + rake == Σ 开局 stack。
        let total: u64 = e.seats.iter().map(|x| x.stack).sum::<u64>() + s.rake;
        assert_eq!(total, 1500 * CENT);
    }

    #[test]
    fn no_rake_without_flop() {
        // 同样 10BB vs 5BB，但未发翻牌（翻前 fold 结束路径用 direct_engine 模拟）。
        let mut e = direct_engine(
            &[(0, 1000 * CENT), (1, 500 * CENT)],
            &[1],
            0,
            100 * CENT,
            false,
        );
        let hole = hole_cards_for(&[(0, hole(12, 11))]);
        let s = settle(&mut e, &hole, &board5(), 0, eval_sum);
        assert_eq!(s.rake, 0);
        // 未跟注退回仍生效：座位 0 退回 5BB，赢 10BB。
        assert_eq!(s.refunds[0], 500 * CENT);
        assert_eq!(s.awards[0], 1000 * CENT);
        assert_eq!(s.pots.len(), 1);
        assert_eq!(s.pots[0].eligible_mask, 0b01);
    }

    #[test]
    fn no_rake_when_pot_not_above_1bb() {
        // gross == 1BB 整：rake = 0（§7.2 条件严格大于）。
        let mut e = direct_engine(&[(0, 50 * CENT), (1, 50 * CENT)], &[], 0, 100 * CENT, true);
        let hole = hole_cards_for(&[(0, hole(12, 11)), (1, hole(9, 8))]);
        let s = settle(&mut e, &hole, &board5(), 5, eval_sum);
        assert_eq!(s.rake, 0);
        assert_eq!(s.awards[0], 100 * CENT);
        // 有未跟注退回时 gross 进一步缩小，同样不收 rake：
        // [60, 40] → 退 20 → gross = 80 CENT < 1BB。
        let mut e = direct_engine(&[(0, 60 * CENT), (1, 40 * CENT)], &[], 0, 100 * CENT, true);
        let s = settle(&mut e, &hole, &board5(), 5, eval_sum);
        assert_eq!(s.refunds[0], 20 * CENT);
        assert_eq!(s.rake, 0);
        assert_eq!(s.awards[0], 80 * CENT);
    }

    #[test]
    fn rake_capped_at_exactly_3bb() {
        // 2.5% 远超 3BB：rake == 3BB（CENT 整数倍）。
        let bb = 100 * CENT;
        let mut e = direct_engine(&[(0, 1000 * bb), (1, 1000 * bb)], &[], 0, bb, true);
        let hole = hole_cards_for(&[(0, hole(12, 11)), (1, hole(9, 8))]);
        let s = settle(&mut e, &hole, &board5(), 5, eval_sum);
        assert_eq!(s.rake, 3 * bb);
        assert_eq!(s.awards[0] + s.rake, 2000 * bb);
    }

    #[test]
    fn rake_floors_down_to_cent() {
        // gross = 82 CENT：2.5% = 2.05 CENT → 向下取整为 2 CENT。
        // （并列最高贡献 41 CENT，不触发未跟注退回。）
        let bb = 10 * CENT;
        let mut e = direct_engine(&[(0, 41 * CENT), (1, 41 * CENT)], &[], 0, bb, true);
        let hole = hole_cards_for(&[(0, hole(12, 11)), (1, hole(9, 8))]);
        let s = settle(&mut e, &hole, &board5(), 5, eval_sum);
        assert_eq!(s.rake, 2 * CENT);
        assert_eq!(s.rake % CENT, 0);
        assert_eq!(s.awards[0] + s.rake, 82 * CENT);
    }

    // --- 边池与 folded 贡献 ----------------------------------------------------

    #[test]
    fn folded_excess_tier_merges_down_never_pays_folders() {
        // 2026-10-07 proptest（rake_total_monotone_across_hands，种子
        // cc 0654468554…）发现的真实漏洞：深筹码在后街 check-fold（合法动作），
        // 其超过 live 玩家投入的层级全是 folded 的钱——修复前兜底分支把该层
        // 分给了 folded 座位。正确行为（真实扑克，无 all-in 边界即无边池）：
        // 并入下层，归仍在场的玩家。
        //
        // seat0(folded)=2BB，seat1(live)=10BB，seat3/seat7(folded)=14BB。
        // 并列最高（2×14BB）→ 无未跟注退回。层级 2/10/14BB：14BB 层无 eligible。
        let bb = CENT;
        let mut e = direct_engine(
            &[(0, 2 * bb), (1, 10 * bb), (3, 14 * bb), (7, 14 * bb)],
            &[0, 3, 7],
            4,
            bb,
            true,
        );
        let hole = hole_cards_for(&[(1, hole(12, 11))]);
        let s = settle(&mut e, &hole, &board5(), 5, eval_sum);
        // 死层并入：2 层变 1 层……准确说 3 层 → 2 层：P0=2BB×4=8BB，
        // P1=(10-2)BB×3 + (14-10)BB×2 = 24BB + 8BB = 32BB。
        assert_eq!(s.pots.len(), 2);
        assert_eq!(s.pots[0].gross, 8 * bb);
        assert_eq!(s.pots[1].gross, 32 * bb);
        for pot in &s.pots {
            assert_eq!(pot.eligible_mask, 0b010);
            assert_eq!(pot.winner_mask, 0b010, "folded 座位永不为赢家");
        }
        // rake = min(floor_cent(40BB × 2.5%), 3BB) = 1BB，从 P0 扣。
        assert_eq!(s.rake, bb);
        // live 的 seat1 通吃 39BB；folded 座位分文不得。
        assert_eq!(s.awards[1], 39 * bb);
        assert_eq!(s.awards[0], 0);
        assert_eq!(s.awards[3], 0);
        assert_eq!(s.awards[7], 0);
        // 守恒：Σ awards + rake == Σ 投入。
        assert_eq!(s.awards.iter().sum::<u64>() + s.rake, 40 * bb);
    }

    #[test]
    fn side_pots_folded_contribute_but_never_eligible() {
        // 座位 0 投了 50 后 fold；座位 1/2 各 100。并列最高 → 无退回。
        // 主池：3*50 = 150，eligible {1,2}；边池：2*50 = 100，eligible {1,2}。
        let bb = 10 * CENT;
        let mut e = direct_engine(
            &[(0, 50 * CENT), (1, 100 * CENT), (2, 100 * CENT)],
            &[0],
            1,
            bb,
            true,
        );
        let hole = hole_cards_for(&[(1, hole(12, 11)), (2, hole(10, 9))]);
        let s = settle(&mut e, &hole, &board5(), 5, eval_sum);
        assert_eq!(s.pots.len(), 2);
        assert_eq!(s.pots[0].gross, 150 * CENT);
        assert_eq!(s.pots[1].gross, 100 * CENT);
        for pot in &s.pots {
            assert_eq!(pot.eligible_mask, 0b110); // folded 的座位 0 永不 eligible
            assert_eq!(pot.eligible_mask & 0b001, 0);
        }
        // rake = min(floor_cent(250 * 2.5%), 3BB) = 6 CENT，先从主池扣。
        assert_eq!(s.rake, 6 * CENT);
        assert_eq!(s.pots[0].net, 144 * CENT);
        assert_eq!(s.pots[1].net, 100 * CENT);
        // 座位 1 牌大，两池通吃。
        assert_eq!(s.pots[0].winner_mask, 0b010);
        assert_eq!(s.pots[1].winner_mask, 0b010);
        assert_eq!(s.awards[1], 244 * CENT);
        // 守恒：awards + rake == gross_total。
        assert_eq!(s.awards.iter().sum::<u64>() + s.rake, 250 * CENT);
    }

    #[test]
    fn three_tier_side_pots_with_unique_max_refund() {
        // 50 / 100 / 200：唯一最高退回 100 → 层级 50（3 人）、100（2 人）。
        let bb = 10 * CENT;
        let mut e = direct_engine(
            &[(0, 50 * CENT), (1, 100 * CENT), (2, 200 * CENT)],
            &[],
            0,
            bb,
            false,
        );
        let hole = hole_cards_for(&[(0, hole(12, 11)), (1, hole(10, 9)), (2, hole(8, 7))]);
        let s = settle(&mut e, &hole, &board5(), 5, eval_sum);
        assert_eq!(s.refunds[2], 100 * CENT);
        assert_eq!(s.pots.len(), 2);
        assert_eq!(s.pots[0].gross, 150 * CENT); // 主池
        assert_eq!(s.pots[0].eligible_mask, 0b111);
        assert_eq!(s.pots[1].gross, 100 * CENT); // 边池
        assert_eq!(s.pots[1].eligible_mask, 0b110);
        // 座位 0 只能赢主池，座位 1 赢边池。
        assert_eq!(s.awards[0], 150 * CENT);
        assert_eq!(s.awards[1], 100 * CENT);
        assert_eq!(s.awards[2], 0);
        assert_eq!(s.rake, 0); // 未发翻牌
                               // 守恒：refunds + awards == 原 pot。
        assert_eq!(
            s.refunds.iter().sum::<u64>() + s.awards.iter().sum::<u64>(),
            350 * CENT
        );
    }

    // --- 奇数筹码 --------------------------------------------------------------

    #[test]
    fn odd_chips_go_clockwise_from_button_left() {
        // 4 人各投 10 CENT，座位 1/2/3 并列赢家：净池 40 CENT，
        // 每人 13 CENT，余 1 CENT 给 button(0) 左侧第一位赢家 = 座位 1。
        let bb = 10 * CENT;
        let mut e = direct_engine(
            &[
                (0, 10 * CENT),
                (1, 10 * CENT),
                (2, 10 * CENT),
                (3, 10 * CENT),
            ],
            &[],
            0,
            bb,
            false,
        );
        let hole = hole_cards_for(&[
            (0, hole(0, 1)),  // 最小
            (1, hole(12, 1)), // 并列最大（rank 和相同）
            (2, hole(11, 2)),
            (3, hole(10, 3)),
        ]);
        // 确认三者 rank 和相同（12+1 == 11+2 == 10+3）。
        let s = settle(&mut e, &hole, &board5(), 5, eval_sum);
        assert_eq!(s.pots.len(), 1);
        assert_eq!(s.pots[0].winner_mask, 0b1110);
        assert_eq!(s.awards[0], 0);
        assert_eq!(s.awards[1], 14 * CENT); // anchor = 1：多得 1 CENT
        assert_eq!(s.awards[2], 13 * CENT);
        assert_eq!(s.awards[3], 13 * CENT);
        assert_eq!(s.awards.iter().sum::<u64>(), 40 * CENT);
    }

    #[test]
    fn odd_chips_anchor_wraps_past_button() {
        // button = 2，赢家 {0, 3}：anchor = 3，顺时针顺序 [3, 0]，余 1 CENT 给座位 3。
        let bb = 10 * CENT;
        let mut e = direct_engine(
            &[(0, 15 * CENT), (2, 15 * CENT), (3, 15 * CENT)],
            &[],
            2,
            bb,
            false,
        );
        let hole = hole_cards_for(&[
            (0, hole(12, 1)), // 并列最大
            (2, hole(0, 1)),  // 最小
            (3, hole(11, 2)), // 并列最大
        ]);
        let s = settle(&mut e, &hole, &board5(), 5, eval_sum);
        assert_eq!(s.pots[0].winner_mask, 0b1001);
        // 净池 45 CENT，每人 22 CENT，余 1 CENT 给 anchor（座位 3）。
        assert_eq!(s.awards[3], 23 * CENT);
        assert_eq!(s.awards[0], 22 * CENT);
        assert_eq!(s.awards[2], 0);
    }

    // --- fold 结束与作废 --------------------------------------------------------

    #[test]
    fn fold_end_single_live_wins_without_evaluation() {
        // 3 人翻前全 fold 给 BB：live == 1，board_len < 5，不比牌。
        let mask = 0b111;
        let mut stacks = [0u64; 9];
        for s in 0..3 {
            stacks[s] = 1000 * CENT;
        }
        let mut e = Engine::new(&stacks, mask, mask, 0, 50 * CENT, 100 * CENT, 10 * CENT).unwrap();
        e.act(0, Action::Fold).unwrap();
        let out = e.act(1, Action::Fold).unwrap();
        assert!(out.hand_finished);
        // 无有效底牌（NO_CARD）也能结算。
        let hole = [[NO_CARD; 2]; 9];
        let s = settle(&mut e, &hole, &board5(), 0, eval_sum);
        assert_eq!(s.rake, 0); // 未发翻牌
                               // 未跟注退回：BB 的 110 是唯一最高（folded 的 60/10 次之）→ 退 50。
        assert_eq!(s.refunds[2], 50 * CENT);
        // 层级 10（3 人）与 60（2 人）两个池，赢家都是唯一 live 的 BB。
        assert_eq!(s.pots.len(), 2);
        assert_eq!(s.pots[0].gross, 30 * CENT);
        assert_eq!(s.pots[1].gross, 100 * CENT);
        for pot in &s.pots {
            assert_eq!(pot.winner_mask, 0b100);
        }
        assert_eq!(s.awards[2], 130 * CENT);
        // BB 净收入 = 退回 50 + 获奖 130，拿回全部 180 底池。
        assert_eq!(e.seats[2].stack, 1000 * CENT - 110 * CENT + 180 * CENT);
    }

    #[test]
    fn void_hand_refunds_everything_without_rake() {
        let mask = 0b111;
        let mut stacks = [0u64; 9];
        for s in 0..3 {
            stacks[s] = 1000 * CENT;
        }
        let mut e = Engine::new(&stacks, mask, mask, 0, 50 * CENT, 100 * CENT, 10 * CENT).unwrap();
        e.act(0, Action::RaiseTo(500 * CENT)).unwrap();
        let refunds = void_hand(&mut e);
        assert_eq!(refunds[0], 510 * CENT); // ante + 加注
        assert_eq!(refunds[1], 60 * CENT); // ante + SB
        assert_eq!(refunds[2], 110 * CENT); // ante + BB
        for s in 0..3 {
            assert_eq!(e.seats[s as usize].stack, 1000 * CENT);
            assert_eq!(e.seats[s as usize].in_hand, 0);
        }
        assert_eq!(e.pot, 0);
        assert!(e.finished);
    }
}
