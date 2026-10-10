//! vrf_callback — VRF fulfillment entrypoint (design §9).
//!
//! Real SDK signature used (ephemeral-vrf-sdk-vrf-macro-0.17.3/src/lib.rs):
//! `#[vrf_callback]` placed ABOVE `#[derive(Accounts)]` injects
//! `vrf_program_identity: Signer<'info>` constrained to
//! `scoped_vrf_identity(&crate::ID)` — the PDA ["identity", program_id] of the
//! VRF program Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz
//! (ephemeral-vrf-sdk-0.17.3/src/consts.rs). A wrong identity therefore fails
//! the Anchor constraint and the whole fulfillment reverts.
//!
//! Wire layout of the fulfillment instruction data (verified against the VRF
//! SDK sources): `callback_discriminator ‖ randomness ‖ callback_args`.
//!
//! Behavior per §9:
//! - wrong identity => error (signer constraint above);
//! - identity ok but request stale/mismatched => return Ok(()) and ignore
//!   (an error would roll back the fulfillment and keep the request queued
//!   until its 120 s TTL);
//! - otherwise store randomness in Deck only — no shuffling, no drawing
//!   (advance does that in Stage 4), and never log it (§15).
//!
//! The match/no-match decision is `solpoker_core::vrf::VrfSlot::fulfill`.

use anchor_lang::prelude::*;
use solpoker_core::vrf::FulfillOutcome;

use crate::state::VrfTarget;
use crate::vrf;
use crate::VrfCallbackState;

pub fn handler(
    ctx: Context<VrfCallbackState>,
    randomness: [u8; 32],
    callback_args: Vec<u8>,
) -> Result<()> {
    let mut game = ctx.accounts.game.load_mut()?;
    let mut deck = ctx.accounts.deck.load_mut()?;

    // Slot not reconstructible for a fulfillment (Idle/Ready/Fulfilled/Void)
    // or malformed args → Ok and ignore, per §9.
    let Some(mut core_slot) = game.vrf.core_replay() else {
        return Ok(());
    };
    let Some(args) = vrf::decode_callback_args(&callback_args) else {
        return Ok(());
    };
    // The deck must belong to the hand this game is playing.
    if deck.hand_id != game.hand_id {
        return Ok(());
    }

    match core_slot.fulfill(
        args.hand_id,
        args.target.to_core(),
        args.attempt,
        randomness,
        game.hand_id,
    ) {
        FulfillOutcome::Stored => {
            let idx = VrfTarget::from_core(core_slot.target()).deck_index();
            deck.vrf_out[idx] = randomness;
            deck.vrf_attempt_used[idx] = core_slot.attempt();
            game.vrf.sync_from_core(&core_slot);
            // 2026-10-10（审计 P1-4）：揭示宽限截止——发牌路径在把缺盐座位作废
            // 之前先等到这个时间点（慢揭示不再误伤全桌）。phase_deadline 在
            // AwaitSeed 阶段无其他用途（commit 超时只在 phase 1 使用它）。
            game.phase_deadline =
                Clock::get()?.unix_timestamp + ctx.accounts.table.reveal_timeout_s as i64;
        }
        FulfillOutcome::Ignored => {
            // §9: correct identity, stale or mismatched request — ignore.
        }
    }

    // §15: randomness is never logged.
    Ok(())
}
