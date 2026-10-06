//! init_permissions — ER test-harness instruction (Stage 3).
//!
//! Creates the PER private permission for Deck: `is_private = true,
//! members = []` (design §4 permission matrix — nobody can RPC-read the raw
//! VRF outputs; CPI writes by this program are unaffected). Permissions are
//! ER-local per the MagicBlock access-control docs: no L1 permission account
//! is created or delegated. PlayerHand permissions (members = [occupant])
//! arrive with Stage 4 dealing.
//!
//! Real SDK signatures used (ephemeral-rollups-sdk 0.17.3 sources):
//! - access_control/instructions/create_ephemeral_permission.rs:
//!   `CreateEphemeralPermissionCpi { permissioned_account, permission, payer,
//!   vault, magic_program, permission_program, args: EphemeralMembersArgs }`
//!   with `.invoke_signed(signers)`; the permissioned account is a readonly
//!   SIGNER meta, so the Deck PDA signs via its seeds.
//! - access_control/structs/member.rs:
//!   `EphemeralMembersArgs { is_private: bool, members: Vec<Member> }`.
//! - access_control/structs/permission.rs: permission PDA seeds
//!   `[b"permission:", permissioned_account]` under PERMISSION_PROGRAM_ID.
//! - consts.rs: MAGIC_PROGRAM_ID / EPHEMERAL_VAULT_ID / PERMISSION_PROGRAM_ID.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::CreateEphemeralPermissionCpi;
use ephemeral_rollups_sdk::access_control::structs::EphemeralMembersArgs;

use crate::InitPermissions;

pub fn handler(ctx: Context<InitPermissions>) -> Result<()> {
    let table_key = ctx.accounts.table.key();
    let table_bytes = table_key.to_bytes();
    let epoch_bytes = ctx.accounts.table.epoch.to_be_bytes();
    let deck_bump = ctx.bumps.deck;
    let commit_payer_bump = ctx.bumps.commit_payer;

    CreateEphemeralPermissionCpi {
        permissioned_account: ctx.accounts.deck.to_account_info(),
        permission: ctx.accounts.permission.to_account_info(),
        // 租金由委托的 commit_payer PDA 支付（ER 规则：被修改的付款账户必须
        // 是委托账户）；两个 PDA 都由本程序 invoke_signed 签名。
        payer: ctx.accounts.commit_payer.to_account_info(),
        vault: ctx.accounts.vault.to_account_info(),
        magic_program: ctx.accounts.magic_program.to_account_info(),
        permission_program: ctx.accounts.permission_program.to_account_info(),
        // Deck: private, members = [] — nobody can read it over RPC (§4).
        args: EphemeralMembersArgs {
            is_private: true,
            members: vec![],
        },
    }
    .invoke_signed(&[
        &[b"deck", table_bytes.as_ref(), &epoch_bytes, &[deck_bump]],
        &[b"commit_payer", table_bytes.as_ref(), &[commit_payer_bump]],
    ])?;

    Ok(())
}
