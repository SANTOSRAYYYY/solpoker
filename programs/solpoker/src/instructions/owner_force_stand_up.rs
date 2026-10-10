//! owner_force_stand_up — 主人回收自己 agent 的座位（ER，2026-10-10，审计 P2）。
//!
//! 场景：agent 失控/被盗/策略跑飞时，主人此前**没有任何链上回收手段**——
//! pause/revoke 只挡新入座，已就座者仍能行动（top_up 已加 profile 门禁，
//! 但座位本身还在）。本指令给主人一个与 `admin_force_stand_up` 同纪律的出口。
//!
//! **资金纪律**：与 admin 版完全一致——筹码全额转入该座位的 `owed_total`，
//! 之后任何人可代跑 cash_out，但**钱只进入座时钉死的 payout 地址**。
//! 主人也拿不到一分钱，只是把 agent 请离。
//!
//! 限制：座位必须在当前手牌之外（与 admin 版同）；账本必须是本桌本座
//! 且 `kind == Agent`、`agent_owner == 签名者`。

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::fund;
use crate::state::MAX_SEATS;
use crate::OwnerForceStandUp;

pub fn handler(ctx: Context<OwnerForceStandUp>, idx: u8) -> Result<()> {
    require!((idx as usize) < MAX_SEATS, SolpokerError::SeatMismatch);

    let table = &ctx.accounts.table;
    let mut game = ctx.accounts.game.load_mut()?;
    let bit = 1u16 << idx;

    // 在玩中的座位不可强清（防干扰对局）。
    require!(game.hand_mask & bit == 0, SolpokerError::SeatInHand);

    let seat = &mut game.seats[idx as usize];
    require!(seat.status == fund::SEAT_SEATED, SolpokerError::NotSeated);

    // 账本（ER 克隆）校验：本桌本座 + kind=Agent + agent_owner=签名者 +
    // occupant 与 ER 状态一致（克隆刷新滞后时宁可失败）。
    let led = fund::read_seat_ledger_clone(
        &ctx.accounts.seat_ledger.to_account_info(),
        &table.key(),
        idx,
    )?;
    require!(led.kind == fund::KIND_AGENT, SolpokerError::KindNotAllowed);
    require!(
        led.agent_owner == ctx.accounts.owner.key(),
        SolpokerError::Unauthorized
    );
    require!(led.occupant == seat.occupant, SolpokerError::SeatMismatch);

    fund::force_release(seat);
    game.occupied_mask &= !bit;
    // L1 尽快看到 owed_total（与 stand_up 同款）。
    game.hands_since_commit = table.commit_every_n_hands;

    fund::assert_conservation_er(&game)?;
    Ok(())
}
