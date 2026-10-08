//! refund_x402_deposit — x402 标准模式的退款（配套文档一 §4.3 的延后项；
//! 2026-10-08 落地）。
//!
//! **场景**：标准模式下「付款已进 TableVault，但入账被拒」（链上实测：同一钱包
//! 占同桌第二座 → `SameOwner`）。钱在保险库、没有归属，靠本指令退回付款人。
//!
//! **门禁**：`config.gateway` 签名。**只能动盈余**：退款后 TableVault 余额仍须
//! ≥ I-X 要求（`fund::required_vault_backing`，与 `audit_table` 同一套算法）——
//! 即运营方无论如何都动不了玩家的钱（钱只能退给「盈余」范围内的付款人）。
//!
//! **收款方**：`ATA(payer, mint)`（由地址约束钉死），payer 由调用方给出 —— 与
//! 入账一样，「这笔付款是谁的」由网关认定；`RefundRecord`（PDA 以付款签名两半
//! 为种子，`init` 语义）保证同一笔付款不会重复退款，且记录 payer/金额/签名
//! 供任何人事后到 L1 核对那笔付款交易。
//!
//! **不变量**：I-L1 的守恒在退款后仍成立（转出 ≤ 盈余）；转出前后 vault 余额
//! 差额必须恰好等于 amount（token 经典 mint，无转账费）。

use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, TokenAccount, TransferChecked};

use crate::errors::SolpokerError;
use crate::fund;
use crate::state::{Table, MAX_SEATS};
use crate::RefundX402Deposit;

pub fn handler(
    ctx: Context<RefundX402Deposit>,
    amount: u64,
    sig_lo: [u8; 32],
    sig_hi: [u8; 32],
) -> Result<()> {
    require!(
        amount > 0 && amount % fund::CENT == 0,
        SolpokerError::BadAmount
    );

    let table = &ctx.accounts.table;
    require!(
        table.status == fund::TABLE_ACTIVE || table.status == 1, // Active/Maintenance 都可退款
        SolpokerError::TableNotActive
    );

    // 先写凭据（含签名）——**写入时机**是栈纪律的一部分（2026-10-08 实测：把
    // 签名拷贝放在 CPI 与账本循环之后，RefundRecord.sig 的后 24 字节会被冲掉；
    // 入参在入口处最可靠，所以尽早落账）。
    {
        let rec = &mut ctx.accounts.refund_record;
        rec.payer = ctx.accounts.payer.key();
        rec.table = table.key();
        rec.amount = amount;
        rec.refunded_at = Clock::get()?.unix_timestamp;
        rec.sig[0..32].copy_from_slice(&sig_lo);
        rec.sig[32..64].copy_from_slice(&sig_hi);
        rec.bump = ctx.bumps.refund_record;
    }

    // ---- 只允许动盈余：退款后余额仍须 ≥ I-X 要求 ----
    let required = required_backing(ctx.accounts.game.as_ref(), ctx.remaining_accounts, table.rake_swept_total)?;
    let after = (ctx.accounts.vault.amount as u128)
        .checked_sub(amount as u128)
        .ok_or(SolpokerError::Overflow)?;
    require!(after >= required, SolpokerError::Conservation);

    // ---- 退款：vault → ATA(payer, mint)，authority = vault_auth PDA ----
    do_refund_transfer(
        &ctx.accounts.token_program.to_account_info(),
        &mut ctx.accounts.vault,
        &ctx.accounts.mint,
        &ctx.accounts.payer_ata,
        &ctx.accounts.vault_auth,
        table,
        amount,
    )?;

    let rec = &ctx.accounts.refund_record;
    emit!(X402DepositRefunded {
        table: table.key(),
        payer: rec.payer,
        amount,
        sig: rec.sig,
    });
    Ok(())
}

/// 退款事件：公开数据（桌/付款人/金额/付款签名），供审计对账。
#[event]
pub struct X402DepositRefunded {
    pub table: Pubkey,
    pub payer: Pubkey,
    pub amount: u64,
    /// 对应那笔「付了款但未入账」的交易签名。
    pub sig: [u8; 64],
}

/// I-X 要求：逐座读计数器（remaining_accounts 顺序 = 座位 0..8）。
///
/// 拆成独立函数是**栈纪律**的一部分（2026-10-08 实测）：refund 指令的
/// `Context` 很大（21 个账户），handler 自身再持有大对象会让 SBF 栈帧
/// 顶穿 4096 字节上限，表现为**入参尾部被覆盖**（RefundRecord.sig 的后
/// 24 字节变成别处数据）。所以重活一律拆出去，本函数只借字节、不搬迁结构体。
#[inline(never)]
fn required_backing(
    game_ai: &AccountInfo,
    seats: &[AccountInfo],
    rake_swept: u64,
) -> Result<u128> {
    require!(seats.len() == MAX_SEATS, SolpokerError::SeatMismatch);
    let snap = fund::read_game_snapshot(game_ai)?;
    let mut counters = [(0u64, 0u64); MAX_SEATS];
    for (i, ai) in seats.iter().enumerate() {
        counters[i] = fund::read_seat_counters(ai)?;
    }
    fund::required_vault_backing_iter(counters, &snap, rake_swept)
}

/// 退款转账（拆出来同样是为了 handler 的栈帧尽量小）。
/// I-L1：转出前后 vault 余额差额必须恰好等于 amount（经典 mint，无转账费）。
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn do_refund_transfer<'info>(
    token_program: &AccountInfo<'info>,
    vault: &mut Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    payer_ata: &Account<'info, TokenAccount>,
    vault_auth: &UncheckedAccount<'info>,
    table: &Account<'info, Table>,
    amount: u64,
) -> Result<()> {
    let table_bytes = table.key().to_bytes();
    let va_bump = [table.vault_auth_bump];
    let seeds: &[&[u8]] = &[b"vault_auth", table_bytes.as_ref(), &va_bump];
    let before = vault.amount;
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: payer_ata.to_account_info(),
                authority: vault_auth.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )?;
    vault.reload()?;
    require!(
        before.checked_sub(amount).ok_or(SolpokerError::Overflow)? == vault.amount,
        SolpokerError::Conservation
    );
    Ok(())
}
