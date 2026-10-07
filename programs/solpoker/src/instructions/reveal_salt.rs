//! reveal_salt — §8.2 step 3 / D6（ER；occupant 或 session key）。
//!
//! D6：这笔交易**只写本人的 PlayerHand**（salt + salt_hand_id），不引用
//! Game。鉴权因此是 ledger-only（auth::authorize_ledger）——占位者克隆
//! 滞后时，上一任占用者的 session key 在克隆刷新前仍能通过鉴权写入本
//! 账户；该写入无法通过 advance 的承诺校验（承诺绑定当前 occupant 钱
//! 包），真正的揭示者在 advance 前重写即可覆盖。已知限制，见 Stage 6
//! Phase 3 报告。
//!
//! 座位是否已提交承诺（salt_commit != 0）在不读 Game 的前提下无法校
//! 验；缺失承诺的揭示会在 advance 处按缺盐作废旧（§8.2 step 4）。

use anchor_lang::prelude::*;

use crate::auth;
use crate::errors::SolpokerError;
use crate::RevealSalt;

pub fn handler(ctx: Context<RevealSalt>, idx: u8, hand_id: u64, salt: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let ledger = crate::fund::read_seat_ledger_clone(
        &ctx.accounts.seat_ledger.to_account_info(),
        &ctx.accounts.table.key(),
        idx,
    )?;
    require!(
        auth::authorize_ledger(&ledger, &ctx.accounts.signer.key(), now),
        SolpokerError::BadSession
    );
    require!(salt != [0u8; 32], SolpokerError::BadSalt);

    let hand = &mut ctx.accounts.player_hand;
    hand.salt = salt;
    hand.salt_hand_id = hand_id;
    Ok(())
}
