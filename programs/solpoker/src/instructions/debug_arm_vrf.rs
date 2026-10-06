//! debug_arm_vrf — ER test-harness instruction (Stage 2/3).
//!
//! The production arm path is `advance` deciding a street needs a VRF draw
//! (§6.2); the Stage 2 stub decides nothing, so the on-chain acceptance tests
//! cannot reach Ready without this hook. Admin-gated (Table.admin), takes the
//! target as a raw u8 (0–4, matching VrfTarget's core wire encoding). Arm
//! rules still go through `solpoker_core::vrf::VrfSlot::arm`, so invalid
//! transitions (e.g. arming over an in-flight request) are rejected exactly
//! as production code would reject them.

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::state::VrfTarget;
use crate::DebugArmVrf;

pub fn handler(ctx: Context<DebugArmVrf>, target: u8) -> Result<()> {
    let game = &mut ctx.accounts.game;
    let target = VrfTarget::from_u8(target).ok_or(SolpokerError::VrfArmRejected)?;

    let mut core_slot = game
        .vrf
        .core_replay()
        .ok_or(SolpokerError::VrfArmRejected)?;
    core_slot
        .arm(target.to_core())
        .map_err(|_| SolpokerError::VrfArmRejected)?;
    game.vrf.sync_from_core(&core_slot);
    Ok(())
}
