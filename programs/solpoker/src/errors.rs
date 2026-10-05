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
}
