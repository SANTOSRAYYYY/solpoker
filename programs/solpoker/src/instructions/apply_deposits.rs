//! apply_deposits — §5.2.4（ER；permissionless）。
//!
//! 只在手与手之间、或本座位不在当前手牌中时执行。设
//! `diff = 克隆.deposited − credited`，`room = max_buy_in − stack`，
//! `credit = min(diff, room)`：`stack += credit`，`credited += diff`，
//! `owed += diff − credit`。Left 座位的 room 为 0——离座后到账的补码直接
//! 记 owed，由下一次 cash_out 退回（§5.2.6）。Empty 座位拒绝（买入由
//! take_seat 计入，不能在这里先行 credit）。结束时断言 I-ER。

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::fund;
use crate::state::MAX_SEATS;
use crate::ApplyDeposits;

pub fn handler(ctx: Context<ApplyDeposits>, idx: u8) -> Result<()> {
    require!((idx as usize) < MAX_SEATS, SolpokerError::SeatMismatch);

    let table = &ctx.accounts.table;
    let ledger = fund::read_seat_ledger_clone(
        &ctx.accounts.seat_ledger.to_account_info(),
        &table.key(),
        idx,
    )?;

    let mut game = ctx.accounts.game.load_mut()?;
    // Between hands, or this seat is not in the current hand.
    let phase = game.phase;
    let in_hand = game.hand_mask & (1u16 << idx) != 0;
    let seat = &mut game.seats[idx as usize];

    require!(
        phase == fund::PHASE_IDLE || !in_hand,
        SolpokerError::SeatInHand
    );
    // Buy-ins are credited by take_seat; deposits only land on live seats
    // (Seated) or flow to owed for released ones (Left).
    require!(
        seat.status == fund::SEAT_SEATED || seat.status == fund::SEAT_LEFT,
        SolpokerError::NotSeated
    );

    let (_, max_stack) =
        fund::buy_in_bounds(table.bb, table.min_buy_in_bb, table.max_buy_in_bb)?;
    fund::apply_deposits_transition(seat, ledger.deposited_total, max_stack);

    fund::assert_conservation_er(&game)?;
    Ok(())
}
