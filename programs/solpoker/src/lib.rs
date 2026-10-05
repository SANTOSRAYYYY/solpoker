//! solpoker on-chain program — Stage 2 slice (VRF in the TEE Ephemeral Rollup).
//!
//! Scope (design doc `solpoker-stage1-design.md`):
//! - §9 VRF 集成: `request_vrf` / `vrf_callback` / `retry_vrf`
//! - §6.2 V1 拆分: `act`/`advance` only arm the slot (Ready); the permissionless
//!   `request_vrf` performs the queue CPI. Queue failure rolls back only this
//!   instruction — the poker action from the earlier act/advance transaction is
//!   already committed and the slot stays armed.
//! - §3.2 minimal account fields: Game (with `vrf: VrfSlot`, `hand_id`), Deck
//!   (`vrf_out`, `vrf_attempt_used`, `hand_id`), Table, seats as stubs.
//! - §15 日志纪律: never log seeds/salts/randomness/cards; one `#[error_code]`
//!   with category-only messages.
//!
//! SDK signatures used here were verified against the published crate sources
//! (paths recorded in each module and in the README), per project discipline:
//! do not invent API signatures from memory.
//!
//! LAYOUT CONSTRAINT (Anchor 1.0): `#[program]` generates
//! `pub mod accounts { pub use crate::__client_accounts_<ix>::*; ... }`, and
//! `#[derive(Accounts)]` in 1.0.x places its `__client_accounts_*` /
//! `__cpi_client_accounts_*` modules NEXT TO the struct. The paths line up
//! only when every Accounts struct is defined at the crate root — verified
//! empirically 2026-10-05 after E0432 `unresolved import crate`. Handlers stay
//! in `src/instructions/`; only the context structs live here.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::vrf::anchor::{vrf, vrf_callback};

pub mod errors;
pub mod instructions;
pub mod state;
pub mod vrf;

use state::{Deck, Game, Table};

// Program id pinned since Stage 0 deployment (docs/design/pubkeys.json); this
// is a real ID, not the placeholder, so PDAs and client config stay stable.
declare_id!("EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf");

// ---------------------------------------------------------------------------
// Accounts contexts (crate root — see LAYOUT CONSTRAINT above)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct RequestVrf<'info> {
    pub table: Account<'info, Table>,
    #[account(
        mut,
        seeds = [b"game", table.key().as_ref()],
        bump,
        owner = ephemeral_rollups_sdk::id(),
    )]
    pub game: Account<'info, Game>,
    /// Outer transaction signer paying the request (ER queue is free; the
    /// account still must be a signer for the VRF program's payer meta).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Nested VRF request accounts (queue + identity signer injected by the
    /// `#[vrf]` macro on `RequestVrfAccounts`).
    pub vrf: RequestVrfAccounts<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestVrfAccounts<'info> {
    /// VRF oracle queue. Devnet/mainnet ER queue:
    /// 5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc; local:
    /// Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT.
    /// CHECK: queue address is caller-chosen by design; the VRF program
    /// validates it against its own queue records.
    pub oracle_queue: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RetryVrf<'info> {
    pub table: Account<'info, Table>,
    #[account(
        mut,
        seeds = [b"game", table.key().as_ref()],
        bump,
        owner = ephemeral_rollups_sdk::id(),
    )]
    pub game: Account<'info, Game>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Nested VRF request accounts (same shape as `request_vrf`).
    pub vrf: RetryVrfAccounts<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RetryVrfAccounts<'info> {
    /// CHECK: caller-chosen queue; must match the queue used for the first
    /// request (keepers use the table's configured queue).
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct VrfCallbackState<'info> {
    /// Private deck; only randomness lands here.
    #[account(mut, owner = ephemeral_rollups_sdk::id())]
    pub deck: Account<'info, Deck>,
    /// Pending request slot to match against callback_args.
    #[account(mut, owner = ephemeral_rollups_sdk::id())]
    pub game: Account<'info, Game>,
}

#[derive(Accounts)]
pub struct Advance<'info> {
    #[account(mut, owner = ephemeral_rollups_sdk::id())]
    pub game: Account<'info, Game>,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod solpoker {
    use super::*;

    /// Permissionless VRF request (ER). Only succeeds when `Game.vrf` is Ready;
    /// transitions the slot to Pending atomically with the CPI.
    pub fn request_vrf(ctx: Context<RequestVrf>) -> Result<()> {
        instructions::request_vrf::handler(ctx)
    }

    /// VRF fulfillment callback. Authenticated by the scoped VRF identity PDA
    /// (injected by `#[vrf_callback]`); stale/mismatched requests are ignored
    /// with `Ok(())`. Only writes randomness into Deck — never logs it.
    pub fn vrf_callback(
        ctx: Context<VrfCallbackState>,
        randomness: [u8; 32],
        callback_args: Vec<u8>,
    ) -> Result<()> {
        instructions::vrf_callback::handler(ctx, randomness, callback_args)
    }

    /// Permissionless retry after `vrf_timeout_s` elapsed since `requested_at`.
    /// Increments the attempt and re-requests with a fresh caller_seed.
    pub fn retry_vrf(ctx: Context<RetryVrf>) -> Result<()> {
        instructions::retry_vrf::handler(ctx)
    }

    /// Deterministic advancement stub (§6.2). Stage 4/5 fills in dealing,
    /// betting-round and settlement transitions from solpoker-core; this slice
    /// only demonstrates the arm hook that sets `VrfSlot = Ready`.
    pub fn advance(ctx: Context<Advance>) -> Result<()> {
        instructions::advance::handler(ctx)
    }
}
