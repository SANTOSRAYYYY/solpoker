//! 7 选 5 牌力评估器：NLHE 摊牌比大小（主设计文档 stage1-design.md 的结算前置件）。
//!
//! 牌编号沿用 [`crate::deal`] 的约定：`card = rank * 4 + suit`，rank 2..A = 0..12，
//! suit ♣♦♥♠ = 0..3。本模块只做纯函数求值，不触碰链上状态：
//!
//! - [`evaluate5`]：恰好 5 张牌求 [`HandRank`]；
//! - [`evaluate7`]：7 张（2 底牌 + 5 公共牌）枚举全部 C(7,5)=21 种组合取最大——
//!   21 × 9 席的规模下朴素枚举足够快，正确性优先；
//! - [`best_indices`]：摊牌时返回并列最强的**全部**下标（分池用）；
//! - [`card_str`] / [`HandRank`] 的 `Display`：测试与日志输出（"As"、"Td"、"2c"）。
//!
//! 大小规则（标准 NLHE）：类别优先，类别相同按 kicker 从高到低逐位比较；
//! **花色不参与比大小**——同 rank 不同 suit 的牌型严格相等（平分底池）。
//! 轮顺（wheel）A-2-3-4-5 的高牌是 5（rank 3），不是 A；皇家同花顺只是高牌为 A
//! 的同花顺，不单列类别。不足 5 张的同花/顺子（如 4 张同花）一律不计。

use core::fmt;

use crate::deal::{card_rank, card_suit};

// ---------------------------------------------------------------------------
// 牌面字符串
// ---------------------------------------------------------------------------

/// rank（0..12）→ 字符（'2'..'9', 'T', 'J', 'Q', 'K', 'A'）。
const RANK_CHARS: [char; 13] = [
    '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A',
];

/// suit（0..3）→ 字符（♣♦♥♠ = "cdhs"）。
const SUIT_CHARS: [char; 4] = ['c', 'd', 'h', 's'];

/// 牌编号 → 两字符字符串（如 "As"、"Td"、"2c"）。
///
/// 仅用于测试与日志；`card >= 52` 时返回 "??"。
pub fn card_str(card: u8) -> String {
    if card >= 52 {
        return "??".to_string();
    }
    let mut s = String::with_capacity(2);
    s.push(RANK_CHARS[card_rank(card) as usize]);
    s.push(SUIT_CHARS[card_suit(card) as usize]);
    s
}

// ---------------------------------------------------------------------------
// 牌力
// ---------------------------------------------------------------------------

/// 5 张牌的类别（强度按声明顺序递增，`Ord` 派生即大小关系）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum HandCategory {
    /// 高牌。
    HighCard,
    /// 一对。
    Pair,
    /// 两对。
    TwoPair,
    /// 三条。
    Trips,
    /// 顺子。
    Straight,
    /// 同花。
    Flush,
    /// 葫芦（三条 + 对）。
    FullHouse,
    /// 四条。
    Quads,
    /// 同花顺（含皇家同花顺：高牌 A 的同花顺）。
    StraightFlush,
}

impl HandCategory {
    /// 中文类别名（测试输出用）。
    pub fn zh_name(self) -> &'static str {
        match self {
            HandCategory::HighCard => "高牌",
            HandCategory::Pair => "一对",
            HandCategory::TwoPair => "两对",
            HandCategory::Trips => "三条",
            HandCategory::Straight => "顺子",
            HandCategory::Flush => "同花",
            HandCategory::FullHouse => "葫芦",
            HandCategory::Quads => "四条",
            HandCategory::StraightFlush => "同花顺",
        }
    }
}

