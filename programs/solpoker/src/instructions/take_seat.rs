//! take_seat — §5.2.2（ER；permissionless）。
//!
//! 读 SeatLedger 的只读克隆。如果克隆中的 `occupancy_id` 大于
//! `SeatState.occupancy_id`，并且座位是 Empty 或 Left、且当前不在手牌中，
//! 就令 `stack = deposited − credited`、`credited = deposited`、状态
//! Seated，并复制 occupant / kind / occupancy_id。PlayerHand[idx] 在本
//! Phase 必须已经清零（cards = 0xFF、salt 全零）。
//!
//! §11.2（Phase 3）：入座成功后把 PlayerHand[idx] 的 PER 成员更新为
//! `[table.admin, 占用者钱包]`——crank 可写（advance 发牌）、占用者可读
//! 自己的底牌并在 reveal_salt 时写入。权限的 authority 是 hand PDA 自身，
//! 由本程序 invoke_signed 更新。结束时断言 I-ER。

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::fund;
use crate::perms;
use crate::state::MAX_SEATS;
use crate::TakeSeat;

pub fn handler(ctx: Context<TakeSeat>, idx: u8) -> Result<()> {
    require!((idx as usize) < MAX_SEATS, SolpokerError::SeatMismatch);

    let table = &ctx.accounts.table;
    let ledger = fund::read_seat_ledger_clone(
        &ctx.accounts.seat_ledger.to_account_info(),
        &table.key(),
        idx,
    )?;

    let mut game = ctx.accounts.game.load_mut()?;
    let bit = 1u16 << idx;
    let in_hand = game.hand_mask & bit != 0;
    let seat = &mut game.seats[idx as usize];

    let changed = ledger.occupancy_id > seat.occupancy_id
        && (seat.status == fund::SEAT_EMPTY || seat.status == fund::SEAT_LEFT)
        && !in_hand; // never re-seat into a live hand
    if changed {
        // I-B: ER never credits more than L1 observed.
        require!(
            ledger.deposited_total >= seat.credited_total,
            SolpokerError::Conservation
        );
        // Phase 2 accepts only a clean hand account.
        let hand = &ctx.accounts.player_hand;
        require!(
            hand.cards == [0xFF; 2] && hand.salt == [0u8; 32],
            SolpokerError::SeatNotClean
        );
        fund::take_seat_transition(seat, &ledger);
        game.occupied_mask |= bit;

        // §11.2: PER members = [crank(admin), occupant wallet]（占用者钱包而
        // 不是 session key——读权限绑定钱包，§12）。
        let table_bytes = table.key().to_bytes();
        let epoch_bytes = table.epoch.to_be_bytes();
        let idx_bytes = [idx];
        let hand_bump = [ctx.bumps.player_hand];
        let hand_seeds: &[&[u8]] = &[
            b"hand",
            table_bytes.as_ref(),
            epoch_bytes.as_ref(),
            idx_bytes.as_ref(),
            &hand_bump,
        ];
        let cp_bump = [ctx.bumps.commit_payer];
        let cp_seeds: &[&[u8]] = &[b"commit_payer", table_bytes.as_ref(), &cp_bump];
        let member_keys = [table.admin, ledger.occupant];
        perms::update_members(
            ctx.accounts.player_hand.to_account_info(),
            ctx.accounts.permission.to_account_info(),
            ctx.accounts.commit_payer.to_account_info(),
            ctx.accounts.table.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
            ctx.accounts.permission_program.to_account_info(),
            &[hand_seeds, cp_seeds],
            &member_keys,
        )?;
    }
    // Not `changed` (stale clone, seat taken, hand live): no-op, Ok — the
    // keeper retries after the clone refreshes.

    fund::assert_conservation_er(&game)?;
    Ok(())
}
