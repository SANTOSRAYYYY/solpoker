//! claim_timeout — §6.3 行动超时（ER；permissionless，截止时间过后）。
//!
//! 能 check 就 check，否则 fold；strikes += 1（引擎只增，主动行动清零在
//! act，连续 max_strikes 次自动站起在结算）。追加规范 Timeout 事件
//! （auto_kind 0=check 1=fold）、action_seq + 1，推进同 act。结束时断言
//! I-ER。

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::fund;
use crate::hand;
use crate::ClaimTimeout;

pub fn handler(ctx: Context<ClaimTimeout>, hand_id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let table = &ctx.accounts.table;
    let mut game = ctx.accounts.game.load_mut()?;

    require!(hand_id == game.hand_id, SolpokerError::StaleAction);
    hand::apply_claim_timeout(table, &mut game, now)?;

    fund::assert_conservation_er(&game)?;
    Ok(())
}
