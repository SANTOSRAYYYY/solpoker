//! Stage 5 规则引擎：2–9 人 No-Limit Hold'em 的下注轮状态机（主设计文档 §7.1 的定稿实现）。
//!
//! 职责边界：
//! - 本模块只管「钱和轮次」：强制注、动作合法性、`pending`/`actionable` 掩码维护、
//!   街推进、runout 触发条件、行动超时；**不含**任何 VRF / 发牌 / 盐逻辑
//!   （那些归 [`crate::deal`] 与链上 `advance`），也不 emit 事件——链上指令
//!   根据每次 [`Engine::act`] 的状态转移追加 transcript 事件（§8.5）。
//! - 一手一个 [`Engine`] 实例：开局用 [`Engine::new`] 构造并自动投强制注
//!   （庄位由调用方给出：第一手来自 [`crate::deal::first_button`]，此后顺时针轮转，
//!   引擎本身不计算庄位）；之后玩家用 [`Engine::act`] 行动，任何人用
//!   [`Engine::claim_timeout`] 处理超时；结算与 rake 在 [`crate::settle`]。
//!
//! 金额单位（§7.1）：全部为 u64 基础单位（1 USDC = 1_000_000），且所有
//! 买入/ante/盲注/下注/stack 都是 [`CENT`]（10_000 = 0.01 USDC）的整数倍；
//! 因为所有输入都是 CENT 的整数倍，call/all-in 推出的金额自然也是。
//!
//! 掩码不变量（每次动作后由 [`Engine::recompute_masks`] 重建）：
//! `pending_to_act_mask ⊆ actionable_mask ⊆ live_mask ⊆ hand_mask ⊆ occupied_mask`，
//! 其中 `live = hand & !folded`，`actionable = live & !all_in & (stack > 0)`。

use crate::deal::{STREET_FLOP, STREET_PREFLOP, STREET_RIVER};
use crate::seats::{next_clockwise, popcount, seat_bit, MAX_SEATS};

/// 金额粒度：0.01 USDC = 10_000 基础单位（§7.1「金额粒度」）。
pub const CENT: u64 = 10_000;

// ---------------------------------------------------------------------------
// 动作与错误
// ---------------------------------------------------------------------------

/// 玩家动作（§7.1）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// 弃牌：能 check 时也允许 fold。
    Fold,
    /// 过牌：仅当 `current_bet == street_bet`。
    Check,
    /// 跟注：支付 `min(current_bet - street_bet, stack)`；短码跟注即 all-in，不重新开放。
    Call,
    /// 翻后首笔下注（仅 `street >= 1` 且 `current_bet == 0`）：`amount >= 1BB` 且 `<= stack`，
    /// 语义等价于 `RaiseTo(amount)`。
    Bet(u64),
    /// 加注到的总目标额（本轮 `street_bet` 的目标值）：增量 `target - current_bet`
    /// 必须 `>= last_full_raise`，且 `target <= street_bet + stack`。
    RaiseTo(u64),
    /// 全下：目标 `street_bet + stack`；增量足额视为完整加注（重新开放），
    /// 不足额只抬高 `current_bet`、不重新开放（§7.1「不足额 all-in」）。
    AllIn,
}

/// 规则引擎错误。所有错误都在**校验阶段**返回，状态保持不变（§7.3「合法性」）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineError {
    /// 本手已结束（`finished` 或等待 runout），不再接受动作。
    HandOver,
    /// 座位号越界或不在本手 `hand_mask` 中。
    SeatNotInHand,
    /// 不是该座位的行动轮（`seat != to_act` 或不在 `pending_to_act_mask`）。
    NotYourTurn,
    /// 当前需要跟注，不能 check。
    CheckNotAllowed,
    /// 无需跟注（`current_bet == street_bet`，应使用 Check）。
    CallNotAllowed,
    /// 当前街不允许 Bet（仅翻后 `current_bet == 0` 时可 Bet）。
    BetNotAllowed,
    /// 下注低于最小额（翻后最小 1BB）。
    BelowMinBet,
    /// 加注目标不超过 `current_bet`，或增量小于 `last_full_raise`。
    BelowMinRaise,
    /// 金额超过可负担范围（`street_bet + stack`）。
    AboveStack,
    /// 金额不是 [`CENT`] 的整数倍。
    NotCentMultiple,
    /// 不足额 all-in 未重新开放行动，已行动者（`acted = true`）只能 call/fold。
    RaiseNotReopened,
    /// 开局构造参数非法（人数、掩码、庄位、盲注结构、stack 粒度）。
    InvalidConfig,
}

/// 一次动作导致的推进结果（供链上决定是否 arm VRF / 进入结算）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ActOutcome {
    /// 本街下注轮已结束（`pending_to_act_mask == 0`）。
    pub street_ended: bool,
    /// 触发 runout：待回应清零且 `live >= 2`、`actionable <= 1`，
    /// 链上 advance 用一次 runout VRF 补完剩余公共牌（§6.1 AwaitRunout）。
    pub runout_started: bool,
    /// 本手结束（live 剩一人，或河牌下注轮结束），进入结算。
    pub hand_finished: bool,
}

/// 超时处理结果（§6.3：能 check 就 check，否则 fold）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeoutResult {
    /// 无需跟注，自动 check。
    Checked(ActOutcome),
    /// 需要跟注，自动 fold。
    Folded(ActOutcome),
}

