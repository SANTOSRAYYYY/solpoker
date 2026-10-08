//! stand_up — §5.2.5（ER；session key 或占用者钱包签名）。
//!
//! 鉴权：读 SeatLedger 克隆，要求克隆描述的是当前占用者（occupancy_id 与
//! occupant 都匹配），然后 signer == session_key 且未过期，或 signer ==
//! occupant。
//!
//! 座位在当前手牌中（hand_mask 含本座位且未 fold）→ 立即 fold 语义：标记
//! folded + leave_requested。折叠走 `hand::apply_stand_up_fold`：轮到该座位
//! 时是**完整引擎动作**（关街/结算推进一步不缺，2026-10-08 修——旧实现直接
//! 清 pending 位会留下 pending=0 的死状态，table #22 曾整桌卡死）；其他座位
//! 只标记 + 掩码同步 + 补规范 Fold 事件。all-in / AwaitRunout / Settle 的
//! 座位不折叠（牌已在池里或本手已定局，折叠会没收其底池权益），只登记离座，
//! 手牌结束时由 close_hand 释放。不移动任何资金计数器。此分支不动 PER 成员
//! （手牌还没结束，占用者还要读牌/reveal）。
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
use crate::hand;
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

    if in_hand {
        // 手内立即折叠语义（§5.2.5）。2026-10-08 修复：折叠不能再绕过引擎——
        // 旧实现直接清 pending 位，轮到该座位时会把下注轮清空却不关街，留下
        // pending=0 且阶段未推进的死状态（table #22 卡死 7 分钟+ 的根因）。
        //
        // all-in / AwaitRunout / Settle 的座位不折叠：牌已在池里或本手已定局，
        // 折叠等于没收其底池权益，只登记离座（手牌结束时由 close_hand 释放）。
        let already_folded = game.seats[idx as usize].folded != 0;
        let all_in = game.seats[idx as usize].all_in != 0 || game.seats[idx as usize].stack == 0;
        if !already_folded && !all_in {
            match game.phase {
                hand::PHASE_PREFLOP | hand::PHASE_BETTING => {
                    hand::apply_stand_up_fold(table, &mut game, idx, now)?;
                }
                hand::PHASE_AWAIT_STREET => {
                    hand::apply_passive_fold(&mut game, idx)?;
                }
                // AwaitRunout / Settle：不折叠，只登记离座。
                _ => {}
            }
        }
        game.seats[idx as usize].leave_requested = 1;
    } else {
        fund::stand_up_release(&mut game.seats[idx as usize], ledger.deposited_total);
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
