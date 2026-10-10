//! Stage 5 规则引擎与结算的性质测试（主设计文档 §7.3）。
//!
//! 用一个确定性 splitmix64 PRNG 展开随机动作序列（proptest 只负责播种与生成开局），
//! 覆盖 §7.3 列出的全部性质：守恒、计数器单调、合法性、终止、确定性、rake 边界、
//! 边池、奇数筹码、单挑位次。

use proptest::prelude::*;
use solpoker_core::engine::{Action, Engine, EngineError, EngineSeat, TimeoutResult, CENT};
use solpoker_core::eval::evaluate7;
use solpoker_core::seats::{next_clockwise, popcount, seat_bit};
use solpoker_core::settle::{settle, RakeParams, NO_CARD};

/// 单手握手上界：完整加注每次至少消耗加注者 1BB，全桌筹码有限，
/// 动作总数必然有限；留出充足余量（§7.3 终止性）。
const MAX_STEPS: u32 = 20_000;

// ---------------------------------------------------------------------------
// 确定性 PRNG（splitmix64）与测试评估器
// ---------------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// 测试用评估器：7 张牌 rank 之和（允许构造任意并列局面）。
fn eval_sum(cards: &[u8; 7]) -> u64 {
    cards.iter().map(|&c| (c / 4) as u64).sum()
}

fn draw_card(rng: &mut Rng, used: &mut [bool; 52]) -> u8 {
    loop {
        let c = rng.below(52) as u8;
        if !used[c as usize] {
            used[c as usize] = true;
            return c;
        }
    }
}

// ---------------------------------------------------------------------------
// 开局生成
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Setup {
    mask: u16,
    button: u8,
    sb: u64,
    bb: u64,
    ante: u64,
    stacks: [u64; 9],
}

impl Setup {
    fn build(&self) -> Engine {
        Engine::new(
            &self.stacks,
            self.mask,
            self.mask,
            self.button,
            self.sb,
            self.bb,
            self.ante,
        )
        .expect("生成的开局必然合法")
    }
}

/// 随机开局：2–9 人（任意稀疏掩码）、bb 为偶数个 CENT（sb = bb/2 恰好整除）、
/// ante = 0.1BB 向下取整到 CENT、每人 stack 5–60 BB、button 在 hand_mask 内。
fn setup_strategy(players: std::ops::RangeInclusive<usize>) -> impl Strategy<Value = (Setup, u64)> {
    prop::collection::vec(any::<bool>(), 9)
        .prop_filter_map("hand_mask 需要 2–9 人", move |bits| {
            let mask = bits
                .iter()
                .enumerate()
                .fold(0u16, |m, (i, &b)| if b { m | (1 << i) } else { m });
            let n = popcount(mask) as usize;
            if players.contains(&n) {
                Some((mask, n))
            } else {
                None
            }
        })
        .prop_flat_map(|(mask, n)| {
            (
                Just(mask),
                1u64..=50,
                prop::collection::vec(5u64..=60, n),
                any::<u64>(),
            )
        })
        .prop_map(|(mask, bb_mult, stack_bbs, seed)| {
            // bb 取偶数个 CENT，保证 sb = bb/2 也是 CENT 整数倍。
            let bb = 2 * bb_mult * CENT;
            let sb = bb / 2;
            let ante = (bb / 10) / CENT * CENT;
            let mut stacks = [0u64; 9];
            let mut seats: Vec<u8> = Vec::new();
            for s in 0..9u8 {
                if mask & seat_bit(s) != 0 {
                    seats.push(s);
                }
            }
            for (i, &s) in seats.iter().enumerate() {
                stacks[s as usize] = stack_bbs[i] * bb;
            }
            let button = seats[(seed as usize) % seats.len()];
            (
                Setup {
                    mask,
                    button,
                    sb,
                    bb,
                    ante,
                    stacks,
                },
                seed,
            )
        })
}

// ---------------------------------------------------------------------------
// 整手驱动：随机动作序列 + 逐步不变量 + 结算校验
// ---------------------------------------------------------------------------