// ---------------------------------------------------------------------------
// 座位与引擎状态
// ---------------------------------------------------------------------------

/// 单个座位在一手牌中的状态。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EngineSeat {
    /// 当前可用筹码（本手尚未投入的部分）。
    pub stack: u64,
    /// 本手累计投入（含 ante/盲注/各街下注；结算时据此构建主池/边池）。
    pub in_hand: u64,
    /// 本街已下注额（ante 不计入，§7.1「ante 是死钱」）。
    pub street_bet: u64,
    /// 是否本手参与者（`hand_mask` 对应 bit）。
    pub in_hand_mask: bool,
    /// 是否已弃牌。
    pub folded: bool,
    /// 是否已全下（`stack == 0` 时置位）。
    pub all_in: bool,
    /// 本轮是否已行动过。完整加注会为其他人清零（重新开放加注权）；
    /// 不足额 all-in 不清零——`acted = true` 的玩家被重新加回 pending 时只能 call/fold。
    pub acted: bool,
    /// 行动超时次数（§6.3）。引擎只增不减；「主动行动清零」「连续 3 次自动站起」
    /// 由链上在本手结束时处理。
    pub strikes: u8,
    /// 是否请求离座（本手结束后生效；引擎不消费，链上读取）。
    pub leave_requested: bool,
}

/// 一手牌的规则引擎状态（纯数据 + 确定性转移；字段公开以便链上账户零拷贝映射，
/// 但所有推进必须通过 [`Engine::new`] / [`Engine::act`] / [`Engine::claim_timeout`] /
/// [`crate::settle`] 进行，以保证掩码不变量）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Engine {
    /// 九个物理座位的状态（未占用的座位全零）。
    pub seats: [EngineSeat; MAX_SEATS as usize],
    /// 本手庄位（输入：第一手由发牌协议 `first_button` 给出，此后调用方顺时针轮转）。
    pub button: u8,
    /// 桌上已占用座位掩码。
    pub occupied_mask: u16,
    /// 本手参与者掩码（2–9 个 bit，D7.1）。
    pub hand_mask: u16,
    /// 仍在牌局中：`hand & !folded`。
    pub live_mask: u16,
    /// 可行动：`live & !all_in & (stack > 0)`。
    pub actionable_mask: u16,
    /// 仍欠一次行动的玩家（`⊆ actionable`）；归零即本街结束。
    pub pending_to_act_mask: u16,
    /// 底池：本手已投入的全部筹码（`Σ in_hand`，含死钱 ante）。
    pub pot: u64,
    /// 本轮当前注额（各玩家 `street_bet` 需要对齐的目标）。
    pub current_bet: u64,
    /// 本轮上一次**完整**加注的增量；街初为 1BB（翻前最小加注到 2BB，翻后最小下注 1BB）。
    pub last_full_raise: u64,
    /// 当前行动座位（仅当 `pending_to_act_mask != 0` 时有意义）。
    pub to_act: u8,
    /// 当前街：0=翻前 1=翻牌 2=转牌 3=河牌（编号与 [`crate::deal`] 一致）。
    pub street: u8,
    /// 小盲。
    pub sb: u64,
    /// 大盲。
    pub bb: u64,
    /// 前注（0.1BB，死钱）。
    pub ante: u64,
    /// 翻牌是否已发出（rake 的 no-flop-no-drop 条件，§7.2）。引擎在街推进到翻牌时置位；
    /// 若翻前直接 runout，链上补发公共牌的 advance 负责置位（翻牌已发出即收 rake）。
    pub flop_dealt: bool,
    /// 是否等待 runout（自动发完剩余公共牌，§7.1「自动发完公共牌」）。
    pub runout_needed: bool,
    /// 本手是否结束（进入结算）。
    pub finished: bool,
}

