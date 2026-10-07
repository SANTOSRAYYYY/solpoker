//! commit_salt — §8.2 step 1（ER；occupant 或 session key，D2/§12）。
//!
//! - phase Idle / Commit：`hand_id == game.hand_id`，写 `salt_commit`（Commit
//!   阶段仅限 hand_mask 内的座位——mask 已冻结，局外座位的承诺等下一手）。
//! - 手牌进行中：`hand_id == game.hand_id + 1`，写 `next_salt_commit`
//!   （§6.4 预提交优化，advance 冻结下一手时提升）。
//!
//! 承诺只落座位字段；SaltCommitted 事件由 advance 在 HandStart 之后按座位
//! 升序批量追加（dealing-protocol §6.3：实时先后不进 transcript）。

use anchor_lang::prelude::*;

use crate::auth;
use crate::errors::SolpokerError;
use crate::hand;
use crate::CommitSalt;

pub fn handler(ctx: Context<CommitSalt>, idx: u8, hand_id: u64, commitment: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mut game = ctx.accounts.game.load_mut()?;
    auth::authorize_seat(
        &ctx.accounts.seat_ledger.to_account_info(),
        &ctx.accounts.table.key(),
        idx,
        &game,
        &ctx.accounts.signer.key(),
        now,
    )?;

    require!(commitment != [0u8; 32], SolpokerError::BadSalt);
    let phase = game.phase;
    let current_hand = game.hand_id;
    let in_mask = game.hand_mask & (1u16 << idx) != 0;
    let seat = &mut game.seats[idx as usize];
    if phase == hand::PHASE_IDLE {
        require!(hand_id == current_hand, SolpokerError::StaleAction);
        seat.salt_commit = commitment;
    } else if phase == hand::PHASE_COMMIT {
        require!(hand_id == current_hand, SolpokerError::StaleAction);
        require!(in_mask, SolpokerError::BadPhase);
        seat.salt_commit = commitment;
    } else {
        // Ongoing hand: pre-commit for the next one.
        require!(hand_id == current_hand + 1, SolpokerError::StaleAction);
        seat.next_salt_commit = commitment;
    }
    Ok(())
}
