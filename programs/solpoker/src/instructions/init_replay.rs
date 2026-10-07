//! init_replay — 创建 HandReplay（§8.7 整手复算输入，L1）。
//!
//! 与 HandProof/HandSecrets 不同，这个账户是**可选、可后补**的：新程序部署后给
//! 每张已存在的桌补一次即可开始记录复算输入；在那之前的历史手牌只是「没有
//! replay entry」——验证页会如实显示 "该手缺少复算输入"。
//!
//! 幂等：账户已存在直接 Ok（重复调用无害，方便脚本重跑）。
//!
//! 空间：8(disc) + 8×504(entries) + 1(head) + 7(pad) = 4,048 字节。
//! 远低于 CPI create_account 的 10,240 上限（state.rs 有尺寸钉子测试）。

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;

use crate::state::HandReplay;
use crate::InitReplay;

/// HandReplay 账户总字节数（含 8 字节 discriminator）。
pub const HAND_REPLAY_ACCOUNT_SIZE: usize = 8 + core::mem::size_of::<HandReplay>();

pub fn handler(ctx: Context<InitReplay>) -> Result<()> {
    let table_key = ctx.accounts.table.key();
    let replay = &ctx.accounts.replay;

    // 幂等：已存在（且非空）直接返回
    if replay.data_len() >= HAND_REPLAY_ACCOUNT_SIZE {
        return Ok(());
    }

    let (expected, bump) =
        Pubkey::find_program_address(&[b"replay", table_key.as_ref()], &crate::ID);
    require_keys_eq!(
        replay.key(),
        expected,
        anchor_lang::error::ErrorCode::ConstraintSeeds
    );

    let bump_b = [bump];
    let signer_seeds: &[&[u8]] = &[b"replay", table_key.as_ref(), &bump_b];
    let rent = Rent::get()?.minimum_balance(HAND_REPLAY_ACCOUNT_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            ctx.accounts.admin.key,
            replay.key,
            rent,
            HAND_REPLAY_ACCOUNT_SIZE as u64,
            &crate::ID,
        ),
        &[
            ctx.accounts.admin.to_account_info(),
            replay.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[signer_seeds],
    )?;

    // discriminator + 全零内容（与 anchor 的 zero-copy init 一致：disc 写在前 8 字节）
    let mut data = replay.try_borrow_mut_data()?;
    let disc = HandReplay::DISCRIMINATOR;
    data[..8].copy_from_slice(disc);
    for b in data[8..].iter_mut() {
        *b = 0;
    }
    Ok(())
}
