//! Account state. Minimal fields per design §3.2 (field set fixed; sizes and
//! ordering are finalized in Stage 5–6). All times are `Clock::unix_timestamp`
//! seconds; all integers serialized big-endian where they enter hashes/seeds.
//!
//! VRF 状态机一律委托 `solpoker-core`（§6.2 V1 拆分）：链上 `VrfSlot` 只是
//! core 槽位的可序列化镜像，且**不保存 randomness**——未公开的 VRF 输出只存在于
//! 私有 Deck 账户（§3.2 字段纪律、§8.8）。镜像通过 `core_replay` 重放构造出
//! core `VrfSlot` 调用其 `arm`/`request`/`fulfill`/`retry`，再用 `sync_from_core`
//! 把结果状态写回，规则只有 core 一份。

use anchor_lang::prelude::*;

pub const MAX_SEATS: usize = 9;

/// L1 table configuration. Never delegated; carries the tunable VRF timeouts
/// (E1: vrf_timeout_s = 10, vrf_max_attempts = 3) so Stage 2 latency
/// measurements can adjust them on-chain instead of in code.
#[account]
pub struct Table {
    pub table_id: u32,
    /// Seconds after `VrfSlot.requested_at` before anyone may call retry_vrf.
    pub vrf_timeout_s: u16,
    /// Maximum request attempts per street (first request is attempt 1).
    pub vrf_max_attempts: u8,
    /// Incremented after an escape (§5.4); part of the Deck PDA seeds.
    pub epoch: u16,
    pub bump: u8,
}

/// ER game state (public). While delegated, the account owner is the
/// delegation program, hence the `owner` override on the field.
#[account]
pub struct Game {
    pub table: Pubkey,
    pub hand_id: u64,
    /// Board cards as dealt (public once dealt). Stage 4 fills the draw logic.
    pub board: [u8; 5],
    pub board_len: u8,
    /// VRF request slot (design §3.2). Mirror of `solpoker_core::vrf::VrfSlot`
    /// WITHOUT the randomness field — secrets never live in public accounts.
    pub vrf: VrfSlot,
    /// Seat ledger stubs (Stage 5 fills the rest of SeatState).
    pub seats: [SeatState; MAX_SEATS],
}

/// Core VRF slot states (solpoker-core `VrfState`), serialized into Game.
/// Lifecycle per §6.2 / §9: act/advance sets Ready (arm), request_vrf sets
/// Pending, vrf_callback sets Fulfilled (randomness in Deck), advance
/// consumes Fulfilled and resets to Idle; retry exhaustion lands on Void and
/// the settlement path voids the hand.
///
/// 注意：不给变体写显式判别值。borsh 1.x（Anchor 1.0 的序列化后端）要求
/// 带显式判别的枚举必须额外声明 `use_discriminant`，而这里的序列化值
/// 不进任何哈希——线上编码由 `VrfTarget::to_core().to_u8()` 显式给出。
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum VrfState {
    Idle,
    Ready,
    Pending,
    Fulfilled,
    Void,
}

/// Which VRF draw a street needs. Wire encoding MUST match
/// `solpoker_core::vrf::VrfTarget::to_u8` (Preflop=0..Runout=4) because it
/// feeds `caller_seed` (pinned CI vector in solpoker-core).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum VrfTarget {
    Preflop,
    Flop,
    Turn,
    River,
    Runout,
}

