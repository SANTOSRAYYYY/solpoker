//! Session-key / occupant authentication shared by the ER seat-gated
//! instructions (D2, design §12): commit_salt / reveal_salt / act / stand_up.
//!
//! Rule: the SeatLedger ER read-only clone must describe the seat's CURRENT
//! occupancy (a clone from a previous occupancy carries the wrong session
//! key — the caller retries after the clone refreshes), and the signer must
//! be the occupant wallet or the unexpired session key.

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::fund;
use crate::state::{Game, SeatLedger, MAX_SEATS};

/// Pure credential check against a ledger (no Game access — D6 reveal_salt
/// touches only the caller's PlayerHand, so it authenticates ledger-only).
pub fn authorize_ledger(ledger: &SeatLedger, signer: &Pubkey, now: i64) -> bool {
    let session_ok = ledger.session_key != Pubkey::default()
        && *signer == ledger.session_key
        && now < ledger.session_expires_at;
    session_ok || *signer == ledger.occupant
}

/// Full seat auth for instructions that hold `game`: clone freshness +
/// seat status + credential check. Returns the verified ledger.
pub fn authorize_seat(
    ledger_ai: &AccountInfo,
    table_key: &Pubkey,
    idx: u8,
    game: &Game,
    signer: &Pubkey,
    now: i64,
) -> Result<SeatLedger> {
    require!((idx as usize) < MAX_SEATS, SolpokerError::SeatMismatch);
    let ledger = fund::read_seat_ledger_clone(ledger_ai, table_key, idx)?;
    let seat = &game.seats[idx as usize];
    require!(seat.status == fund::SEAT_SEATED, SolpokerError::NotSeated);
    require!(
        ledger.occupancy_id == seat.occupancy_id && ledger.occupant == seat.occupant,
        SolpokerError::StaleSnapshot
    );
    require!(
        authorize_ledger(&ledger, signer, now),
        SolpokerError::BadSession
    );
    Ok(ledger)
}
