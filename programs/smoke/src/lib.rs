//! Stage 0 spike program (throwaway; closed on devnet once the Stage 3 spikes no longer need it).
//!
//! Verifies that anchor-lang =1.0.2 + ephemeral-rollups-sdk =0.17.3 can
//! delegate a PDA to an explicitly named ER validator, mutate it inside the ER,
//! commit it back to L1 with `MagicIntentBundleBuilder`, and finally
//! commit-and-undelegate it so ownership returns to this program.
//!
//! No secrets live here; the counter is public on purpose.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("BU1Ad3zgoJWrP11kZTzomMTJtebVGYdVweMjkQHtfQW4");

pub const COUNTER_SEED: &[u8] = b"smoke-counter";

/// devnet TEE validator (MagicBlock Private ER, Intel TDX).
pub const DEVNET_TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
/// Local ephemeral-validator identity used by mb-stack.
pub const LOCAL_ER_VALIDATOR: Pubkey = pubkey!("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");

#[ephemeral]
#[program]
pub mod smoke {
    use super::*;

    /// L1: create the counter PDA for `authority`.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.authority = ctx.accounts.authority.key();
        counter.count = 0;
        counter.bump = ctx.bumps.counter;
        Ok(())
    }

    /// ER (or L1 when not delegated): increment by one. Authority only.
    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = counter.count.checked_add(1).ok_or(SmokeError::Overflow)?;
        Ok(())
    }

    /// L1: delegate the counter to an explicitly named validator.
    /// `validator: None` (the SDK default) is never used.
    pub fn delegate(ctx: Context<DelegateCounter>, validator: Pubkey) -> Result<()> {
        require!(
            validator == DEVNET_TEE_VALIDATOR || validator == LOCAL_ER_VALIDATOR,
            SmokeError::ValidatorNotAllowed
        );
        let authority = ctx.accounts.payer.key();
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[COUNTER_SEED, authority.as_ref()],
            DelegateConfig {
                validator: Some(validator),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// ER: commit the current counter state to L1 (account stays delegated).
    pub fn commit(ctx: Context<CommitCounter>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.counter.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// ER: commit and undelegate; ownership returns to this program on L1.
    pub fn undelegate(ctx: Context<CommitCounter>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.counter.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Counter::INIT_SPACE,
        seeds = [COUNTER_SEED, authority.key().as_ref()],
        bump
    )]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(
        mut,
        seeds = [COUNTER_SEED, authority.key().as_ref()],
        bump = counter.bump,
        has_one = authority
    )]
    pub counter: Account<'info, Counter>,
    pub authority: Signer<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateCounter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the counter PDA of `payer`; ownership is transferred to the delegation program.
    #[account(mut, del, seeds = [COUNTER_SEED, payer.key().as_ref()], bump)]
    pub pda: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitCounter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [COUNTER_SEED, payer.key().as_ref()],
        bump = counter.bump,
        constraint = counter.authority == payer.key() @ SmokeError::Unauthorized
    )]
    pub counter: Account<'info, Counter>,
}

#[account]
#[derive(InitSpace)]
pub struct Counter {
    pub authority: Pubkey,
    pub count: u64,
    pub bump: u8,
}

#[error_code]
pub enum SmokeError {
    #[msg("validator is not on the allowlist")]
    ValidatorNotAllowed,
    #[msg("counter overflow")]
    Overflow,
    #[msg("signer is not the counter authority")]
    Unauthorized,
}