impl Engine {
    /// 开局：校验参数、投强制注（ante → SB → BB）、定位翻前首个行动者。
    ///
    /// - `stacks`：九席开局筹码（`hand_mask` 内必须非零且为 CENT 整数倍）；
    /// - `hand_mask` ⊆ `occupied_mask`，2–9 个 bit；`button` 必须在 `hand_mask` 内；
    /// - `sb <= bb`，`sb`/`bb`/`ante` 都是 CENT 整数倍，`bb > 0`。
    ///
    /// 投完强制注后 `current_bet = bb`、`last_full_raise = bb`。
    /// 极端短码（盲注后无人可动）会直接置 `runout_needed`。
    pub fn new(
        stacks: &[u64; MAX_SEATS as usize],
        occupied_mask: u16,
        hand_mask: u16,
        button: u8,
        sb: u64,
        bb: u64,
        ante: u64,
    ) -> Result<Self, EngineError> {
        let players = popcount(hand_mask);
        if !(2..=MAX_SEATS).contains(&players) {
            return Err(EngineError::InvalidConfig);
        }
        if hand_mask & !occupied_mask != 0 {
            return Err(EngineError::InvalidConfig);
        }
        if button >= MAX_SEATS || hand_mask & seat_bit(button) == 0 {
            return Err(EngineError::InvalidConfig);
        }
        if bb == 0 || sb > bb {
            return Err(EngineError::InvalidConfig);
        }
        if sb % CENT != 0 || bb % CENT != 0 || ante % CENT != 0 {
            return Err(EngineError::NotCentMultiple);
        }
        for s in 0..MAX_SEATS {
            if hand_mask & seat_bit(s) == 0 {
                continue;
            }
            if stacks[s as usize] == 0 {
                return Err(EngineError::InvalidConfig);
            }
            if stacks[s as usize] % CENT != 0 {
                return Err(EngineError::NotCentMultiple);
            }
        }

        let mut seats = [EngineSeat::default(); MAX_SEATS as usize];
        for s in 0..MAX_SEATS {
            seats[s as usize].stack = stacks[s as usize];
            seats[s as usize].in_hand_mask = hand_mask & seat_bit(s) != 0;
        }
        let mut engine = Engine {
            seats,
            button,
            occupied_mask,
            hand_mask,
            live_mask: hand_mask,
            actionable_mask: 0,
            pending_to_act_mask: 0,
            pot: 0,
            current_bet: 0,
            last_full_raise: bb,
            to_act: button,
            street: STREET_PREFLOP,
            sb,
            bb,
            ante,
            flop_dealt: false,
            runout_needed: false,
            finished: false,
        };
        engine.post_forced_bets();
        engine.current_bet = bb;
        engine.last_full_raise = bb;
        engine.recompute_masks();
        engine.pending_to_act_mask = engine.actionable_mask;
        let anchor = engine.street_anchor();
        engine.to_act = engine
            .scan_from(anchor, engine.pending_to_act_mask)
            .unwrap_or(anchor);
        // 极端短码：盲注后可能全员 all-in（pending 为空），直接关街触发 runout。
        engine.close_streets();
        Ok(engine)
    }

    // -----------------------------------------------------------------------
    // 位置与查询
    // -----------------------------------------------------------------------

    /// 是否单挑（2 人特殊规则，§7.1「位置」）。
    pub fn heads_up(&self) -> bool {
        popcount(self.hand_mask) == 2
    }

    /// SB 座位：3–9 人为 button 左侧第一位；2 人时 button 即 SB。
    pub fn sb_seat(&self) -> u8 {
        if self.heads_up() {
            self.button
        } else {
            next_clockwise(self.button, self.hand_mask).expect("hand_mask 非空")
        }
    }

    /// BB 座位：SB 左侧第一位（2 人时即非 button 的另一家）。
    pub fn bb_seat(&self) -> u8 {
        next_clockwise(self.sb_seat(), self.hand_mask).expect("hand_mask 非空")
    }

    /// 本手是否已不可再行动（结束或等待 runout）。
    pub fn is_over(&self) -> bool {
        self.finished || self.runout_needed
    }

    /// `seat` 当前跟注所需金额（未对齐 `current_bet` 的差额；已对齐时为 0）。
    pub fn call_amount(&self, seat: u8) -> u64 {
        self.current_bet
            .saturating_sub(self.seats[seat as usize].street_bet)
    }

    /// 当前最小加注目标额（`current_bet == 0` 时为 1BB，即翻后最小下注）。
    pub fn min_raise_to(&self) -> u64 {
        if self.current_bet == 0 {
            self.bb
        } else {
            self.current_bet + self.last_full_raise
        }
    }

    /// `seat` 当前是否可以 check。
    pub fn can_check(&self, seat: u8) -> bool {
        self.current_bet == self.seats[seat as usize].street_bet
    }

    // -----------------------------------------------------------------------
    // 动作
    // -----------------------------------------------------------------------

