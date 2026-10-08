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

// ---------------------------------------------------------------------------
// 成员策略（2026-10-09）：运营方永久退出私有账户的成员名单
// ---------------------------------------------------------------------------

/// VRF 程序绑定到本程序的回调身份 PDA（无密钥）。当"占位哨兵"用：名单里必须有
/// 一个成员（平台文档建议），而它谁也读不了（没有私钥能签出鉴权 token）。
pub fn vrf_identity() -> Pubkey {
    ephemeral_rollups_sdk::vrf::consts::scoped_vrf_identity(&crate::ID)
}

/// 成员策略：**table.admin（运营方）永不入名单**。背景：admin 曾是全部 10 个
/// 私有权限的基线成员（旧版 keeper 写回需要），实测证实运营方可借成员身份
/// RPC 读底牌与牌堆；而 2026-10-09 的实验证明「把运营方移出名单后，keeper 的
/// 程序执行读写与整手流程照常」——名单就是隐私开关（CHANGELOG 同日条目）。
///
/// 允许的集合：
/// - deck（target_index 0）：仅 VRF 身份（或空）；
/// - hand_i（1..=9）：VRF 身份 ∪ 该座当前占用者（座位空时只剩 VRF 身份）。
///
/// 覆盖通道（admin_set_members）同样过这层校验——运营方无法再把自己加回来。
pub fn member_policy_ok(target_index: u8, occupant: &Pubkey, members: &[Pubkey]) -> bool {
    let vrf = vrf_identity();
    members.iter().all(|pk| {
        if *pk == vrf {
            return true;
        }
        target_index != 0 && *occupant != Pubkey::default() && pk == occupant
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deck_only_allows_vrf_identity() {
        let vrf = vrf_identity();
        assert!(member_policy_ok(0, &Pubkey::default(), &[vrf]));
        assert!(member_policy_ok(0, &Pubkey::default(), &[]));
        assert!(!member_policy_ok(0, &Pubkey::default(), &[Pubkey::new_unique()]));
        assert!(!member_policy_ok(0, &Pubkey::default(), &[vrf, Pubkey::new_unique()]));
    }

    #[test]
    fn hand_allows_vrf_and_current_occupant_only() {
        let vrf = vrf_identity();
        let occ = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        assert!(member_policy_ok(3, &occ, &[occ]));
        assert!(member_policy_ok(3, &occ, &[vrf, occ]));
        assert!(member_policy_ok(3, &occ, &[vrf]));
        assert!(!member_policy_ok(3, &occ, &[other]));
        assert!(!member_policy_ok(3, &occ, &[vrf, other]));
        // 空座：只允许 VRF 身份。
        assert!(!member_policy_ok(3, &Pubkey::default(), &[occ]));
        assert!(member_policy_ok(3, &Pubkey::default(), &[vrf]));
    }
}
