//! init_config — 一次性全局初始化（design §11.1 前置步骤，L1）。
//!
//! 创建两个账户：
//! - ProgramConfig PDA ["config"]：admin = 签名者，treasury / tee_validator /
//!   gateway 由参数传入；tee_validator 必须等于 `state::TEE_VALIDATOR`
//!   （MTEW…，委托显式传入、禁止 None 的纪律在这里钉死）。flags = 0，
//!   version = 1。
//! - DelegPayer（D3）PDA ["deleg_payer"]：0 字节**系统账户**，admin 充
//!   0.05 SOL 运营余额。它必须归系统程序所有——delegate_table 里它作为
//!   create_account / transfer 的付款来源，系统 CPI 要求 from 的 owner 是
//!   系统程序。Anchor 的 `init` 会把 owner 设为本程序，所以这里手工 CPI。
//!
//! 重复调用会因 ProgramConfig 的 `init` 约束失败（账户已存在），天然一次性。

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::SolpokerError;
use crate::state::TEE_VALIDATOR;
use crate::InitConfig;

/// DelegPayer 初始运营余额：0.05 SOL（与 CommitPayer 的测试台注资同档，
/// 委托租金实测预算在 Stage 3 之后按实际费率修订）。
const DELEG_PAYER_FUND: u64 = 50_000_000;

pub fn handler(
    ctx: Context<InitConfig>,
    treasury: Pubkey,
    tee_validator: Pubkey,
    gateway: Pubkey,
) -> Result<()> {
    require!(
        tee_validator == TEE_VALIDATOR,
        SolpokerError::ValidatorNotAllowed
    );

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.treasury = treasury;
    config.tee_validator = tee_validator;
    config.gateway = gateway;
    config.flags = 0;
    config.version = 1;
    config.bump = ctx.bumps.config;
    config.deleg_payer_bump = ctx.bumps.deleg_payer;

    // DelegPayer：owner = 系统程序、space = 0、余额 0.05 SOL。
    let bump = [ctx.bumps.deleg_payer];
    let seeds: &[&[u8]] = &[b"deleg_payer", &bump];
    system_program::create_account(
        CpiContext::new_with_signer(
            anchor_lang::system_program::ID,
            system_program::CreateAccount {
                from: ctx.accounts.admin.to_account_info(),
                to: ctx.accounts.deleg_payer.to_account_info(),
            },
            &[seeds],
        ),
        DELEG_PAYER_FUND,
        0,
        &system_program::ID,
    )?;

    Ok(())
}
