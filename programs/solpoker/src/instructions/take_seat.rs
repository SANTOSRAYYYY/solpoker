//! take_seat — §5.2.2（ER；permissionless）。
//!
//! 读 SeatLedger 的只读克隆。如果克隆中的 `occupancy_id` 大于
//! `SeatState.occupancy_id`，并且座位是 Empty 或 Left、且当前不在手牌中，
//! 就令 `stack = deposited − credited`、`credited = deposited`、状态
//! Seated，并复制 occupant / kind / occupancy_id。PlayerHand[idx] 在本
//! Phase 必须已经清零（cards = 0xFF、salt 全零）——PER 成员替换是
//! Phase 3（§11.2）。结束时断言 I-ER。

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::fund;
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
        // Phase 2 accepts only a clean hand account; PER member replacement
        // for a dirty one is Phase 3 (§11.2).
        let hand = &ctx.accounts.player_hand;
        require!(
            hand.cards == [0xFF; 2] && hand.salt == [0u8; 32],
            SolpokerError::SeatNotClean
        );
        fund::take_seat_transition(seat, &ledger);
        game.occupied_mask |= bit;
        // TODO(Phase 3): replace PlayerHand[idx] PER members with the new
        // occupant's wallet and wait for the permission to take effect (§11.2).
    }
    // Not `changed` (stale clone, seat taken, hand live): no-op, Ok — the
    // keeper retries after the clone refreshes.

    fund::assert_conservation_er(&game)?;
    Ok(())
}
