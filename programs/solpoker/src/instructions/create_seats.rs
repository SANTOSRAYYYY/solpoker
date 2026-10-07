//! create_seats — §11.1 第 1 步补（L1）：创建 SeatLedger×9。
//!
//! 从 create_table 拆出（2026-10-07，try_accounts 帧溢出修复，见
//! create_table.rs 模块头）。每个 SeatLedger：occupant 默认空、计数全 0、
//! discriminator‖borsh 布局——与 Anchor init 的最终字节完全一致。

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;

use crate::state::{SeatLedger, MAX_SEATS};
use crate::CreateSeats;

pub fn handler(ctx: Context<CreateSeats>) -> Result<()> {
    let table_key = ctx.accounts.table.key();
    create_seat_ledgers(
        &ctx.accounts.admin.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &table_key,
        [
            &ctx.accounts.seat0.to_account_info(),
            &ctx.accounts.seat1.to_account_info(),
            &ctx.accounts.seat2.to_account_info(),
            &ctx.accounts.seat3.to_account_info(),
            &ctx.accounts.seat4.to_account_info(),
            &ctx.accounts.seat5.to_account_info(),
            &ctx.accounts.seat6.to_account_info(),
            &ctx.accounts.seat7.to_account_info(),
            &ctx.accounts.seat8.to_account_info(),
        ],
    )
}

/// SeatLedger×9：地址派生+断言、create_account（seeds 签名）、
/// discriminator‖borsh 写字段。
#[inline(never)]
fn create_seat_ledgers<'info>(
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    table_key: &Pubkey,
    seats: [&AccountInfo<'info>; MAX_SEATS],
) -> Result<()> {
    for (i, seat) in seats.iter().enumerate() {
        let idx = [i as u8];
        let (expected, bump) =
            Pubkey::find_program_address(&[b"seat", table_key.as_ref(), &idx], &crate::ID);
        require_keys_eq!(
            seat.key(),
            expected,
            anchor_lang::error::ErrorCode::ConstraintSeeds
        );
        let bump_b = [bump];
        let signer_seeds: &[&[u8]] = &[b"seat", table_key.as_ref(), &idx, &bump_b];
        let space = 8 + SeatLedger::INIT_SPACE;
        let rent = Rent::get()?.minimum_balance(space);
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                seat.key,
                rent,
                space as u64,
                &crate::ID,
            ),
            &[payer.clone(), (*seat).clone(), system_program.clone()],
            &[signer_seeds],
        )?;
        let ledger = SeatLedger {
            table: *table_key,
            idx: i as u8,
            occupant: Pubkey::default(),
            occupancy_id: 0,
            kind: 0,
            agent_owner: Pubkey::default(),
            session_key: Pubkey::default(),
            session_expires_at: 0,
            payout: Pubkey::default(),
            deposited_total: 0,
            paid_total: 0,
            bump,
        };
        let mut data = seat.try_borrow_mut_data()?;
        data[..8].copy_from_slice(SeatLedger::DISCRIMINATOR);
        let mut writer: &mut [u8] = &mut data[8..];
        AnchorSerialize::serialize(&ledger, &mut writer)
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;
    }
    Ok(())
}
