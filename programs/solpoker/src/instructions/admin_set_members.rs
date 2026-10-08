//! admin_set_members — §11.2 覆盖/修复通道（ER，admin 门禁）：更新 Deck 或
//! PlayerHand[i] 的 PER 成员列表。
//!
//! 背景：PER 权限的 authority 是被权限账户本身（init_permissions 创建时由
//! PDA 签名），客户端无法直接更新成员——必须由本程序以 PDA invoke_signed
//! 发起 UpdateEphemeralPermissionCpi。
//!
//! **成员策略（2026-10-09，见 perms::member_policy_ok）**：运营方
//! （table.admin）永久退出成员名单——历史版本把 admin 作为全部 10 个私有权限
//! 的基线成员（为旧 keeper 写回而设），实测证实运营方借此可 RPC 读底牌/牌堆；
//! 实验证明收紧名单后 keeper 的程序读写与整手流程照常（CHANGELOG 同日）。
//! 本指令保留为修复通道，但同样过策略校验：deck 仅 [VRF 身份]（或空），
//! hand_i 仅 [VRF 身份 ∪ 该座当前占用者]——运营方无法把自己加回来。
//!
//! 正常轮换在 take_seat（占用者加入）/ stand_up（恢复到 [VRF 身份]）内联完成；
//! 本指令处理存量账本的修复（如老版本留下的 [admin, …] 名单）。

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

    // 成员策略（2026-10-09）：运营方永久出局；hand 的"当前占用者"从 Game 读。
    let occupant = if target_index == 0 {
        Pubkey::default()
    } else {
        let game = ctx.accounts.game.load()?;
        game.seats[(target_index - 1) as usize].occupant
    };
    require!(
        crate::perms::member_policy_ok(target_index, &occupant, &member_pubkeys),
        SolpokerError::MemberNotAllowed
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