/// 5 张牌的牌力：类别 + 按比较顺序排列的 kicker（rank 0..12）。
///
/// `kickers` 的语义按类别：
/// - 顺子/同花顺：`[高牌]`（轮顺的高牌是 5，即 rank 3）；
/// - 四条：`[四条rank, 单张]`；葫芦：`[三条rank, 对子rank]`；
/// - 三条：`[三条rank, k1, k2]`；两对：`[高对, 低对, 单张]`；
/// - 一对：`[对子rank, k1, k2, k3]`；高牌/同花：5 个 rank 降序。
///
/// 不足 5 位的尾部填 0（任何合法 rank 都 ≥ 0，且顺子类比较只看 `kickers[0]`，
/// 填充位永不参与有效区分——两手同类时填充位必然相同）。
///
/// `Ord` 派生按字段顺序比较：先类别、再逐位 kicker；花色不出现，故同 rank
/// 不同 suit 严格 `Equal`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HandRank {
    pub category: HandCategory,
    pub kickers: [u8; 5],
}

impl fmt::Display for HandRank {
    /// 形如 `同花顺(A)`、`一对(A K Q J)`、`葫芦(K 2)`（测试输出用）。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let n = match self.category {
            HandCategory::Straight | HandCategory::StraightFlush => 1,
            HandCategory::Quads | HandCategory::FullHouse => 2,
            HandCategory::Trips | HandCategory::TwoPair => 3,
            HandCategory::Pair => 4,
            HandCategory::HighCard | HandCategory::Flush => 5,
        };
        write!(f, "{}(", self.category.zh_name())?;
        for (i, k) in self.kickers[..n].iter().enumerate() {
            if i > 0 {
                write!(f, " ")?;
            }
            write!(f, "{}", RANK_CHARS[*k as usize])?;
        }
        write!(f, ")")
    }
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

/// 轮顺（A-2-3-4-5）的 rank 位掩码：A(12) + 5..2(3..0)。
const WHEEL_MASK: u16 = (1 << 12) | (1 << 3) | (1 << 2) | (1 << 1) | (1 << 0);

/// 从 rank 位掩码中找顺子高牌：先扫 5 连位（A 高优先），再特判轮顺。
/// 无顺子返回 `None`。
fn straight_high(bits: u16) -> Option<u8> {
    // high 从 A(12) 降到 5(3)：窗口 high-4 ..= high。
    for high in (4u8..=12).rev() {
        if (bits >> (high - 4)) & 0b1_1111 == 0b1_1111 {
            return Some(high);
        }
    }
    // 轮顺：A 当 1 用，高牌是 5（rank 3）。
    if bits & WHEEL_MASK == WHEEL_MASK {
        return Some(3);
    }
    None
}

/// 恰好 5 张牌求 [`HandRank`]。
///
/// `cards` 内不得有重复牌编号（一副牌内）；重复属于调用方 bug，结果未定义。
pub fn evaluate5(cards: &[u8; 5]) -> HandRank {
    debug_assert!(
        cards.iter().all(|&c| c < 52),
        "牌编号必须在 0..52：{cards:?}"
    );
    let mut count = [0u8; 13];
    let mut bits = 0u16;
    for &c in cards {
        let r = card_rank(c);
        count[r as usize] += 1;
        bits |= 1 << r;
    }
    let flush = cards.iter().all(|&c| card_suit(c) == card_suit(cards[0]));
    let straight = straight_high(bits);

    // 分组：(重复次数, rank)，先按次数降序、同次按 rank 降序。
    // 组序即 kicker 比较序（如对子：对子 rank 先行，其余单张降序）；
    // 每个 rank 只出现一次（重复次数已编码在组序里），尾部填 0。
    let mut groups: [(u8, u8); 5] = [(0, 0); 5];
    let mut n_groups = 0usize;
    for r in (0..13u8).rev() {
        if count[r as usize] > 0 {
            groups[n_groups] = (count[r as usize], r);
            n_groups += 1;
        }
    }
    groups[..n_groups].sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));

    let mut kickers = [0u8; 5];
    if let Some(high) = straight {
        // 顺子或同花顺（5 张 5 rank，天然无对子）：kicker 只有高牌一位。
        kickers[0] = high;
        let category = if flush {
            HandCategory::StraightFlush
        } else {
            HandCategory::Straight
        };
        return HandRank { category, kickers };
    }

    for (slot, &(_, r)) in kickers.iter_mut().zip(groups[..n_groups].iter()) {
        *slot = r;
    }

    let category = match (groups[0].0, n_groups) {
        (4, _) => HandCategory::Quads,
        (3, 2) => HandCategory::FullHouse,
        (3, _) => HandCategory::Trips,
        (2, 3) => HandCategory::TwoPair,
        (2, _) => HandCategory::Pair,
        _ => {
            if flush {
                HandCategory::Flush
            } else {
                HandCategory::HighCard
            }
        }
    };
    HandRank { category, kickers }
}

