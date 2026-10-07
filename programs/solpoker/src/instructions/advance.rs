//! advance — deterministic phase machine (design §6.1/§6.2, ER, permissionless).
//!
//! One transition per call; keepers and clients chain calls. The full machine
//! lives in `hand::advance` (pure, unit-tested); this handler only does
//! account plumbing and the I-ER assertion. Phases: Idle → Commit (freeze
//! hand_mask) → AwaitSeed (arm VRF_0) → deal hole → Preflop/Betting ⇄
//! AwaitStreet/AwaitRunout → Settle/Void → Idle. VRF queue CPIs never happen
//! here (V1 拆分: request_vrf/retry_vrf do them; advance only arms the slot).
//!
//! CU note (§7.4): Settle runs evaluation + distribution + proof + secret
//! zeroing in this single instruction for Stage 6; if CU measurement exceeds
//! the budget, split Settle into "evaluate & pin" and "distribute" — the
//! phase boundary already isolates it.
//!
//! Stack note: Game / Deck / HandProof are zero-copy AccountLoader accounts —
//! `load_mut()` reads/writes them in place, so this handler's frame no longer
//! carries the ≈1.5KB Game / ≈11KB HandProof borsh deserialization buffers
//! that previously blew the 4096-byte SBF stack budget.

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::fund;
use crate::hand;
use crate::state::{PlayerHand, MAX_SEATS};
use crate::Advance;

pub fn handler(ctx: Context<Advance>, hand_id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let table = &ctx.accounts.table;
    let mut game = ctx.accounts.game.load_mut()?;

    require!(hand_id == game.hand_id, SolpokerError::StaleAction);

    let mut deck = ctx.accounts.deck.load_mut()?;
    let mut proof = ctx.accounts.hand_proof.load_mut()?;
    let mut secrets = ctx.accounts.hand_secrets.load_mut()?;
    let mut replay = ctx.accounts.hand_replay.load_mut()?;
    let mut hands: [&mut PlayerHand; MAX_SEATS] = [
        &mut ctx.accounts.hand0,
        &mut ctx.accounts.hand1,
        &mut ctx.accounts.hand2,
        &mut ctx.accounts.hand3,
        &mut ctx.accounts.hand4,
        &mut ctx.accounts.hand5,
        &mut ctx.accounts.hand6,
        &mut ctx.accounts.hand7,
        &mut ctx.accounts.hand8,
    ];

    let program_id = crate::ID.to_bytes();
    let table_bytes = table.key().to_bytes();
    hand::advance(
        table,
        &table_bytes,
        &mut game,
        &mut deck,
        &mut proof,
        &mut secrets,
        &mut replay,
        &mut hands,
        &program_id,
        now,
    )?;

    fund::assert_conservation_er(&game)?;
    Ok(())
}
