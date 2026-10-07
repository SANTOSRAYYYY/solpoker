//! Agent 身份指令（Stage 8 / 配套文档一 §2.1）。
//!
//! - `register_agent`：agent 与主人双签、主人付租金（§2.1 注册流程；主网
//!   KYC 白名单由 ProgramConfig.flags 位开启后强制）。
//! - `pause_agent` / `resume_agent`（X9）、`revoke_agent`、`set_agent_payout`、
//!   `update_agent`：主人权限。
//! - `set_agent_status`：admin 封禁/解封（合规）。
//! - `allow_owner` / `remove_owner`：admin 维护 OwnerAllowlist（主网 KYC）。
//!
//! `name` / `meta_uri` 一律不可信文本：只入账户数据，绝不进日志/事件（§15）。

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::state::{AGENT_ACTIVE, AGENT_BANNED, AGENT_PAUSED, AGENT_REVOKED, FLAG_REQUIRE_OWNER_KYC};
use crate::{
    AgentOwnerOnly, AllowOwner, RegisterAgent, RemoveOwner, SetAgentStatus,
};

pub fn register(
    ctx: Context<RegisterAgent>,
    name: [u8; 32],
    meta_uri: [u8; 96],
    payout_agent: bool,
) -> Result<()> {
    // 主网：主人须在 KYC 白名单（账户存在即通过；devnet flags=0 不检查）。
    if ctx.accounts.config.flags & FLAG_REQUIRE_OWNER_KYC != 0 {
        let owner = ctx.accounts.owner.key();
        let allowlist = ctx
            .accounts
            .allowlist
            .as_ref()
            .ok_or(SolpokerError::Unauthorized)?;
        let (expected, _) = Pubkey::find_program_address(&[b"owner_ok", owner.as_ref()], &crate::ID);
        require_keys_eq!(allowlist.key(), expected, SolpokerError::Unauthorized);
        require_keys_eq!(*allowlist.owner, crate::ID, SolpokerError::Unauthorized);
    }

    let profile = &mut ctx.accounts.profile;
    profile.agent = ctx.accounts.agent.key();
    profile.owner = ctx.accounts.owner.key();
    profile.payout_kind = if payout_agent { 1 } else { 0 };
    profile.status = AGENT_ACTIVE;
    profile.name = name;
    profile.meta_uri = meta_uri;
    profile.registered_at = Clock::get()?.unix_timestamp;
    profile.bump = ctx.bumps.profile;
    Ok(())
}

pub fn update(ctx: Context<AgentOwnerOnly>, name: [u8; 32], meta_uri: [u8; 96]) -> Result<()> {
    let profile = &mut ctx.accounts.profile;
    require!(
        profile.status != AGENT_REVOKED,
        SolpokerError::AgentNotActive
    );
    profile.name = name;
    profile.meta_uri = meta_uri;
    Ok(())
}

pub fn set_payout(ctx: Context<AgentOwnerOnly>, payout_agent: bool) -> Result<()> {
    let profile = &mut ctx.accounts.profile;
    require!(
        profile.status != AGENT_REVOKED,
        SolpokerError::AgentNotActive
    );
    profile.payout_kind = if payout_agent { 1 } else { 0 };
    Ok(())
}

pub fn pause(ctx: Context<AgentOwnerOnly>) -> Result<()> {
    let profile = &mut ctx.accounts.profile;
    require!(
        profile.status == AGENT_ACTIVE,
        SolpokerError::AgentNotActive
    );
    profile.status = AGENT_PAUSED;
    Ok(())
}

pub fn resume(ctx: Context<AgentOwnerOnly>) -> Result<()> {
    let profile = &mut ctx.accounts.profile;
    require!(
        profile.status == AGENT_PAUSED,
        SolpokerError::AgentNotActive
    );
    profile.status = AGENT_ACTIVE;
    Ok(())
}

pub fn revoke(ctx: Context<AgentOwnerOnly>) -> Result<()> {
    let profile = &mut ctx.accounts.profile;
    require!(
        profile.status != AGENT_REVOKED,
        SolpokerError::AgentNotActive
    );
    profile.status = AGENT_REVOKED;
    Ok(())
}

pub fn set_status(ctx: Context<SetAgentStatus>, banned: bool) -> Result<()> {
    let profile = &mut ctx.accounts.profile;
    // Revoked 不可恢复；Banned ↔ Active（Paused 也可被封）。
    require!(
        profile.status != AGENT_REVOKED,
        SolpokerError::AgentNotActive
    );
    profile.status = if banned { AGENT_BANNED } else { AGENT_ACTIVE };
    Ok(())
}

pub fn allow_owner(ctx: Context<AllowOwner>, owner: Pubkey) -> Result<()> {
    let al = &mut ctx.accounts.allowlist;
    al.owner = owner;
    al.bump = ctx.bumps.allowlist;
    Ok(())
}

pub fn remove_owner(_ctx: Context<RemoveOwner>) -> Result<()> {
    Ok(()) // 账户在退出时 close（租金退回 admin）
}
