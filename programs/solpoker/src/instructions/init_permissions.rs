//! init_permissions — §11.1 第 3 步（ER，每张桌执行一次）。
//!
//! 创建全部 10 个 PER 私有权限账户：Deck（is_private = true, members = []，
//! §4 权限矩阵——没有人能 RPC 读到原始 VRF 输出）和 PlayerHand×9
//! （is_private = true；新桌全空座，members = []；入座后按 §11.2 的顺序用
//! UpdateEphemeralPermissionCpi 把 members 换成 [占用者钱包]，那是 Phase 2/3
//! 的事）。权限是 ER-local 的：不在 L1 建权限账户，也不委托。
//!
//! 幂等：某个权限账户已存在（owner == 权限程序）就跳过它——允许在部分
//! 失败后重跑本指令补齐。
//!
//! Real SDK signatures used (ephemeral-rollups-sdk 0.17.3 sources):
//! - access_control/instructions/create_ephemeral_permission.rs:
//!   `CreateEphemeralPermissionCpi { permissioned_account, permission, payer,
//!   vault, magic_program, permission_program, args: EphemeralMembersArgs }`
//!   with `.invoke_signed(signers)`; the permissioned account is a readonly
//!   SIGNER meta, so each PDA signs via its seeds.
//! - access_control/structs/member.rs:
//!   `EphemeralMembersArgs { is_private: bool, members: Vec<Member> }`.
//! - access_control/structs/permission.rs: permission PDA seeds
//!   `[b"permission:", permissioned_account]` under PERMISSION_PROGRAM_ID.
//! - consts.rs: MAGIC_PROGRAM_ID / EPHEMERAL_VAULT_ID / PERMISSION_PROGRAM_ID.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::CreateEphemeralPermissionCpi;
use ephemeral_rollups_sdk::access_control::structs::{EphemeralMembersArgs, Member};
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;

use crate::InitPermissions;