    /// 玩家行动。所有非法动作在校验阶段返回 `Err`，状态保持不变（§7.3「合法性」）。
    pub fn act(&mut self, seat: u8, action: Action) -> Result<ActOutcome, EngineError> {
        if self.is_over() {
            return Err(EngineError::HandOver);
        }
        if seat >= MAX_SEATS || self.hand_mask & seat_bit(seat) == 0 {
            return Err(EngineError::SeatNotInHand);
        }
        if seat != self.to_act || self.pending_to_act_mask & seat_bit(seat) == 0 {
            return Err(EngineError::NotYourTurn);
        }
        let street_bet = self.seats[seat as usize].street_bet;
        let stack = self.seats[seat as usize].stack;
        let acted = self.seats[seat as usize].acted;

        match action {
            Action::Fold => {
                // 能 check 时也允许 fold（§7.1）。
                self.seats[seat as usize].folded = true;
            }
            Action::Check => {
                if self.current_bet != street_bet {
                    return Err(EngineError::CheckNotAllowed);
                }
                self.seats[seat as usize].acted = true;
            }
            Action::Call => {
                let owe = self.current_bet - street_bet;
                if owe == 0 {
                    return Err(EngineError::CallNotAllowed);
                }
                // 短码跟注：支付全部 stack 即 all-in；call 永不重新开放行动。
                let pay = owe.min(stack);
                self.move_chips(seat, pay);
                self.seats[seat as usize].acted = true;
            }
            Action::Bet(amount) => {
                if self.street == STREET_PREFLOP || self.current_bet != 0 {
                    return Err(EngineError::BetNotAllowed);
                }
                if amount % CENT != 0 {
                    return Err(EngineError::NotCentMultiple);
                }
                if amount < self.bb {
                    return Err(EngineError::BelowMinBet);
                }
                if amount > stack {
                    return Err(EngineError::AboveStack);
                }
                if acted {
                    return Err(EngineError::RaiseNotReopened);
                }
                // Bet 视为「加到 amount」的完整加注（current_bet == 0，增量即 amount >= 1BB）。
                self.apply_raise(seat, amount);
            }
            Action::RaiseTo(target) => {
                if target % CENT != 0 {
                    return Err(EngineError::NotCentMultiple);
                }
                if target <= self.current_bet {
                    return Err(EngineError::BelowMinRaise);
                }
                if target - self.current_bet < self.last_full_raise {
                    return Err(EngineError::BelowMinRaise);
                }
                if target > street_bet + stack {
                    return Err(EngineError::AboveStack);
                }
                if acted {
                    return Err(EngineError::RaiseNotReopened);
                }
                self.apply_raise(seat, target);
            }
            Action::AllIn => {
                let target = street_bet + stack;
                if target > self.current_bet && target - self.current_bet >= self.last_full_raise {
                    // 足额 all-in：等价完整加注，重新开放行动。
                    if acted {
                        return Err(EngineError::RaiseNotReopened);
                    }
                    self.apply_raise(seat, target);
                } else {
                    // 不足额 all-in（§7.1）：current_bet 只在被推高时更新，但**不重新开放**——
                    // 仍欠额的可行动玩家被重新加回 pending，其中已行动者保留
                    // `acted = true`（只能 call/fold）；未行动者 `acted = false`，仍可加注。
                    self.move_chips(seat, stack);
                    self.seats[seat as usize].acted = true;
                    if target > self.current_bet {
                        self.current_bet = target;
                        self.recompute_masks();
                        let mut behind = 0u16;
                        for s in 0..MAX_SEATS {
                            if s == seat {
                                continue;
                            }
                            if self.actionable_mask & seat_bit(s) != 0
                                && self.seats[s as usize].street_bet < self.current_bet
                            {
                                behind |= seat_bit(s);
                            }
                        }
                        self.pending_to_act_mask |= behind;
                    }
                }
            }
        }

        self.pending_to_act_mask &= !seat_bit(seat);
        self.recompute_masks();
        // 防御：pending ⊆ actionable（fold/all-in 已把人移出 actionable）。
        self.pending_to_act_mask &= self.actionable_mask;
        Ok(self.advance_turn(seat))
    }

    /// 行动超时（§6.3）：能 check 就 check，否则 fold；`strikes += 1`。
    ///
    /// 只允许对当前行动座位调用（截止时间由链上校验）。
    /// 引擎不清零 strikes；「连续 3 次自动站起」由链上在本手结束时处理。
    pub fn claim_timeout(&mut self, seat: u8) -> Result<TimeoutResult, EngineError> {
        if self.is_over() {
            return Err(EngineError::HandOver);
        }
        if seat >= MAX_SEATS || self.hand_mask & seat_bit(seat) == 0 {
            return Err(EngineError::SeatNotInHand);
        }
        if seat != self.to_act || self.pending_to_act_mask & seat_bit(seat) == 0 {
            return Err(EngineError::NotYourTurn);
        }
        self.seats[seat as usize].strikes = self.seats[seat as usize].strikes.saturating_add(1);
        if self.can_check(seat) {
            let outcome = self.act(seat, Action::Check)?;
            Ok(TimeoutResult::Checked(outcome))
        } else {
            let outcome = self.act(seat, Action::Fold)?;
            Ok(TimeoutResult::Folded(outcome))
        }
    }

    // -----------------------------------------------------------------------
    // 内部：强制注 / 筹码移动 / 掩码与轮次推进
    // -----------------------------------------------------------------------

    /// 强制投入（§7.1）：`hand_mask` 全员按座位升序投 ante（死钱，不计入
    /// `street_bet`）→ SB → BB。短码先 ante 再尽量投盲注，不够即 all-in。
    fn post_forced_bets(&mut self) {
        for s in 0..MAX_SEATS {
            if self.hand_mask & seat_bit(s) != 0 {
                self.pay_in(s, self.ante, false);
            }
        }
        let sb_seat = self.sb_seat();
        let bb_seat = self.bb_seat();
        self.pay_in(sb_seat, self.sb, true);
        self.pay_in(bb_seat, self.bb, true);
    }

    /// 强制注支付：`min(应付, stack)`， ante 用 `to_street = false`。
    fn pay_in(&mut self, seat: u8, amount: u64, to_street: bool) {
        let s = &mut self.seats[seat as usize];
        let pay = amount.min(s.stack);
        s.stack -= pay;
        s.in_hand += pay;
        if to_street {
            s.street_bet += pay;
        }
        if s.stack == 0 {
            s.all_in = true;
        }
        self.pot += pay;
    }

    /// 下注筹码移动（动作阶段，必计入 `street_bet` 与 `pot`）。
    fn move_chips(&mut self, seat: u8, amount: u64) {
        debug_assert!(amount <= self.seats[seat as usize].stack);
        let s = &mut self.seats[seat as usize];
        s.stack -= amount;
        s.in_hand += amount;
        s.street_bet += amount;
        if s.stack == 0 {
            s.all_in = true;
        }
        self.pot += amount;
    }

