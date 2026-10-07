//! PER 成员更新的公共 CPI 封装（§11.2）。
//!
//! 权限的 authority 是被权限账户自身（创建时 PDA 签名），所以更新只能由本
//! 程序以 PDA invoke_signed 发起 `UpdateEphemeralPermissionCpi`——take_seat
//! （占用者加入自己的 hand）与 stand_up（占用者移出）都走这里。
//! admin_set_members 是 admin 覆盖通道，也复用本助手。

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::UpdateEphemeralPermissionCpi;
use ephemeral_rollups_sdk::access_control::structs::{EphemeralMembersArgs, Member};

#[allow(clippy::too_many_arguments)]
pub fn update_members<'info>(
    permissioned_account: AccountInfo<'info>,
    permission: AccountInfo<'info>,
    payer: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    vault: AccountInfo<'info>,
    magic_program: AccountInfo<'info>,
    permission_program: AccountInfo<'info>,
    signers: &[&[&[u8]]],
    member_pubkeys: &[Pubkey],
) -> Result<()> {
    let members = member_pubkeys
        .iter()
        .map(|pk| Member {
            flags: 0,
            pubkey: ephemeral_rollups_sdk::compat::Pubkey::new_from_array(pk.to_bytes()),
        })
        .collect();
    UpdateEphemeralPermissionCpi {
        permissioned_account,
        permission,
        payer,
        // authority 不签名（authority_is_signer = false）→ 权限程序改验
        // permissioned_account 签名（我们的 PDA，signers 第二组 seeds）。
        authority,
        vault,
        magic_program,
        permission_program,
        authority_is_signer: false,
        args: EphemeralMembersArgs {
            is_private: true,
            members,
        },
    }
    .invoke_signed(signers)?;
    Ok(())
}
