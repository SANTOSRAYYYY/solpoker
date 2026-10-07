//! sit_down — §5.2.1（L1；占用者钱包签名；不创建任何账户）。
//!
//! USDC 从占用者的 ATA 经 `transfer_checked` 转入 TableVault（decimals 取自
//! Table.mint 账户），随后写 SeatLedger：occupant / kind（本 Phase 恒 Human；
//! agent 路径是 Stage 8）/ session_key / session_expires_at / payout
//! （= 签名者，X7 固定），occupancy_id += 1，deposited_total += buy_in。
//!
//! 前置条件：牌桌 Active；座位为空；buy_in ∈ [min_buy_in_bb × bb,
//! max_buy_in_bb × bb] 且为 CENT（0.01 USDC）的整数倍；session 有效期
//! ≤ now + 7 天。I-L1：转账前后 vault 余额的增量恰好等于 buy_in。

use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, TransferChecked};

use crate::errors::SolpokerError;
use crate::fund;
use crate::SitDown;

pub fn handler(
    ctx: Context<SitDown>,
    _idx: u8, // consumed by the seat PDA seeds constraint
    buy_in: u64,
    session_key: Pubkey,
    session_expires_at: i64,
) -> Result<()> {
    let table = &ctx.accounts.table;
    require!(
        table.status == fund::TABLE_ACTIVE,
        SolpokerError::TableNotActive
    );
    // Agent path is Stage 8; a human sit-down is rejected on AgentOnly tables
    // (牌桌类型规则, 配套文档一 §2).
    require!(
        table.kind != fund::TABLE_KIND_AGENT_ONLY,
        SolpokerError::KindNotAllowed
    );

    let seat = &mut ctx.accounts.seat;
    require!(
        seat.occupant == Pubkey::default(),
        SolpokerError::SeatNotEmpty
    );

    let (min, max) = fund::buy_in_bounds(table.bb, table.min_buy_in_bb, table.max_buy_in_bb)?;
    require!(
        fund::is_valid_buy_in(buy_in, min, max),
        SolpokerError::BadBuyIn
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        session_expires_at <= now + fund::MAX_SESSION_TTL_S,
        SolpokerError::SessionTooLong
    );

    // USDC → TableVault（decimals 来自 mint 账户）。
    let vault = &mut ctx.accounts.vault;
    let before = vault.amount;
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.player_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: vault.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        ),
        buy_in,
        ctx.accounts.mint.decimals,
    )?;
    // I-L1: the vault balance increased by exactly buy_in (nothing skimmed —
    // classic-token mints only, Token-2022 fees are rejected at create_table).
    vault.reload()?;
    let expected = before.checked_add(buy_in).ok_or(SolpokerError::Overflow)?;
    require!(vault.amount == expected, SolpokerError::Conservation);

    seat.occupant = ctx.accounts.payer.key();
    seat.kind = fund::KIND_HUMAN;
    seat.agent_owner = Pubkey::default();
    seat.session_key = session_key;
    seat.session_expires_at = session_expires_at;
    seat.payout = ctx.accounts.payer.key();
    seat.occupancy_id = seat
        .occupancy_id
        .checked_add(1)
        .ok_or(SolpokerError::Overflow)?;
    seat.deposited_total = seat
        .deposited_total
        .checked_add(buy_in)
        .ok_or(SolpokerError::Overflow)?;

    Ok(())
}