    /// 完整加注（含 Bet 与足额 all-in）：抬高 `current_bet`，刷新
    /// `last_full_raise`，除加注者外的 actionable 玩家全部回到 pending、acted 清零。
    fn apply_raise(&mut self, seat: u8, target: u64) {
        let cost = target - self.seats[seat as usize].street_bet;
        let increment = target - self.current_bet;
        self.move_chips(seat, cost);
        self.current_bet = target;
        self.last_full_raise = increment;
        for s in 0..MAX_SEATS as usize {
            self.seats[s].acted = s == seat as usize;
        }
        self.recompute_masks();
        self.pending_to_act_mask = self.actionable_mask & !seat_bit(seat);
    }

    /// 由座位状态重建 `live_mask` 与 `actionable_mask`。
    fn recompute_masks(&mut self) {
        let mut folded = 0u16;
        let mut blocked = 0u16;
        for s in 0..MAX_SEATS {
            let seat = &self.seats[s as usize];
            if seat.folded {
                folded |= seat_bit(s);
            }
            if seat.all_in || seat.stack == 0 {
                blocked |= seat_bit(s);
            }
        }
        self.live_mask = self.hand_mask & !folded;
        self.actionable_mask = self.live_mask & !blocked;
    }

    /// 本街首个行动者的扫描起点（含起点座位，§7.1「位置」）：
    /// 3–9 人翻前从 BB 左侧开始、翻后从 button 左侧开始；2 人翻前 button 先、翻后 BB 先。
    fn street_anchor(&self) -> u8 {
        if self.street == STREET_PREFLOP {
            if self.heads_up() {
                self.button
            } else {
                next_clockwise(self.bb_seat(), self.hand_mask).unwrap_or(self.button)
            }
        } else if self.heads_up() {
            self.bb_seat()
        } else {
            next_clockwise(self.button, self.hand_mask).unwrap_or(self.button)
        }
    }

    /// 从 `start`（含）开始顺时针找第一个在 `mask` 中的座位。
    fn scan_from(&self, start: u8, mask: u16) -> Option<u8> {
        for offset in 0..MAX_SEATS {
            let s = (start + offset) % MAX_SEATS;
            if mask & seat_bit(s) != 0 {
                return Some(s);
            }
        }
        None
    }

    /// 动作后的轮次推进：live 只剩一人立即结束（无需等 pending 清零）；
    /// pending 非空则移交给下一位 pending 玩家；否则关街。
    fn advance_turn(&mut self, just_acted: u8) -> ActOutcome {
        if popcount(self.live_mask) <= 1 {
            // §7.1「live 只剩一人则立即结算」：fold 掉倒数第二家时无需再行动。
            self.pending_to_act_mask = 0;
            self.finished = true;
            return ActOutcome {
                street_ended: true,
                hand_finished: true,
                ..ActOutcome::default()
            };
        }
        if self.pending_to_act_mask == 0 {
            self.close_streets()
        } else {
            self.to_act =
                next_clockwise(just_acted, self.pending_to_act_mask).unwrap_or(self.to_act);
            ActOutcome::default()
        }
    }