/// 7 张牌（2 底牌 + 5 公共牌）取最优 5 张的 [`HandRank`]。
///
/// 朴素枚举全部 C(7,5)=21 种组合取最大；21 × 9 席的规模足够快，正确性优先。
pub fn evaluate7(cards: &[u8; 7]) -> HandRank {
    let mut best: Option<HandRank> = None;
    for a in 0..3 {
        for b in a + 1..4 {
            for c in b + 1..5 {
                for d in c + 1..6 {
                    for e in d + 1..7 {
                        let five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
                        let rank = evaluate5(&five);
                        if best.is_none_or(|bb| rank > bb) {
                            best = Some(rank);
                        }
                    }
                }
            }
        }
    }
    best.expect("21 种组合必然非空")
}

/// 摊牌比大小：返回并列最强的**全部**下标（升序），供分池使用。
///
/// 空输入返回空 vec；所有并列第一都计入（花色不影响大小）。
pub fn best_indices(ranks: &[HandRank]) -> Vec<usize> {
    let Some(&best) = ranks.iter().max() else {
        return Vec::new();
    };
    ranks
        .iter()
        .enumerate()
        .filter_map(|(i, r)| (*r == best).then_some(i))
        .collect()
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 牌编号便捷构造：rank(0..12) * 4 + suit(0..3)。
    const fn c(rank: u8, suit: u8) -> u8 {
        rank * 4 + suit
    }

    /// 指定类别 + kicker 的便捷构造。
    const fn hr(category: HandCategory, kickers: [u8; 5]) -> HandRank {
        HandRank { category, kickers }
    }

    use HandCategory::*;

    // ------------------------------------------------------------------
    // 字符串输出
    // ------------------------------------------------------------------

    #[test]
    fn card_str_formats_rank_and_suit() {
        assert_eq!(card_str(c(12, 3)), "As");
        assert_eq!(card_str(c(8, 1)), "Td");
        assert_eq!(card_str(c(0, 0)), "2c");
        assert_eq!(card_str(c(11, 2)), "Kh");
        assert_eq!(card_str(52), "??");
    }

    #[test]
    fn hand_rank_display() {
        assert_eq!(hr(StraightFlush, [12, 0, 0, 0, 0]).to_string(), "同花顺(A)");
        assert_eq!(hr(Straight, [3, 0, 0, 0, 0]).to_string(), "顺子(5)");
        assert_eq!(hr(Pair, [12, 11, 10, 7, 0]).to_string(), "一对(A K Q 9)");
        assert_eq!(hr(FullHouse, [11, 0, 0, 0, 0]).to_string(), "葫芦(K 2)");
        assert_eq!(
            hr(HighCard, [12, 8, 6, 5, 2]).to_string(),
            "高牌(A T 8 7 4)"
        );
    }

    // ------------------------------------------------------------------
    // 各类别检测 + kicker 区分
    // ------------------------------------------------------------------

    #[test]
    fn high_card_kickers_compare_in_order() {
        let a = evaluate5(&[c(12, 0), c(11, 1), c(10, 2), c(9, 3), c(7, 0)]); // A K Q J 9
        assert_eq!(a, hr(HighCard, [12, 11, 10, 9, 7]));
        let b = evaluate5(&[c(12, 1), c(11, 2), c(10, 3), c(9, 0), c(6, 1)]); // A K Q J 8
        assert!(a > b, "第 5 位 kicker 9 > 8");
        // 第一位就分胜负（注意避开顺子：K Q J 9 8 不成顺）。
        let c1 = evaluate5(&[c(12, 0), c(5, 1), c(4, 2), c(3, 3), c(1, 0)]); // A 高
        let c2 = evaluate5(&[c(11, 0), c(10, 1), c(9, 2), c(7, 3), c(6, 1)]); // K 高
        assert!(c1 > c2);
    }

    #[test]
    fn pair_kicker_decides() {
        // 对 A + K kicker vs 对 A + Q kicker。
        let ak = evaluate5(&[c(12, 0), c(12, 1), c(11, 2), c(8, 3), c(5, 0)]);
        assert_eq!(ak, hr(Pair, [12, 11, 8, 5, 0]));
        let aq = evaluate5(&[c(12, 2), c(12, 3), c(10, 0), c(8, 1), c(5, 2)]);
        assert_eq!(aq, hr(Pair, [12, 10, 8, 5, 0]));
        assert!(ak > aq);
        // 对子本身分胜负优先于 kicker。
        let kk = evaluate5(&[c(11, 0), c(11, 1), c(10, 2), c(8, 3), c(5, 1)]);
        assert!(ak > kk, "对 A > 对 K，与 kicker 无关");
    }

    #[test]
    fn two_pair_order_and_kicker() {
        let aakk_q = evaluate5(&[c(12, 0), c(12, 1), c(11, 2), c(11, 3), c(10, 0)]);
        assert_eq!(aakk_q, hr(TwoPair, [12, 11, 10, 0, 0]));
        let aakk_j = evaluate5(&[c(12, 2), c(12, 3), c(11, 0), c(11, 1), c(9, 2)]);
        assert!(aakk_q > aakk_j, "两对相同比单张 kicker");
        let aaqq = evaluate5(&[c(12, 0), c(12, 1), c(10, 2), c(10, 3), c(11, 0)]);
        assert!(aakk_j > aaqq, "低对 K > Q 优先于 kicker");
    }

    #[test]
    fn trips_kickers() {
        let kkk_aq = evaluate5(&[c(11, 0), c(11, 1), c(11, 2), c(12, 3), c(10, 0)]);
        assert_eq!(kkk_aq, hr(Trips, [11, 12, 10, 0, 0]));
        let kkk_aj = evaluate5(&[c(11, 3), c(11, 0), c(11, 1), c(12, 2), c(9, 1)]);
        assert!(kkk_aq > kkk_aj);
        let qqq = evaluate5(&[c(10, 0), c(10, 1), c(10, 2), c(12, 0), c(11, 1)]);
        assert_eq!(qqq.category, Trips);
        assert!(kkk_aj > qqq, "三条 K > 三条 Q");
    }

    #[test]
    fn straight_high_card_decides() {
        let broadway = evaluate5(&[c(12, 0), c(11, 1), c(10, 2), c(9, 3), c(8, 0)]);
        assert_eq!(broadway, hr(Straight, [12, 0, 0, 0, 0]));
        let nine_high = evaluate5(&[c(7, 1), c(6, 2), c(5, 3), c(4, 0), c(3, 1)]);
        assert_eq!(nine_high, hr(Straight, [7, 0, 0, 0, 0]));
        assert!(broadway > nine_high);
    }

    #[test]
    fn flush_kickers_and_flush_beats_straight() {
        let f1 = evaluate5(&[c(12, 2), c(10, 2), c(7, 2), c(4, 2), c(1, 2)]); // A Q 9 6 3 ♥
        assert_eq!(f1, hr(Flush, [12, 10, 7, 4, 1]));
        let f2 = evaluate5(&[c(12, 0), c(10, 0), c(7, 0), c(4, 0), c(0, 0)]); // A Q 9 6 2 ♣
        assert!(f1 > f2, "同花比到第 5 张");
        let straight = evaluate5(&[c(7, 1), c(6, 2), c(5, 3), c(4, 1), c(3, 2)]);
        assert!(f2 > straight, "同花 > 顺子（类别优先）");
    }

    #[test]
    fn full_house_trips_then_pair() {
        let aaa_kk = evaluate5(&[c(12, 0), c(12, 1), c(12, 2), c(11, 3), c(11, 0)]);
        assert_eq!(aaa_kk, hr(FullHouse, [12, 11, 0, 0, 0]));
        let kkk_aa = evaluate5(&[c(11, 1), c(11, 2), c(11, 3), c(12, 3), c(12, 0)]);
        assert_eq!(kkk_aa, hr(FullHouse, [11, 12, 0, 0, 0]));
        assert!(aaa_kk > kkk_aa, "葫芦先比三条");
        let aaa_qq = evaluate5(&[c(12, 0), c(12, 1), c(12, 3), c(10, 2), c(10, 3)]);
        assert!(aaa_kk > aaa_qq, "三条相同再比对子");
    }

    #[test]
    fn quads_and_straight_flush() {
        let aaaa_k = evaluate5(&[c(12, 0), c(12, 1), c(12, 2), c(12, 3), c(11, 0)]);
        assert_eq!(aaaa_k, hr(Quads, [12, 11, 0, 0, 0]));
        let aaaa_q = evaluate5(&[c(12, 0), c(12, 1), c(12, 2), c(12, 3), c(10, 1)]);
        assert!(aaaa_k > aaaa_q, "四条比单张");
        let kkkk = evaluate5(&[c(11, 0), c(11, 1), c(11, 2), c(11, 3), c(12, 2)]);
        assert!(aaaa_q > kkkk);

        let sf = evaluate5(&[c(8, 3), c(7, 3), c(6, 3), c(5, 3), c(4, 3)]); // T-6 ♠
        assert_eq!(sf, hr(StraightFlush, [8, 0, 0, 0, 0]));
        assert!(sf > aaaa_k, "同花顺 > 四条");

        // 皇家同花顺 = 高牌 A 的同花顺。
        let royal = evaluate5(&[c(12, 0), c(11, 0), c(10, 0), c(9, 0), c(8, 0)]);
        assert_eq!(royal, hr(StraightFlush, [12, 0, 0, 0, 0]));
        assert!(royal > sf);
    }

    // ------------------------------------------------------------------
    // 轮顺（A-2-3-4-5）
    // ------------------------------------------------------------------

    #[test]
    fn wheel_high_card_is_five_not_ace() {
        let wheel = evaluate5(&[c(12, 0), c(0, 1), c(1, 2), c(2, 3), c(3, 0)]);
        assert_eq!(
            wheel,
            hr(Straight, [3, 0, 0, 0, 0]),
            "轮顺高牌是 5（rank 3）"
        );
        let six_high = evaluate5(&[c(0, 0), c(1, 1), c(2, 2), c(3, 3), c(4, 0)]);
        assert_eq!(six_high, hr(Straight, [4, 0, 0, 0, 0]));
        assert!(six_high > wheel, "23456 > A2345");
        // 轮顺输给任何 6 高以上顺子，但赢所有三条及以下。
        let trips = evaluate5(&[c(12, 1), c(12, 2), c(12, 3), c(11, 0), c(10, 1)]);
        assert!(wheel > trips);
    }

    #[test]
    fn wheel_straight_flush() {
        let steel_wheel = evaluate5(&[c(12, 2), c(0, 2), c(1, 2), c(2, 2), c(3, 2)]);
        assert_eq!(steel_wheel, hr(StraightFlush, [3, 0, 0, 0, 0]));
        let six_sf = evaluate5(&[c(0, 1), c(1, 1), c(2, 1), c(3, 1), c(4, 1)]);
        assert!(six_sf > steel_wheel);
    }

    // ------------------------------------------------------------------
    // 不足 5 张的同花/顺子不计
    // ------------------------------------------------------------------

    #[test]
    fn four_flush_and_four_straight_do_not_count() {
        // 4 张 ♥ + 一张无关牌：只能是高牌，不是同花。
        let four_flush = evaluate7(&[
            c(12, 2),
            c(9, 2),
            c(6, 2),
            c(3, 2),
            c(10, 0),
            c(7, 1),
            c(2, 3),
        ]);
        assert_eq!(four_flush.category, HighCard);
        assert_eq!(four_flush.kickers, [12, 10, 9, 7, 6]);

        // 4 连张 + 无法补顺：只能是高牌，不是顺子。
        let four_straight = evaluate7(&[
            c(11, 0),
            c(10, 1),
            c(9, 2),
            c(8, 3),
            c(12, 1),
            c(1, 0),
            c(0, 2),
        ]);
        // A K Q J T 是顺子——把 T 换成无关牌再测。
        assert_eq!(four_straight.category, Straight); // 这手其实是 Broadway
        let four_only = evaluate7(&[
            c(10, 0),
            c(9, 1),
            c(8, 2),
            c(7, 3),
            c(12, 1),
            c(12, 2),
            c(1, 0),
        ]);
        assert_eq!(four_only.category, Pair, "只有 4 连张，对 A 成牌");
        assert_eq!(four_only.kickers, [12, 10, 9, 8, 0]);
    }

    // ------------------------------------------------------------------
    // evaluate7 已知答案
    // ------------------------------------------------------------------

    #[test]
    fn evaluate7_picks_best_five() {
        // 底牌 A♠ A♥，公共 A♦ K♣ K♥ Q♠ J♦：葫芦 A 满 K（优于三条 A）。
        let h = evaluate7(&[
            c(12, 3),
            c(12, 2),
            c(12, 1),
            c(11, 0),
            c(11, 2),
            c(10, 3),
            c(9, 1),
        ]);
        assert_eq!(h, hr(FullHouse, [12, 11, 0, 0, 0]));

        // 同花听牌 + 对子：同花胜出。
        // ♠: A 5 4 3 2 + K♥ Q♦ → 同花 A 5 4 3 2（注意：5 张 ♠ 同时是轮顺 → 同花顺！）
        let sf = evaluate7(&[
            c(12, 3),
            c(3, 3),
            c(2, 3),
            c(1, 3),
            c(0, 3),
            c(11, 2),
            c(10, 1),
        ]);
        assert_eq!(
            sf,
            hr(StraightFlush, [3, 0, 0, 0, 0]),
            "5 张 ♠ 恰好成轮顺同花顺"
        );

        // 公共牌 5 张 ♥（A J 9 6 4），底牌 K♣ Q♣ 不补花：一起玩公共牌。
        let board_flush = evaluate7(&[
            c(11, 0),
            c(10, 0),
            c(12, 1),
            c(9, 1),
            c(7, 1),
            c(4, 1),
            c(2, 1),
        ]);
        assert_eq!(board_flush, hr(Flush, [12, 9, 7, 4, 2]));
    }

    #[test]
    fn evaluate7_ordering_known_matchups() {
        // 经典对决：set over set。
        let set_a = evaluate7(&[
            c(12, 0),
            c(12, 1),
            c(12, 2),
            c(7, 3),
            c(5, 0),
            c(3, 1),
            c(1, 2),
        ]);
        let set_k = evaluate7(&[
            c(11, 0),
            c(11, 1),
            c(11, 2),
            c(7, 0),
            c(5, 1),
            c(3, 2),
            c(1, 3),
        ]);
        assert!(set_a > set_k);

        // 顶两对 vs 纯顺子。
        let two_pair = evaluate7(&[
            c(12, 0),
            c(12, 1),
            c(11, 2),
            c(11, 3),
            c(5, 2),
            c(2, 0),
            c(0, 1),
        ]);
        let straight = evaluate7(&[
            c(6, 0),
            c(5, 1),
            c(4, 2),
            c(3, 3),
            c(2, 2),
            c(12, 3),
            c(0, 3),
        ]);
        assert!(straight > two_pair);

        // 同花顺 > 四条（7 牌池里同取最优）。
        let quads = evaluate7(&[
            c(9, 0),
            c(9, 1),
            c(9, 2),
            c(9, 3),
            c(12, 0),
            c(11, 0),
            c(2, 1),
        ]);
        let sf = evaluate7(&[
            c(5, 2),
            c(4, 2),
            c(3, 2),
            c(2, 2),
            c(1, 2),
            c(12, 1),
            c(0, 0),
        ]);
        assert_eq!(quads.category, Quads);
        assert!(sf > quads);
    }

    // ------------------------------------------------------------------
    // 平局与 best_indices
    // ------------------------------------------------------------------

    #[test]
    fn identical_ranks_different_suits_are_equal() {
        // 同 rank 不同花色：严格相等（分池）。
        let a = evaluate5(&[c(12, 0), c(12, 1), c(11, 2), c(8, 3), c(5, 0)]);
        let b = evaluate5(&[c(12, 2), c(12, 3), c(11, 0), c(8, 1), c(5, 2)]);
        assert_eq!(a.cmp(&b), core::cmp::Ordering::Equal);
        assert_eq!(a, b);

        // 7 牌池：双方底牌都无关、只能玩公共牌，严格平局。
        let p1 = evaluate7(&[
            c(0, 0),
            c(1, 0),
            c(12, 2),
            c(11, 2),
            c(10, 2),
            c(9, 2),
            c(8, 2),
        ]);
        let p2 = evaluate7(&[
            c(0, 1),
            c(1, 1),
            c(12, 3),
            c(11, 3),
            c(10, 3),
            c(9, 3),
            c(8, 3),
        ]);
        assert_eq!(p1, hr(StraightFlush, [12, 0, 0, 0, 0]));
        assert_eq!(p1, p2, "同 rank 同花顺不同花色：平分");
    }

    #[test]
    fn best_indices_returns_all_tied_winners() {
        let pair_a = hr(Pair, [12, 11, 8, 5, 0]);
        let pair_a_dup = hr(Pair, [12, 11, 8, 5, 0]);
        let pair_k = hr(Pair, [11, 12, 10, 9, 0]);
        let ranks = [pair_k, pair_a, pair_k, pair_a_dup];
        assert_eq!(best_indices(&ranks), vec![1, 3], "两个对 A 平分");
        assert_eq!(best_indices(&[pair_k]), vec![0]);
        assert_eq!(best_indices(&[]), Vec::<usize>::new());
    }

    // ------------------------------------------------------------------
    // 随机 sanity：xorshift PRNG，不引外部 rand crate
    // ------------------------------------------------------------------

    /// xorshift64*：测试内自含的确定性 PRNG。
    struct XorShift(u64);

    impl XorShift {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
    }

    #[test]
    fn evaluate7_never_panics_on_random_draws() {
        let mut rng = XorShift(0x9E37_79B9_7F4A_7C15);
        for _ in 0..500 {
            // Fisher–Yates 洗 52 张取前 7。
            let mut deck: [u8; 52] = core::array::from_fn(|i| i as u8);
            for i in (1..52).rev() {
                let j = (rng.next() % (i as u64 + 1)) as usize;
                deck.swap(i, j);
            }
            let seven: [u8; 7] = deck[..7].try_into().unwrap();
            let best = evaluate7(&seven);

            // 不变量：evaluate7 = 21 个 5 张组合的最大值（与任意子集一致）。
            let sub5: [u8; 5] = seven[..5].try_into().unwrap();
            assert!(best >= evaluate5(&sub5));

            // 不变量：kicker 都是合法 rank，顺子类只有一位有效 kicker。
            assert!(best.kickers.iter().all(|&k| k <= 12));
            match best.category {
                Straight | StraightFlush => assert_eq!(&best.kickers[1..], &[0; 4]),
                FullHouse => assert_ne!(best.kickers[0], best.kickers[1]),
                _ => {}
            }
            // 高牌/同花必须严格降序。
            if matches!(best.category, HighCard | Flush) {
                assert!(best.kickers.windows(2).all(|w| w[0] > w[1]));
            }
        }
    }

    #[test]
    fn category_ordering_is_strict() {
        // 类别序：高牌 < 对子 < 两对 < 三条 < 顺子 < 同花 < 葫芦 < 四条 < 同花顺。
        let order = [
            HighCard,
            Pair,
            TwoPair,
            Trips,
            Straight,
            Flush,
            FullHouse,
            Quads,
            StraightFlush,
        ];
        for w in order.windows(2) {
            assert!(w[0] < w[1]);
        }
    }
}
