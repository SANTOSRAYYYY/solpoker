//! Error codes. Design §15: exactly one `#[error_code]` enum per program, and
//! messages carry only the reason category — never seeds, salts, randomness,
//! cards, pubkeys of players, or any other hand data.

use anchor_lang::prelude::*;

#[error_code]
pub enum SolpokerError {
    /// VRF slot is not armed (act/advance did not mark it Ready).
    #[msg("vrf")]
    VrfNotArmed,
    /// VRF slot is not Pending (nothing to retry).
    #[msg("vrf")]
    VrfNotPending,
    /// vrf_timeout_s has not elapsed since requested_at.
    #[msg("vrf")]
    VrfTimeoutNotElapsed,
    /// Slot state does not allow arming (e.g. Fulfilled not yet consumed).
    #[msg("vrf")]
    VrfArmRejected,
    /// Delegation validator is not on the allowlist.
    #[msg("validator")]
    ValidatorNotAllowed,
    /// Signer is not the table admin (test harness instructions).
    #[msg("admin")]
    Unauthorized,
    // --- Stage 6 Phase 2: fund flow (§5) ---
    /// Table is not Active (maintenance / escaping / escaped).
    #[msg("state")]
    TableNotActive,
    /// Table kind does not admit this occupant kind (e.g. human on AgentOnly).
    #[msg("table")]
    KindNotAllowed,
    /// Seat is not empty for a new occupant.
    #[msg("seat")]
    SeatNotEmpty,
    /// Seat is not in the status this action requires.
    #[msg("seat")]
    NotSeated,
    /// Seat index out of range or seat account fields mismatch.
    #[msg("seat")]
    SeatMismatch,
    /// PlayerHand account is not in the clean (zeroed) state for a new occupant.
    #[msg("seat")]
    SeatNotClean,
    /// Seat is in a live hand; this fund movement is only allowed between hands.
    #[msg("state")]
    SeatInHand,
    /// Buy-in outside [min, max] or not a CENT multiple.
    #[msg("funds")]
    BadBuyIn,
    /// Amount is zero or not a CENT multiple.
    #[msg("funds")]
    BadAmount,
    /// Session expiry exceeds now + 7 days.
    #[msg("session")]
    SessionTooLong,
    /// Signer is neither the occupant nor a valid (unexpired) session key.
    #[msg("auth")]
    BadSession,
    /// Signer is not the seat occupant.
    #[msg("auth")]
    NotOccupant,
    /// Snapshot account failed address / owner / discriminator / length checks.
    #[msg("snapshot")]
    BadSnapshot,
    /// Snapshot does not describe the current occupant; retry after a commit.
    #[msg("snapshot")]
    StaleSnapshot,
    /// Conservation invariant violated.
    #[msg("conservation")]
    Conservation,
    /// Checked arithmetic overflow.
    #[msg("math")]
    Overflow,
    // --- Stage 6 Phase 3: game loop (§6 / §7 / §8) ---
    /// hand_id or action_seq does not match the current game state.
    #[msg("stale")]
    StaleAction,
    /// Game phase does not allow this instruction right now.
    #[msg("phase")]
    BadPhase,
    /// The engine rejected the action (turn, amount, or legality).
    #[msg("action")]
    BadAction,
    /// The action deadline has not elapsed yet.
    #[msg("timeout")]
    TimeoutNotElapsed,
    /// Salt commitment or reveal is empty or invalid.
    #[msg("salt")]
    BadSalt,
    /// magic_fee_vault is not the canonical validator-scoped PDA.
    #[msg("commit")]
    BadFeeVault,
    // --- Stage 8: agent 身份（配套文档一 §2） ---
    /// AgentProfile 不是 Active（暂停/注销/封禁中不可入座）。
    #[msg("agent")]
    AgentNotActive,
    /// 同主人规则（§2.3）：同桌 owner/occupant 冲突。
    #[msg("agent")]
    SameOwner,
    /// 同一占用者已在该桌其他座位。
    #[msg("seat")]
    AlreadySeated,
    /// AgentProfile 与签名者/传入账户不匹配。
    #[msg("agent")]
    AgentProfileMismatch,
    // --- 资金防御（2026-10-08） ---
    /// cash_out 的 payout 是默认地址（历史损坏账本）；有金额可付时拒绝执行。
    #[msg("payout")]
    PayoutNotSet,
}