impl VrfTarget {
    /// Index into `Deck.vrf_out` / `Deck.vrf_attempt_used`
    /// ([preflop, flop, turn, river, runout]).
    pub fn deck_index(self) -> usize {
        match self {
            VrfTarget::Preflop => 0,
            VrfTarget::Flop => 1,
            VrfTarget::Turn => 2,
            VrfTarget::River => 3,
            VrfTarget::Runout => 4,
        }
    }

    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(VrfTarget::Preflop),
            1 => Some(VrfTarget::Flop),
            2 => Some(VrfTarget::Turn),
            3 => Some(VrfTarget::River),
            4 => Some(VrfTarget::Runout),
            _ => None,
        }
    }

    pub fn to_core(self) -> solpoker_core::vrf::VrfTarget {
        match self {
            VrfTarget::Preflop => solpoker_core::vrf::VrfTarget::Preflop,
            VrfTarget::Flop => solpoker_core::vrf::VrfTarget::Flop,
            VrfTarget::Turn => solpoker_core::vrf::VrfTarget::Turn,
            VrfTarget::River => solpoker_core::vrf::VrfTarget::River,
            VrfTarget::Runout => solpoker_core::vrf::VrfTarget::Runout,
        }
    }

    pub fn from_core(t: solpoker_core::vrf::VrfTarget) -> Self {
        match t {
            solpoker_core::vrf::VrfTarget::Preflop => VrfTarget::Preflop,
            solpoker_core::vrf::VrfTarget::Flop => VrfTarget::Flop,
            solpoker_core::vrf::VrfTarget::Turn => VrfTarget::Turn,
            solpoker_core::vrf::VrfTarget::River => VrfTarget::River,
            solpoker_core::vrf::VrfTarget::Runout => VrfTarget::Runout,
        }
    }
}

/// Public mirror of the core VRF slot (see module docs). `attempt` is 1-based
/// (core convention). `requested_at` is 0 unless state == Pending.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct VrfSlot {
    pub state: VrfState,
    pub target: VrfTarget,
    pub attempt: u8,
    pub requested_at: i64,
}

impl Default for VrfSlot {
    fn default() -> Self {
        VrfSlot {
            state: VrfState::Idle,
            target: VrfTarget::Preflop,
            attempt: 0,
            requested_at: 0,
        }
    }
}

impl VrfSlot {
    /// Reconstruct a core `VrfSlot` from the persisted mirror by replaying
    /// the recorded transitions. Returns None for Fulfilled/Void, which have
    /// no legal VRF transitions until advance resets the slot — callers map
    /// that to their "wrong state" error or ignore rule.
    pub fn core_replay(&self) -> Option<solpoker_core::vrf::VrfSlot> {
        use solpoker_core::vrf::VrfSlot as CoreSlot;
        let mut s = CoreSlot::new();
        match self.state {
            VrfState::Idle => Some(s),
            VrfState::Ready => {
                s.arm(self.target.to_core()).ok()?;
                Some(s)
            }
            VrfState::Pending => {
                s.arm(self.target.to_core()).ok()?;
                s.request(self.attempt, self.requested_at).ok()?;
                Some(s)
            }
            VrfState::Fulfilled | VrfState::Void => {
                // Fulfilled would need the stored randomness to reconstruct and
                // Void is terminal; neither has transitions here.
                None
            }
        }
    }

    /// Persist the result of a core transition back into the mirror.
    pub fn sync_from_core(&mut self, core: &solpoker_core::vrf::VrfSlot) {
        use solpoker_core::vrf::VrfState as CoreState;
        self.state = match core.state() {
            CoreState::Idle => VrfState::Idle,
            CoreState::Ready => VrfState::Ready,
            CoreState::Pending => VrfState::Pending,
            CoreState::Fulfilled => VrfState::Fulfilled,
            CoreState::Void => VrfState::Void,
        };
        self.target = VrfTarget::from_core(core.target());
        self.attempt = core.attempt();
        self.requested_at = core.requested_at();
    }
}

/// ER seat ledger stub (design §3.2 / D1). Stage 5 adds the remaining fields
/// (occupant, status, in_hand, street_bet, folded, strikes, salt commits, ...).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct SeatState {
    pub stack: u64,
    pub credited_total: u64,
    pub owed_total: u64,
}

/// ER deck state (private account, members = [] per §4). Only the VRF
/// fulfillment callback and dealing instructions may write here.
#[account]
pub struct Deck {
    pub hand_id: u64,
    /// Raw VRF outputs per draw: [preflop, flop, turn, river, runout].
    /// Written only by `vrf_callback`; never logged (§15). Cleared at hand end.
    pub vrf_out: [[u8; 32]; 5],
    /// Which attempt produced each entry (for HandProof audit, §8.7).
    pub vrf_attempt_used: [u8; 5],
}
