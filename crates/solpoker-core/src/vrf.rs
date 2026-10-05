//! VRF 状态机与请求标识（主设计文档 §9「VRF 集成」、§6.2「由谁推进」的 V1 拆分方案）。
//!
//! V1 拆分：扑克动作指令（`act` / `advance`）只负责把 [`VrfSlot`] 置为 `Ready`；
//! permissionless 的 `request_vrf` 指令在 `Ready` 时向 ER 队列发 CPI 并原子改为 `Pending`；
//! VRF 回调只存 randomness，发牌仍由后续的 `advance` 完成。
//!
//! 关键纪律（§9）：
//! - **身份不对才报错**（由链上回调入口校验签名者身份）；
//! - **身份正确但请求已过期或不匹配时返回 `Ok` 并忽略**——回调报错会让整笔 fulfillment
//!   回滚，请求会一直留在队列里直到 120 秒 TTL；
//! - 10 秒超时（`vrf_timeout_s`），任何人可重试，最多 3 次（`vrf_max_attempts`），
//!   3 次都失败则本手作废（Void），全额退款。

use sha2::{Digest, Sha256};

/// VRF 请求的目标：四条街各一次，all-in 合并时额外的补发公共牌为 `Runout`。
///
/// 对应设计 §3.2 `Game.vrf: VrfSlot { target: Street|Runout, ... }`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum VrfTarget {
    /// 翻前（发底牌用的 VRF_0，同时决定第一手庄位）。
    Preflop,
    /// 翻牌（3 张）。
    Flop,
    /// 转牌（1 张）。
    Turn,
    /// 河牌（1 张）。
    River,
    /// all-in 合并后的补发公共牌（VRF_r）。
    Runout,
}

impl VrfTarget {
    /// 规范 u8 编码，进入 `caller_seed` 的哈希输入。
    ///
    /// 取值与发牌协议 §8.5 事件编码同一风格（从 0 递增），
    /// 一旦定稿不得更改，否则历史请求的 caller_seed 无法复算。
    pub const fn to_u8(self) -> u8 {
        match self {
            VrfTarget::Preflop => 0,
            VrfTarget::Flop => 1,
            VrfTarget::Turn => 2,
            VrfTarget::River => 3,
            VrfTarget::Runout => 4,
        }
    }
}

/// VRF 槽位的推进状态。
///
/// 状态机：`Idle → Ready → Pending → Fulfilled`；
/// `Pending` 在重试用尽后进入终态 `Void`（本手作废信号）。
/// `Fulfilled` 被 `advance` 消费后由链侧重置回 `Idle`（见 [`VrfSlot::reset`]）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VrfState {
    /// 无待处理的 VRF 请求。
    Idle,
    /// 本街已结束、`act`/`advance` 已标记需要 VRF，等待 `request_vrf` 发 CPI。
    Ready,
    /// 请求已发出，等待回调（或超时重试）。
    Pending,
    /// 回调已存下 randomness，等待 `advance` 发牌。
    Fulfilled,
    /// 终态：重试用尽，本手作废（由链上结算路径退回全部投入并写 Void 证明）。
    Void,
}

/// arm 阶段可拒绝的情形。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArmError {
    /// 已有请求在途（`Pending`）。幂等规则：`act`/`advance` 不允许覆盖在途请求，
    /// 防止一笔晚到的结束本街动作把进行中的回调作废。
    RequestInFlight,
    /// 当前状态不允许 arm（`Fulfilled` 必须先被 `advance` 消费、`Void` 是终态）。
    InvalidState,
}

/// request 阶段可拒绝的情形。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestError {
    /// 只有 `Ready` 才能发起请求；队列拥堵时 `request_vrf` 失败只回滚本指令，
    /// 不影响已完成的扑克动作（V1 拆分的目的）。
    NotReady,
}

