//! credit_x402_deposit — x402 标准模式入账（配套文档一 §4.3，D5 的延后项；
//! 2026-10-08 落地）。
//!
//! **场景**：标准 x402 客户端的付款交易里只能有「计算预算 + 一笔
//! TransferChecked + Memo」（exact SVM 规范的快速路径），夹带不了本程序的
//! 入座指令。所以先付款（USDC 直接进这张桌的 TableVault），再由网关调用本
//! 指令把这次付款记到座位账本。
//!
//! **门禁**：`config.gateway` 签名（Unauthorized 否则）。
//!
//! **信任边界（如实）**：本程序读不到别的交易的内容，所以「这笔钱是谁付的」
//! 由网关认定 —— 这是 x402 路径里唯一需要信任运营方的地方。但事后可完全
//! 审计：`DepositRecord`（PDA `["x402", sig_lo, sig_hi]`，`init` 语义 = 同一
//! 笔付款不可重复入账）记下付款人/桌/座/金额/付款签名；拿签名去 L1 查那笔
//! 交易即可核对「付款人 → TableVault」的转账（/history 的「L1 审计视图」就是
//! 干这个的）。不想信任网关的 agent 走原生路径（自己签 `sit_down`）即可。
//!
//! **规则与 sit_down / top_up 一致**：
//! - 座位为空 → 按入座处理：金额必须落在 [$min, $max] 买入区间、身份规则
//!   （§2.2/§2.3，三类桌 + 同主人）用与 sit_down 相同的 8 座扫描；
//!   占用者 = 付款人，payout 固定为付款人（真人）或 agent profile 的 payout 设置；
//!   **不设 session key**（网关没有占用者的签名）——占用者之后自己调 `set_session`。
//! - 座位已有同一付款人 → 按补码处理：`deposited_total += amount`（单笔 ≤ 最大买入）。
//! - 金额必须是 CENT（0.01 USDC）整数倍。
//!
//! **I-L1**：本指令不动钱（钱已在 vault、由付款交易转入）；它只做账本记账。

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::fund;
use crate::state::{SeatLedger, MAX_SEATS};
use crate::CreditX402Deposit;

pub fn handler(
    ctx: Context<CreditX402Deposit>,
    idx: u8,
    payer: Pubkey,
    amount: u64,
    sig_lo: [u8; 32],
    sig_hi: [u8; 32],
) -> Result<()> {
    require!((idx as usize) < MAX_SEATS, SolpokerError::SeatMismatch);
    require!(payer != Pubkey::default(), SolpokerError::BadAmount);
    require!(
        amount > 0 && amount % fund::CENT == 0,
        SolpokerError::BadAmount
    );

    let table = &ctx.accounts.table;
    require!(
        table.status == fund::TABLE_ACTIVE,
        SolpokerError::TableNotActive
    );
    let (min, max) = fund::buy_in_bounds(table.bb, table.min_buy_in_bb, table.max_buy_in_bb)?;
    // 单笔上限：一次入座/补码不超过本桌最大买入（网关无法把巨额一次记进来）。
    require!(amount <= max, SolpokerError::BadBuyIn);

    let seat = &mut ctx.accounts.seat;
    if seat.occupant == Pubkey::default() {
        // ---- 新占座：与 sit_down 完全相同的金额与身份规则 ----
        require!(
            fund::is_valid_buy_in(amount, min, max),
            SolpokerError::BadBuyIn
        );
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
            let l = fund::read_seat_ledger_l1(&ai.to_account_info())?;
            require!(l.idx != idx, SolpokerError::SeatMismatch);
            let bit = 1u16 << l.idx;
            require!(seen & bit == 0, SolpokerError::SeatMismatch);
            seen |= bit;
            others.push(l);
        }
        require!(
            seen == (0x1FFu16 & !(1u16 << idx)),
            SolpokerError::SeatMismatch
        );
        let agent = ctx.accounts.agent_profile.as_deref();
        fund::check_sit_identity(table.kind, &payer, agent, &others)?;

        seat.occupant = payer;
        match agent {
            Some(p) => {
                seat.kind = fund::KIND_AGENT;
                seat.agent_owner = p.owner;
                seat.payout = if p.payout_kind == 1 { p.agent } else { p.owner };
            }
            None => {
                seat.kind = fund::KIND_HUMAN;
                seat.agent_owner = Pubkey::default();
                seat.payout = payer;
            }
        }
        seat.session_key = Pubkey::default();
        seat.session_expires_at = 0;
        seat.occupancy_id = seat
            .occupancy_id
            .checked_add(1)
            .ok_or(SolpokerError::Overflow)?;
    } else {
        // ---- 补码：只允许给「同一个付款人」的座位充值 ----
        require!(seat.occupant == payer, SolpokerError::NotOccupant);
    }
    seat.deposited_total = seat
        .deposited_total
        .checked_add(amount)
        .ok_or(SolpokerError::Overflow)?;

    let rec = &mut ctx.accounts.deposit_record;
    rec.payer = payer;
    rec.table = table.key();
    rec.seat_idx = idx;
    rec.amount = amount;
    rec.credited_at = Clock::get()?.unix_timestamp;
    rec.sig[0..32].copy_from_slice(&sig_lo);
    rec.sig[32..64].copy_from_slice(&sig_hi);
    rec.bump = ctx.bumps.deposit_record;

    emit!(X402DepositCredited {
        table: table.key(),
        payer,
        seat: idx,
        amount,
        sig: rec.sig,
    });
    Ok(())
}

/// 入账事件：只含公开数据（付款人/桌/座/金额/付款签名），不含任何私密材料。
#[event]
pub struct X402DepositCredited {
    pub table: Pubkey,
    pub payer: Pubkey,
    pub seat: u8,
    pub amount: u64,
    /// 付款交易签名 —— 审计用：拿它去 L1 核对「付款人 → TableVault」的转账。
    pub sig: [u8; 64],
}