fn drive(setup: &Setup, seed: u64) -> (Engine, solpoker_core::settle::Settlement) {
    let mut rng = Rng(seed);
    let mut e = setup.build();
    let initial_total: u64 = setup.stacks.iter().sum();
    let mut strikes_peak = [0u8; 9];
    let mut steps = 0u32;

    while !e.is_over() {
        steps += 1;
        assert!(steps <= MAX_STEPS, "终止性：手牌未在 {MAX_STEPS} 步内结束");
        // 守恒（§7.3）：Σ stack + pot == Σ 开局 stack，且 pot == Σ in_hand。
        assert_eq!(
            e.seats.iter().map(|s| s.stack).sum::<u64>() + e.pot,
            initial_total,
            "守恒：Σ stack + pot"
        );
        assert_eq!(
            e.pot,
            e.seats.iter().map(|s| s.in_hand).sum::<u64>(),
            "守恒：pot == Σ in_hand"
        );
        // 掩码不变量：pending ⊆ actionable ⊆ live ⊆ hand。
        assert_eq!(e.pending_to_act_mask & !e.actionable_mask, 0);
        assert_eq!(e.actionable_mask & !e.live_mask, 0);
        assert_eq!(e.live_mask & !e.hand_mask, 0);
        // 单调：strikes 手内不减少。
        for (seat, peak) in e.seats.iter().zip(strikes_peak.iter_mut()) {
            assert!(seat.strikes >= *peak, "strikes 单调");
            *peak = seat.strikes;
        }

        let seat = e.to_act;
        let st = e.seats[seat as usize];
        let owe = e.current_bet - st.street_bet;
        let before = e.clone();
        match rng.below(100) {
            // 10%：非法动作注入——必须 Err 且状态逐字段不变（§7.3 合法性）。
            0..=9 => {
                let res = match rng.below(5) {
                    // 错座位（可能不在本手 → SeatNotInHand，否则 NotYourTurn）。
                    0 => {
                        let other = (seat + 1 + rng.below(8) as u8) % 9;
                        e.act(other, Action::Call)
                    }
                    // 金额非 CENT 整数倍。
                    1 => e.act(seat, Action::RaiseTo(e.current_bet + 1)),
                    // 超过 stack。
                    2 => e.act(seat, Action::RaiseTo(st.street_bet + st.stack + CENT)),
                    // 低于最小加注（CENT 整数倍）。
                    3 => e.act(seat, Action::RaiseTo(e.min_raise_to() - CENT)),
                    // Bet 时机非法（翻前/已有注额）或金额非整数倍。
                    _ => e.act(seat, Action::Bet(setup.bb + 1)),
                };
                assert!(res.is_err(), "非法动作必须被拒绝");
                assert_eq!(e, before, "非法动作后状态必须不变");
            }
            // 5%：超时——能 check 就 check，否则 fold；strikes +1。
            10..=14 => {
                let r = e.claim_timeout(seat).expect("当前座位超时合法");
                assert_eq!(e.seats[seat as usize].strikes, st.strikes + 1);
                match r {
                    TimeoutResult::Checked(_) => assert_eq!(owe, 0),
                    TimeoutResult::Folded(_) => assert!(owe > 0),
                }
            }
            // 10%：fold（能 check 时也允许）。
            15..=24 => {
                e.act(seat, Action::Fold).unwrap();
            }
            // 15%：all-in（已行动者面对不足额 all-in 无加注权 → 退化为 call）。
            25..=39 => {
                if st.acted {
                    e.act(seat, Action::Call).unwrap();
                } else {
                    e.act(seat, Action::AllIn).unwrap();
                }
            }
            // 15%：最小加注 / 翻后最小下注。
            40..=54 => {
                if st.acted {
                    e.act(seat, Action::Call).unwrap();
                } else {
                    let target = e.min_raise_to();
                    if target > st.street_bet + st.stack {
                        e.act(seat, Action::AllIn).unwrap();
                    } else if e.current_bet == 0 {
                        e.act(seat, Action::Bet(target)).unwrap();
                    } else {
                        e.act(seat, Action::RaiseTo(target)).unwrap();
                    }
                }
            }
            // 10%：更大的随机加注。
            55..=64 => {
                if st.acted {
                    e.act(seat, Action::Call).unwrap();
                } else {
                    let mult = 1 + rng.below(10);
                    let target = e
                        .current_bet
                        .saturating_add(e.last_full_raise.saturating_mul(mult));
                    let cap = st.street_bet + st.stack;
                    if target >= cap {
                        e.act(seat, Action::AllIn).unwrap();
                    } else if e.current_bet == 0 {
                        e.act(seat, Action::Bet(target)).unwrap();
                    } else {
                        e.act(seat, Action::RaiseTo(target)).unwrap();
                    }
                }
            }
            // 其余：call / check（终止性主力）。
            _ => {
                if owe == 0 {
                    e.act(seat, Action::Check).unwrap();
                } else {
                    e.act(seat, Action::Call).unwrap();
                }
            }
        }
    }

    // 收尾：runout 补完公共牌 / 摊牌 / fold 结束。
    let live = popcount(e.live_mask);
    let showdown = live >= 2;
    if e.runout_needed {
        // 链上 advance 用一次 runout VRF 补完剩余公共牌；翻牌发出即收 rake（§7.2）。
        e.flop_dealt = true;
    }
    let board_len: u8 = if showdown || e.runout_needed {
        5
    } else {
        match e.street {
            0 => 0,
            1 => 3,
            2 => 4,
            _ => 5,
        }
    };
    let flop_dealt = e.flop_dealt;
    let mut used = [false; 52];
    let mut board = [0u8; 5];
    for c in board.iter_mut() {
        *c = draw_card(&mut rng, &mut used);
    }
    let mut hole = [[NO_CARD; 2]; 9];
    for s in 0..9u8 {
        if e.live_mask & seat_bit(s) != 0 {
            hole[s as usize] = [
                draw_card(&mut rng, &mut used),
                draw_card(&mut rng, &mut used),
            ];
        }
    }
    let st = settle(&mut e, &hole, &board, board_len, RakeParams::default(), evaluate7);

    // 结算守恒：Σ stack + rake == Σ 开局 stack。
    assert_eq!(
        e.seats.iter().map(|x| x.stack).sum::<u64>() + st.rake,
        initial_total,
        "结算守恒：Σ stack + rake == Σ 开局 stack"
    );
    assert_eq!(e.pot, 0);
    assert!(e.finished);
    // rake 边界（§7.3）。
    let gross: u64 = st.pots.iter().map(|p| p.gross).sum();
    assert_eq!(st.awards.iter().sum::<u64>() + st.rake, gross);
    assert!(st.rake <= 3 * setup.bb, "rake <= 3BB");
    assert_eq!(st.rake % CENT, 0, "rake 是 CENT 整数倍");
    if !flop_dealt || gross <= setup.bb {
        assert_eq!(st.rake, 0, "未发翻牌或 pot <= 1BB 时 rake = 0");
    } else {
        let expect = ((gross as u128 * 25 / 1000) as u64) / CENT * CENT;
        assert_eq!(st.rake, expect.min(3 * setup.bb), "rake == min(2.5%, 3BB)");
    }
    // 池资格：folded 永不 eligible，赢家 ⊆ eligible。
    let folded_mask = e.hand_mask & !e.live_mask;
    for pot in &st.pots {
        assert_eq!(pot.eligible_mask & folded_mask, 0);
        assert_eq!(pot.eligible_mask & !e.live_mask, 0);
        assert_ne!(pot.winner_mask, 0);
        assert_eq!(pot.winner_mask & !pot.eligible_mask, 0);
    }
    // fold 结束：唯一 live 玩家赢下全部池。
    if live == 1 {
        for pot in &st.pots {
            assert_eq!(pot.winner_mask, e.live_mask);
        }
    }
    (e, st)
}