/// `Game.vrf` 槽位（设计 §3.2 字段定义）。
///
/// 只保存公开数据；randomness 在 fulfill 后由链上指令同时写入私有的 `Deck`，
/// 本结构里保留一份以便 `advance` 校验来源（§8.7 的 `board_src`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VrfSlot {
    state: VrfState,
    /// 请求目标（当前这条街或 runout）。
    target: VrfTarget,
    /// 已发出的请求次数（1 起；`Ready` 时为 0）。链上 Table 的 `vrf_max_attempts` 约束它。
    attempt: u8,
    /// 最近一次请求发出时的 `Clock::unix_timestamp`（秒）；非 `Pending` 时为 0。
    requested_at: i64,
    /// 已收到的 randomness；仅 `state == Fulfilled` 时有意义。
    randomness: [u8; 32],
}

impl Default for VrfSlot {
    fn default() -> Self {
        Self {
            state: VrfState::Idle,
            target: VrfTarget::Preflop,
            attempt: 0,
            requested_at: 0,
            randomness: [0u8; 32],
        }
    }
}

/// `fulfill` 的结果：区分「已接收」与「忽略」（旧 attempt / 过期 / 目标不符）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FulfillOutcome {
    /// 身份匹配，randomness 已存，状态进入 `Fulfilled`。
    Stored,
    /// 身份正确但与当前挂起请求不匹配（旧 attempt、旧目标或槽位已不在 `Pending`）：
    /// 按 §9 返回 Ok 并忽略，绝不能让 fulfillment 整笔回滚。
    Ignored,
}

/// `retry` 的结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryOutcome {
    /// 还没到超时时间，什么都不做。
    NotExpired,
    /// 槽位不在 `Pending`（Idle/Ready/Fulfilled/Void），什么都不做。
    NotPending,
    /// 已用新的 attempt 重新计时；链上 `retry_vrf` 指令应随之重发 CPI。
    Retried { attempt: u8 },
    /// 已是第 3 次（`vrf_max_attempts`）仍超时：进入终态 `Void`，
    /// 链上结算路径作废本手、全额退款。
    Voided,
}

impl VrfSlot {
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前状态。
    pub fn state(&self) -> VrfState {
        self.state
    }

    /// 请求目标。
    pub fn target(&self) -> VrfTarget {
        self.target
    }

    /// 当前 attempt（`Ready` 时为 0）。
    pub fn attempt(&self) -> u8 {
        self.attempt
    }

    /// 最近一次请求时间戳（秒）。
    pub fn requested_at(&self) -> i64 {
        self.requested_at
    }

    /// 已存的 randomness（仅 `Fulfilled` 时有效）。
    pub fn randomness(&self) -> [u8; 32] {
        self.randomness
    }

    /// `act` / `advance` 结束本街时调用：只把槽位置为 `Ready`（V1 拆分，§6.2）。
    ///
    /// 幂等：已在 `Ready` 时重复 arm 返回 `Ok`；已有请求在途（`Pending`）时报错，
    /// 防止覆盖进行中的请求。
    pub fn arm(&mut self, target: VrfTarget) -> Result<(), ArmError> {
        match self.state {
            VrfState::Idle => {
                self.target = target;
                self.state = VrfState::Ready;
                Ok(())
            }
            VrfState::Ready => {
                // 幂等：同一目标重复 arm 视为 no-op；换目标属于链侧逻辑错误，直接报错。
                if self.target == target {
                    Ok(())
                } else {
                    Err(ArmError::RequestInFlight)
                }
            }
            VrfState::Pending => Err(ArmError::RequestInFlight),
            VrfState::Fulfilled | VrfState::Void => Err(ArmError::InvalidState),
        }
    }

    /// `request_vrf` 调用：`Ready → Pending`，记录 attempt 与请求时间。
    ///
    /// `attempt` 由链上从 1 开始递增传入（第一次请求 attempt = 1）；
    /// 队列 CPI 失败时链上只回滚本指令，槽位回到 `Ready`。
    pub fn request(&mut self, attempt: u8, requested_at: i64) -> Result<(), RequestError> {
        if self.state != VrfState::Ready {
            return Err(RequestError::NotReady);
        }
        self.attempt = attempt;
        self.requested_at = requested_at;
        self.state = VrfState::Pending;
        Ok(())
    }

