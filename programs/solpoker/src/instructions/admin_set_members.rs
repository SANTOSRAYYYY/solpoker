//! admin_set_members — §11.2 过渡版（ER，admin 门禁）：更新 Deck 或
//! PlayerHand[i] 的 PER 成员列表。
//!
//! 背景：PER 权限的 authority 是被权限账户本身（init_permissions 创建时由
//! PDA 签名），客户端无法直接更新成员——必须由本程序以 PDA invoke_signed
//! 发起 UpdateEphemeralPermissionCpi。
//!
//! 为什么现在需要它（2026-10-07 实测）：devnet-tee 对「交易写了 PER 私有
//! 账户而签名者不是成员」拒绝执行（顶层 InvalidWritableAccount）。Anchor 对
//! `mut` 的 borsh 账户在成功退出时无条件写回——`advance` 每次都会写回全部
//! 9 个 PlayerHand + Deck，所以 crank 签名者必须是 deck 与全部 hand 的成员，
//! 否则 advance 永远被拒。
//!
//! 成员模型（Stage 6 验收）：
//! - deck ← [crank/admin]：含全部盐与 VRF 输出，**绝不加玩家**；
//! - hand_i ← [crank/admin, 占用者_i]：占用者读自己的手牌无害（盐和牌本来
//!   就是他自己的），reveal_salt 由占用者签名写自己的 hand 需要此成员资格。
//!
//! Phase 3 正式版会把成员轮换并入 take_seat/stand_up（见两处 TODO）；本指令
//! 作为 admin 覆盖通道保留。

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::UpdateEphemeralPermissionCpi;
use ephemeral_rollups_sdk::access_control::structs::{EphemeralMembersArgs, Member};
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;

use crate::errors::SolpokerError;
use crate::AdminSetMembers;

pub fn handler(
    ctx: Context<AdminSetMembers>,
    target_index: u8,
    member_pubkeys: Vec<Pubkey>,
) -> Result<()> {
    let table_key = ctx.accounts.table.key();
    let table_bytes = table_key.to_bytes();
    let epoch_bytes = ctx.accounts.table.epoch.to_be_bytes();

    // 目标账户 PDA 推导 + 断言：0 = deck，1..=9 = hand[i-1]。
    let target = &ctx.accounts.target;
    let (expected_target, target_bump) = if target_index == 0 {
        Pubkey::find_program_address(
            &[b"deck", table_bytes.as_ref(), epoch_bytes.as_ref()],
            &crate::ID,
        )
    } else if target_index <= 9 {
        let idx = [target_index - 1];
        Pubkey::find_program_address(
            &[b"hand", table_bytes.as_ref(), epoch_bytes.as_ref(), idx.as_ref()],
            &crate::ID,
        )
    } else {
        return err!(SolpokerError::SeatMismatch);
    };
    require_keys_eq!(target.key(), expected_target, SolpokerError::SeatMismatch);

    let permission = &ctx.accounts.permission;
    let (expected_permission, _) = Pubkey::find_program_address(
        &[b"permission:", target.key().as_ref()],
        &PERMISSION_PROGRAM_ID,
    );
    require_keys_eq!(
        permission.key(),
        expected_permission,
        SolpokerError::SeatMismatch
    );

    let idx = [target_index.saturating_sub(1)];
    let target_seeds: &[&[u8]] = if target_index == 0 {
        &[b"deck", table_bytes.as_ref(), epoch_bytes.as_ref(), &[target_bump]]
    } else {
        &[
            b"hand",
            table_bytes.as_ref(),
            epoch_bytes.as_ref(),
            idx.as_ref(),
            &[target_bump],
        ]
    };
    let cp_bump = [ctx.bumps.commit_payer];
    let commit_payer_seeds: &[&[u8]] = &[b"commit_payer", table_bytes.as_ref(), &cp_bump];

    let members = member_pubkeys
        .into_iter()
        .map(|pk| Member {
            flags: 0,
            pubkey: ephemeral_rollups_sdk::compat::Pubkey::new_from_array(pk.to_bytes()),
        })
        .collect();

    UpdateEphemeralPermissionCpi {
        permissioned_account: target.to_account_info(),
        permission: permission.to_account_info(),
        payer: ctx.accounts.commit_payer.to_account_info(),
        // authority 不签名（authority_is_signer = false）→ 权限程序改验
        // permissioned_account 签名，即我们的目标 PDA（invoke_signed 第二组 seeds）。
        authority: ctx.accounts.table.to_account_info(),
        vault: ctx.accounts.vault.to_account_info(),
        magic_program: ctx.accounts.magic_program.to_account_info(),
        permission_program: ctx.accounts.permission_program.to_account_info(),
        authority_is_signer: false,
        args: EphemeralMembersArgs {
            is_private: true,
            members,
        },
    }
    .invoke_signed(&[target_seeds, commit_payer_seeds])?;

    Ok(())
}