    /// 关街循环（§7.1「行动轮完成」）：pending 清零后——
    /// live 剩一人 → 直接结束；河牌结束 → 结束；`actionable <= 1` → 触发 runout；
    /// 否则推进到下一街（重置 `street_bet`/`acted`，`current_bet = 0`，
    /// `last_full_raise = bb`，按位置规则定首个行动者）。
    fn close_streets(&mut self) -> ActOutcome {
        let mut outcome = ActOutcome {
            street_ended: true,
            ..ActOutcome::default()
        };
        while self.pending_to_act_mask == 0 && !self.finished && !self.runout_needed {
            if popcount(self.live_mask) <= 1 {
                // live 只剩一人：立即进入结算（§7.1）。
                self.finished = true;
                outcome.hand_finished = true;
                break;
            }
            if self.street == STREET_RIVER {
                // 河牌下注轮结束：进入摊牌结算。
                self.finished = true;
                outcome.hand_finished = true;
                break;
            }
            if popcount(self.actionable_mask) <= 1 {
                // 自动发完公共牌：进入 AwaitRunout（§6.1），链上 advance
                // 用一次 runout VRF 补完剩余公共牌后结算。
                self.runout_needed = true;
                outcome.runout_started = true;
                break;
            }
            self.street += 1;
            if self.street == STREET_FLOP {
                self.flop_dealt = true;
            }
            self.current_bet = 0;
            self.last_full_raise = self.bb;
            for s in self.seats.iter_mut() {
                s.street_bet = 0;
                s.acted = false;
            }
            self.recompute_masks();
            self.pending_to_act_mask = self.actionable_mask;
            let anchor = self.street_anchor();
            self.to_act = self
                .scan_from(anchor, self.pending_to_act_mask)
                .unwrap_or(anchor);
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SB: u64 = 50 * CENT; // 0.5 BB
    const BB: u64 = 100 * CENT;
    const ANTE: u64 = 10 * CENT; // 0.1 BB

    fn stacks_for(mask: u16, per: u64) -> [u64; 9] {
        let mut stacks = [0u64; 9];
        for s in 0..MAX_SEATS {
            if mask & seat_bit(s) != 0 {
                stacks[s as usize] = per;
            }
        }
        stacks
    }

    fn engine3() -> Engine {
        // 3 人：座位 0(button)/1(SB)/2(BB)，各 100BB。
        Engine::new(
            &stacks_for(0b111, 10_000 * CENT),
            0b111,
            0b111,
            0,
            SB,
            BB,
            ANTE,
        )
        .unwrap()
    }

    // --- 位置与强制注 -------------------------------------------------------

    #[test]
    fn three_player_positions_and_ante_dead_money() {
        let e = engine3();
        assert_eq!(e.sb_seat(), 1);
        assert_eq!(e.bb_seat(), 2);
        // 翻前从 BB 左侧开始：3 人时即 button。
        assert_eq!(e.to_act, 0);
        assert_eq!(e.current_bet, BB);
        assert_eq!(e.last_full_raise, BB);
        // ante 是死钱：进 pot/in_hand，不计入 street_bet。
        assert_eq!(e.seats[1].street_bet, SB);
        assert_eq!(e.seats[1].in_hand, SB + ANTE);
        assert_eq!(e.seats[2].street_bet, BB);
        assert_eq!(e.seats[2].in_hand, BB + ANTE);
        assert_eq!(e.seats[0].street_bet, 0);
        assert_eq!(e.seats[0].in_hand, ANTE);
        assert_eq!(e.pot, 3 * ANTE + SB + BB);
        // SB 补齐 0.5BB 即可跟注（ante 不抵扣）。
        assert_eq!(e.call_amount(1), BB - SB);
        assert_eq!(e.call_amount(2), 0);
        assert!(e.can_check(2));
        assert!(!e.can_check(0));
    }

    #[test]
    fn nine_player_positions_full_ring() {
        let mask = 0x1FF;
        let e = Engine::new(
            &stacks_for(mask, 10_000 * CENT),
            mask,
            mask,
            4,
            SB,
            BB,
            ANTE,
        )
        .unwrap();
        assert_eq!(e.sb_seat(), 5);
        assert_eq!(e.bb_seat(), 6);
        assert_eq!(e.to_act, 7); // BB 左侧第一位
        assert_eq!(e.pot, 9 * ANTE + SB + BB);
        assert_eq!(popcount(e.pending_to_act_mask), 9);
    }

    #[test]
    fn heads_up_positions_preflop_button_first_postflop_bb_first() {
        let mask = 0b100001; // 座位 0 与 5
        let mut e = Engine::new(
            &stacks_for(mask, 10_000 * CENT),
            mask,
            mask,
            0,
            SB,
            BB,
            ANTE,
        )
        .unwrap();
        assert!(e.heads_up());
        assert_eq!(e.sb_seat(), 0); // button = SB
        assert_eq!(e.bb_seat(), 5);
        assert_eq!(e.to_act, 0); // 翻前 button 先动
                                 // button 跟注（补 0.5BB），BB check → 进入翻牌，BB 先动。
        e.act(0, Action::Call).unwrap();
        let out = e.act(5, Action::Check).unwrap();
        assert!(out.street_ended);
        assert_eq!(e.street, 1);
        assert!(e.flop_dealt);
        assert_eq!(e.to_act, 5); // 翻后 BB 先动
        assert_eq!(e.current_bet, 0);
        assert_eq!(e.last_full_raise, BB);
        // 街推进后 street_bet/acted 已重置。
        assert_eq!(e.seats[0].street_bet, 0);
        assert!(!e.seats[0].acted);
    }

    // --- 下注与加注规则 ------------------------------------------------------

    #[test]
    fn preflop_min_raise_is_2bb() {
        let mut e = engine3();
        // 非 CENT 整数倍：拒绝且状态不变。
        let before = e.clone();
        assert_eq!(
            e.act(0, Action::RaiseTo(2 * BB - 1)),
            Err(EngineError::NotCentMultiple)
        );
        assert_eq!(e, before);
        // 增量不足 1BB（目标 < 2BB）：拒绝且状态不变。
        assert_eq!(
            e.act(0, Action::RaiseTo(2 * BB - CENT)),
            Err(EngineError::BelowMinRaise)
        );
        assert_eq!(e, before);
        // 不超过 current_bet：拒绝。
        assert_eq!(
            e.act(0, Action::RaiseTo(BB)),
            Err(EngineError::BelowMinRaise)
        );
        // 最小加注到 2BB：接受。
        e.act(0, Action::RaiseTo(2 * BB)).unwrap();
        assert_eq!(e.current_bet, 2 * BB);
        assert_eq!(e.last_full_raise, BB);
        // 完整加注重新开放：其余 actionable 全部回到 pending。
        assert_eq!(e.pending_to_act_mask, 0b110);
        assert_eq!(e.to_act, 1);
        // 再加注增量必须 >= 上一次完整增量（1BB）：到 3BB 可以，到 2.5BB 不行。
        assert_eq!(
            e.act(1, Action::RaiseTo(2 * BB + SB)),
            Err(EngineError::BelowMinRaise)
        );
        e.act(1, Action::RaiseTo(3 * BB)).unwrap();
        assert_eq!(e.last_full_raise, BB);
    }

    #[test]
    fn bet_only_postflop_with_min_1bb() {
        let mut e = engine3();
        // 翻前不允许 Bet。
        let before = e.clone();
        assert_eq!(
            e.act(0, Action::Bet(2 * BB)),
            Err(EngineError::BetNotAllowed)
        );
        assert_eq!(e, before);
        // 走完翻前到翻牌。
        e.act(0, Action::Call).unwrap();
        e.act(1, Action::Call).unwrap();
        e.act(2, Action::Check).unwrap();
        assert_eq!(e.street, 1);
        assert_eq!(e.to_act, 1); // 翻后 button 左侧第一位
                                 // 低于 1BB 的下注：拒绝。
        assert_eq!(
            e.act(1, Action::Bet(BB - CENT)),
            Err(EngineError::BelowMinBet)
        );
        // 超出 stack：拒绝。
        assert_eq!(
            e.act(1, Action::Bet(10_000 * CENT)),
            Err(EngineError::AboveStack)
        );
        // 合法 Bet 1BB。
        e.act(1, Action::Bet(BB)).unwrap();
        assert_eq!(e.current_bet, BB);
        assert_eq!(e.last_full_raise, BB);
        // 已有注额后不能再 Bet。
        assert_eq!(e.act(2, Action::Bet(BB)), Err(EngineError::BetNotAllowed));
    }

    #[test]
    fn fold_allowed_even_when_check_available() {
        let mut e = engine3();
        e.act(0, Action::Call).unwrap();
        e.act(1, Action::Call).unwrap();
        // BB 可以 check，但也允许 fold。
        let out = e.act(2, Action::Fold).unwrap();
        assert!(out.street_ended);
        assert_eq!(e.live_mask, 0b011);
        assert_eq!(e.street, 1);
    }

    #[test]
    fn check_and_call_gatekeeping() {
        let mut e = engine3();
        // 面对 bb 注额不能 check。
        assert_eq!(e.act(0, Action::Check), Err(EngineError::CheckNotAllowed));
        e.act(0, Action::Call).unwrap();
        e.act(1, Action::Call).unwrap();
        // BB 无需跟注，不能 Call（应 Check）。
        assert_eq!(e.act(2, Action::Call), Err(EngineError::CallNotAllowed));
        e.act(2, Action::Check).unwrap();
    }

    #[test]
    fn short_all_in_raises_but_does_not_reopen() {
        // 3 人，座位 0 只有 3.5BB：翻前跟注 1BB，翻牌后不足额 all-in。
        let mut stacks = stacks_for(0b111, 10_000 * CENT);
        stacks[0] = 350 * CENT;
        let mut e = Engine::new(&stacks, 0b111, 0b111, 0, SB, BB, 0).unwrap();
        e.act(0, Action::Call).unwrap(); // 0 跟注 1BB（stack 剩 2.5BB）
        e.act(1, Action::Call).unwrap();
        e.act(2, Action::Check).unwrap();
        assert_eq!(e.street, 1);
        // 翻牌：SB 下注 2BB（完整加注，last_full_raise = 2BB）。
        e.act(1, Action::Bet(2 * BB)).unwrap();
        e.act(2, Action::Call).unwrap();
        // 座位 0 all-in：本街 street_bet 已清零，目标 = 剩余 stack 2.5BB；
        // 增量 0.5BB < 2BB → 不足额。
        let out = e.act(0, Action::AllIn).unwrap();
        assert!(!out.street_ended);
        assert_eq!(e.current_bet, 250 * CENT); // current_bet 被推高
        assert_eq!(e.last_full_raise, 2 * BB); // 完整增量不变
                                               // 不重新开放：已行动的 SB/BB 被重新加回 pending 但保留 acted = true。
        assert_eq!(e.pending_to_act_mask, 0b110);
        assert!(e.seats[1].acted);
        assert!(e.seats[2].acted);
        assert_eq!(e.to_act, 1);
        // SB 只能 call/fold：加注被拒绝且状态不变。
        let before = e.clone();
        assert_eq!(
            e.act(1, Action::RaiseTo(6 * BB)),
            Err(EngineError::RaiseNotReopened)
        );
        assert_eq!(e, before);
        // 足额 all-in 同样被拒绝（已行动者无加注权）。
        assert_eq!(e.act(1, Action::AllIn), Err(EngineError::RaiseNotReopened));
        assert_eq!(e, before);
        // SB 跟注 1.5BB，BB 弃牌 → live=2 且 actionable=1 → runout。
        e.act(1, Action::Call).unwrap();
        let out = e.act(2, Action::Fold).unwrap();
        assert!(out.runout_started);
        assert!(e.runout_needed);
        assert!(!e.finished);
        // runout 等待期间不再接受动作。
        assert_eq!(e.act(1, Action::Check), Err(EngineError::HandOver));
    }

    #[test]
    fn full_all_in_reopens_action() {
        // 同上布局，但座位 0 有 6BB：all-in 增量足额 → 重新开放。
        let mut stacks = stacks_for(0b111, 10_000 * CENT);
        stacks[0] = 600 * CENT;
        let mut e = Engine::new(&stacks, 0b111, 0b111, 0, SB, BB, 0).unwrap();
        e.act(0, Action::Call).unwrap();
        e.act(1, Action::Call).unwrap();
        e.act(2, Action::Check).unwrap();
        e.act(1, Action::Bet(2 * BB)).unwrap();
        e.act(2, Action::Call).unwrap();
        // all-in：本街 street_bet 已清零，目标 = 剩余 stack 5BB；
        // 增量 3BB >= 2BB → 完整加注。
        e.act(0, Action::AllIn).unwrap();
        assert_eq!(e.current_bet, 500 * CENT);
        assert_eq!(e.last_full_raise, 3 * BB);
        assert!(e.seats[0].all_in);
        // 重新开放：SB/BB 回到 pending 且 acted 清零，可以加注。
        assert_eq!(e.pending_to_act_mask, 0b110);
        assert!(!e.seats[1].acted);
        assert!(!e.seats[2].acted);
        e.act(1, Action::Fold).unwrap();
        // BB 全下跟注（不足额 call 式 all-in，不再抬 current_bet）。
        let out = e.act(2, Action::AllIn).unwrap();
        assert!(out.runout_started);
    }

    #[test]
    fn runout_triggers_when_blinds_cover_stacks() {
        // 2 人短码：SB 投完盲注即 all-in，BB 跟注后 actionable = 0 → runout。
        let mask = 0b11;
        let stacks = stacks_for(mask, BB);
        let mut e = Engine::new(&stacks, mask, mask, 0, SB, BB, 0).unwrap();
        // button=SB 投 0.5BB 后还剩 0.5BB，BB 投 1BB 后 all-in。
        assert!(e.seats[1].all_in);
        assert_eq!(e.to_act, 0);
        let out = e.act(0, Action::AllIn).unwrap();
        assert!(out.runout_started);
        assert!(e.runout_needed);
        assert_eq!(e.live_mask, 0b11);
        assert_eq!(popcount(e.actionable_mask), 0);
    }

    #[test]
    fn immediate_runout_when_both_blinds_all_in() {
        // 极端短码：SB 投 0.5BB 全下、BB 投 1BB 全下 → 开局即 runout。
        let mask = 0b11;
        let mut stacks = stacks_for(mask, BB);
        stacks[0] = SB;
        let e = Engine::new(&stacks, mask, mask, 0, SB, BB, 0).unwrap();
        assert!(e.runout_needed);
        assert_eq!(e.pot, SB + BB);
    }

    #[test]
    fn hand_ends_immediately_when_one_live() {
        let mut e = engine3();
        e.act(0, Action::Fold).unwrap();
        let out = e.act(1, Action::Fold).unwrap();
        assert!(out.hand_finished);
        assert!(e.finished);
        assert_eq!(e.live_mask, 0b100);
        assert_eq!(e.act(2, Action::Check), Err(EngineError::HandOver));
    }

    // --- 超时 ----------------------------------------------------------------

    #[test]
    fn timeout_checks_when_free_and_strikes_accumulate() {
        let mut e = engine3();
        e.act(0, Action::Call).unwrap();
        e.act(1, Action::Call).unwrap();
        // BB 可 check：超时自动 check，strikes += 1。
        let r = e.claim_timeout(2).unwrap();
        assert!(matches!(r, TimeoutResult::Checked(_)));
        assert_eq!(e.seats[2].strikes, 1);
        assert_eq!(e.street, 1);
        // 非行动座位不能代领超时。
        assert_eq!(e.claim_timeout(0), Err(EngineError::NotYourTurn));
    }

    #[test]
    fn timeout_folds_when_facing_bet() {
        let mut e = engine3();
        // UTG 面对 bb：超时自动 fold。
        let r = e.claim_timeout(0).unwrap();
        assert!(matches!(r, TimeoutResult::Folded(_)));
        assert_eq!(e.seats[0].strikes, 1);
        assert!(e.seats[0].folded);
        assert_eq!(e.to_act, 1);
        // 再超时一次：strikes 单调递增。
        e.claim_timeout(1).unwrap();
        assert_eq!(e.seats[1].strikes, 1);
        assert!(e.finished); // 只剩 BB
    }

    // --- 合法性与守恒 ----------------------------------------------------------

    #[test]
    fn wrong_seat_and_over_stack_rejected_with_state_unchanged() {
        let mut e = engine3();
        let before = e.clone();
        // 不是行动轮。
        assert_eq!(e.act(1, Action::Fold), Err(EngineError::NotYourTurn));
        assert_eq!(e, before);
        // 不在本手的座位。
        assert_eq!(e.act(5, Action::Fold), Err(EngineError::SeatNotInHand));
        assert_eq!(e, before);
        // 加注超过 stack。
        assert_eq!(
            e.act(0, Action::RaiseTo(10_000 * CENT + BB)),
            Err(EngineError::AboveStack)
        );
        assert_eq!(e, before);
        // 守恒：Σ stack + pot 恒等于开局总筹码。
        let total: u64 = e.seats.iter().map(|s| s.stack).sum::<u64>() + e.pot;
        assert_eq!(total, 3 * 10_000 * CENT);
    }

    #[test]
    fn invalid_config_rejected() {
        let mask = 0b11;
        let stacks = stacks_for(mask, BB);
        // 单人。
        assert!(Engine::new(&stacks_for(0b1, BB), 0b1, 0b1, 0, SB, BB, 0).is_err());
        // button 不在 hand_mask。
        assert!(Engine::new(&stacks, mask, mask, 2, SB, BB, 0).is_err());
        // hand_mask 超出 occupied_mask。
        assert!(Engine::new(&stacks, 0b01, mask, 0, SB, BB, 0).is_err());
        // 非 CENT 整数倍盲注。
        let bad = Engine::new(&stacks, mask, mask, 0, SB + 1, BB, 0);
        assert_eq!(bad.unwrap_err(), EngineError::NotCentMultiple);
        // stack 为 0 不能入 hand。
        let zero = stacks_for(0b10, BB);
        assert!(Engine::new(&zero, mask, mask, 1, SB, BB, 0).is_err());
    }
}
