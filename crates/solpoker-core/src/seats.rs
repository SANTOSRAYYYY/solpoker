//! 九席固定座位的掩码与顺时针扫描助手（D7：v1 完整支持 2–9 人）。
//!
//! 物理座位固定为 `0..8`（`MAX_SEATS = 9`），每手 `hand_mask` 有 2–9 个 bit。
//! 座位 i 对应掩码 bit i（`1 << i`）。所有座位扫描（发牌顺序、行动顺序、
//! 庄位轮转、奇数筹码发放）统一调用 [`next_clockwise`]。

/// 固定物理座位数（设计 §3.2：Game.seats 固定 9 项；D7.1）。
pub const MAX_SEATS: u8 = 9;

/// 座位 i 在掩码中的 bit。`1u16 << i`，i ∈ 0..8。
pub const fn seat_bit(seat: u8) -> u16 {
    1u16 << seat
}

/// 掩码中 set bit 的数量。
///
/// `hand_mask` 必须满足 2 ≤ popcount ≤ 9（D7.1）。
pub fn popcount(mask: u16) -> u8 {
    mask.count_ones() as u8
}

/// 掩码中第 n（0 起）个 set bit 对应的座位号，按座位升序数。
///
/// 例如 `nth_set_bit(0b10100, 1) == Some(4)`。n 越界时返回 `None`。
/// 第一手庄位用 `seed_0 mod popcount(hand_mask)` 选中后，用本函数映射到座位。
pub fn nth_set_bit(mask: u16, n: u8) -> Option<u8> {
    if n >= popcount(mask) {
        return None;
    }
    let mut seen = 0u8;
    for seat in 0..MAX_SEATS {
        if mask & seat_bit(seat) != 0 {
            if seen == n {
                return Some(seat);
            }
            seen += 1;
        }
    }
    None
}

/// 从 `from` 座位开始，在 `mask` 中找严格下一位（顺时针）被占用的座位，
/// 到 8 号后绕回 0 号。
///
/// - 用于：庄位轮转（button 移到下一位合格参与者）、SB/BB 定位、
///   发牌起点（button 左侧第一位）、行动顺序、奇数筹码顺时针发放；
/// - `from` 本身不计入结果（「下一位」是严格顺时针的下一个）；
/// - 返回 `None` 当且仅当 `mask` 为空；若 `mask` 只剩 `from` 自己，绕一圈
///   后返回 `from`（调用方的轮转/发放循环可以无条件继续，无需特判）。
///   注意：开手的 `hand_mask` 必有 2–9 人（D7.1），单人情形只会出现在
///   桌边等待等非发牌路径。
///
/// # 示例
/// ```
/// use solpoker_core::seats::next_clockwise;
/// assert_eq!(next_clockwise(0, 0b111), Some(1)); // 绕圈：0 之后是 1
/// assert_eq!(next_clockwise(2, 0b111), Some(0)); // 2 之后绕回 0
/// ```
pub fn next_clockwise(from: u8, mask: u16) -> Option<u8> {
    if from >= MAX_SEATS {
        return None;
    }
    for offset in 1..=MAX_SEATS as u16 {
        let seat = ((from as u16 + offset) % MAX_SEATS as u16) as u8;
        if mask & seat_bit(seat) != 0 {
            return Some(seat);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn popcount_and_nth_set_bit() {
        assert_eq!(popcount(0), 0);
        assert_eq!(popcount(0b1), 1);
        assert_eq!(popcount(0b101_0101_0101), 6);
        assert_eq!(popcount(0x1FF), 9);

        assert_eq!(nth_set_bit(0b10100, 0), Some(2));
        assert_eq!(nth_set_bit(0b10100, 1), Some(4));
        assert_eq!(nth_set_bit(0b10100, 2), None);
        assert_eq!(nth_set_bit(0x1FF, 8), Some(8));
        assert_eq!(nth_set_bit(0x1FF, 9), None);
    }

    #[test]
    fn next_clockwise_wraps_on_full_ring() {
        let full = 0x1FF; // 9 人全满
        assert_eq!(next_clockwise(0, full), Some(1));
        assert_eq!(next_clockwise(7, full), Some(8));
        assert_eq!(next_clockwise(8, full), Some(0)); // 绕回
    }

    #[test]
    fn next_clockwise_skips_empty_seats() {
        // 稀疏 9 席：只有 0、4、8 有人。
        let sparse = 0b1_0001_0001;
        assert_eq!(next_clockwise(0, sparse), Some(4));
        assert_eq!(next_clockwise(4, sparse), Some(8));
        assert_eq!(next_clockwise(8, sparse), Some(0));
    }

    #[test]
    fn heads_up_masks() {
        // 2 人常见布局：button=SB 与 BB 坐对角。
        let two = 0b0_0000_0011; // 座位 0、1
        assert_eq!(next_clockwise(0, two), Some(1));
        assert_eq!(next_clockwise(1, two), Some(0));

        let two_sparse = 0b0_0100_0001; // 座位 0、6
        assert_eq!(next_clockwise(0, two_sparse), Some(6));
        assert_eq!(next_clockwise(6, two_sparse), Some(0));
        assert_eq!(nth_set_bit(two_sparse, 1), Some(6));
    }

    #[test]
    fn next_clockwise_alone_returns_self_and_empty_returns_none() {
        // 单人掩码：绕一圈回到自己（保证轮转/发放循环 total，不用特判）。
        let only_me = 0b0_0000_0100; // 只有自己
        assert_eq!(next_clockwise(2, only_me), Some(2));
        // 空掩码：唯一的 None 情形。
        assert_eq!(next_clockwise(5, 0), None);
    }

    #[test]
    fn button_rotation_covers_whole_table() {
        // 庄位轮转一圈回到起点（3–9 人：不因换人重掷，只顺移）。
        let mask = 0b0_0101_0111; // 座位 0,1,2,4,6
        let mut button = 0u8;
        let mut order = vec![button];
        for _ in 0..4 {
            button = next_clockwise(button, mask).unwrap();
            order.push(button);
        }
        assert_eq!(order, vec![0, 1, 2, 4, 6]);
        // 再移一位回到起点。
        assert_eq!(next_clockwise(button, mask), Some(0));
    }
}
