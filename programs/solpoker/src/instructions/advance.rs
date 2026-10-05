//! advance — deterministic state advancement stub (design §6.2, §14.2).
//!
//! Stage 2 slice: the real transitions (freeze hand_mask, set button, post
//! blinds, deal hole/board cards, settle, void) land in Stage 4/5 on top of
//! the solpoker-core phase machine. This stub pins down the arm hook: when the
//! state machine decides the next step needs a VRF draw, advance arms the slot
//! (Ready). The actual queue CPI never happens here — the permissionless
//! `request_vrf` instruction does it (V1 拆分), so queue congestion cannot roll
//! back a completed betting action.
//!
//! The arm transition itself goes through `solpoker_core::vrf::VrfSlot::arm`
//! (idempotent per core rules; refuses to overwrite an in-flight request).

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::state::{Game, VrfTarget};
use crate::Advance;

/// Stage 4/5 replaces this with the real §6.1 phase-machine decision
/// (AwaitSeed/AwaitStreet/AwaitRunout → which street's VRF, if any) implemented
/// in solpoker-core. Returning None means "no VRF needed for this advance".
#[allow(dead_code)] // exercised by Stage 4/5's real advance; stub for the arm hook only
fn next_vrf_target_stub(_game: &Game) -> Option<VrfTarget> {
    None
}

pub fn handler(ctx: Context<Advance>) -> Result<()> {
    let game = &mut ctx.accounts.game;

    if let Some(target) = next_vrf_target_stub(game) {
        let mut core_slot = game
            .vrf
            .core_replay()
            .ok_or(SolpokerError::VrfArmRejected)?;
        core_slot
            .arm(target.to_core())
            .map_err(|_| SolpokerError::VrfArmRejected)?;
        game.vrf.sync_from_core(&core_slot);
    }

    Ok(())
}
