//! create_hands — §11.1 第 1 步补（L1）：创建 PlayerHand×9。
//!
//! 从 create_table 拆出（2026-10-07，try_accounts 帧溢出修复，见
//! create_table.rs 模块头）。每个 PlayerHand：cards = 0xFF（没牌）、盐全零。
//! 新桌 epoch 恒为 0，seed 里写字面量。

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;

use crate::state::{PlayerHand, MAX_SEATS};
use crate::CreateHands;

pub fn handler(ctx: Context<CreateHands>) -> Result<()> {
    let table_key = ctx.accounts.table.key();
    create_player_hands(
        &ctx.accounts.admin.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &table_key,
        [
            &ctx.accounts.hand0.to_account_info(),
            &ctx.accounts.hand1.to_account_info(),
            &ctx.accounts.hand2.to_account_info(),
            &ctx.accounts.hand3.to_account_info(),
            &ctx.accounts.hand4.to_account_info(),
            &ctx.accounts.hand5.to_account_info(),
            &ctx.accounts.hand6.to_account_info(),
            &ctx.accounts.hand7.to_account_info(),
            &ctx.accounts.hand8.to_account_info(),
        ],
    )
}

/// PlayerHand×9：地址派生+断言、create_account（seeds 签名）、
/// discriminator‖borsh。
#[inline(never)]
fn create_player_hands<'info>(
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    table_key: &Pubkey,
    hands: [&AccountInfo<'info>; MAX_SEATS],
) -> Result<()> {
    let epoch_zero = [0u8, 0u8];
    for (i, hand) in hands.iter().enumerate() {
        let idx = [i as u8];
        let (expected, bump) = Pubkey::find_program_address(
            &[b"hand", table_key.as_ref(), &epoch_zero, &idx],
            &crate::ID,
        );
        require_keys_eq!(
            hand.key(),
            expected,
            anchor_lang::error::ErrorCode::ConstraintSeeds
        );
        let bump_b = [bump];
        let signer_seeds: &[&[u8]] = &[b"hand", table_key.as_ref(), &epoch_zero, &idx, &bump_b];
        let space = 8 + PlayerHand::INIT_SPACE;
        let rent = Rent::get()?.minimum_balance(space);
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                hand.key,
                rent,
                space as u64,
                &crate::ID,
            ),
            &[payer.clone(), (*hand).clone(), system_program.clone()],
            &[signer_seeds],
        )?;
        let player_hand = PlayerHand {
            hand_id: 0,
            cards: [0xFF; 2],
            salt: [0u8; 32],
            salt_hand_id: 0,
        };
        let mut data = hand.try_borrow_mut_data()?;
        data[..8].copy_from_slice(PlayerHand::DISCRIMINATOR);
        let mut writer: &mut [u8] = &mut data[8..];
        AnchorSerialize::serialize(&player_hand, &mut writer)
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;
    }
    Ok(())
}