pub fn handler(ctx: Context<InitPermissions>) -> Result<()> {
    let table_key = ctx.accounts.table.key();
    let table_bytes = table_key.to_bytes();
    let epoch_bytes = ctx.accounts.table.epoch.to_be_bytes();

    let cp_bump = [ctx.bumps.commit_payer];
    let commit_payer_seeds: &[&[u8]] = &[b"commit_payer", table_bytes.as_ref(), &cp_bump];

    let payer = ctx.accounts.commit_payer.to_account_info();
    let vault = ctx.accounts.vault.to_account_info();
    let magic_program = ctx.accounts.magic_program.to_account_info();
    let permission_program = ctx.accounts.permission_program.to_account_info();

    let idx0 = [0u8];
    let idx1 = [1u8];
    let idx2 = [2u8];
    let idx3 = [3u8];
    let idx4 = [4u8];
    let idx5 = [5u8];
    let idx6 = [6u8];
    let idx7 = [7u8];
    let idx8 = [8u8];

    // 10 个被权限账户：(account, seeds, bump, permission PDA)。
    let deck_bump = [ctx.bumps.deck];
    let h0 = [ctx.bumps.hand0];
    let h1 = [ctx.bumps.hand1];
    let h2 = [ctx.bumps.hand2];
    let h3 = [ctx.bumps.hand3];
    let h4 = [ctx.bumps.hand4];
    let h5 = [ctx.bumps.hand5];
    let h6 = [ctx.bumps.hand6];
    let h7 = [ctx.bumps.hand7];
    let h8 = [ctx.bumps.hand8];
    let targets = [
        (
            ctx.accounts.deck.to_account_info(),
            vec![b"deck".as_ref(), table_bytes.as_ref(), epoch_bytes.as_ref(), deck_bump.as_ref()],
            ctx.accounts.permission_deck.to_account_info(),
        ),
        (
            ctx.accounts.hand0.to_account_info(),
            vec![b"hand".as_ref(), table_bytes.as_ref(), epoch_bytes.as_ref(), idx0.as_ref(), h0.as_ref()],
            ctx.accounts.permission_hand0.to_account_info(),
        ),
        (
            ctx.accounts.hand1.to_account_info(),
            vec![b"hand".as_ref(), table_bytes.as_ref(), epoch_bytes.as_ref(), idx1.as_ref(), h1.as_ref()],
            ctx.accounts.permission_hand1.to_account_info(),
        ),
        (
            ctx.accounts.hand2.to_account_info(),
            vec![b"hand".as_ref(), table_bytes.as_ref(), epoch_bytes.as_ref(), idx2.as_ref(), h2.as_ref()],
            ctx.accounts.permission_hand2.to_account_info(),
        ),
        (
            ctx.accounts.hand3.to_account_info(),
            vec![b"hand".as_ref(), table_bytes.as_ref(), epoch_bytes.as_ref(), idx3.as_ref(), h3.as_ref()],
            ctx.accounts.permission_hand3.to_account_info(),
        ),
        (
            ctx.accounts.hand4.to_account_info(),
            vec![b"hand".as_ref(), table_bytes.as_ref(), epoch_bytes.as_ref(), idx4.as_ref(), h4.as_ref()],
            ctx.accounts.permission_hand4.to_account_info(),
        ),
        (
            ctx.accounts.hand5.to_account_info(),
            vec![b"hand".as_ref(), table_bytes.as_ref(), epoch_bytes.as_ref(), idx5.as_ref(), h5.as_ref()],
            ctx.accounts.permission_hand5.to_account_info(),
        ),
        (
            ctx.accounts.hand6.to_account_info(),
            vec![b"hand".as_ref(), table_bytes.as_ref(), epoch_bytes.as_ref(), idx6.as_ref(), h6.as_ref()],
            ctx.accounts.permission_hand6.to_account_info(),
        ),
        (
            ctx.accounts.hand7.to_account_info(),
            vec![b"hand".as_ref(), table_bytes.as_ref(), epoch_bytes.as_ref(), idx7.as_ref(), h7.as_ref()],
            ctx.accounts.permission_hand7.to_account_info(),
        ),
        (
            ctx.accounts.hand8.to_account_info(),
            vec![b"hand".as_ref(), table_bytes.as_ref(), epoch_bytes.as_ref(), idx8.as_ref(), h8.as_ref()],
            ctx.accounts.permission_hand8.to_account_info(),
        ),
    ];

    for (account, signer_seeds, permission) in targets {
        // 权限 PDA 地址断言（seeds::program 校验从上下文约束搬到循环内——
        // 10 组 seeds 约束会把 try_accounts 顶过 SBF 4096 字节预算；循环体
        // 的栈帧每次迭代复用，不累积）。
        let (expected_permission, _) = Pubkey::find_program_address(
            &[b"permission:", account.key.as_ref()],
            &PERMISSION_PROGRAM_ID,
        );
        require_keys_eq!(
            permission.key(),
            expected_permission,
            crate::errors::SolpokerError::SeatMismatch
        );
        // 幂等：权限已存在（owner 是权限程序）就跳过，允许失败后重跑补齐。
        if permission.owner == &PERMISSION_PROGRAM_ID {
            continue;
        }
        CreateEphemeralPermissionCpi {
            permissioned_account: account,
            permission,
            // 租金由委托的 commit_payer PDA 支付（ER 规则：被修改的付款账户必须
            // 是委托账户）；被权限账户与 commit_payer 都由本程序 invoke_signed 签名。
            payer: payer.clone(),
            vault: vault.clone(),
            magic_program: magic_program.clone(),
            permission_program: permission_program.clone(),
            // 基线成员 = [VRF 程序身份]（无密钥哨兵，成员策略见
            // perms::member_policy_ok）：运营方（table.admin）不入名单；
            // deck 永不加玩家；占用者由 take_seat 加入自己的 hand。
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![Member {
                    flags: 0,
                    pubkey: ephemeral_rollups_sdk::compat::Pubkey::new_from_array(
                        crate::perms::vrf_identity().to_bytes(),
                    ),
                }],
            },
        }
        .invoke_signed(&[&signer_seeds, commit_payer_seeds])?;
    }

    Ok(())
}
