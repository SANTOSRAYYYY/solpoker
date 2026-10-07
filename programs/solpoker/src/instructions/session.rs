//! set_session / revoke_session — D2 会话密钥管理（L1；只有占用者钱包能签）。
//!
//! set_session：设置或替换 session_key 与有效期（≤ now + 7 天）。
//! revoke_session：清空 session_key 与有效期。两者都不动资金计数器。
//! ER 的动作指令读 SeatLedger 克隆做会话鉴权，撤销在克隆刷新后生效
//! （秒级，§7 会话表注记）。

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::fund;
use crate::{RevokeSession, SetSession};

fn require_occupant(seat: &crate::state::SeatLedger, signer: &Pubkey) -> Result<()> {
    require!(
        seat.occupant != Pubkey::default() && &seat.occupant == signer,
        SolpokerError::NotOccupant
    );
    Ok(())
}

pub fn set_handler(
    ctx: Context<SetSession>,
    session_key: Pubkey,
    session_expires_at: i64,
) -> Result<()> {
    let seat = &mut ctx.accounts.seat;
    require_occupant(seat, &ctx.accounts.payer.key())?;
    let now = Clock::get()?.unix_timestamp;
    require!(
        session_expires_at <= now + fund::MAX_SESSION_TTL_S,
        SolpokerError::SessionTooLong
    );
    seat.session_key = session_key;
    seat.session_expires_at = session_expires_at;
    Ok(())
}

pub fn revoke_handler(ctx: Context<RevokeSession>) -> Result<()> {
    let seat = &mut ctx.accounts.seat;
    require_occupant(seat, &ctx.accounts.payer.key())?;
    seat.session_key = Pubkey::default();
    seat.session_expires_at = 0;
    Ok(())
}
