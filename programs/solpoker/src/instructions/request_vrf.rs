//! request_vrf — permissionless queue request (design §6.2 V1 拆分, §9).
//!
//! Real SDK signatures used (ephemeral-rollups-sdk 0.17.3):
//! - `ephemeral_rollups_sdk::vrf::instructions::create_request_randomness_ix(
//!   params: RequestRandomnessParams) -> compat::Instruction`
//!   (source: ephemeral-vrf-sdk-0.17.3/src/instructions.rs)
//! - `RequestRandomnessParams { payer, oracle_queue, callback_program_id,
//!      callback_discriminator, accounts_metas, caller_seed, callback_args }`
//! - the `#[vrf]` attribute (ephemeral-vrf-sdk-vrf-macro-0.17.3/src/lib.rs)
//!   generates `invoke_signed_vrf(&self, payer: &AccountInfo, ix: &Instruction)`
//!   on the annotated struct, mapping the request discriminator to the scoped
//!   variant (10) and signing with the identity PDA seeds ["identity"].
//!
//! State transition (Ready → Pending) is delegated to
//! `solpoker_core::vrf::VrfSlot::request`.
//!
//! V1 拆分: if the queue CPI fails (queue paused, congestion, ...), this whole
//! instruction reverts, but the poker action that armed the slot in the
//! preceding act/advance transaction is NOT rolled back — the slot stays
//! Ready and anyone can re-submit request_vrf.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::vrf::instructions::{
    create_request_randomness_ix, RequestRandomnessParams,
};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;

use crate::errors::SolpokerError;
use crate::state::VrfTarget;
use crate::vrf;
use crate::RequestVrf;

pub fn handler(ctx: Context<RequestVrf>) -> Result<()> {
    let mut game = ctx.accounts.game.load_mut()?;
    let table = &ctx.accounts.table;

    // Ready → Pending via the core state machine. core_replay() is None only
    // for Fulfilled/Void, which both reject a new request (NotReady).
    let mut core_slot = game.vrf.core_replay().ok_or(SolpokerError::VrfNotArmed)?;
    let now = Clock::get()?.unix_timestamp;
    core_slot
        .request(1, now)
        .map_err(|_| SolpokerError::VrfNotArmed)?;

    let table_key = table.key();
    let table_bytes = table_key.to_bytes();
    let core_target = core_slot.target();
    let attempt = core_slot.attempt();
    let caller_seed = vrf::caller_seed(&table_bytes, game.hand_id, core_target, attempt);
    let callback_args =
        vrf::encode_callback_args(game.hand_id, VrfTarget::from_core(core_target), attempt);

    // Deck PDA is referenced in the callback account metas but not read here;
    // derive it instead of taking the account (it stays private, members = []).
    let (deck_pda, _) = Pubkey::find_program_address(
        &[b"deck", table_bytes.as_ref(), &table.epoch.to_be_bytes()],
        &crate::ID,
    );

    // Callback account order must match VrfCallbackState field order after the
    // injected identity signer: [deck (writable), game (writable)].
    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.vrf.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: vrf::vrf_callback_discriminator().to_vec(),
        accounts_metas: Some(vec![
            SerializableAccountMeta {
                pubkey: deck_pda,
                is_signer: false,
                is_writable: true,
            },
            SerializableAccountMeta {
                pubkey: ctx.accounts.game.key(),
                is_signer: false,
                is_writable: true,
            },
        ]),
        caller_seed,
        callback_args: Some(callback_args),
    });

    // Queue CPI. On failure this reverts only the request; the armed slot from
    // the earlier act/advance tx persists (V1 拆分, §6.2).
    ctx.accounts
        .vrf
        .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;

    game.vrf.sync_from_core(&core_slot);
    // §15: randomness and caller_seed must never appear in logs — nothing logged here.
    Ok(())
}
