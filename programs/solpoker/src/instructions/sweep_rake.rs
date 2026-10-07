//! sweep_rake — §5.2.7（L1；permissionless）。
//!
//! 读 Game 快照，付 `快照.rake_total − rake_swept_total` 到
//! ATA(ProgramConfig.treasury, mint)，vault_auth PDA 签名，然后
//! `rake_swept_total += 金额`。断言：I-B（rake_swept ≤ rake_快照）、
//! I-L1（vault 余额减幅恰好等于本次付款）。

use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, TransferChecked};

use crate::errors::SolpokerError;
use crate::fund;
use crate::SweepRake;

pub fn handler(ctx: Context<SweepRake>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let snap = fund::read_game_snapshot(ctx.accounts.game.as_ref())?;

    // I-B: rake_swept ≤ rake_快照.
    require!(
        snap.rake_total >= table.rake_swept_total,
        SolpokerError::Conservation
    );
    let amount = snap.rake_total - table.rake_swept_total;

    if amount > 0 {
        let vault = &mut ctx.accounts.vault;
        let before = vault.amount;
        let table_key = table.key();
        let bump = [table.vault_auth_bump];
        let signer_seeds: &[&[u8]] = &[b"vault_auth", table_key.as_ref(), &bump];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.treasury_ata.to_account_info(),
                    authority: ctx.accounts.vault_auth.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        // I-L1: the vault balance decreased by exactly the sweep.
        vault.reload()?;
        let expected = before
            .checked_sub(amount)
            .ok_or(SolpokerError::Conservation)?;
        require!(vault.amount == expected, SolpokerError::Conservation);
        table.rake_swept_total = table
            .rake_swept_total
            .checked_add(amount)
            .ok_or(SolpokerError::Overflow)?;
    }

    Ok(())
}
