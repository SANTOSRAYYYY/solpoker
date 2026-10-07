//! act — §7.1 玩家动作（ER；occupant 或 session key）。
//!
//! 参数带 `hand_id` 与 `action_seq`（X8 防重放/防陈旧）：与 Game 不一致
//! 即 StaleAction，状态不变。动作本身由 solpoker-core 引擎判定合法性
//! （所有非法动作在校验阶段拒绝，状态不变，§7.3）。成功后：镜像写回、
//! 追加规范 Action 事件、action_seq + 1；街结束/runout/手结束的推进按
//! hand::resolve_outcome（VRF 只 arm 不请求，V1 拆分）。结束时断言 I-ER。

use anchor_lang::prelude::*;
use solpoker_core::engine::Action as CoreAction;

use crate::auth;
use crate::errors::SolpokerError;
use crate::fund;
use crate::hand;
use crate::{Act, ActionArg};

pub fn handler(ctx: Context<Act>, idx: u8, hand_id: u64, action_seq: u32, action: ActionArg) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let table = &ctx.accounts.table;
    let mut game = ctx.accounts.game.load_mut()?;

    require!(hand_id == game.hand_id, SolpokerError::StaleAction);
    require!(action_seq == game.action_seq, SolpokerError::StaleAction);
    auth::authorize_seat(
        &ctx.accounts.seat_ledger.to_account_info(),
        &table.key(),
        idx,
        &game,
        &ctx.accounts.signer.key(),
        now,
    )?;

    let core_action = match action {
        ActionArg::Fold => CoreAction::Fold,
        ActionArg::Check => CoreAction::Check,
        ActionArg::Call => CoreAction::Call,
        ActionArg::Bet(a) => CoreAction::Bet(a),
        ActionArg::RaiseTo(t) => CoreAction::RaiseTo(t),
        ActionArg::AllIn => CoreAction::AllIn,
    };
    hand::apply_action(table, &mut game, idx, core_action, now)?;

    fund::assert_conservation_er(&game)?;
    Ok(())
}
