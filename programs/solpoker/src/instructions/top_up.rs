//! top_up — §5.2.3（L1；只有占用者本人能签）。
//!
//! 金额 > 0 且为 CENT 整数倍；USDC 从占用者 ATA 转入 TableVault，
//! deposited_total += amount。L1 不知道当前 stack，1000BB 上限由 ER 的
//! apply_deposits 执行（超额记 owed，下次 cash_out 退回）。I-L1：转账前后
//! vault 余额增量恰好等于 amount。

use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, TransferChecked};

use crate::errors::SolpokerError;
use crate::fund;
use crate::TopUp;

pub fn handler(ctx: Context<TopUp>, _idx: u8, amount: u64) -> Result<()> {
    let seat = &mut ctx.accounts.seat;
    require!(
        seat.occupant != Pubkey::default() && seat.occupant == ctx.accounts.payer.key(),
        SolpokerError::NotOccupant
    );
    require!(
        amount > 0 && amount % fund::CENT == 0,
        SolpokerError::BadAmount
    );

    let vault = &mut ctx.accounts.vault;
    let before = vault.amount;
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.player_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: vault.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    vault.reload()?;
    let expected = before
        .checked_add(amount)
        .ok_or(SolpokerError::Overflow)?;
    require!(vault.amount == expected, SolpokerError::Conservation);

    seat.deposited_total = seat
        .deposited_total
        .checked_add(amount)
        .ok_or(SolpokerError::Overflow)?;

    Ok(())
}
