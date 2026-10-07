//! cash_out — §5.2.6（L1；permissionless）。
//!
//! 读 Game 快照（§5.3：地址 = PDA(["game", table])，owner ∈ {DELeGG…,
//! 本程序}，discriminator + borsh 手工校验），付
//! `快照.owed_total − paid_total` 到 ATA(SeatLedger.payout, mint)（X7：只付
//! 入座时固定的 payout），vault_auth PDA 签名 `transfer_checked`，然后
//! `paid_total += 金额`。
//!
//! 快照时效：委托期间 L1 上的 Game 数据是最后一次 commit。stand_up 之后、
//! 下一次 commit 之前调用 cash_out，看到的 owed 可能还是旧值——只会少付，
//! 差额在下一次 commit 后的 cash_out 补足；六个计数器全部只增，永远不会
//! 多付（§5.1）。快照必须描述当前占用者（occupancy_id 匹配），否则 owed
//! 可能属于上一任占用者，拒绝并等 commit。
//!
//! 座位释放：快照中该座位为 Left、occupancy_id 与账本一致、
//! `credited == deposited`（L1 没有未计入的补码）、`owed == paid`（全部
//! 付清）时，清空 occupant 与 session 字段（计数器保留，永不重置——L1
//! 从不自行退回未计入的补码，否则下一任占用者会被多计筹码）。
//!
//! 断言：I-B（paid ≤ owed_快照）、I-L1（转账前后 vault 余额减幅恰好等于
//! 付款额）。

use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, TransferChecked};

use crate::errors::SolpokerError;
use crate::fund;
use crate::state::MAX_SEATS;
use crate::CashOut;

pub fn handler(ctx: Context<CashOut>, idx: u8) -> Result<()> {
    require!((idx as usize) < MAX_SEATS, SolpokerError::SeatMismatch);

    let table = &ctx.accounts.table;
    let snap = fund::read_game_snapshot(ctx.accounts.game.as_ref())?;
    let snap_seat = &snap.seats[idx as usize];

    let seat = &mut ctx.accounts.seat;
    require!(
        snap_seat.occupancy_id == seat.occupancy_id,
        SolpokerError::StaleSnapshot
    );
    // I-B: paid ≤ owed_快照.
    require!(
        snap_seat.owed_total >= seat.paid_total,
        SolpokerError::Conservation
    );
    let amount = snap_seat.owed_total - seat.paid_total;

    if amount > 0 {
        let vault = &mut ctx.accounts.vault;
        let before = vault.amount;
        let table_key = table.key();
        let bump = [table.vault_auth_bump];
        let signer_seeds: &[&[u8]] = &[b"vault_auth", table_key.as_ref(), &bump];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.payout_ata.to_account_info(),
                    authority: ctx.accounts.vault_auth.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        // I-L1: the vault balance decreased by exactly the payout.
        vault.reload()?;
        let expected = before
            .checked_sub(amount)
            .ok_or(SolpokerError::Conservation)?;
        require!(vault.amount == expected, SolpokerError::Conservation);
        seat.paid_total = seat
            .paid_total
            .checked_add(amount)
            .ok_or(SolpokerError::Overflow)?;
    }

    // §5.2.6: release the seat once the snapshot proves everything settled.
    if snap_seat.status == fund::SEAT_LEFT
        && snap_seat.credited_total == seat.deposited_total
        && snap_seat.owed_total == seat.paid_total
    {
        seat.occupant = Pubkey::default();
        seat.kind = 0;
        seat.agent_owner = Pubkey::default();
        seat.session_key = Pubkey::default();
        seat.session_expires_at = 0;
        seat.payout = Pubkey::default();
    }

    Ok(())
}
