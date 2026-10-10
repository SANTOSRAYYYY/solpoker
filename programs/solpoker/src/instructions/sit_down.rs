//! sit_down — §5.2.1（L1；占用者钱包签名；不创建任何账户）。
//!
//! USDC 从占用者的 ATA 经 `transfer_checked` 转入 TableVault（decimals 取自
//! Table.mint 账户），随后写 SeatLedger：occupant / kind / agent_owner /
//! session_key / session_expires_at / payout（X7 固定），occupancy_id += 1，
//! deposited_total += buy_in。
//!
//! Stage 8（配套文档一 §2.2/§2.3）：传 `agent_profile`（Active）即以 agent
//! 入席，否则为真人；三类桌规则与同主人规则经 `fund::check_sit_identity`
//! 全桌扫描（其余 8 个座位账本随交易传入，handler 内校验为不同座位）。
//!
//! 前置条件：牌桌 Active；座位为空；buy_in ∈ [min_buy_in_bb × bb,
//! max_buy_in_bb × bb] 且为 CENT（0.01 USDC）的整数倍；session 有效期
//! ≤ now + 7 天。I-L1：转账前后 vault 余额的增量恰好等于 buy_in。

use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, TransferChecked};

use crate::errors::SolpokerError;
use crate::fund;
use crate::state::{SeatLedger, MAX_SEATS};
use crate::SitDown;

pub fn handler(
    ctx: Context<SitDown>,
    idx: u8, // consumed by the seat PDA seeds constraint
    buy_in: u64,
    session_key: Pubkey,
    session_expires_at: i64,
) -> Result<()> {
    require!((idx as usize) < MAX_SEATS, SolpokerError::SeatMismatch);
    let table = &ctx.accounts.table;
    require!(
        table.status == fund::TABLE_ACTIVE,
        SolpokerError::TableNotActive
    );

    let seat = &mut ctx.accounts.seat;
    require!(
        seat.occupant == Pubkey::default(),
        SolpokerError::SeatNotEmpty
    );

    // ---- Stage 8 §2.2/§2.3：其余 8 个座位账本（去重校验）+ 身份规则 ----
    let mut seen = 0u16;
    let mut others: Vec<SeatLedger> = Vec::with_capacity(8);
    let other_infos = [
        &ctx.accounts.other0,
        &ctx.accounts.other1,
        &ctx.accounts.other2,
        &ctx.accounts.other3,
        &ctx.accounts.other4,
        &ctx.accounts.other5,
        &ctx.accounts.other6,
        &ctx.accounts.other7,
    ];
    for ai in other_infos {
        // 2026-10-10（审计 P1-3）：账本读取绑定本桌——此前传别桌账本即可绕过身份规则。
        let l = fund::read_seat_ledger_l1(&ai.to_account_info(), &table.key())?;
        require!(l.idx != idx, SolpokerError::SeatMismatch);
        let bit = 1u16 << l.idx;
        require!(seen & bit == 0, SolpokerError::SeatMismatch); // 不得重复传同一座位
        seen |= bit;
        others.push(l);
    }
    // 8 个不同座位且都不等于目标座位 ⇒ 恰好覆盖其余全部座位。
    require!(
        seen == (0x1FFu16 & !(1u16 << idx)),
        SolpokerError::SeatMismatch
    );

    let agent = ctx.accounts.agent_profile.as_deref();
    fund::check_sit_identity(table.kind, &ctx.accounts.payer.key(), agent, &others)?;

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
    // Stage 8：有 Active profile = agent 席位；否则真人。
    match agent {
        Some(p) => {
            seat.kind = fund::KIND_AGENT;
            seat.agent_owner = p.owner;
            seat.payout = if p.payout_kind == 1 { p.agent } else { p.owner };
        }
        None => {
            seat.kind = fund::KIND_HUMAN;
            seat.agent_owner = Pubkey::default();
            seat.payout = ctx.accounts.payer.key();
        }
    }
    seat.session_key = session_key;
    seat.session_expires_at = session_expires_at;
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