    /// VRF 回调入口（`#[vrf_callback]` 的核心逻辑；签名者身份校验由链上完成）。
    ///
    /// 校验回调携带的请求身份 `(hand_id, target, attempt)` 与当前挂起请求一致：
    /// - 一致：存 randomness，进入 `Fulfilled`；
    /// - 不一致（旧 attempt 迟到、目标不符、槽位已不在 Pending）：返回
    ///   `Ok(FulfillOutcome::Ignored)` 并忽略，**不报错**（§9：
    ///   「身份正确但请求已过期或不匹配时返回 Ok 并忽略」）。
    pub fn fulfill(
        &mut self,
        hand_id: u64,
        target: VrfTarget,
        attempt: u8,
        randomness: [u8; 32],
        current_hand_id: u64,
    ) -> Result<FulfillOutcome, ()> {
        if self.state == VrfState::Pending
            && self.target == target
            && self.attempt == attempt
            && hand_id == current_hand_id
        {
            self.randomness = randomness;
            self.state = VrfState::Fulfilled;
            Ok(FulfillOutcome::Stored)
        } else {
            Ok(FulfillOutcome::Ignored)
        }
    }

    /// 是否已超过本次请求的超时时间（`vrf_timeout_s`，默认 10 秒）。
    ///
    /// 非 `Pending` 一律 false。`now == requested_at + timeout_s` 视为已过期
    /// （截止时间是「截止时间过后才能成功」，见 §6.3）。
    pub fn is_expired(&self, now: i64, timeout_s: u16) -> bool {
        self.state == VrfState::Pending && now - self.requested_at >= timeout_s as i64
    }

    /// `retry_vrf` 调用（permissionless，超时后任何人可发）：
    /// 超时则换新 attempt 重新计时；`max_attempts` 次仍失败则进入 `Void`。
    pub fn retry(&mut self, now: i64, timeout_s: u16, max_attempts: u8) -> RetryOutcome {
        if self.state != VrfState::Pending {
            return RetryOutcome::NotPending;
        }
        if !self.is_expired(now, timeout_s) {
            return RetryOutcome::NotExpired;
        }
        if self.attempt < max_attempts {
            self.attempt += 1;
            self.requested_at = now;
            RetryOutcome::Retried {
                attempt: self.attempt,
            }
        } else {
            self.state = VrfState::Void;
            RetryOutcome::Voided
        }
    }