// ---------------------------------------------------------------------------
// 结算场景直构（随机贡献向量）
// ---------------------------------------------------------------------------

/// 直接以贡献向量构造待结算引擎（绕过下注过程，专注 §7.2 的建池/rake/分配）。
fn contrib_engine(
    contribs: &[(u8, u64)],
    folded_mask: u16,
    button: u8,
    bb: u64,
    flop_dealt: bool,
) -> Engine {
    let mut seats = [EngineSeat::default(); 9];
    let mut hand_mask = 0u16;
    let mut live_mask = 0u16;
    let mut pot = 0u64;
    for &(s, c) in contribs {
        hand_mask |= seat_bit(s);
        seats[s as usize].in_hand_mask = true;
        seats[s as usize].in_hand = c;
        pot += c;
        if folded_mask & seat_bit(s) != 0 {
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

/// 期望的未跟注退回：唯一最高贡献者退 `highest - second_highest`。
fn expected_refunds(contribs: &[(u8, u64)]) -> [u64; 9] {
    let mut refunds = [0u64; 9];
    let mut max_c = 0u64;
    let mut second = 0u64;
    let mut count = 0u8;
    let mut max_seat = 0u8;
    for &(s, c) in contribs {
        if c > max_c {
            second = max_c;
            max_c = c;
            count = 1;
            max_seat = s;
        } else if c == max_c {
            count += 1;
        } else if c > second {
            second = c;
        }
    }
    if count == 1 && max_c > second {
        refunds[max_seat as usize] = max_c - second;
    }
    refunds
}

// ---------------------------------------------------------------------------
// 性质
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// 守恒 + 终止 + 掩码不变量 + 非法动作注入（§7.3 守恒/合法性/终止）。
    #[test]
    fn random_hands_conserve_and_terminate((setup, seed) in setup_strategy(2..=9)) {
        drive(&setup, seed);
    }

    /// 确定性：相同初始状态 + 相同动作序列 → 逐字段相同结果（§7.3 确定性）。
    #[test]
    fn determinism_same_seed_same_outcome((setup, seed) in setup_strategy(2..=9)) {
        let (e1, s1) = drive(&setup, seed);
        let (e2, s2) = drive(&setup, seed);
        prop_assert_eq!(e1, e2);
        prop_assert_eq!(s1, s2);
    }

    /// rake_total 跨手单调不减（§7.3 计数器单调；本手内 strikes 单调在 drive 中断言）。
    #[test]
    fn rake_total_monotone_across_hands(
        (setup, seed) in setup_strategy(2..=9),
        hands in 1usize..=4,
    ) {
        let mut rake_total = 0u64;
        let mut button = setup.button;
        let mut rng = Rng(seed);
        for _ in 0..hands {
            let hand = Setup { button, ..setup.clone() };
            let (_e, st) = drive(&hand, rng.next());
            let new_total = rake_total + st.rake;
            prop_assert!(new_total >= rake_total);
            rake_total = new_total;
            button = next_clockwise(button, setup.mask).unwrap();
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// 合法性：错座位 / 非 CENT 倍数 / 低于最小加注 / 超过 stack 一律拒绝且状态不变。
    #[test]
    fn illegal_actions_rejected_state_unchanged((setup, seed) in setup_strategy(2..=9)) {
        let mut rng = Rng(seed);
        let mut e = setup.build();
        // 先随机走若干步（只 call/check）到任意中段。
        for _ in 0..rng.below(16) {
            if e.is_over() {
                break;
            }
            let seat = e.to_act;
            if e.call_amount(seat) == 0 {
                e.act(seat, Action::Check).unwrap();
            } else {
                e.act(seat, Action::Call).unwrap();
            }
        }
        if e.is_over() {
            return Ok(());
        }
        let seat = e.to_act;
        let st = e.seats[seat as usize];
        let before = e.clone();
        // 错座位。
        let other = (seat + 1 + rng.below(8) as u8) % 9;
        prop_assert!(e.act(other, Action::Fold).is_err());
        prop_assert_eq!(&e, &before);
        // 金额非 CENT 整数倍。
        prop_assert_eq!(
            e.act(seat, Action::RaiseTo(e.current_bet + 1)),
            Err(EngineError::NotCentMultiple)
        );
        prop_assert_eq!(&e, &before);
        // 低于最小加注（CENT 整数倍）。
        prop_assert!(e.act(seat, Action::RaiseTo(e.min_raise_to() - CENT)).is_err());
        prop_assert_eq!(&e, &before);
        // 超过 stack。
        prop_assert!(e.act(seat, Action::RaiseTo(st.street_bet + st.stack + CENT)).is_err());
        prop_assert_eq!(&e, &before);
        // check/call 门控。
        if e.current_bet > st.street_bet {
            prop_assert_eq!(e.act(seat, Action::Check), Err(EngineError::CheckNotAllowed));
        } else {
            prop_assert_eq!(e.act(seat, Action::Call), Err(EngineError::CallNotAllowed));
        }
        prop_assert_eq!(&e, &before);
        // 错座位超时。
        prop_assert!(e.claim_timeout(other).is_err());
        prop_assert_eq!(&e, &before);
    }

    /// 边池（§7.3）：随机贡献向量下每个筹码只进入一个池、folded 贡献但永不
    /// eligible、awards + rake == 匹配后的总池、rake 精确等于公式值。
    #[test]
    fn side_pots_partition_contributions(
        contribs_cents in prop::collection::vec(0u64..=80, 2usize..=9),
        folded_bits in any::<u16>(),
        bb_mult in 2u64..=100,
        flop_dealt in any::<bool>(),
        seed in any::<u64>(),
    ) {
        let n = contribs_cents.len();
        let mask = (1u16 << n) - 1;
        let folded_mask = folded_bits & mask;
        prop_assume!(popcount(mask & !folded_mask) >= 1); // 至少一家 live
        let bb = bb_mult * CENT;
        let contribs: Vec<(u8, u64)> = (0..n as u8)
            .map(|s| (s, contribs_cents[s as usize] * CENT))
            .collect();
        let pot_total: u64 = contribs.iter().map(|&(_, c)| c).sum();
        // 只保留引擎可达的场景：退回后每个贡献层级内必有 live 玩家
        // （真实牌局中 fold 面对的注额必有 live 玩家匹配，等价于
        // 「退回后的最高贡献必属 live 玩家」）。
        let refunds_exp = expected_refunds(&contribs);
        let post = |s: u8| contribs[s as usize].1 - refunds_exp[s as usize];
        let max_all = (0..n as u8).map(post).max().unwrap_or(0);
        let max_live = (0..n as u8)
            .filter(|s| folded_mask & seat_bit(*s) == 0)
            .map(post)
            .max()
            .unwrap_or(0);
        prop_assume!(max_all == 0 || max_live == max_all);
        let mut rng = Rng(seed);
        let button = (rng.below(n as u64)) as u8;
        let mut e = contrib_engine(&contribs, folded_mask, button, bb, flop_dealt);

        let mut used = [false; 52];
        let mut board = [0u8; 5];
        for c in board.iter_mut() {
            *c = draw_card(&mut rng, &mut used);
        }
        let mut hole = [[NO_CARD; 2]; 9];
        for s in 0..n as u8 {
            if e.live_mask & seat_bit(s) != 0 {
                hole[s as usize] = [draw_card(&mut rng, &mut used), draw_card(&mut rng, &mut used)];
            }
        }
        let live = popcount(e.live_mask);
        let board_len = if live >= 2 { 5 } else { 0 };
        let st = settle(&mut e, &hole, &board, board_len, RakeParams::default(), evaluate7);

        // 未跟注退回与公式一致。
        prop_assert_eq!(st.refunds, expected_refunds(&contribs));
        let refund_total: u64 = st.refunds.iter().sum();
        let gross: u64 = st.pots.iter().map(|p| p.gross).sum();
        // 每个筹码恰好进入一个池：Σ gross == pot − 退回。
        prop_assert_eq!(gross, pot_total - refund_total);
        // 池数 == 退回后不同正贡献层级数。
        let mut post: Vec<u64> = contribs
            .iter()
            .map(|&(s, c)| c - st.refunds[s as usize])
            .filter(|&c| c > 0)
            .collect();
        post.sort_unstable();
        post.dedup();
        prop_assert_eq!(st.pots.len(), post.len());
        // rake 精确等于公式。
        let expected_rake = if flop_dealt && gross > bb {
            (((gross as u128 * 25) / 1000) as u64) / CENT * CENT
        } else {
            0
        }
        .min(3 * bb);
        prop_assert_eq!(st.rake, expected_rake);
        prop_assert!(st.rake <= 3 * bb);
        prop_assert_eq!(st.rake % CENT, 0);
        // awards + rake == 匹配后的总池。
        prop_assert_eq!(st.awards.iter().sum::<u64>() + st.rake, gross);
        // 池资格：folded 贡献（计入 gross）但永不 eligible；赢家 ⊆ eligible ⊆ live。
        for pot in &st.pots {
            prop_assert_eq!(pot.eligible_mask & folded_mask, 0);
            prop_assert_eq!(pot.eligible_mask & !e.live_mask, 0);
            prop_assert_eq!(pot.winner_mask & !pot.eligible_mask, 0);
            prop_assert_ne!(pot.winner_mask, 0);
        }
        // 座位守恒：Σ stack + rake == 原 pot（直构引擎 stack 从 0 起）。
        prop_assert_eq!(
            e.seats.iter().map(|x| x.stack).sum::<u64>() + st.rake,
            pot_total
        );
    }

    /// 奇数筹码（§7.3）：余数 cent 只给该池赢家，严格从 button 左侧第一位赢家起顺时针。
    #[test]
    fn odd_chips_clockwise_within_winners(
        n in 3usize..=9,
        level_cents in 1u64..=200,
        n_winners in 2usize..=9,
        button_seed in any::<u64>(),
    ) {
        let n_winners = n_winners.min(n);
        let mask = (1u16 << n) - 1;
        let button = (button_seed % n as u64) as u8;
        let bb = 10 * CENT;
        let contribs: Vec<(u8, u64)> =
            (0..n as u8).map(|s| (s, level_cents * CENT)).collect();
        let mut e = contrib_engine(&contribs, 0, button, bb, false); // 无翻牌 → rake = 0
        // 赢家并列同分（相同 rank 组合），输家更低。
        let mut hole = [[NO_CARD; 2]; 9];
        for s in 0..n as u8 {
            hole[s as usize] = if (s as usize) < n_winners {
                [48, 44] // A♣ + K♣（rank 12 + 11）
            } else {
                [0, 4] // 2♣ + 3♣
            };
        }
        let board = [2, 6, 10, 14, 18]; // 低分公共牌
        let st = settle(&mut e, &hole, &board, 5, RakeParams::default(), eval_sum);

        let net = n as u64 * level_cents * CENT;
        let w = n_winners as u64;
        let per = (net / w) / CENT * CENT;
        let remainder_cents = (net - per * w) / CENT;
        prop_assert!(remainder_cents < w);
        // 期望：赢家顺时针从 anchor 排序，前 remainder_cents 位各多得 1 CENT。
        let winner_mask: u16 = (0..n_winners as u8).map(seat_bit).fold(0, |a, b| a | b);
        let anchor = next_clockwise(button, mask).unwrap();
        let mut expected = [0u64; 9];
        let mut s = anchor;
        let mut given = 0u64;
        for _ in 0..9 {
            if winner_mask & seat_bit(s) != 0 {
                expected[s as usize] = per + if given < remainder_cents { CENT } else { 0 };
                given += 1;
            }
            s = (s + 1) % 9;
        }
        prop_assert_eq!(st.pots.len(), 1);
        prop_assert_eq!(st.pots[0].winner_mask, winner_mask);
        prop_assert_eq!(st.awards, expected);
    }

    /// 单挑特殊位次（§7.1/§7.3）：button = SB，翻前 button 先动，翻后 BB 先动。
    #[test]
    fn heads_up_position_order((setup, _seed) in setup_strategy(2..=2)) {
        let mut e = setup.build();
        let other = next_clockwise(setup.button, setup.mask).unwrap();
        prop_assert!(e.heads_up());
        prop_assert_eq!(e.sb_seat(), setup.button); // button = SB
        prop_assert_eq!(e.bb_seat(), other);
        // stack >= 5BB，盲注不会全下；翻前 button 先动。
        prop_assert_eq!(e.to_act, setup.button);
        e.act(setup.button, Action::Call).unwrap();
        e.act(other, Action::Check).unwrap();
        prop_assert_eq!(e.street, 1);
        prop_assert!(e.flop_dealt);
        prop_assert_eq!(e.to_act, other); // 翻后 BB 先动
    }
}
