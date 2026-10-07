//! stand_up — §5.2.5（ER；session key 或占用者钱包签名）。
//!
//! 鉴权：读 SeatLedger 克隆，要求克隆描述的是当前占用者（occupancy_id 与
//! occupant 都匹配），然后 signer == session_key 且未过期，或 signer ==
//! occupant。
//!
//! 座位在当前手牌中（hand_mask 含本座位且未 fold）→ 立即 fold 语义：标记
//! folded + leave_requested，并从 actionable / pending_to_act 掩码中移除
//! ——这次 fold 由手牌状态机按一次普通 fold 处理（Phase 3）。不移动任何
//! 资金计数器。此分支不动 PER 成员（手牌还没结束，占用者还要读牌/reveal）。
//!
//! 在手牌边界（或本座位不在手牌中）→ 释放：未计入的补码直接记 owed
//! （credited 同时追平 deposited），`owed += stack`，`stack = 0`，状态
//! Left，清空 salt commits，并把 hands_since_commit 顶到
//! commit_every_n_hands 以安排一次 commit（真正的 commit 由 Phase 3 的
//! commit/heartbeat 指令触发）。§11.2：同时把 PlayerHand[idx] 的 PER 成员
//! 恢复为 `[table.admin]`（占用者移出）。结束时断言 I-ER。

use anchor_lang::prelude::*;

use crate::auth;
use crate::errors::SolpokerError;
use crate::fund;
use crate::perms;
use crate::state::MAX_SEATS;
use crate::StandUp;

pub fn handler(ctx: Context<StandUp>, idx: u8) -> Result<()> {
    require!((idx as usize) < MAX_SEATS, SolpokerError::SeatMismatch);

    let table = &ctx.accounts.table;
    let mut game = ctx.accounts.game.load_mut()?;
    let signer = ctx.accounts.signer.key();
    let now = Clock::get()?.unix_timestamp;
    let ledger = auth::authorize_seat(
        &ctx.accounts.seat_ledger.to_account_info(),
        &table.key(),
        idx,
        &game,
        &signer,
        now,
    )?;

    let bit = 1u16 << idx;
    let in_hand = game.hand_mask & bit != 0;
    let seat = &mut game.seats[idx as usize];

    let mut folded_now = false;
    if in_hand {
        // In the current hand: immediate fold semantics. The fold itself is
        // processed like a fold action by the hand machine (Phase 3); the
        // fund release happens at the hand boundary via a later stand_up.
        if seat.folded == 0 {
            seat.folded = 1;
            folded_now = true;
        }
        seat.leave_requested = 1;
    } else {
        fund::stand_up_release(seat, ledger.deposited_total);
    }
    // Seat borrow ends here; game-level fields follow.
    if folded_now {
        game.actionable_mask &= !bit;
        game.pending_to_act_mask &= !bit;
    }
    if !in_hand {
        game.occupied_mask &= !bit;
        // Schedule a commit so L1 sees owed_total ASAP: the Phase 3
        // commit/heartbeat instruction fires once hands_since_commit reaches
        // commit_every_n_hands.
        game.hands_since_commit = table.commit_every_n_hands;

        // §11.2: PER members back to [crank(admin)]（占用者移出）。
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
        let member_keys = [table.admin];
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

    fund::assert_conservation_er(&game)?;
    Ok(())
}