    /// `advance` 消费掉 `Fulfilled` 的 randomness 后，链上把槽位重置回 `Idle`。
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// VRF 请求标识（设计 §9）：
/// `caller_seed = sha256("solpoker/vrf/v1" ‖ table ‖ hand_id_be ‖ target ‖ attempt)`。
///
/// - `table`：Table 账户地址（32 字节）；
/// - `hand_id`：u64 大端；
/// - `target`：[`VrfTarget`] 的规范 u8 编码；
/// - `attempt`：u8（1 起）。
///
/// 每次请求（含重试）的 caller_seed 都不同，队列据此把回调路由回正确的挂起请求。
pub fn caller_seed(table: &[u8; 32], hand_id: u64, target: VrfTarget, attempt: u8) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"solpoker/vrf/v1");
    h.update(table);
    h.update(hand_id.to_be_bytes());
    h.update([target.to_u8()]);
    h.update([attempt]);
    h.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_000_000;

    fn arm_request(slot: &mut VrfSlot, target: VrfTarget, t: i64) {
        slot.arm(target).unwrap();
        slot.request(1, t).unwrap();
    }

    #[test]
    fn happy_path_arm_request_fulfill() {
        let mut slot = VrfSlot::new();
        assert_eq!(slot.state(), VrfState::Idle);

        slot.arm(VrfTarget::Flop).unwrap();
        assert_eq!(slot.state(), VrfState::Ready);
        assert_eq!(slot.target(), VrfTarget::Flop);

        slot.request(1, T0).unwrap();
        assert_eq!(slot.state(), VrfState::Pending);
        assert_eq!(slot.attempt(), 1);
        assert_eq!(slot.requested_at(), T0);

        let rnd = [0xABu8; 32];
        let out = slot.fulfill(7, VrfTarget::Flop, 1, rnd, 7).unwrap();
        assert_eq!(out, FulfillOutcome::Stored);
        assert_eq!(slot.state(), VrfState::Fulfilled);
        assert_eq!(slot.randomness(), rnd);

        slot.reset();
        assert_eq!(slot.state(), VrfState::Idle);
    }

    #[test]
    fn arm_twice_is_idempotent() {
        let mut slot = VrfSlot::new();
        slot.arm(VrfTarget::Preflop).unwrap();
        // 同一目标重复 arm：Ok，不推进状态。
        slot.arm(VrfTarget::Preflop).unwrap();
        assert_eq!(slot.state(), VrfState::Ready);

        slot.request(1, T0).unwrap();
        // 请求在途时再 arm：拒绝（幂等规则，不允许覆盖在途请求）。
        assert_eq!(slot.arm(VrfTarget::Preflop), Err(ArmError::RequestInFlight));
        assert_eq!(slot.state(), VrfState::Pending);
    }

    #[test]
    fn request_requires_ready() {
        let mut slot = VrfSlot::new();
        assert_eq!(slot.request(1, T0), Err(RequestError::NotReady));
        slot.arm(VrfTarget::Turn).unwrap();
        slot.request(1, T0).unwrap();
        // 已在 Pending，再 request 必须失败（V1 拆分：原子改 Pending）。
        assert_eq!(slot.request(2, T0), Err(RequestError::NotReady));
    }

    #[test]
    fn fulfill_with_wrong_seed_is_ignored_not_error() {
        let mut slot = VrfSlot::new();
        arm_request(&mut slot, VrfTarget::River, T0);

        // 目标不符。
        let out = slot.fulfill(7, VrfTarget::Turn, 1, [1u8; 32], 7).unwrap();
        assert_eq!(out, FulfillOutcome::Ignored);
        // hand_id 不符。
        let out = slot.fulfill(6, VrfTarget::River, 1, [1u8; 32], 7).unwrap();
        assert_eq!(out, FulfillOutcome::Ignored);
        assert_eq!(slot.state(), VrfState::Pending);

        // 正确身份仍然可以 fulfill。
        let out = slot.fulfill(7, VrfTarget::River, 1, [2u8; 32], 7).unwrap();
        assert_eq!(out, FulfillOutcome::Stored);
    }

    #[test]
    fn late_old_attempt_callback_is_ignored() {
        let mut slot = VrfSlot::new();
        arm_request(&mut slot, VrfTarget::Flop, T0);

        // 第 1 次请求超时，重试为 attempt 2。
        assert_eq!(
            slot.retry(T0 + 10, 10, 3),
            RetryOutcome::Retried { attempt: 2 }
        );
        assert_eq!(slot.attempt(), 2);

        // 迟到的旧 attempt=1 回调：Ok 并忽略，不能报错、不能覆盖。
        let out = slot.fulfill(7, VrfTarget::Flop, 1, [9u8; 32], 7).unwrap();
        assert_eq!(out, FulfillOutcome::Ignored);
        assert_eq!(slot.state(), VrfState::Pending);
        assert_eq!(slot.attempt(), 2);

        // 新 attempt 的回调正常接收。
        let out = slot.fulfill(7, VrfTarget::Flop, 2, [3u8; 32], 7).unwrap();
        assert_eq!(out, FulfillOutcome::Stored);
    }

    #[test]
    fn expires_at_exactly_timeout() {
        let mut slot = VrfSlot::new();
        arm_request(&mut slot, VrfTarget::Preflop, T0);
        // 9 秒：未过期；10 秒：恰好过期（截止时间过后才算超时，边界算过期）。
        assert!(!slot.is_expired(T0 + 9, 10));
        assert!(slot.is_expired(T0 + 10, 10));
        // retry 在恰好 10 秒处生效。
        assert_eq!(
            slot.retry(T0 + 10, 10, 3),
            RetryOutcome::Retried { attempt: 2 }
        );
    }

    #[test]
    fn retry_not_expired_is_noop() {
        let mut slot = VrfSlot::new();
        arm_request(&mut slot, VrfTarget::Preflop, T0);
        assert_eq!(slot.retry(T0 + 9, 10, 3), RetryOutcome::NotExpired);
        assert_eq!(slot.attempt(), 1);
    }

    #[test]
    fn three_attempts_then_void() {
        let mut slot = VrfSlot::new();
        arm_request(&mut slot, VrfTarget::Preflop, T0);
        // attempt 1 超时 → 2；attempt 2 超时 → 3；attempt 3 超时 → Void。
        assert_eq!(
            slot.retry(T0 + 10, 10, 3),
            RetryOutcome::Retried { attempt: 2 }
        );
        assert_eq!(
            slot.retry(T0 + 20, 10, 3),
            RetryOutcome::Retried { attempt: 3 }
        );
        assert_eq!(slot.retry(T0 + 30, 10, 3), RetryOutcome::Voided);
        assert_eq!(slot.state(), VrfState::Void);
        // Void 后一切推进都被拒绝/忽略。
        assert_eq!(slot.retry(T0 + 40, 10, 3), RetryOutcome::NotPending);
        let out = slot
            .fulfill(7, VrfTarget::Preflop, 3, [0u8; 32], 7)
            .unwrap();
        assert_eq!(out, FulfillOutcome::Ignored);
        assert_eq!(slot.arm(VrfTarget::Preflop), Err(ArmError::InvalidState));
    }

    #[test]
    fn void_hand_after_max_attempts_fires_even_without_fulfill() {
        // 作废信号只依赖重试次数，不依赖是否收到过（被忽略的）回调。
        let mut slot = VrfSlot::new();
        arm_request(&mut slot, VrfTarget::Runout, T0);
        slot.retry(T0 + 10, 10, 3).unwrap_retried();
        slot.retry(T0 + 20, 10, 3).unwrap_retried();
        assert_eq!(slot.retry(T0 + 30, 10, 3), RetryOutcome::Voided);
    }

    #[test]
    fn caller_seed_matches_pinned_vector() {
        // 固定输入测试向量（CI 钉死）：
        //   table    = 0x11 * 32
        //   hand_id  = 7
        //   target   = Flop (u8 编码 1)
        //   attempt  = 2
        // caller_seed = sha256("solpoker/vrf/v1" ‖ table ‖ 0000000000000007 ‖ 01 ‖ 02)
        let table = [0x11u8; 32];
        let seed = caller_seed(&table, 7, VrfTarget::Flop, 2);
        let hex: String = seed.iter().map(|b| format!("{b:02x}")).collect();
        println!("caller_seed vector (table=0x11*32, hand_id=7, Flop, attempt=2): {hex}");
        assert_eq!(
            hex,
            // 真实值（.NET SHA256 独立复算，CI 钉死）：
            //   sha256("solpoker/vrf/v1" ‖ 0x11*32 ‖ 0000000000000007 ‖ 01 ‖ 02)
            "a1d3786b5c6a0e36d4210b947c41712bbc267068cc7210cc0643a36304b40f03"
        );
    }

    #[test]
    fn caller_seed_is_deterministic_and_target_sensitive() {
        let table = [0x22u8; 32];
        let a = caller_seed(&table, 1, VrfTarget::Preflop, 1);
        let b = caller_seed(&table, 1, VrfTarget::Preflop, 1);
        assert_eq!(a, b);
        assert_ne!(a, caller_seed(&table, 2, VrfTarget::Preflop, 1));
        assert_ne!(a, caller_seed(&table, 1, VrfTarget::Flop, 1));
        assert_ne!(a, caller_seed(&table, 1, VrfTarget::Preflop, 2));
        // attempt 编码占 1 字节，0 是非法 attempt（1 起），链上应拒绝。
        let _ = caller_seed(&table, 1, VrfTarget::Preflop, 0);
    }

    trait UnwrapRetried {
        fn unwrap_retried(self);
    }
    impl UnwrapRetried for RetryOutcome {
        fn unwrap_retried(self) {
            match self {
                RetryOutcome::Retried { .. } => {}
                other => panic!("expected Retried, got {other:?}"),
            }
        }
    }
}
