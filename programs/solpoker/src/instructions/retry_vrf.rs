//! retry_vrf — permissionless re-request after vrf_timeout_s (design §9).
//!
//! Anyone may call this once `vrf_timeout_s` (default 10 s, E1) elapsed since
//! `requested_at` without a callback. The core slot advances the attempt
//! counter (a fresh `attempt` produces a fresh caller_seed since attempt is
//! part of the seed formula) and a new request is issued for the same street.
//! When `vrf_max_attempts` (3) are exhausted the slot enters the terminal Void
//! state and this instruction returns Ok — voiding the hand (full refund) is
//! the settlement path's job, not this instruction's. Late callbacks from
//! earlier attempts are ignored by vrf_callback.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::vrf::instructions::{
    create_request_randomness_ix, RequestRandomnessParams,
};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;
use solpoker_core::vrf::RetryOutcome;

use crate::errors::SolpokerError;
use crate::state::VrfTarget;
use crate::vrf;
use crate::RetryVrf;

pub fn handler(ctx: Context<RetryVrf>) -> Result<()> {
    let game = &mut ctx.accounts.game;
    let table = &ctx.accounts.table;

    let Some(mut core_slot) = game.vrf.core_replay() else {
        return err!(SolpokerError::VrfNotPending);
    };

    let now = Clock::get()?.unix_timestamp;
    let core_target = core_slot.target();
    match core_slot.retry(now, table.vrf_timeout_s, table.vrf_max_attempts) {
        RetryOutcome::Retried { attempt } => {
            let table_key = table.key();
            let table_bytes = table_key.to_bytes();
            let caller_seed = vrf::caller_seed(&table_bytes, game.hand_id, core_target, attempt);
            let callback_args =
                vrf::encode_callback_args(game.hand_id, VrfTarget::from_core(core_target), attempt);

            let (deck_pda, _) = Pubkey::find_program_address(
                &[b"deck", table_bytes.as_ref(), &table.epoch.to_be_bytes()],
                &crate::ID,
            );

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
                        pubkey: game.key(),
                        is_signer: false,
                        is_writable: true,
                    },
                ]),
                caller_seed,
                callback_args: Some(callback_args),
            });

            // Same V1-拆分 note as request_vrf: CPI failure reverts only this retry.
            ctx.accounts
                .vrf
                .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;

            game.vrf.sync_from_core(&core_slot);
            Ok(())
        }
        RetryOutcome::NotExpired => err!(SolpokerError::VrfTimeoutNotElapsed),
        // Unreachable: core_replay only yields Idle/Ready/Pending slots and
        // Idle/Ready map to retry() = NotPending. Kept for exhaustiveness.
        RetryOutcome::NotPending => err!(SolpokerError::VrfNotPending),
        RetryOutcome::Voided => {
            // Persist the terminal Void state; advance/settlement voids the hand.
            game.vrf.sync_from_core(&core_slot);
            Ok(())
        }
    }
}
