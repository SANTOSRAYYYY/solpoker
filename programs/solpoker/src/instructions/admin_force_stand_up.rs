//! admin_force_stand_up — 弃置座位回收（ER，table.admin 门禁，2026-10-07）。
//!
//! 场景：占位玩家的密钥丢失/长期离线且无法再超时（例如独自坐在空桌，或
//! 手牌卡在 Commit 后仅剩其一人），座位无法通过 A7 自动离座回收，桌子
//! 永远不干净（#5 的活例）。
//!
//! **资金纪律**：筹码全额转入该座位自己的 `owed_total` —— 之后 crank 会把
//! owed 带上 L1，任何人（包括运营方）可代跑 cash_out，但**钱只进占用者
//! 入座时固定的 payout 地址**。管理员无法把任何资金转给自己或金库。
//!
//! 限制：座位必须在当前手牌之外（hand_mask 无本位）——防止对在玩的玩家
//! 强行清座；在手里的座位请等本手结束（自动离座会把超时者带走）。

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::fund;
use crate::state::MAX_SEATS;
use crate::AdminForceStandUp;

pub fn handler(ctx: Context<AdminForceStandUp>, idx: u8) -> Result<()> {
    require!((idx as usize) < MAX_SEATS, SolpokerError::SeatMismatch);

    let table = &ctx.accounts.table;
    let mut game = ctx.accounts.game.load_mut()?;
    let bit = 1u16 << idx;

    // 在玩中的座位不可强清（防干扰对局）。
    require!(game.hand_mask & bit == 0, SolpokerError::SeatInHand);

    let seat = &mut game.seats[idx as usize];
    require!(seat.status == fund::SEAT_SEATED, SolpokerError::NotSeated);
    fund::force_release(seat);
    game.occupied_mask &= !bit;
    // L1 尽快看到 owed_total（与 stand_up 同款）。
    game.hands_since_commit = table.commit_every_n_hands;

    fund::assert_conservation_er(&game)?;
    Ok(())
}
