//! Game-loop shared logic (design 鎼? 閹靛澧濋悩鑸碘偓浣规簚, 鎼? 鐟欏嫬鍨鏇熸惛閹恒儳鍤? 鎼? 閸欐垹澧濋崡蹇氼唴).
//!
//! Everything here is pure (no CPI, no Clock 閳?`now` is passed in) so the
//! whole phase machine is unit-testable in-memory; the instruction handlers
//! only do account plumbing and then call into this module.
//!
//! Two mirror disciplines:
//!
//! - **Engine mirror** (same pattern as the VrfSlot mirror): [`engine_from_game`]
//!   rebuilds a `solpoker_core::engine::Engine` from the persisted Game fields
//!   (seats + masks + bets), the core applies one transition, and
//!   [`sync_game_from_engine`] writes the result back. Rules live only in core.
//! - **Deal driver**: `solpoker_core::deal::DealSession` is an in-memory
//!   machine and cannot persist between instructions. [`DealState`] is its
//!   persisted twin: `(used_mask, draw_no, transcript)` stored across `Deck`
//!   and `Game`, rebuilt at every `advance`, and driving the exact same draw
//!   math via core's public `draw_value` / `rejection_threshold` /
//!   `hole_order` / `seed_k` / `salt_digest` with events encoded by core's
//!   `Event::encode`. The `#[cfg(test)]` parity test pins byte-for-byte
//!   equality of cards and transcripts against `DealSession`.
//!
//! CU budget note (design 鎼?.4): settlement (up to 9 鑴?21 five-card
//! evaluations + pot math + proof write + secret zeroing) runs in ONE
//! `advance` instruction for Stage 6. If CU measurement blows the budget, the
//! deterministic split is "evaluate & pin result" then "distribute" 閳?the
//! phase machine already isolates Settle as its own transition, so the split
//! is a local change to [`advance`].
//!
//! Transcript layout note: `Game.transcript` stores only the rolling chain
//! hash (Stage 6 Phase 1 decision 閳?full event bytes are re-derivable from
//! HandProof + public fields).

// clippy：座位号/抽牌序号就是数组下标（与 seat_bit、game.seats 平行），索引式循环
// 比 zip 更贴合牌桌语义；手牌机与各街 helper 参数多（游戏状态本身就很宽），不宜再包一层。
#![allow(clippy::needless_range_loop, clippy::too_many_arguments)]
use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};
use solpoker_core::deal::{
    self, BoardStreet, Event, ForcedBetKind, HandInputs, HandResult, VoidReason,
};
use solpoker_core::engine::{ActOutcome, Action as CoreAction, Engine, EngineSeat};
use solpoker_core::eval;
use solpoker_core::seats::{next_clockwise, popcount, seat_bit};
use solpoker_core::settle;
use solpoker_core::vrf::VrfTarget as CoreVrfTarget;

use crate::errors::SolpokerError;
use crate::fund;
use crate::state::{Deck, Game, HandProof, HandReplay, HandSecrets, PlayerHand, ProofEntry, ReplayEntry, SecretsEntry, Table, VrfSlot, VrfState, VrfTarget, MAX_SEATS, REPLAY_RING};

// ---------------------------------------------------------------------------
// Game.phase (state.rs field comment pins the encoding)
// ---------------------------------------------------------------------------

pub const PHASE_IDLE: u8 = 0;
pub const PHASE_COMMIT: u8 = 1;
pub const PHASE_AWAIT_SEED: u8 = 2;
pub const PHASE_PREFLOP: u8 = 3;
pub const PHASE_AWAIT_STREET: u8 = 4;
pub const PHASE_BETTING: u8 = 5;
pub const PHASE_AWAIT_RUNOUT: u8 = 6;
pub const PHASE_SETTLE: u8 = 7;
// 8 = Void is transient: voiding completes inside one advance call and the
// phase returns to Idle; the u8 encoding reserves 8 for it (state.rs).

/// ProofEntry.status
pub const PROOF_SETTLED: u8 = 0;
pub const PROOF_VOID: u8 = 1;

// ---------------------------------------------------------------------------
// Engine mirror
// ---------------------------------------------------------------------------

/// Game 閳?core Engine. `flop_dealt` is not persisted on Game; it is exactly
/// "the flop is on the board" (board_len >= 3), which also covers the preflop
/// runout case (advance deals all five cards 閳?rake then applies, 鎼?.1 note in
/// core engine docs).
pub fn engine_from_game(game: &Game, sb: u64, bb: u64, ante: u64) -> Engine {
    let mut seats = [EngineSeat::default(); MAX_SEATS];
    for i in 0..MAX_SEATS {
        let s = &game.seats[i];
        seats[i] = EngineSeat {
            stack: s.stack,
            in_hand: s.in_hand,
            street_bet: s.street_bet,
            in_hand_mask: game.hand_mask & seat_bit(i as u8) != 0,
            folded: s.folded != 0,
            all_in: s.all_in != 0,
            acted: s.acted != 0,
            strikes: s.strikes,
            leave_requested: s.leave_requested != 0,
        };
    }
    Engine {
        seats,
        button: game.button,
        occupied_mask: game.occupied_mask,
        hand_mask: game.hand_mask,
        live_mask: game.live_mask,
        actionable_mask: game.actionable_mask,
        pending_to_act_mask: game.pending_to_act_mask,
        pot: game.pot,
        current_bet: game.current_bet,
        last_full_raise: game.last_full_raise,
        to_act: game.to_act,
        street: game.street,
        sb,
        bb,
        ante,
        flop_dealt: game.board_len >= 3,
        runout_needed: game.phase == PHASE_AWAIT_RUNOUT,
        finished: game.phase == PHASE_SETTLE,
    }
}

/// Core Engine 閳?Game (seat money/flags + masks + bet state + street).
pub fn sync_game_from_engine(game: &mut Game, e: &Engine) {
    for i in 0..MAX_SEATS {
        let s = &mut game.seats[i];
        let es = &e.seats[i];
        s.stack = es.stack;
        s.in_hand = es.in_hand;
        s.street_bet = es.street_bet;
        s.folded = es.folded as u8;
        s.all_in = es.all_in as u8;
        s.acted = es.acted as u8;
        s.strikes = es.strikes;
        s.leave_requested = es.leave_requested as u8;
    }
    game.live_mask = e.live_mask;
    game.actionable_mask = e.actionable_mask;
    game.pending_to_act_mask = e.pending_to_act_mask;
    game.pot = e.pot;
    game.current_bet = e.current_bet;
    game.last_full_raise = e.last_full_raise;
    game.to_act = e.to_act;
    game.street = e.street;
}

// ---------------------------------------------------------------------------
// Transcript (byte-identical to solpoker_core::deal::Transcript, persisted)
// ---------------------------------------------------------------------------

/// transcript_0 = sha256("solpoker/transcript/v1" 閳?program_id 閳?table 閳?hand_id).
pub fn transcript_init(program_id: &[u8; 32], table: &[u8; 32], hand_id: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"solpoker/transcript/v1");
    h.update(program_id);
    h.update(table);
    h.update(hand_id.to_be_bytes());
    h.finalize().into()
}

/// transcript_{n+1} = sha256(transcript_n 閳?event.encode()).
pub fn transcript_append(digest: &mut [u8; 32], event: &Event) {
    let enc = event.encode();
    let mut h = Sha256::new();
    h.update(*digest);
    h.update(&enc);
    *digest = h.finalize().into();
}

// ---------------------------------------------------------------------------
// §7 事件流存证：规范事件 emit（验证器据此从 ER 交易日志重建行动序列）
// ---------------------------------------------------------------------------

/// event_tag：0 = 主动行动（act），1 = 超时自动行动（claim_timeout）。
pub const EVENT_TAG_ACTION: u8 = 0;
pub const EVENT_TAG_TIMEOUT: u8 = 1;

/// 玩家行动 / 超时自动行动的**规范事件**（与写进 transcript 的 Event 同值）。
/// 公开数据：金额、座号、行动类型——结算后本就按 §8.7 公开；不含盐、不含牌面。
/// 验证用途：把这些事件按序追加到 draw_digest[k]，应复现 street_end[k]；
/// 全部追加 + HandEnd 后应复现 transcript_final。
#[event]
pub struct HandEventLog {
    pub hand_id: u64,
    /// 该手内事件序号（action_seq，Timeout 也占一号）——仅信息性，验证按日志顺序。
    pub seq: u32,
    /// 0=Action 1=Timeout
    pub event_tag: u8,
    pub seat: u8,
    /// Action: kind 0..5（fold/check/call/bet/raise/allin）；Timeout: auto_kind（0=fold,1=check）
    pub kind: u8,
    /// Action: call=实际支付额、bet/raise/allin=目标额；Timeout 恒 0
    pub amount: u64,
}

// ---------------------------------------------------------------------------
// DealState 閳?persisted twin of core's DrawMachine/DealSession
// ---------------------------------------------------------------------------

/// The draw-machine state that must survive between instructions.
/// `used_mask`/`draw_no` live in `Deck`, `transcript` in `Game`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DealState {
    pub used_mask: u64,
    pub draw_no: u16,
    pub transcript: [u8; 32],
}

/// The `index`-th card (0-based, ascending) not yet drawn.
fn nth_free_card(used_mask: u64, index: usize) -> u8 {
    let mut seen = 0usize;
    for card in 0..deal::DECK_SIZE as u8 {
        if used_mask & (1u64 << card) == 0 {
            if seen == index {
                return card;
            }
            seen += 1;
        }
    }
    unreachable!("index < remaining count by construction");
}

impl DealState {
    pub fn new(program_id: &[u8; 32], table: &[u8; 32], hand_id: u64) -> Self {
        Self {
            used_mask: 0,
            draw_no: 0,
            transcript: transcript_init(program_id, table, hand_id),
        }
    }

    /// Resume from persisted state (AwaitStreet/AwaitRunout advances).
    pub fn resume(deck: &Deck, game: &Game) -> Self {
        Self {
            used_mask: deck.used_mask,
            draw_no: deck.draw_no,
            transcript: game.transcript,
        }
    }

    /// Persist back into Deck + Game.
    pub fn store(&self, deck: &mut Deck, game: &mut Game) {
        deck.used_mask = self.used_mask;
        deck.draw_no = self.draw_no;
        game.transcript = self.transcript;
    }

    pub fn append(&mut self, event: &Event) {
        transcript_append(&mut self.transcript, event);
    }

    /// One draw, byte-identical to `solpoker_core::deal::DrawMachine::draw`:
    /// sample against the CURRENT transcript (with rejection sampling), then
    /// append `make_event(card, draw_no)` and advance draw_no.
    pub fn draw(
        &mut self,
        seed: &[u8; 32],
        table: &[u8; 32],
        hand_id: u64,
        make_event: impl FnOnce(u8, u16) -> Event,
    ) -> (u8, u16) {
        let mut retry = 0u16;
        loop {
            let n = (deal::DECK_SIZE as u64 - self.used_mask.count_ones() as u64) as usize;
            debug_assert!(n >= 1, "deck exhausted");
            let v = deal::draw_value(seed, table, hand_id, self.draw_no, retry, &self.transcript);
            if v < deal::rejection_threshold(n) {
                retry += 1;
                continue;
            }
            let index = (v % n as u64) as usize;
            let card = nth_free_card(self.used_mask, index);
            self.used_mask |= 1u64 << card;
            let draw_no = self.draw_no;
            self.draw_no += 1;
            self.append(&make_event(card, draw_no));
            return (card, draw_no);
        }
    }
}

// ---------------------------------------------------------------------------
// Forced bets (event plan, amounts byte-identical to Engine::post_forced_bets)
// ---------------------------------------------------------------------------

/// Canonical ForcedBet event sequence (dealing-protocol 鎼?.3/鎼?.4): all antes
/// from `next_clockwise(button)` clockwise, then SB, then BB. Amounts are
/// `min(due, remaining stack)` 閳?exactly what `Engine::post_forced_bets`
/// moves, so the events match the engine mirror one-to-one.
pub fn forced_bet_events(
    stacks: &[u64; MAX_SEATS],
    hand_mask: u16,
    button: u8,
    sb: u64,
    bb: u64,
    ante: u64,
) -> Vec<Event> {
    let heads_up = popcount(hand_mask) == 2;
    let sb_seat = if heads_up {
        button
    } else {
        next_clockwise(button, hand_mask).expect("hand_mask non-empty")
    };
    let bb_seat = next_clockwise(sb_seat, hand_mask).expect("hand_mask non-empty");
    let mut remaining = *stacks;
    let mut out = Vec::new();
    // Antes: from button's left, clockwise.
    let mut s = next_clockwise(button, hand_mask).expect("hand_mask non-empty");
    for _ in 0..popcount(hand_mask) {
        let pay = ante.min(remaining[s as usize]);
        remaining[s as usize] -= pay;
        out.push(Event::ForcedBet {
            seat: s,
            kind: ForcedBetKind::Ante,
            amount: pay,
        });
        s = next_clockwise(s, hand_mask).expect("hand_mask non-empty");
    }
    let sb_pay = sb.min(remaining[sb_seat as usize]);
    remaining[sb_seat as usize] -= sb_pay;
    out.push(Event::ForcedBet {
        seat: sb_seat,
        kind: ForcedBetKind::SmallBlind,
        amount: sb_pay,
    });
    let bb_pay = bb.min(remaining[bb_seat as usize]);
    out.push(Event::ForcedBet {
        seat: bb_seat,
        kind: ForcedBetKind::BigBlind,
        amount: bb_pay,
    });
    out
}

// ---------------------------------------------------------------------------
// Salts
// ---------------------------------------------------------------------------

/// Verify one hand_mask seat's revealed salt against its stored commitment
/// (鎼?.2 step 4). `table` is the Table account address.
pub fn verify_seat_salt(
    table: &[u8; 32],
    hand_id: u64,
    seat: &crate::state::SeatState,
    hand: &PlayerHand,
) -> bool {
    hand.salt_hand_id == hand_id
        && hand.salt != [0u8; 32]
        && seat.salt_commit != [0u8; 32]
        && deal::salt_commitment(table, hand_id, &seat.occupant.to_bytes(), &hand.salt)
            == seat.salt_commit
}

/// Build core `HandInputs` from Game + revealed salts + VRF outputs.
/// Canonical HandStart shape (dealing-protocol 鎼?.3): seats outside hand_mask
/// carry zero stacks/occupancy_ids.
pub fn hand_inputs(
    program_id: &[u8; 32],
    table: &[u8; 32],
    game: &Game,
    salts: &[[u8; 32]; MAX_SEATS],
    vrf: &[[u8; 32]; 5],
) -> HandInputs {
    let mut stacks = [0u64; MAX_SEATS];
    let mut occupancy_ids = [0u64; MAX_SEATS];
    let mut occupants = [[0u8; 32]; MAX_SEATS];
    for i in 0..MAX_SEATS {
        if game.hand_mask & seat_bit(i as u8) != 0 {
            stacks[i] = game.seats[i].stack;
            occupancy_ids[i] = game.seats[i].occupancy_id;
            occupants[i] = game.seats[i].occupant.to_bytes();
        }
    }
    HandInputs {
        program_id: *program_id,
        table: *table,
        hand_id: game.hand_id,
        hand_mask: game.hand_mask,
        stacks,
        occupancy_ids,
        occupants,
        salts: *salts,
        vrf: *vrf,
    }
}

/// salt_digest for the current hand from persisted salts (Deck copy).
pub fn current_salt_digest(
    table: &[u8; 32],
    game: &Game,
    salts: &[[u8; 32]; MAX_SEATS],
) -> [u8; 32] {
    let mut occupancy_ids = [0u64; MAX_SEATS];
    let mut occupants = [[0u8; 32]; MAX_SEATS];
    for i in 0..MAX_SEATS {
        occupancy_ids[i] = game.seats[i].occupancy_id;
        occupants[i] = game.seats[i].occupant.to_bytes();
    }
    deal::salt_digest(
        table,
        game.hand_id,
        game.hand_mask,
        &occupants,
        &occupancy_ids,
        salts,
    )
}

// ---------------------------------------------------------------------------
// VRF slot helpers (mirror pattern of advance's arm path)
// ---------------------------------------------------------------------------

/// arm the slot for `target` via the core state machine.
pub fn arm_vrf(game: &mut Game, target: VrfTarget) -> Result<()> {
    let mut core_slot = game
        .vrf
        .core_replay()
        .ok_or(SolpokerError::VrfArmRejected)?;
    core_slot
        .arm(target.to_core())
        .map_err(|_| SolpokerError::VrfArmRejected)?;
    game.vrf.sync_from_core(&core_slot);
    Ok(())
}

/// Consume a Fulfilled slot: reset the mirror to Idle (core `VrfSlot::reset`).
pub fn reset_vrf(game: &mut Game) {
    game.vrf = VrfSlot::default();
}

// ---------------------------------------------------------------------------
// act / claim_timeout
// ---------------------------------------------------------------------------

/// Shared outcome resolution after a successful engine action (鎼?.1):
/// finished 閳?Settle; runout 閳?arm Runout + AwaitRunout; street end 閳?/// AwaitStreet (advance arms the street VRF 閳?the street transition itself is
/// advance's job); otherwise refresh the action deadline for the next actor.
fn resolve_outcome(game: &mut Game, table: &Table, outcome: &ActOutcome, now: i64) -> Result<()> {
    if outcome.hand_finished {
        game.phase = PHASE_SETTLE;
        game.action_deadline = 0;
    } else if outcome.runout_started {
        arm_vrf(game, VrfTarget::Runout)?;
        game.phase = PHASE_AWAIT_RUNOUT;
        game.action_deadline = 0;
    } else if outcome.street_ended {
        game.phase = PHASE_AWAIT_STREET;
        game.action_deadline = 0;
    } else {
        game.action_deadline = now + table.action_timeout_s as i64;
    }
    Ok(())
}

fn require_betting_phase(game: &Game) -> Result<()> {
    require!(
        game.phase == PHASE_PREFLOP || game.phase == PHASE_BETTING,
        SolpokerError::BadPhase
    );
    Ok(())
}

/// `act` (鎼?.1): one engine action + canonical Action event + seq bump.
/// Caller has already authenticated seat `idx` and checked hand_id/action_seq.
pub fn apply_action(
    table: &Table,
    game: &mut Game,
    idx: u8,
    action: CoreAction,
    now: i64,
) -> Result<()> {
    require_betting_phase(game)?;
    require!(
        (idx as usize) < MAX_SEATS && game.hand_mask & seat_bit(idx) != 0,
        SolpokerError::BadAction
    );
    let street_bet_before = game.seats[idx as usize].street_bet;
    let stack_before = game.seats[idx as usize].stack;
    // Event amounts are computed from PRE-act state: a street-ending action
    // lets the engine reset street_bet (close_streets), so post-act reads
    // cannot recover them. call = actual amount paid (min(owe, stack), the
    // engine's Call rule); all-in = the target street_bet + stack.
    let call_pay = game
        .current_bet
        .saturating_sub(street_bet_before)
        .min(stack_before);
    let allin_target = street_bet_before + stack_before;
    let mut engine = engine_from_game(game, table.sb, table.bb, table.ante);
    let outcome = engine
        .act(idx, action)
        .map_err(|_| SolpokerError::BadAction)?;

    // Canonical Action event amount (dealing-protocol 搂6.3): call = actual
    // amount paid; bet/raise/all-in = the street_bet target reached.
    use solpoker_core::deal::ActionKind;
    let (kind, amount) = match action {
        CoreAction::Fold => (ActionKind::Fold, 0),
        CoreAction::Check => (ActionKind::Check, 0),
        CoreAction::Call => (ActionKind::Call, call_pay),
        CoreAction::Bet(a) => (ActionKind::Bet, a),
        CoreAction::RaiseTo(t) => (ActionKind::Raise, t),
        CoreAction::AllIn => (ActionKind::AllIn, allin_target),
    };
    // §8.3: a voluntary action clears the seat's timeout strikes.
    engine.seats[idx as usize].strikes = 0;

    sync_game_from_engine(game, &engine);
    transcript_append(
        &mut game.transcript,
        &Event::Action {
            seat: idx,
            kind,
            amount,
        },
    );
    // §7 事件流存证：把**规范事件**（程序实际写进 transcript 的那个）emit 成日志，
    // 让验证器能从 ER 交易日志重建行动序列并与 street_end / transcript_final 对账。
    // 这些是结算后本就公开的数据（§8.7），不含盐、不含未揭示的牌。
    emit!(HandEventLog {
        hand_id: game.hand_id,
        seq: game.action_seq,
        event_tag: EVENT_TAG_ACTION,
        seat: idx,
        kind: kind as u8,
        amount,
    });
    game.action_seq = game
        .action_seq
        .checked_add(1)
        .ok_or(SolpokerError::Overflow)?;
    resolve_outcome(game, table, &outcome, now)
}

/// `claim_timeout` (鎼?.3): check-or-fold for the seat on the clock + strikes.
/// Permissionless; caller checked hand_id. Only after the deadline.
pub fn apply_claim_timeout(table: &Table, game: &mut Game, now: i64) -> Result<()> {
    require_betting_phase(game)?;
    require!(game.pending_to_act_mask != 0, SolpokerError::BadPhase);
    require!(
        now >= game.action_deadline,
        SolpokerError::TimeoutNotElapsed
    );
    let seat = game.to_act;
    require!(
        (seat as usize) < MAX_SEATS && game.hand_mask & seat_bit(seat) != 0,
        SolpokerError::BadPhase
    );
    let mut engine = engine_from_game(game, table.sb, table.bb, table.ante);
    let result = engine
        .claim_timeout(seat)
        .map_err(|_| SolpokerError::BadAction)?;
    let (auto_kind, outcome) = match result {
        solpoker_core::engine::TimeoutResult::Checked(o) => (0u8, o),
        solpoker_core::engine::TimeoutResult::Folded(o) => (1u8, o),
    };
    // Strikes are NOT cleared (engine incremented them); no voluntary action.
    sync_game_from_engine(game, &engine);
    transcript_append(&mut game.transcript, &Event::Timeout { seat, auto_kind });
    // §7：超时自动行动同样进 transcript，也要 emit（验证器不能从 act 交易里看到它）
    emit!(HandEventLog {
        hand_id: game.hand_id,
        seq: game.action_seq,
        event_tag: EVENT_TAG_TIMEOUT,
        seat,
        kind: auto_kind,
        amount: 0,
    });
    game.action_seq = game
        .action_seq
        .checked_add(1)
        .ok_or(SolpokerError::Overflow)?;
    resolve_outcome(game, table, &outcome, now)
}

// ---------------------------------------------------------------------------
// stand_up 的手内折叠 / 下注街自愈（2026-10-08）
// ---------------------------------------------------------------------------

/// 被动折叠：标记 + 掩码同步 + 规范 Action 事件（不动引擎、不推进轮次）。
/// 适用：非当前行动者的 stand_up 折叠、AwaitStreet 阶段的离座折叠。引擎镜像
/// 会在下次重建（engine_from_game 读 folded）时自然一致，pending 仍有 to_act
/// 在列，不受影响。
///
/// 事件纪律：stand_up 的折叠也是行动流的一部分，验证器要靠它复现 transcript
/// 链式哈希（旧实现不记事件 → 事件流与链上 transcript 对不上，2026-10-08 修）。
pub fn apply_passive_fold(game: &mut Game, idx: u8) -> Result<()> {
    use solpoker_core::deal::ActionKind;
    let bit = seat_bit(idx);
    game.seats[idx as usize].folded = 1;
    game.actionable_mask &= !bit;
    game.pending_to_act_mask &= !bit;
    transcript_append(
        &mut game.transcript,
        &Event::Action {
            seat: idx,
            kind: ActionKind::Fold,
            amount: 0,
        },
    );
    emit!(HandEventLog {
        hand_id: game.hand_id,
        seq: game.action_seq,
        event_tag: EVENT_TAG_ACTION,
        seat: idx,
        kind: ActionKind::Fold as u8,
        amount: 0,
    });
    game.action_seq = game
        .action_seq
        .checked_add(1)
        .ok_or(SolpokerError::Overflow)?;
    Ok(())
}

/// stand_up 的手内「立即折叠」规范路径（§5.2.5）：与一次自愿 Fold 动作同语义。
/// 当前行动者走 [`apply_action`] 的完整引擎推进（关街/结算/runout 一步不缺）；
/// 其他座位走 [`apply_passive_fold`]。
///
/// 背景（table #22 卡死根因）：旧实现在指令侧直接 `pending_to_act_mask &= !bit`，
/// 轮到该座位时折叠后 pending 归零却没有关街，phase 停在下注阶段、advance 对
/// 下注阶段是 no-op → 全桌死锁。
pub fn apply_stand_up_fold(table: &Table, game: &mut Game, idx: u8, now: i64) -> Result<()> {
    require_betting_phase(game)?;
    let bit = seat_bit(idx);
    if game.pending_to_act_mask & bit != 0 && game.to_act == idx {
        return apply_action(table, game, idx, CoreAction::Fold, now);
    }
    apply_passive_fold(game, idx)
}

/// 下注街自愈（2026-10-08）：`pending_to_act_mask == 0` 却还停在下注阶段，
/// 即「下注轮已结束、关街没跑」。唯一已知来源是旧版 stand_up 的直接清位
/// （已修）；这里为存量桌（table #22）和任何漏网路径兜底——advance 是
/// permissionless 的，任何 keeper 一发即修复。pending 非零时正常 no-op。
#[inline(never)]
fn close_stalled_betting(table: &Table, game: &mut Game, now: i64) -> Result<()> {
    if game.pending_to_act_mask != 0 {
        return Ok(()); // 正常：等玩家行动
    }
    let mut engine = engine_from_game(game, table.sb, table.bb, table.ante);
    let outcome = engine.resolve_stalled_street();
    sync_game_from_engine(game, &engine);
    resolve_outcome(game, table, &outcome, now)
}

// ---------------------------------------------------------------------------
// Hand close (shared by Settle and Void)
// ---------------------------------------------------------------------------

/// Reset all per-hand state on Game after the proof entry is written:
/// clears seat hand fields + salt_commit, processes leave_requested /
/// zero-stack / max-strikes auto stand-ups (fund release per 鎼?.2.5, minus
/// uncredited-deposit handling which needs the L1 ledger 閳?late deposits are
/// swept to owed by the next apply_deposits/cash_out, 鎼?.1 monotonicity),
/// and returns the phase to Idle with hand_id + 1.
fn close_hand(game: &mut Game, table: &Table) {
    let hand_mask = game.hand_mask;
    for i in 0..MAX_SEATS {
        if hand_mask & seat_bit(i as u8) == 0 {
            continue;
        }
        let s = &mut game.seats[i];
        s.in_hand = 0;
        s.street_bet = 0;
        s.folded = 0;
        s.all_in = 0;
        s.acted = 0;
        s.salt_commit = [0; 32];
        // 鎼?.1: zero stack auto stand-up; 鎼?.3: max-strikes auto stand-up.
        let auto_leave = s.stack == 0 || s.strikes >= table.max_strikes;
        if s.leave_requested != 0 || auto_leave {
            s.owed_total = s.owed_total.saturating_add(s.stack);
            s.stack = 0;
            s.status = fund::SEAT_LEFT;
            s.leave_requested = 0;
            s.next_salt_commit = [0; 32];
            s.strikes = 0;
            game.occupied_mask &= !seat_bit(i as u8);
            // Schedule a commit so L1 sees owed_total ASAP (same as stand_up).
            game.hands_since_commit = table.commit_every_n_hands;
        }
    }
    game.hand_mask = 0;
    game.live_mask = 0;
    game.actionable_mask = 0;
    game.pending_to_act_mask = 0;
    game.pot = 0;
    game.current_bet = 0;
    game.last_full_raise = 0;
    game.to_act = u8::MAX;
    game.action_deadline = 0;
    game.phase_deadline = 0;
    game.action_seq = 0;
    game.board = [0xFF; 5];
    game.board_len = 0;
    game.board_src = [0; 5];
    game.phase = PHASE_IDLE;
    game.hand_id = game.hand_id.saturating_add(1);
    game.hands_since_commit = game.hands_since_commit.saturating_add(1);
    // A voided hand may leave the slot in the terminal Void state; the next
    // hand always starts from Idle.
    game.vrf = VrfSlot::default();
}

/// Zero every secret for the finished hand (鎼?.7/鎼?.8): Deck VRF outputs,
/// salts, draw state, and each hand_mask seat's PlayerHand (cards + salt).
/// PlayerHand accounts of seats NOT in the hand are untouched 閳?they may
/// hold a pre-reveal for the next hand.
fn zero_secrets(deck: &mut Deck, hands: &mut [&mut PlayerHand; MAX_SEATS], hand_mask: u16) {
    deck.vrf_out = [[0u8; 32]; 5];
    deck.vrf_attempt_used = [0; 5];
    deck.salts = [[0u8; 32]; MAX_SEATS];
    deck.used_mask = 0;
    deck.draw_no = 0;
    for i in 0..MAX_SEATS {
        if hand_mask & seat_bit(i as u8) != 0 {
            let h = &mut hands[i];
            h.cards = [0xFF; 2];
            h.salt = [0u8; 32];
            h.salt_hand_id = 0;
        }
    }
}

// ---------------------------------------------------------------------------
// HandReplay 写入（§8.7 整手复算输入；见 docs/design/hand-replay-design.md）
// ---------------------------------------------------------------------------

/// replay 槽位 = hand_id % REPLAY_RING（state.rs 的布局测试钉死同义实现）。
#[inline]
fn replay_slot(hand_id: u64) -> usize {
    (hand_id % REPLAY_RING as u64) as usize
}

/// 发牌前记录「该街第一张牌抽取前」的 transcript 摘要。
/// k = VrfTarget::deck_index()（0=preflop, 1=flop, 2=turn, 3=river, 4=runout）。
/// 槽位首次使用时清空（旧手残留），后续调用只累加。
pub fn capture_draw_digest(replay: &mut HandReplay, hand_id: u64, k: usize, digest: &[u8; 32]) {
    let slot = replay_slot(hand_id);
    if replay.entries[slot].hand_id != hand_id {
        replay.entries[slot] = ReplayEntry {
            hand_id,
            ..Default::default()
        };
    }
    replay.entries[slot].draw_digest[k] = *digest;
    replay.entries[slot].streets_used |= 1u8 << k;
}

/// 手牌结束：补齐 replay entry 的其余字段（salt_digest / vrf_attempt_used / status）。
/// 必须在 secrets 清零前调用（attempt 来自 Deck）。layout_ver 写 2（street_end 版）。
pub fn finalize_replay(
    replay: &mut HandReplay,
    game: &Game,
    deck: &Deck,
    salts: &[[u8; 32]; MAX_SEATS],
    status: u8,
) {
    let slot = replay_slot(game.hand_id);
    let entry = &mut replay.entries[slot];
    if entry.hand_id != game.hand_id {
        *entry = ReplayEntry {
            hand_id: game.hand_id,
            ..Default::default()
        };
    }
    entry.salt_digest = current_salt_digest(&game.table.to_bytes(), game, salts);
    entry.vrf_attempt_used = deck.vrf_attempt_used;
    entry.status = status;
    entry.layout_ver = 2;
    replay.head = replay.head.wrapping_add(1);
}

/// 记录**某条街结束时**的 transcript（§7 事件流存证的锚点）。
/// street 用手里的 street 编号（0=preflop..3=river）；runout 结束的是最后一条下注街。
/// **幂等**：同一街只记第一次（先到先得）—— runout 场景下"runout 前的下注街结束"
/// 先写，随后结算路径再写同一街会被跳过，不会被 runout 的发牌事件污染。
pub fn capture_street_end(replay: &mut HandReplay, game: &Game, street: u8) {
    if street > 3 {
        return;
    }
    let slot = replay_slot(game.hand_id);
    let entry = &mut replay.entries[slot];
    if entry.hand_id != game.hand_id {
        *entry = ReplayEntry {
            hand_id: game.hand_id,
            ..Default::default()
        };
    }
    if entry.streets_ended & (1u8 << street) != 0 {
        return; // 已经有锚点（先到先得）
    }
    entry.street_end[street as usize] = game.transcript;
    entry.streets_ended |= 1u8 << street;
    entry.layout_ver = 2;
}

/// Write the ring-buffer proof entry for the finished hand and bump head.
/// Must run BEFORE secrets are zeroed (vrf_out/salts come from Deck).
/// 盐与 VRF 写入配套的 HandSecrets 环（2026-10-07 拆分，见 state.rs 偏差记录）。
fn write_proof_entry(
    proof: &mut HandProof,
    secrets: &mut HandSecrets,
    replay: &mut HandReplay,
    game: &Game,
    deck: &Deck,
    status: u8,
    hole: &[[u8; 2]; MAX_SEATS],
    salts: &[[u8; 32]; MAX_SEATS],
    deltas: [i64; MAX_SEATS],
    rake: u64,
    now: i64,
) {
    let hand_mask = game.hand_mask;
    let mut occupancy_ids = [0u64; MAX_SEATS];
    let mut hole_masked = [[0xFFu8; 2]; MAX_SEATS];
    let mut salts_masked = [[0u8; 32]; MAX_SEATS];
    let mut vrf_mask = 0u8;
    for k in 0..5 {
        if deck.vrf_attempt_used[k] != 0 {
            vrf_mask |= 1u8 << k;
        }
    }
    for i in 0..MAX_SEATS {
        if hand_mask & seat_bit(i as u8) != 0 {
            occupancy_ids[i] = game.seats[i].occupancy_id;
            hole_masked[i] = hole[i];
            salts_masked[i] = salts[i];
        }
    }
    let entry = ProofEntry {
        hand_id: game.hand_id,
        status,
        button: game.button,
        hand_mask,
        occupancy_ids,
        transcript_final: game.transcript,
        board: game.board,
        hole: hole_masked,
        deltas,
        rake,
        settled_at: now,
        _pad: [0; 5],
    };
    proof.entries[(proof.head % 16) as usize] = entry;
    proof.head = proof.head.wrapping_add(1);
    secrets.entries[(secrets_head(proof) % 16) as usize] = SecretsEntry {
        salts: salts_masked,
        vrf_out: deck.vrf_out,
        vrf_mask,
        _pad: [0; 7],
    };
    // §8.7：把整手复算所需的输入写进 HandReplay（occupants / salt_digest /
    // attempts / status；draw_digest 在发牌时已逐街写入）。
    finalize_replay(replay, game, deck, salts, status);
}

/// HandSecrets 没有独立 head——与 HandProof.head 同步（拆分记录，见 state.rs）。
/// 注意调用点在 proof.head 自增之后，所以用 head−1。
fn secrets_head(proof: &HandProof) -> u8 {
    proof.head.wrapping_sub(1)
}

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

/// Read hole cards from the PlayerHand accounts (folded seats may be 0xFF 閳?/// core settle skips invalid cards).
pub fn collect_hole(hands: &[&mut PlayerHand; MAX_SEATS], hand_mask: u16) -> [[u8; 2]; MAX_SEATS] {
    let mut hole = [[settle::NO_CARD; 2]; MAX_SEATS];
    for i in 0..MAX_SEATS {
        if hand_mask & seat_bit(i as u8) != 0 {
            hole[i] = hands[i].cards;
        }
    }
    hole
}

/// PHASE_SETTLE transition (鎼?.2, 鎼?.7): core settle, awards/rake to seats,
/// HandEnd event, full ProofEntry, zero secrets, close the hand.
#[inline(never)]
fn do_settle(
    table: &Table,
    game: &mut Game,
    deck: &mut Deck,
    proof: &mut HandProof,
    secrets: &mut HandSecrets,
    replay: &mut HandReplay,
    hands: &mut [&mut PlayerHand; MAX_SEATS],
    now: i64,
) -> Result<()> {
    let hand_mask = game.hand_mask;
    require!(popcount(hand_mask) >= 1, SolpokerError::BadPhase);

    let hole = collect_hole(hands, hand_mask);
    let mut engine = engine_from_game(game, table.sb, table.bb, table.ante);
    let in_hand_before: [u64; MAX_SEATS] = {
        let mut a = [0u64; MAX_SEATS];
        for i in 0..MAX_SEATS {
            a[i] = game.seats[i].in_hand;
        }
        a
    };
    let settlement = settle::settle(
        &mut engine,
        &hole,
        &game.board,
        game.board_len,
        // 2026-10-10（审计 P2-3）：抽水参数改由 Table 上链值传入（此前 core 硬编码
        // 2.5%/3BB，Table 上的 rake_* 字段是死码）。
        solpoker_core::settle::RakeParams {
            bps: table.rake_bps,
            cap_bb: table.rake_cap_bb,
            min_pot_bb: table.rake_min_pot_bb,
        },
        eval::evaluate7,
    );

    // Deltas: refund + award 閳?contribution (鍗?deltas == 閳姰ake by 鎼?.2 conservation).
    let mut deltas = [0i64; MAX_SEATS];
    for i in 0..MAX_SEATS {
        if hand_mask & seat_bit(i as u8) != 0 {
            let net = settlement.refunds[i] + settlement.awards[i];
            deltas[i] = net as i64 - in_hand_before[i] as i64;
        }
    }
    sync_game_from_engine(game, &engine);
    debug_assert_eq!(game.pot, 0, "settle drains the pot");
    game.rake_total = game
        .rake_total
        .checked_add(settlement.rake)
        .ok_or(SolpokerError::Overflow)?;

    // §7：HandEnd 之前先把"最后一条下注街结束"的 transcript 锚点写进 replay
    // （否则以弃牌/河牌结束的手，最后一条街没有 street_end 锚点）
    capture_street_end(replay, game, game.street);
    transcript_append(
        &mut game.transcript,
        &Event::HandEnd {
            result: HandResult::Settled,
            deltas,
            rake: settlement.rake,
        },
    );
    write_proof_entry(
        proof,
        secrets,        replay,
        game,
        deck,
        PROOF_SETTLED,
        &hole,
        &deck.salts,
        deltas,
        settlement.rake,
        now,
    );
    zero_secrets(deck, hands, hand_mask);
    close_hand(game, table);
    Ok(())
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

/// Void the current hand (鎼?.1, 鎼?.5 HandVoid): full refund of in_hand (if
/// any bets were posted), HandVoid event, Void ProofEntry, strikes for
/// offenders, zero secrets, close.
///
/// `offenders_mask`: seats that failed salt verification (MissingSalt only).
#[inline(never)]
fn void_hand_path(
    table: &Table,
    table_bytes: &[u8; 32],
    program_id: &[u8; 32],
    game: &mut Game,
    deck: &mut Deck,
    proof: &mut HandProof,
    secrets: &mut HandSecrets,
    replay: &mut HandReplay,
    hands: &mut [&mut PlayerHand; MAX_SEATS],
    now: i64,
    reason: VoidReason,
    offenders_mask: u16,
) -> Result<()> {
    let hand_mask = game.hand_mask;
    let phase = game.phase;

    // Refund whatever was invested (nothing at AwaitSeed 閳?forced bets are
    // posted only when hole cards are dealt, 鎼?.3).
    if game.pot > 0 {
        let mut engine = engine_from_game(game, table.sb, table.bb, table.ante);
        settle::void_hand(&mut engine);
        sync_game_from_engine(game, &engine);
    }

    // Strikes for offenders (鎼?.3: missing/failed salt counts as a timeout).
    for i in 0..MAX_SEATS {
        if offenders_mask & seat_bit(i as u8) != 0 {
            let s = &mut game.seats[i];
            s.strikes = s.strikes.saturating_add(1);
        }
    }

    // Transcript: if the hand never reached the deal (AwaitSeed), the
    // canonical prefix (HandStart, SaltCommitted asc, optional
    // VrfFulfilled(0)) was never rolled 閳?build it now from public fields
    // (dealing-protocol 鎼?.4: a missing-salt void may carry only this prefix).
    // Otherwise the running transcript continues and HandVoid terminates it.
    if phase == PHASE_AWAIT_SEED && deck.draw_no == 0 {
        let mut st = DealState::new(program_id, table_bytes, game.hand_id);
        let inputs = hand_inputs(program_id, table_bytes, game, &[[0u8; 32]; MAX_SEATS], &[[0u8; 32]; 5]);
        st.append(&Event::HandStart {
            hand_id: game.hand_id,
            button: game.button,
            hand_mask,
            stacks: inputs.stacks,
            occupancy_ids: inputs.occupancy_ids,
        });
        for i in 0..MAX_SEATS {
            if hand_mask & seat_bit(i as u8) != 0 {
                st.append(&Event::SaltCommitted {
                    seat: i as u8,
                    commitment: game.seats[i].salt_commit,
                });
            }
        }
        if deck.vrf_attempt_used[VrfTarget::Preflop.deck_index()] != 0 {
            st.append(&Event::VrfFulfilled {
                target: CoreVrfTarget::Preflop,
                attempt: deck.vrf_attempt_used[VrfTarget::Preflop.deck_index()],
            });
        }
        game.transcript = st.transcript;
    }
    // §7：HandVoid 之前补一次"最后一条下注街结束"的锚点（未发牌的手这里是空转录）
    capture_street_end(replay, game, game.street);
    transcript_append(&mut game.transcript, &Event::HandVoid { reason });

    // Proof salts: whatever verifies against the stored commitments (zero for
    // missing/mismatched 閳?the void itself is the evidence).
    let mut salts = [[0u8; 32]; MAX_SEATS];
    for i in 0..MAX_SEATS {
        if hand_mask & seat_bit(i as u8) != 0
            && verify_seat_salt(table_bytes, game.hand_id, &game.seats[i], hands[i])
        {
            salts[i] = hands[i].salt;
        }
    }
    let hole = collect_hole(hands, hand_mask);
    write_proof_entry(
        proof,
        secrets,        replay,
        game,
        deck,
        PROOF_VOID,
        &hole,
        &salts,
        [0i64; MAX_SEATS],
        0,
        now,
    );
    zero_secrets(deck, hands, hand_mask);
    close_hand(game, table);
    Ok(())
}

// ---------------------------------------------------------------------------
// advance 閳?the deterministic phase machine (鎼?.1/鎼?.2)
// ---------------------------------------------------------------------------

/// Idle 閳?Commit: freeze hand_mask from occupied & Seated & stack > 0 (D7.1
/// requires 2閳?), promote next_salt_commit (鎼?.4 pre-commits), start the
/// commit timer. No-op until at least 2 seats qualify.
#[inline(never)]
fn idle_to_commit(game: &mut Game, table: &Table, now: i64) -> Result<()> {
    let mut mask = 0u16;
    for i in 0..MAX_SEATS {
        let s = &game.seats[i];
        if game.occupied_mask & seat_bit(i as u8) != 0
            && s.status == fund::SEAT_SEATED
            && s.stack > 0
        {
            mask |= seat_bit(i as u8);
        }
    }
    if popcount(mask) < 2 {
        return Ok(());
    }
    game.hand_mask = mask;
    for i in 0..MAX_SEATS {
        let bit = seat_bit(i as u8);
        let s = &mut game.seats[i];
        if mask & bit != 0 {
            if s.salt_commit == [0u8; 32] && s.next_salt_commit != [0u8; 32] {
                s.salt_commit = s.next_salt_commit;
            }
        } else {
            // Defensive: a commitment bound to this hand_id is useless for a
            // seat that is not in the hand.
            s.salt_commit = [0; 32];
        }
        s.next_salt_commit = [0; 32];
    }
    game.phase = PHASE_COMMIT;
    game.phase_deadline = now + table.commit_timeout_s as i64;
    Ok(())
}

/// Commit 閳?AwaitSeed: all hand_mask seats committed 閳?arm VRF Preflop (the
/// request itself is the permissionless request_vrf, V1 閹峰棗鍨?. On
/// commit_timeout_s, strike the missing seats and re-time (鎼?.3 閳?the hand
/// simply does not start; nothing was invested).
///
/// A7 补齐（2026-10-07）：缺承诺的座位 strike 达 max_strikes 时**在此直接
/// 自动离座**（未开始的手牌没有任何投入，释放方式与 close_hand 相同）。此前
/// 该路径只累积 strikes 但永不释放——手牌卡在 Commit 时 close_hand 永远不
/// 执行，桌子会永久卡死（生产上等于「掉线玩家占座不走」）。离座后手牌不足
/// 2 人则整个手牌取消（无投入、无发牌、不写证明条目），回到 Idle 等下一手。
#[inline(never)]
fn commit_to_await_seed(
    game: &mut Game,
    deck: &mut Deck,
    hands: &mut [&mut PlayerHand; MAX_SEATS],
    table: &Table,
    now: i64,
) -> Result<()> {
    let mut missing = 0u16;
    for i in 0..MAX_SEATS {
        if game.hand_mask & seat_bit(i as u8) != 0 && game.seats[i].salt_commit == [0u8; 32] {
            missing |= seat_bit(i as u8);
        }
    }
    if missing == 0 {
        arm_vrf(game, VrfTarget::Preflop)?;
        // The deck must belong to this hand before any callback can land.
        deck.hand_id = game.hand_id;
        game.phase = PHASE_AWAIT_SEED;
        game.phase_deadline = 0;
        return Ok(());
    }
    if now >= game.phase_deadline {
        let mut left_any = false;
        for i in 0..MAX_SEATS {
            let bit = seat_bit(i as u8);
            if missing & bit == 0 {
                continue;
            }
            let do_leave = {
                let s = &mut game.seats[i];
                s.strikes = s.strikes.saturating_add(1);
                if s.strikes >= table.max_strikes {
                    // 手牌未开始：直接记 owed 并释放（与 close_hand 同款）。
                    s.owed_total = s.owed_total.saturating_add(s.stack);
                    s.stack = 0;
                    s.status = fund::SEAT_LEFT;
                    s.leave_requested = 0;
                    s.in_hand = 0;
                    s.street_bet = 0;
                    s.folded = 0;
                    s.all_in = 0;
                    s.acted = 0;
                    s.salt_commit = [0; 32];
                    s.next_salt_commit = [0; 32];
                    s.strikes = 0;
                    true
                } else {
                    false
                }
            };
            if do_leave {
                game.occupied_mask &= !bit;
                game.hand_mask &= !bit;
                left_any = true;
                // 2026-10-10（审计延伸；#22 座位 8 实锤 5244 次 6011）：被踢出
                // 本手的座位必须把手牌账户清零——zero_secrets 只清最终 hand_mask，
                // 漏下的盐会让该席位的 take_seat 永远报 SeatNotClean（钱在 L1
                // 也坐不进来，只能升级程序救）。
                hands[i].cards = [0xFF; 2];
                hands[i].salt = [0u8; 32];
                hands[i].salt_hand_id = 0;
            }
        }
        if left_any {
            // L1 尽快看到 owed_total（与 stand_up 同款）。
            game.hands_since_commit = table.commit_every_n_hands;
        }
        if popcount(game.hand_mask) < 2 {
            // 不足两人：本手不成立（无投入、无发牌，不写证明条目）。
            for i in 0..MAX_SEATS {
                if game.hand_mask & seat_bit(i as u8) != 0 {
                    let s = &mut game.seats[i];
                    s.salt_commit = [0; 32];
                    s.next_salt_commit = [0; 32];
                    // 同上的手牌账户清零（防脏盐卡死 take_seat）。
                    hands[i].cards = [0xFF; 2];
                    hands[i].salt = [0u8; 32];
                    hands[i].salt_hand_id = 0;
                }
            }
            game.hand_mask = 0;
            game.live_mask = 0;
            game.actionable_mask = 0;
            game.pending_to_act_mask = 0;
            game.to_act = u8::MAX;
            game.phase = PHASE_IDLE;
            game.phase_deadline = 0;
            game.action_deadline = 0;
            game.hand_id = game.hand_id.saturating_add(1);
            game.hands_since_commit = game.hands_since_commit.saturating_add(1);
            game.vrf = VrfSlot::default();
        } else {
            game.phase_deadline = now + table.commit_timeout_s as i64;
        }
    }
    Ok(())
}

/// AwaitSeed 閳?Preflop (deal) or Void. 鎼?.2: deal ONLY when VRF_0 arrived AND
/// every hand_mask salt verifies against its commitment.
#[inline(never)]
fn await_seed(
    table: &Table,
    table_bytes: &[u8; 32],
    game: &mut Game,
    deck: &mut Deck,
    proof: &mut HandProof,
    secrets: &mut HandSecrets,
    replay: &mut HandReplay,
    hands: &mut [&mut PlayerHand; MAX_SEATS],
    program_id: &[u8; 32],
    now: i64,
) -> Result<()> {
    match game.vrf.state {
        VrfState::Void => {
            return void_hand_path(
                table,
                table_bytes,
                program_id,
                game,
                deck,
                proof,
                secrets,                replay,
                hands,
                now,
                VoidReason::VrfExhausted,
                0,
            );
        }
        VrfState::Fulfilled => {}
        _ => return Ok(()), // armed/requested; nothing to do yet
    }
    require!(
        game.vrf.target == VrfTarget::Preflop,
        SolpokerError::BadPhase
    );

    // 鎼?.2 step 4: verify every hand_mask salt.
    let hand_mask = game.hand_mask;
    let mut offenders = 0u16;
    let mut salts = [[0u8; 32]; MAX_SEATS];
    for i in 0..MAX_SEATS {
        if hand_mask & seat_bit(i as u8) == 0 {
            continue;
        }
        if verify_seat_salt(table_bytes, game.hand_id, &game.seats[i], hands[i]) {
            salts[i] = hands[i].salt;
        } else {
            offenders |= seat_bit(i as u8);
        }
    }
    if offenders != 0 {
        // 2026-10-10（审计 P1-4）：揭示宽限——VRF 已履行后先等到 phase_deadline
        // （= 履行时刻 + reveal_timeout_s，由 vrf_callback 写入），慢揭示不再
        // 误伤全桌；到期仍缺盐 → 作废 + strike。BadPhase 由 crank 静默重试。
        if now < game.phase_deadline {
            return err!(SolpokerError::BadPhase);
        }
        return void_hand_path(
            table,
            table_bytes,
            program_id,
            game,
            deck,
            proof,
            secrets,            replay,
            hands,
            now,
            VoidReason::MissingSalt,
            offenders,
        );
    }
    deck.salts = salts;

    // 2026-10-09 修补：非本手座位的手内状态必须原样保留 —— 手牌**冻结后中途
    // 入座**的座位不在 hand_mask 里，而 `hand_inputs` 对它们给出 0 筹码，
    // 随后的 sync_game_from_engine 会把它们的 stack 清零 → 破坏 I-ER
    // （6020 Conservation，五 agent 同桌实测暴露；交易整笔回滚，手永远发不出）。
    // 处理：发牌前快照这些座位的手内字段，sync 后原样写回。
    let mut keep: [(u64, u64, u64, u8, u8, u8, u8, u8); MAX_SEATS] = [(0, 0, 0, 0, 0, 0, 0, 0); MAX_SEATS];
    let mut keep_mask = 0u16;
    for i in 0..MAX_SEATS {
        if hand_mask & seat_bit(i as u8) == 0 {
            let s = &game.seats[i];
            keep[i] = (
                s.stack,
                s.in_hand,
                s.street_bet,
                s.folded,
                s.all_in,
                s.acted,
                s.strikes,
                s.leave_requested,
            );
            keep_mask |= seat_bit(i as u8);
        }
    }

    // Button: first dealt hand 閳?deal.first_button (鎼?.3); else clockwise
    // rotation from the previous button over the NEW hand_mask (鎼?.1).
    let inputs = hand_inputs(program_id, table_bytes, game, &salts, &deck.vrf_out);
    let button = if game.button_initialized == 0 {
        deal::first_button(&inputs).ok_or(SolpokerError::BadPhase)?
    } else {
        next_clockwise(game.button, hand_mask).ok_or(SolpokerError::BadPhase)?
    };
    game.button = button;
    game.button_initialized = 1;

    // Forced bets: engine posts them; the event plan mirrors the amounts.
    let stacks = inputs.stacks;
    let preflop_events = forced_bet_events(&stacks, hand_mask, button, table.sb, table.bb, table.ante);
    let engine = Engine::new(
        &stacks,
        game.occupied_mask,
        hand_mask,
        button,
        table.sb,
        table.bb,
        table.ante,
    )
    .map_err(|_| SolpokerError::BadPhase)?;

    // Deal: HandStart 閳?SaltCommitted asc 閳?VrfFulfilled(0) 閳?ForcedBet閳?閳?    // StreetStart(0) 閳?HoleDealt 鑴?n (dealing-protocol 鎼?.4 canonical order).
    let salt_digest = current_salt_digest(table_bytes, game, &salts);
    let seed0 = deal::seed_k(
        &deck.vrf_out[VrfTarget::Preflop.deck_index()],
        &salt_digest,
    );
    let attempt0 = deck.vrf_attempt_used[VrfTarget::Preflop.deck_index()];
    let mut st = DealState::new(program_id, table_bytes, game.hand_id);
    st.append(&Event::HandStart {
        hand_id: game.hand_id,
        button,
        hand_mask,
        stacks,
        occupancy_ids: inputs.occupancy_ids,
    });
    for i in 0..MAX_SEATS {
        if hand_mask & seat_bit(i as u8) != 0 {
            // Canonical event carries the commitment stored at commit_salt
            // time (Game.seats[i].salt_commit) — no recompute needed.
            st.append(&Event::SaltCommitted {
                seat: i as u8,
                commitment: game.seats[i].salt_commit,
            });
        }
    }
    st.append(&Event::VrfFulfilled {
        target: CoreVrfTarget::Preflop,
        attempt: attempt0,
    });
    for ev in &preflop_events {
        st.append(ev);
    }
    st.append(&Event::StreetStart {
        street: deal::STREET_PREFLOP,
    });
    // §8.7：记录本轮（preflop）第一张牌抽取前的 transcript（整手复算输入）
    capture_draw_digest(
        replay,
        game.hand_id,
        VrfTarget::Preflop.deck_index(),
        &st.transcript,
    );
    let order = deal::hole_order(button, hand_mask).ok_or(SolpokerError::BadPhase)?;
    let n = popcount(hand_mask) as usize;
    for k in 0..2 * n {
        let seat = order[k % n];
        let slot = k / n;
        let (card, _dn) = st.draw(&seed0, table_bytes, game.hand_id, |_c, dn| {
            Event::HoleDealt { seat, draw_no: dn }
        });
        let h = &mut hands[seat as usize];
        h.cards[slot] = card;
    }
    for i in 0..MAX_SEATS {
        if hand_mask & seat_bit(i as u8) != 0 {
            hands[i].hand_id = game.hand_id;
        }
    }

    sync_game_from_engine(game, &engine);
    // 恢复非本手座位（冻结后中途入座者）的手内状态：sync 只应影响本手参与者。
    for i in 0..MAX_SEATS {
        if keep_mask & seat_bit(i as u8) != 0 {
            let (stack, in_hand, street_bet, folded, all_in, acted, strikes, leave) = keep[i];
            let s = &mut game.seats[i];
            s.stack = stack;
            s.in_hand = in_hand;
            s.street_bet = street_bet;
            s.folded = folded;
            s.all_in = all_in;
            s.acted = acted;
            s.strikes = strikes;
            s.leave_requested = leave;
        }
    }
    st.store(deck, game);
    game.street = deal::STREET_PREFLOP;
    game.board = [0xFF; 5];
    game.board_len = 0;
    game.board_src = [0; 5];
    game.action_seq = 0;
    reset_vrf(game);

    // Extreme short stacks: the blinds can consume everyone 閳?immediate runout.
    if engine.runout_needed {
        arm_vrf(game, VrfTarget::Runout)?;
        game.phase = PHASE_AWAIT_RUNOUT;
        game.action_deadline = 0;
    } else {
        game.phase = PHASE_PREFLOP;
        game.action_deadline = now + table.action_timeout_s as i64;
    }
    Ok(())
}

/// AwaitStreet: arm the street VRF if not armed yet; on fulfillment, deal the
/// street's board cards (VrfFulfilled(k), StreetStart(k), BoardDealt閳? and
/// reopen betting. VrfExhausted 閳?Void.
#[inline(never)]
fn await_street(
    table: &Table,
    table_bytes: &[u8; 32],
    game: &mut Game,
    deck: &mut Deck,
    proof: &mut HandProof,
    secrets: &mut HandSecrets,
    replay: &mut HandReplay,
    hands: &mut [&mut PlayerHand; MAX_SEATS],
    program_id: &[u8; 32],
    now: i64,
) -> Result<()> {
    let street = game.street;
    let board_street = BoardStreet::from_street_u8(street).ok_or(SolpokerError::BadPhase)?;
    let target = VrfTarget::from_u8(street).ok_or(SolpokerError::BadPhase)?;
    match game.vrf.state {
        VrfState::Idle => return arm_vrf(game, target),
        VrfState::Void => {
            return void_hand_path(
                table,
                table_bytes,
                program_id,
                game,
                deck,
                proof,
                secrets,                replay,
                hands,
                now,
                VoidReason::VrfExhausted,
                0,
            );
        }
        VrfState::Fulfilled => {
            require!(game.vrf.target == target, SolpokerError::BadPhase);
        }
        _ => return Ok(()),
    }

    let k = target.deck_index();
    let salt_digest = current_salt_digest(table_bytes, game, &deck.salts);
    let seed = deal::seed_k(&deck.vrf_out[k], &salt_digest);
    let attempt = deck.vrf_attempt_used[k];
    let mut st = DealState::resume(deck, game);
    // §7：下一条街开始发牌之前，此刻的 transcript 就是"上一条街结束"的锚点。
    // 注意 game.street 在发牌这一刻已经是**新街**（测试钉死：街号在发牌前推进），
    // 所以要减一 —— 否则 0 号街（preflop）永远没有锚点。
    capture_street_end(replay, game, game.street.saturating_sub(1));
    st.append(&Event::VrfFulfilled {
        target: target.to_core(),
        attempt,
    });
    st.append(&Event::StreetStart { street });
    // §8.7：记录本街第一张牌抽取前的 transcript（整手复算输入）
    capture_draw_digest(replay, game.hand_id, k, &st.transcript);
    let count = board_street.card_count();
    for _ in 0..count {
        let (card, _dn) = st.draw(&seed, table_bytes, game.hand_id, |c, dn| {
            Event::BoardDealt {
                street,
                card: c,
                draw_no: dn,
                vrf_src: target.to_core(),
            }
        });
        let pos = game.board_len as usize;
        require!(pos < 5, SolpokerError::BadPhase);
        game.board[pos] = card;
        game.board_src[pos] = street; // normal street: board_src == street (鎼?.3 BoardDealt)
        game.board_len += 1;
    }
    st.store(deck, game);
    reset_vrf(game);
    game.phase = PHASE_BETTING;
    game.action_deadline = now + table.action_timeout_s as i64;
    Ok(())
}

/// AwaitRunout: on fulfillment, deal ALL remaining board cards from the
/// runout seed (RunoutStarted, VrfFulfilled(4), BoardDealt with actual street
/// and vrf_src = 4, StreetSkipped per skipped betting round), then Settle on
/// the next advance.
#[inline(never)]
fn await_runout(
    table: &Table,
    table_bytes: &[u8; 32],
    game: &mut Game,
    deck: &mut Deck,
    proof: &mut HandProof,
    secrets: &mut HandSecrets,
    replay: &mut HandReplay,
    hands: &mut [&mut PlayerHand; MAX_SEATS],
    program_id: &[u8; 32],
    now: i64,
) -> Result<()> {
    match game.vrf.state {
        VrfState::Idle => return arm_vrf(game, VrfTarget::Runout),
        VrfState::Void => {
            return void_hand_path(
                table,
                table_bytes,
                program_id,
                game,
                deck,
                proof,
                secrets,                replay,
                hands,
                now,
                VoidReason::VrfExhausted,
                0,
            );
        }
        VrfState::Fulfilled => {
            require!(
                game.vrf.target == VrfTarget::Runout,
                SolpokerError::BadPhase
            );
        }
        _ => return Ok(()),
    }

    let k = VrfTarget::Runout.deck_index();
    let salt_digest = current_salt_digest(table_bytes, game, &deck.salts);
    let seed = deal::seed_k(&deck.vrf_out[k], &salt_digest);
    let attempt = deck.vrf_attempt_used[k];
    let mut st = DealState::resume(deck, game);
    // §7：runout 开始前，上一条下注街结束（transcript 锚点）
    capture_street_end(replay, game, game.street);
    st.append(&Event::RunoutStarted);
    st.append(&Event::VrfFulfilled {
        target: CoreVrfTarget::Runout,
        attempt,
    });
    let mut dealt_streets = 0u8; // bits 1..3 for streets dealt by this runout
    // §8.7：记录 runout 第一张牌抽取前的 transcript（整手复算输入）
    capture_draw_digest(replay, game.hand_id, k, &st.transcript);
    while game.board_len < 5 {
        // Actual street of the next board position (dealing-protocol 鎼?.4).
        let street = match game.board_len {
            0..=2 => deal::STREET_FLOP,
            3 => deal::STREET_TURN,
            _ => deal::STREET_RIVER,
        };
        let (card, _dn) = st.draw(&seed, table_bytes, game.hand_id, |c, dn| {
            Event::BoardDealt {
                street,
                card: c,
                draw_no: dn,
                vrf_src: CoreVrfTarget::Runout,
            }
        });
        let pos = game.board_len as usize;
        game.board[pos] = card;
        game.board_src[pos] = VrfTarget::Runout.to_core().to_u8();
        game.board_len += 1;
        dealt_streets |= 1u8 << street;
    }
    // StreetSkipped for every betting round the runout replaced (ascending).
    for street in 1..=3u8 {
        if dealt_streets & (1u8 << street) != 0 {
            st.append(&Event::StreetSkipped { street });
        }
    }
    st.store(deck, game);
    reset_vrf(game);
    // flop_dealt is derived (board_len >= 3) 閳?a runout always deals the flop,
    // so rake applies from here on (鎼?.1 note in core engine docs).
    game.phase = PHASE_SETTLE;
    game.action_deadline = 0;
    Ok(())
}

/// The deterministic phase machine. One transition per call; permissionless
/// callers (keepers, clients) chain calls. No-ops return Ok so spam is cheap.
#[inline(never)]
pub fn advance(
    table: &Table,
    table_bytes: &[u8; 32],
    game: &mut Game,
    deck: &mut Deck,
    proof: &mut HandProof,
    secrets: &mut HandSecrets,
    replay: &mut HandReplay,
    hands: &mut [&mut PlayerHand; MAX_SEATS],
    program_id: &[u8; 32],
    now: i64,
) -> Result<()> {
    match game.phase {
        PHASE_IDLE => idle_to_commit(game, table, now),
        PHASE_COMMIT => commit_to_await_seed(game, deck, hands, table, now),
        PHASE_AWAIT_SEED => {
            await_seed(table, table_bytes, game, deck, proof, secrets, replay, hands, program_id, now)
        }
        PHASE_PREFLOP | PHASE_BETTING => close_stalled_betting(table, game, now),
        PHASE_AWAIT_STREET => {
            await_street(table, table_bytes, game, deck, proof, secrets, replay, hands, program_id, now)
        }
        PHASE_AWAIT_RUNOUT => {
            await_runout(table, table_bytes, game, deck, proof, secrets, replay, hands, program_id, now)
        }
        PHASE_SETTLE => do_settle(table, game, deck, proof, secrets, replay, hands, now),
        _ => err!(SolpokerError::BadPhase),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use solpoker_core::deal::{DealSession, Transcript};
    use solpoker_core::engine::{Action as CoreAction, CENT};
    use solpoker_core::vrf::VrfTarget as CoreTarget;

    const NOW: i64 = 1_000_000;
    const SB: u64 = 50 * CENT;
    const BB: u64 = 100 * CENT;
    const ANTE: u64 = 10 * CENT;
    const STACK: u64 = 10_000 * CENT; // 100 BB

    fn prog() -> [u8; 32] {
        crate::ID.to_bytes()
    }

    fn table_bytes() -> [u8; 32] {
        [0x77u8; 32]
    }

    fn sample_table() -> Table {
        Table {
            table_id: 0,
            admin: Pubkey::new_unique(),
            kind: 0,
            max_seats: 9,
            status: 0,
            mint: Pubkey::new_unique(),
            sb: SB,
            bb: BB,
            ante: ANTE,
            min_buy_in_bb: 100,
            max_buy_in_bb: 1000,
            rake_bps: 250,
            rake_cap_bb: 3,
            rake_min_pot_bb: 1,
            action_timeout_s: 30,
            commit_timeout_s: 10,
            reveal_timeout_s: 10,
            vrf_timeout_s: 10,
            vrf_max_attempts: 3,
            max_strikes: 3,
            commit_every_n_hands: 1,
            heartbeat_s: 3600,
            escape_stale_s: 3600,
            rake_swept_total: 0,
            epoch: 0,
            bump: 255,
            vault_auth_bump: 254,
            commit_payer_bump: 253,
        }
    }

    fn sample_game() -> Game {
        Game {
            table: Pubkey::from(table_bytes()),
            hand_id: 0,
            phase: PHASE_IDLE,
            street: 0,
            button: 0,
            button_initialized: 0,
            seats: [crate::state::SeatState::default(); MAX_SEATS],
            occupied_mask: 0,
            hand_mask: 0,
            live_mask: 0,
            actionable_mask: 0,
            pending_to_act_mask: 0,
            pot: 0,
            current_bet: 0,
            last_full_raise: 0,
            to_act: u8::MAX,
            action_deadline: 0,
            phase_deadline: 0,
            action_seq: 0,
            board: [0xFF; 5],
            board_len: 0,
            board_src: [0; 5],
            vrf: VrfSlot::default(),
            transcript: [0; 32],
            rake_total: 0,
            last_commit_at: 0,
            hands_since_commit: 0,
            maintenance_requested: 0,
        }
    }

    fn occupants() -> [Pubkey; MAX_SEATS] {
        let mut o = [Pubkey::default(); MAX_SEATS];
        for (i, slot) in o.iter_mut().enumerate() {
            let mut b = [0u8; 32];
            b[0] = 0x40 + i as u8;
            *slot = Pubkey::from(b);
        }
        o
    }

    /// Seat `mask` seats as Seated with `stack` (credited == stack, so the
    /// genesis conservation check holds).
    fn seat_players(game: &mut Game, mask: u16, stack: u64) {
        let occ = occupants();
        for i in 0..MAX_SEATS {
            if mask & seat_bit(i as u8) == 0 {
                continue;
            }
            game.seats[i] = crate::state::SeatState {
                occupant: occ[i],
                occupancy_id: 1,
                kind: 0,
                status: fund::SEAT_SEATED,
                stack,
                credited_total: stack,
                owed_total: 0,
                in_hand: 0,
                street_bet: 0,
                folded: 0,
                all_in: 0,
                acted: 0,
                strikes: 0,
                leave_requested: 0,
                salt_commit: [0; 32],
                next_salt_commit: [0; 32],
                _pad0: 0,
            };
            game.occupied_mask |= seat_bit(i as u8);
        }
    }

    fn sample_deck() -> Deck {
        Deck {
            hand_id: 0,
            vrf_out: [[0u8; 32]; 5],
            vrf_attempt_used: [0; 5],
            salts: [[0u8; 32]; MAX_SEATS],
            used_mask: 0,
            draw_no: 0,
            _pad: 0,
        }
    }

    fn sample_proof() -> HandProof {
        HandProof {
            head: 0,
            entries: [ProofEntry::default(); 16],
            _pad: [0; 7],
        }
    }

    fn fresh_hand() -> PlayerHand {
        PlayerHand {
            hand_id: 0,
            cards: [0xFF; 2],
            salt: [0u8; 32],
            salt_hand_id: 0,
        }
    }

    struct Hands {
        h: [PlayerHand; MAX_SEATS],
    }

    impl Hands {
        fn new() -> Self {
            Self {
                h: [
                    fresh_hand(),
                    fresh_hand(),
                    fresh_hand(),
                    fresh_hand(),
                    fresh_hand(),
                    fresh_hand(),
                    fresh_hand(),
                    fresh_hand(),
                    fresh_hand(),
                ],
            }
        }
        fn as_mut(&mut self) -> [&mut PlayerHand; MAX_SEATS] {
            let [a, b, c, d, e, f, g, h, i] = &mut self.h;
            [a, b, c, d, e, f, g, h, i]
        }
    }

    fn salt_for(seat: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x60 + seat;
        s
    }

    /// Commit + reveal for a seat (what commit_salt/reveal_salt persist).
    fn commit_and_reveal(game: &mut Game, hands: &mut [&mut PlayerHand; MAX_SEATS], seat: u8) {
        let salt = salt_for(seat);
        let c = deal::salt_commitment(
            &table_bytes(),
            game.hand_id,
            &game.seats[seat as usize].occupant.to_bytes(),
            &salt,
        );
        game.seats[seat as usize].salt_commit = c;
        hands[seat as usize].salt = salt;
        hands[seat as usize].salt_hand_id = game.hand_id;
    }

    /// Simulate a fulfilled VRF request (what vrf_callback persists).
    fn fulfill(game: &mut Game, deck: &mut Deck, target: VrfTarget, randomness: [u8; 32]) {
        assert_eq!(game.vrf.state, VrfState::Ready, "slot must be armed first");
        deck.vrf_out[target.deck_index()] = randomness;
        deck.vrf_attempt_used[target.deck_index()] = 1;
        game.vrf = VrfSlot {
            state: VrfState::Fulfilled,
            target,
            attempt: 1,
            requested_at: NOW,
            _pad: [0; 5],
        };
    }

    fn step(
        table: &Table,
        game: &mut Game,
        deck: &mut Deck,
        proof: &mut HandProof,
        secrets: &mut HandSecrets,
    replay: &mut HandReplay,
        hands: &mut [&mut PlayerHand; MAX_SEATS],
    ) {
        advance(
            table,
            &table_bytes(),
            game,
            deck,
            proof,
            secrets,            replay,
            hands,
            &prog(),
            NOW,
        )
        .unwrap();
        fund::assert_conservation_er(game).unwrap();
    }

    // --- mirror round-trip ---------------------------------------------------

    #[test]
    fn engine_mirror_round_trip() {
        let mut game = sample_game();
        seat_players(&mut game, 0b101, STACK);
        game.hand_mask = 0b101;
        game.phase = PHASE_BETTING;
        game.street = 1;
        game.button = 2;
        game.pot = 500 * CENT;
        game.current_bet = 200 * CENT;
        game.last_full_raise = 200 * CENT;
        game.to_act = 0;
        game.live_mask = 0b101;
        game.actionable_mask = 0b101;
        game.pending_to_act_mask = 0b001;
        game.board_len = 3;
        game.seats[0].street_bet = 200 * CENT;
        game.seats[0].in_hand = 300 * CENT;
        game.seats[0].acted = 1;
        game.seats[0].strikes = 2;
        game.seats[2].in_hand = 200 * CENT;

        let engine = engine_from_game(&game, SB, BB, ANTE);
        assert!(engine.flop_dealt); // derived from board_len >= 3
        assert_eq!(engine.seats[0].strikes, 2);
        assert!(engine.seats[0].in_hand_mask);
        assert!(!engine.seats[1].in_hand_mask);

        let mut back = sample_game();
        seat_players(&mut back, 0b101, STACK);
        back.hand_mask = 0b101;
        back.phase = PHASE_BETTING;
        back.button = 2;
        back.board_len = 3;
        sync_game_from_engine(&mut back, &engine);
        for i in 0..MAX_SEATS {
            assert_eq!(back.seats[i].stack, game.seats[i].stack, "stack {i}");
            assert_eq!(back.seats[i].in_hand, game.seats[i].in_hand, "in_hand {i}");
            assert_eq!(
                back.seats[i].street_bet, game.seats[i].street_bet,
                "street_bet {i}"
            );
            assert_eq!(back.seats[i].strikes, game.seats[i].strikes);
        }
        assert_eq!(back.live_mask, game.live_mask);
        assert_eq!(back.actionable_mask, game.actionable_mask);
        assert_eq!(back.pending_to_act_mask, game.pending_to_act_mask);
        assert_eq!(back.pot, game.pot);
        assert_eq!(back.current_bet, game.current_bet);
        assert_eq!(back.last_full_raise, game.last_full_raise);
        assert_eq!(back.to_act, game.to_act);
        assert_eq!(back.street, game.street);
    }

    // --- transcript / event encoding -----------------------------------------

    #[test]
    fn transcript_append_matches_core_for_every_event() {
        let program = prog();
        let table = table_bytes();
        let events = [
            Event::HandStart {
                hand_id: 7,
                button: 1,
                hand_mask: 0b101,
                stacks: [1, 2, 3, 4, 5, 6, 7, 8, 9],
                occupancy_ids: [9, 8, 7, 6, 5, 4, 3, 2, 1],
            },
            Event::SaltCommitted {
                seat: 2,
                commitment: [0xAB; 32],
            },
            Event::VrfFulfilled {
                target: CoreTarget::Flop,
                attempt: 2,
            },
            Event::ForcedBet {
                seat: 0,
                kind: ForcedBetKind::BigBlind,
                amount: BB,
            },
            Event::StreetStart { street: 0 },
            Event::HoleDealt { seat: 2, draw_no: 3 },
            Event::Action {
                seat: 0,
                kind: solpoker_core::deal::ActionKind::Raise,
                amount: 2 * BB,
            },
            Event::Timeout {
                seat: 2,
                auto_kind: 1,
            },
            Event::BoardDealt {
                street: 1,
                card: 7,
                draw_no: 4,
                vrf_src: CoreTarget::Flop,
            },
            Event::RunoutStarted,
            Event::StreetSkipped { street: 2 },
            Event::HandEnd {
                result: HandResult::Settled,
                deltas: [-5, 0, 5, 0, 0, 0, 0, 0, 0],
                rake: 5,
            },
            Event::HandVoid {
                reason: VoidReason::MissingSalt,
            },
        ];
        let mut core_t = Transcript::new(&program, &table, 7);
        let mut digest = transcript_init(&program, &table, 7);
        assert_eq!(digest, core_t.digest());
        for ev in &events {
            core_t.append(ev);
            transcript_append(&mut digest, ev);
            assert_eq!(digest, core_t.digest(), "transcript diverged at {ev:?}");
        }
    }

    // --- DealState vs DealSession parity (byte-for-byte) ---------------------

    fn parity_inputs(mask: u16) -> HandInputs {
        let occ = occupants();
        let mut occupants_b = [[0u8; 32]; MAX_SEATS];
        let mut salts = [[0u8; 32]; MAX_SEATS];
        let mut stacks = [0u64; MAX_SEATS];
        let mut occupancy_ids = [0u64; MAX_SEATS];
        for i in 0..MAX_SEATS {
            if mask & seat_bit(i as u8) != 0 {
                occupants_b[i] = occ[i].to_bytes();
                salts[i] = salt_for(i as u8);
                stacks[i] = STACK;
                occupancy_ids[i] = 1;
            }
        }
        let mut vrf = [[0u8; 32]; 5];
        for (k, v) in vrf.iter_mut().enumerate() {
            *v = [0x90 + k as u8; 32];
        }
        HandInputs {
            program_id: prog(),
            table: table_bytes(),
            hand_id: 7,
            hand_mask: mask,
            stacks,
            occupancy_ids,
            occupants: occupants_b,
            salts,
            vrf,
        }
    }

    /// Replay one full deal through the persisted DealState driver, mirroring
    /// exactly what await_seed/await_street/await_runout do.
    /// deal_state_full_run 的返回：抽牌序号 / 逐张牌 / 玩家的 draw 记录 / 最终 transcript。
    type FullRun = (Vec<(u8, u8, u8)>, Vec<u8>, Vec<u8>, [u8; 32]);

    fn deal_state_full_run(
        inputs: &HandInputs,
        button: u8,
        preflop_events: &[Event],
    ) -> FullRun {
        let table = inputs.table;
        let hand_id = inputs.hand_id;
        let salt_digest = deal::salt_digest(
            &table,
            hand_id,
            inputs.hand_mask,
            &inputs.occupants,
            &inputs.occupancy_ids,
            &inputs.salts,
        );
        let mut st = DealState::new(&inputs.program_id, &table, hand_id);
        st.append(&Event::HandStart {
            hand_id,
            button,
            hand_mask: inputs.hand_mask,
            stacks: inputs.stacks,
            occupancy_ids: inputs.occupancy_ids,
        });
        for i in 0..MAX_SEATS {
            if inputs.hand_mask & seat_bit(i as u8) != 0 {
                st.append(&Event::SaltCommitted {
                    seat: i as u8,
                    commitment: deal::salt_commitment(
                        &table,
                        hand_id,
                        &inputs.occupants[i],
                        &inputs.salts[i],
                    ),
                });
            }
        }
        // hole
        let seed0 = deal::seed_k(&inputs.vrf[0], &salt_digest);
        st.append(&Event::VrfFulfilled {
            target: CoreTarget::Preflop,
            attempt: 1,
        });
        for ev in preflop_events {
            st.append(ev);
        }
        st.append(&Event::StreetStart { street: 0 });
        let order = deal::hole_order(button, inputs.hand_mask).unwrap();
        let n = popcount(inputs.hand_mask) as usize;
        let mut hole = Vec::new();
        for k in 0..2 * n {
            let seat = order[k % n];
            let (card, _dn) = st.draw(&seed0, &table, hand_id, |_c, dn| Event::HoleDealt {
                seat,
                draw_no: dn,
            });
            hole.push((seat, (k / n) as u8, card));
        }
        // flop
        let seed1 = deal::seed_k(&inputs.vrf[1], &salt_digest);
        st.append(&Event::VrfFulfilled {
            target: CoreTarget::Flop,
            attempt: 1,
        });
        st.append(&Event::StreetStart { street: 1 });
        let mut flop = Vec::new();
        for _ in 0..3 {
            let (card, _dn) = st.draw(&seed1, &table, hand_id, |c, dn| Event::BoardDealt {
                street: 1,
                card: c,
                draw_no: dn,
                vrf_src: CoreTarget::Flop,
            });
            flop.push(card);
        }
        // runout (turn + river)
        let seedr = deal::seed_k(&inputs.vrf[4], &salt_digest);
        st.append(&Event::RunoutStarted);
        st.append(&Event::VrfFulfilled {
            target: CoreTarget::Runout,
            attempt: 1,
        });
        let mut board_len = 3u8;
        let mut runout = Vec::new();
        let mut dealt_streets = 0u8;
        while board_len < 5 {
            let street = match board_len {
                0..=2 => 1,
                3 => 2,
                _ => 3,
            };
            let (card, _dn) = st.draw(&seedr, &table, hand_id, |c, dn| Event::BoardDealt {
                street,
                card: c,
                draw_no: dn,
                vrf_src: CoreTarget::Runout,
            });
            board_len += 1;
            runout.push(card);
            dealt_streets |= 1u8 << street;
        }
        for street in 1..=3u8 {
            if dealt_streets & (1u8 << street) != 0 {
                st.append(&Event::StreetSkipped { street });
            }
        }
        (hole, flop, runout, st.transcript)
    }

    #[test]
    fn deal_state_matches_deal_session_byte_for_byte() {
        let inputs = parity_inputs(0b101);
        let button = deal::first_button(&inputs).unwrap();
        let preflop = forced_bet_events(&inputs.stacks, inputs.hand_mask, button, SB, BB, ANTE);

        let mut sess = DealSession::new(&inputs, button).unwrap();
        let hole_ref = sess.deal_hole(1, &preflop);
        let flop_ref = sess.deal_street(BoardStreet::Flop, 1);
        let runout_ref = sess.deal_runout(1);
        let t_ref = sess.transcript_digest();

        let (hole, flop, runout, t) = deal_state_full_run(&inputs, button, &preflop);
        for (i, rec) in hole_ref.iter().enumerate() {
            assert_eq!(hole[i].0, rec.seat.unwrap(), "hole seat {i}");
            assert_eq!(hole[i].2, rec.card, "hole card {i}");
        }
        assert_eq!(
            flop,
            flop_ref.iter().map(|r| r.card).collect::<Vec<_>>()
        );
        assert_eq!(
            runout,
            runout_ref.iter().map(|r| r.card).collect::<Vec<_>>()
        );
        // StreetSkipped events do not exist in DealSession; compare the
        // transcript up to the runout's last BoardDealt by re-appending them.
        let mut t2 = t_ref;
        for street in [2u8, 3] {
            transcript_append(&mut t2, &Event::StreetSkipped { street });
        }
        assert_eq!(t, t2, "final transcript must match DealSession + skips");
    }

    #[test]
    fn forced_bet_plan_matches_engine_amounts() {
        // short stack on the SB seat: ante first, then partial blind.
        let mask = 0b111;
        let mut stacks = [0u64; MAX_SEATS];
        stacks[0] = STACK;
        stacks[1] = ANTE + SB / 2; // SB seat: ante then half the small blind
        stacks[2] = STACK;
        let events = forced_bet_events(&stacks, mask, 0, SB, BB, ANTE);
        // button 0, 3 players: SB=1, BB=2; antes from seat 1 clockwise: 1,2,0.
        let kinds: Vec<(u8, u8, u64)> = events
            .iter()
            .map(|e| match e {
                Event::ForcedBet { seat, kind, amount } => (*seat, kind.to_u8(), *amount),
                _ => panic!("only forced bets"),
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                (1, 0, ANTE),
                (2, 0, ANTE),
                (0, 0, ANTE),
                (1, 1, SB / 2), // short: only half the SB left
                (2, 2, BB),
            ]
        );
        // The engine must move exactly these amounts.
        let engine = Engine::new(&stacks, mask, mask, 0, SB, BB, ANTE).unwrap();
        assert_eq!(engine.seats[1].in_hand, ANTE + SB / 2);
        assert_eq!(engine.seats[2].in_hand, ANTE + BB);
        assert_eq!(engine.seats[0].in_hand, ANTE);
    }

    // --- scripted 2-player hand, end to end -----------------------------------

    struct World {
        table: Table,
        game: Game,
        deck: Deck,
        proof: HandProof,
        secrets: HandSecrets,
        replay: HandReplay,
        hands: Hands,
    }

    impl World {
        fn heads_up() -> Self {
            let mut game = sample_game();
            seat_players(&mut game, 0b011, STACK);
            Self {
                table: sample_table(),
                game,
                deck: sample_deck(),
                proof: sample_proof(),
                secrets: HandSecrets::default(),
                replay: HandReplay::default(),
                hands: Hands::new(),
            }
        }

        fn step(&mut self) {
            let mut hands = self.hands.as_mut();
            step(
                &self.table,
                &mut self.game,
                &mut self.deck,
                &mut self.proof,
                &mut self.secrets,
                &mut self.replay,
                &mut hands,
            );
        }

        fn fulfill(&mut self, target: VrfTarget, tag: u8) {
            fulfill(&mut self.game, &mut self.deck, target, [tag; 32]);
        }

        /// Freeze + commit + arm + fulfill + reveal + deal (reaches Preflop).
        fn start_hand(&mut self) {
            self.step(); // Idle 鈫?Commit
            assert_eq!(self.game.phase, PHASE_COMMIT);
            assert_eq!(self.game.hand_mask, 0b011);
            {
                let mut hands = self.hands.as_mut();
                for seat in 0..2u8 {
                    commit_and_reveal(&mut self.game, &mut hands, seat);
                }
            }
            self.step(); // Commit 鈫?AwaitSeed (armed)
            assert_eq!(self.game.phase, PHASE_AWAIT_SEED);
            self.fulfill(VrfTarget::Preflop, 0x90);
            self.step(); // AwaitSeed 鈫?Preflop (deal)
            assert_eq!(self.game.phase, PHASE_PREFLOP);
        }

        fn check_or_call(&mut self) {
            let seat = self.game.to_act;
            let owe = self
                .game
                .current_bet
                .saturating_sub(self.game.seats[seat as usize].street_bet);
            let action = if owe == 0 {
                CoreAction::Check
            } else {
                CoreAction::Call
            };
            apply_action(&self.table, &mut self.game, seat, action, NOW).unwrap();
            fund::assert_conservation_er(&self.game).unwrap();
        }

        /// Play the current street with check/call, then advance through the
        /// next street's VRF cycle. Returns false when the hand reached Settle.
        fn play_street(&mut self, street_vrf: VrfTarget, tag: u8) -> bool {
            let seq_before = self.game.action_seq;
            self.check_or_call();
            self.check_or_call();
            if self.game.phase == PHASE_SETTLE {
                return false;
            }
            assert_eq!(self.game.phase, PHASE_AWAIT_STREET);
            assert_eq!(self.game.action_seq, seq_before + 2);
            self.step(); // arm the street VRF
            assert_eq!(self.game.vrf.state, VrfState::Ready);
            self.fulfill(street_vrf, tag);
            self.step(); // deal the street
            assert_eq!(self.game.phase, PHASE_BETTING);
            true
        }
    }

    #[test]
    fn scripted_two_player_hand_settles_end_to_end() {
        let mut w = World::heads_up();
        w.start_hand();
        assert!(w.game.button_initialized != 0);
        let button = w.game.button;
        assert!(button < 2);

        // Hole cards must match the core DealSession exactly, and the
        // transcript after the deal must equal the session's.
        let inputs = {
            let occ = occupants();
            let mut occupants_b = [[0u8; 32]; MAX_SEATS];
            let mut salts = [[0u8; 32]; MAX_SEATS];
            let mut stacks = [0u64; MAX_SEATS];
            let mut occ_ids = [0u64; MAX_SEATS];
            for i in 0..2usize {
                occupants_b[i] = occ[i].to_bytes();
                salts[i] = salt_for(i as u8);
                stacks[i] = STACK;
                occ_ids[i] = 1;
            }
            let mut vrf = [[0u8; 32]; 5];
            vrf[0] = [0x90; 32];
            HandInputs {
                program_id: prog(),
                table: table_bytes(),
                hand_id: 0,
                hand_mask: 0b011,
                stacks,
                occupancy_ids: occ_ids,
                occupants: occupants_b,
                salts,
                vrf,
            }
        };
        let expected_button = deal::first_button(&inputs).unwrap();
        assert_eq!(button, expected_button);
        let preflop = forced_bet_events(&inputs.stacks, 0b011, button, SB, BB, ANTE);
        let mut sess = DealSession::new(&inputs, button).unwrap();
        let hole_ref = sess.deal_hole(1, &preflop);
        assert_eq!(sess.transcript_digest(), w.game.transcript);
        for rec in &hole_ref {
            let seat = rec.seat.unwrap() as usize;
            let slot = if w.hands.h[seat].cards[0] == rec.card {
                0
            } else {
                1
            };
            assert_eq!(w.hands.h[seat].cards[slot], rec.card);
        }
        assert_eq!(w.hands.h[0].hand_id, 0);
        // Forced bets posted: pot = 2 ante + SB + BB; heads-up SB = button.
        assert_eq!(w.game.pot, 2 * ANTE + SB + BB);
        assert_eq!(w.game.to_act, button); // heads-up preflop: button first

        // Play all streets passively down to the river.
        assert!(w.play_street(VrfTarget::Flop, 0x91));
        assert_eq!(w.game.board_len, 3);
        assert_eq!(w.game.street, 1);
        assert!(w.play_street(VrfTarget::Turn, 0x92));
        assert_eq!(w.game.board_len, 4);
        assert!(w.play_street(VrfTarget::River, 0x93));
        assert_eq!(w.game.board_len, 5);
        // River betting: two checks end the hand.
        w.check_or_call();
        w.check_or_call();
        assert_eq!(w.game.phase, PHASE_SETTLE);

        let stacks_before: Vec<u64> = w.game.seats.iter().map(|s| s.stack).collect();
        let in_hand: Vec<u64> = w.game.seats.iter().map(|s| s.in_hand).collect();
        w.step(); // Settle
        assert_eq!(w.game.phase, PHASE_IDLE);
        assert_eq!(w.game.hand_id, 1);
        assert_eq!(w.game.pot, 0);
        assert_eq!(w.game.hand_mask, 0);
        // rake: flop was dealt, pot = 2BB + 2 ante = 220 CENT > 1BB 鈫?        // min(floor_cent(220 * 2.5%), 3BB) = 5 CENT.
        assert_eq!(w.game.rake_total, 5 * CENT);
        // Conservation: stacks moved only via awards/refunds/rake.
        let total_after: u64 = w.game.seats.iter().map(|s| s.stack).sum::<u64>();
        assert_eq!(
            total_after + w.game.rake_total,
            stacks_before.iter().sum::<u64>() + in_hand.iter().sum::<u64>()
        );

        // Proof entry.
        assert_eq!(w.proof.head, 1);
        let e = &w.proof.entries[0];
        assert_eq!(e.hand_id, 0);
        assert_eq!(e.status, PROOF_SETTLED);
        assert_eq!(e.button, button);
        assert_eq!(e.hand_mask, 0b011);
        assert_eq!(e.rake, 5 * CENT);
        let se = &w.secrets.entries[0];
        assert_eq!(se.vrf_mask, 0b1111); // preflop + flop + turn + river
        assert_eq!(se.vrf_out[0], [0x90; 32]);
        assert_eq!(se.vrf_out[3], [0x93; 32]);
        assert_eq!(se.salts[0], salt_for(0));
        assert_eq!(se.salts[1], salt_for(1));
        let delta_sum: i64 = e.deltas.iter().sum();
        assert_eq!(delta_sum, -(5 * CENT as i64));
        for i in 0..2usize {
            assert_eq!(
                e.deltas[i] as i128,
                (w.game.seats[i].stack as i128)
                    - (stacks_before[i] as i128)
                    - (in_hand[i] as i128),
                "delta == final_stack - start_of_hand_stack (seat {i})"
            );
        }

        // Secrets zeroed.
        assert_eq!(w.deck.vrf_out, [[0u8; 32]; 5]);
        assert_eq!(w.deck.salts, [[0u8; 32]; MAX_SEATS]);
        assert_eq!(w.deck.used_mask, 0);
        assert_eq!(w.deck.draw_no, 0);
        for i in 0..2usize {
            assert_eq!(w.hands.h[i].cards, [0xFF; 2]);
            assert_eq!(w.hands.h[i].salt, [0u8; 32]);
            assert_eq!(w.hands.h[i].salt_hand_id, 0);
        }
        // Seat hand state cleared; salt commits cleared; next hand can start.
        for i in 0..2usize {
            let s = &w.game.seats[i];
            assert_eq!(s.in_hand, 0);
            assert_eq!(s.salt_commit, [0u8; 32]);
            assert_eq!(s.status, fund::SEAT_SEATED);
        }
        assert_eq!(w.game.hands_since_commit, 1);
    }

    // --- void paths -------------------------------------------------------------

    #[test]
    fn missing_salt_voids_with_strike_and_no_refund() {
        let mut w = World::heads_up();
        w.step(); // 鈫?Commit
        {
            let mut hands = w.hands.as_mut();
            commit_and_reveal(&mut w.game, &mut hands, 0);
            // seat 1 commits but never reveals
            let c = deal::salt_commitment(
                &table_bytes(),
                w.game.hand_id,
                &w.game.seats[1].occupant.to_bytes(),
                &salt_for(1),
            );
            w.game.seats[1].salt_commit = c;
        }
        w.step(); // 鈫?AwaitSeed
        w.fulfill(VrfTarget::Preflop, 0x90);
        w.step(); // salt check fails for seat 1 鈫?Void
        assert_eq!(w.game.phase, PHASE_IDLE);
        assert_eq!(w.game.hand_id, 1);
        assert_eq!(w.game.pot, 0);
        assert_eq!(w.game.rake_total, 0);
        // No bets were ever posted: stacks untouched.
        assert_eq!(w.game.seats[0].stack, STACK);
        assert_eq!(w.game.seats[1].stack, STACK);
        assert_eq!(w.game.seats[1].strikes, 1); // offender
        assert_eq!(w.game.seats[0].strikes, 0);
        let e = &w.proof.entries[0];
        assert_eq!(e.status, PROOF_VOID);
        assert_eq!(e.deltas, [0i64; MAX_SEATS]);
        let se = &w.secrets.entries[0];
        assert_eq!(se.salts[0], salt_for(0)); // verified salt is published
        assert_eq!(se.salts[1], [0u8; 32]); // offender's stays zero
        assert_eq!(se.vrf_mask, 0b0001);
    }

    #[test]
    fn vrf_exhausted_mid_hand_refunds_everything() {
        let mut w = World::heads_up();
        w.start_hand();
        // Preflop: button raises to 3BB, BB calls 鈫?AwaitStreet.
        let button = w.game.button;
        apply_action(&w.table, &mut w.game, button, CoreAction::RaiseTo(3 * BB), NOW).unwrap();
        let other = 1 - button;
        apply_action(&w.table, &mut w.game, other, CoreAction::Call, NOW).unwrap();
        assert_eq!(w.game.phase, PHASE_AWAIT_STREET);
        let pot_before_void = w.game.pot;
        assert_eq!(pot_before_void, 6 * BB + 2 * ANTE);
        w.step(); // arm Flop
        // VRF retries exhaust 鈫?slot Void.
        w.game.vrf = VrfSlot {
            state: VrfState::Void,
            target: VrfTarget::Flop,
            attempt: 3,
            requested_at: NOW,
            _pad: [0; 5],
        };
        w.step(); // 鈫?Void
        assert_eq!(w.game.phase, PHASE_IDLE);
        assert_eq!(w.game.hand_id, 1);
        assert_eq!(w.game.pot, 0);
        assert_eq!(w.game.rake_total, 0);
        // Full refund: both stacks restored to the buy-in.
        assert_eq!(w.game.seats[0].stack, STACK);
        assert_eq!(w.game.seats[1].stack, STACK);
        assert_eq!(w.game.seats[0].strikes, 0);
        assert_eq!(w.game.seats[1].strikes, 0);
        let e = &w.proof.entries[0];
        assert_eq!(e.status, PROOF_VOID);
        assert_eq!(e.deltas, [0i64; MAX_SEATS]);
        assert_eq!(e.rake, 0);
        // Both salts published (they verified at deal time), cards zeroed.
        let se = &w.secrets.entries[0];
        assert_eq!(se.salts[0], salt_for(0));
        assert_eq!(se.salts[1], salt_for(1));
        assert_eq!(w.hands.h[0].cards, [0xFF; 2]);
        fund::assert_conservation_er(&w.game).unwrap();
    }

    /// §8.7 规范测试（2026-10-08）：只用 HandReplay + HandSecrets + HandProof
    /// 就能把每一张牌重新抽出来 —— 这正是验证器
    /// （web/lib/deal-verify.mjs 的 dealFromReplay）要做的事，两边同构。
    #[test]
    fn replay_entry_rebuilds_every_drawn_card() {
        let mut w = World::heads_up();
        w.start_hand();
        assert!(w.play_street(VrfTarget::Flop, 0x91));
        assert!(w.play_street(VrfTarget::Turn, 0x92));
        assert!(w.play_street(VrfTarget::River, 0x93));
        w.check_or_call();
        w.check_or_call();
        assert_eq!(w.game.phase, PHASE_SETTLE);

        let hand_id = w.game.hand_id;
        let board = w.game.board;
        let hole_cards: [[u8; 2]; MAX_SEATS] =
            core::array::from_fn(|i| w.hands.h[i].cards);
        let button = w.game.button;
        let hand_mask = w.game.hand_mask;
        w.step(); // Settle 鈫?Idle：写 proof / secrets / replay

        // 1) replay 槽位与字段
        let slot = (hand_id % REPLAY_RING as u64) as usize;
        let e = w.replay.entries[slot];
        assert_eq!(e.hand_id, hand_id, "槽位必须属于这一手");
        assert_eq!(e.status, PROOF_SETTLED);
        assert_eq!(e.streets_used, 0b1111, "preflop/flop/turn/river 都应记下首抽摘要");
        // v2：四条街结束时都应有 transcript 锚点（§7 事件流存证）
        assert_eq!(e.layout_ver, 2, "布局版本应为 v2");
        assert_eq!(e.streets_ended, 0b1111, "四条街都应写下结束锚点");
        assert!(e.street_end[3].iter().any(|b| *b != 0), "河牌街锚点不应为空");

        // 2) salt_digest 必须能从（Game 的 occupants —— v2 起不再存进 replay）+
        //    （secrets 的盐）+ occupancy_ids 复算
        let proof_slot = (w.proof.head.wrapping_sub(1) % 16) as usize;
        let pe = w.proof.entries[proof_slot];
        let secrets_slot = (secrets_head(&w.proof) % 16) as usize;
        let sec = w.secrets.entries[secrets_slot];
        let mut occupants = [[0u8; 32]; MAX_SEATS];
        for i in 0..MAX_SEATS {
            occupants[i] = w.game.seats[i].occupant.to_bytes();
        }
        let recomputed = deal::salt_digest(
            &table_bytes(),
            hand_id,
            hand_mask,
            &occupants,
            &pe.occupancy_ids,
            &sec.salts,
        );
        assert_eq!(recomputed, e.salt_digest, "salt_digest 必须可复算");

        // 3) 逐街重放：从 draw_digest[k] 出发重新抽牌，与 proof 的牌逐张比对
        let mut used: u64 = 0;
        let mut draw_no: u16 = 0;

        // --- preflop（2n 张底牌，HoleDealt 事件） ---
        let seed0 = deal::seed_k(&sec.vrf_out[VrfTarget::Preflop.deck_index()], &e.salt_digest);
        let mut st = DealState {
            used_mask: used,
            draw_no,
            transcript: e.draw_digest[VrfTarget::Preflop.deck_index()],
        };
        let order = deal::hole_order(button, hand_mask).unwrap();
        let n = popcount(hand_mask) as usize;
        let mut hole_rebuilt = [[0xFFu8; 2]; MAX_SEATS];
        for k in 0..2 * n {
            let seat = order[k % n];
            let slots = k / n;
            let (card, dn) = st.draw(&seed0, &table_bytes(), hand_id, |_c, dn| {
                Event::HoleDealt { seat, draw_no: dn }
            });
            assert_eq!(card, hole_cards[seat as usize][slots], "底牌第 {k} 张必须一致");
            assert_eq!(dn, draw_no);
            hole_rebuilt[seat as usize][slots] = card;
            draw_no += 1;
        }
        used = st.used_mask;

        // --- 逐街公共牌（BoardDealt 事件；street 与 vrf_src 按程序实际值） ---
        for (target, street, count, tag) in [
            (VrfTarget::Flop, deal::STREET_FLOP, 3usize, 0x91u8),
            (VrfTarget::Turn, deal::STREET_TURN, 1, 0x92),
            (VrfTarget::River, deal::STREET_RIVER, 1, 0x93),
        ] {
            let k = target.deck_index();
            let seed = deal::seed_k(&sec.vrf_out[k], &e.salt_digest);
            let mut st = DealState {
                used_mask: used,
                draw_no,
                transcript: e.draw_digest[k],
            };
            for _ in 0..count {
                let (card, dn) = st.draw(&seed, &table_bytes(), hand_id, |c, dn| {
                    Event::BoardDealt {
                        street,
                        card: c,
                        draw_no: dn,
                        vrf_src: target.to_core(),
                    }
                });
                let pos = (draw_no as usize) - (2 * n);
                assert_eq!(card, board[pos], "公共牌第 {pos} 张必须一致（street {street}）");
                assert_eq!(dn, draw_no);
                let _ = tag;
                draw_no += 1;
            }
            used = st.used_mask;
        }

        assert_eq!(hole_rebuilt[order[0] as usize], hole_cards[order[0] as usize]);
        assert_eq!(draw_no as usize, 2 * n + 5, "共 2n+5 张（不含 runout）");
    }

    /// A7 补齐（2026-10-07）：手牌卡在 Commit（无人提交盐承诺）时，第 3 次
    /// 超时自动离座；不足两人 → 手牌取消回 Idle（无投入、无证明条目）。
    #[test]
    fn commit_timeout_auto_stands_up_after_max_strikes() {
        let mut w = World::heads_up();
        w.step(); // Idle → Commit
        assert_eq!(w.game.phase, PHASE_COMMIT);
        assert_eq!(w.game.hand_mask, 0b011);

        let probe = |w: &mut World, now: i64| {
            let mut hands = w.hands.as_mut();
            advance(
                &w.table,
                &table_bytes(),
                &mut w.game,
                &mut w.deck,
                &mut w.proof,
                &mut w.secrets,
                &mut w.replay,
                &mut hands,
                &prog(),
                now,
            )
            .unwrap();
        };
        let timeout = w.table.commit_timeout_s as i64;

        // 第 1、2 次超时：只累积 strikes，手牌仍等 Commit。
        probe(&mut w, NOW + timeout + 1);
        assert_eq!(w.game.seats[0].strikes, 1);
        assert_eq!(w.game.seats[1].strikes, 1);
        assert_eq!(w.game.phase, PHASE_COMMIT);
        probe(&mut w, NOW + 2 * timeout + 2);
        assert_eq!(w.game.seats[0].strikes, 2);

        // 第 3 次：双双达 max_strikes → 自动离座；不足两人 → 取消本手回 Idle。
        probe(&mut w, NOW + 3 * timeout + 3);
        assert_eq!(w.game.phase, PHASE_IDLE);
        assert_eq!(w.game.hand_mask, 0);
        assert_eq!(w.game.occupied_mask, 0);
        assert_eq!(w.game.hand_id, 1);
        for s in &w.game.seats[..2] {
            assert_eq!(s.status, fund::SEAT_LEFT);
            assert_eq!(s.stack, 0);
            assert_eq!(s.owed_total, STACK); // 全额转 owed，等待 L1 commit 后 cash_out
            assert_eq!(s.strikes, 0);
        }
        // 手牌从未开始：不写证明条目。
        assert_eq!(w.proof.head, 0);
        fund::assert_conservation_er(&w.game).unwrap();
    }

    /// admin_force_stand_up 的释放逻辑（2026-10-07）：筹码全额转 owed、
    /// 状态 Left、字段清空；资金只归原座位的 owed（守恒不变式保持）。
    #[test]
    fn force_release_moves_stack_to_owed() {
        let mut w = World::heads_up();
        let before_owed = w.game.seats[0].owed_total;
        fund::force_release(&mut w.game.seats[0]);
        w.game.occupied_mask &= !1;
        let s = &w.game.seats[0];
        assert_eq!(s.status, fund::SEAT_LEFT);
        assert_eq!(s.stack, 0);
        assert_eq!(s.owed_total, before_owed + STACK);
        assert_eq!(s.strikes, 0);
        assert_eq!(s.salt_commit, [0u8; 32]);
        fund::assert_conservation_er(&w.game).unwrap();
    }

    #[test]
    fn proof_ring_wraps_after_16_entries() {
        let mut w = World::heads_up();
        for hand_no in 0..17u64 {
            assert_eq!(w.game.hand_id, hand_no);
            w.step(); // 鈫?Commit
            // commit-only (no reveal needed for the VrfExhausted void path)
            for seat in 0..2usize {
                w.game.seats[seat].salt_commit = [0xAA; 32];
            }
            w.step(); // 鈫?AwaitSeed
            w.game.vrf = VrfSlot {
                state: VrfState::Void,
                target: VrfTarget::Preflop,
                attempt: 3,
                requested_at: NOW,
                _pad: [0; 5],
            };
            w.step(); // 鈫?Void, proof entry written
            assert_eq!(w.game.phase, PHASE_IDLE);
        }
        assert_eq!(w.proof.head, 17);
        // Ring: index 0 was overwritten by hand 16; index 15 still holds 15.
        assert_eq!(w.proof.entries[0].hand_id, 16);
        assert_eq!(w.proof.entries[0].status, PROOF_VOID);
        assert_eq!(w.proof.entries[15].hand_id, 15);
        assert_eq!(w.proof.entries[1].hand_id, 1);
        assert_eq!(w.game.hand_id, 17);
        fund::assert_conservation_er(&w.game).unwrap();
    }

    // --- stand_up 折叠与下注街自愈（2026-10-08，table #22 死锁回归） ---------

    /// 行动者 stand_up 折叠必须走引擎：pending 清空的同时关街/结束推进，
    /// 不留下「pending=0 且停在下注阶段」的死状态（旧 bug 的修复本体）。
    #[test]
    fn stand_up_fold_on_actor_never_stalls() {
        let mut w = World::heads_up();
        w.start_hand();
        let button = w.game.button;
        apply_stand_up_fold(&w.table, &mut w.game, button, NOW).unwrap();
        fund::assert_conservation_er(&w.game).unwrap();
        assert!(w.game.seats[button as usize].folded != 0);
        // 2 人：fold 后 live 只剩 1 → 手直接进入 Settle（而不是死状态）。
        assert_eq!(w.game.phase, PHASE_SETTLE);
        assert_eq!(w.game.pending_to_act_mask, 0);
        w.step(); // Settle → Idle
        assert_eq!(w.game.phase, PHASE_IDLE);
        assert_eq!(w.game.hand_id, 1);
    }

    /// 非行动者 stand_up 折叠：手牌继续，行动权仍在原行动者，且补规范事件。
    #[test]
    fn stand_up_fold_off_actor_keeps_hand_running() {
        let mut w = World::heads_up();
        w.start_hand();
        let button = w.game.button;
        let other = 1 - button;
        apply_stand_up_fold(&w.table, &mut w.game, other, NOW).unwrap();
        assert!(w.game.seats[other as usize].folded != 0);
        assert_eq!(w.game.phase, PHASE_PREFLOP);
        assert_eq!(w.game.to_act, button);
        assert_eq!(w.game.pending_to_act_mask, seat_bit(button));
        assert_eq!(w.game.action_seq, 1); // 折叠进了行动流
        // button 跟注后 live=1 → 手结束。
        apply_action(&w.table, &mut w.game, button, CoreAction::Call, NOW).unwrap();
        assert_eq!(w.game.phase, PHASE_SETTLE);
        fund::assert_conservation_er(&w.game).unwrap();
    }

    /// 存量死状态（旧 stand_up 直接清 pending 位留下的形态，table #22 实况）
    /// 由 advance 自愈：关街/结算继续走，离座者的筹码经 owed 释放。
    #[test]
    fn advance_heals_legacy_stalled_betting_and_releases_leaver() {
        let mut w = World::heads_up();
        w.start_hand();
        let button = w.game.button;
        let stack_before = w.game.seats[button as usize].stack;
        let in_hand_before = w.game.seats[button as usize].in_hand;
        assert!(in_hand_before > 0); // 强制注已投出（ante+SB）
        // 复刻旧 stand_up 的死状态：不经过引擎，裸标记 folded + 清掩码位。
        w.game.seats[button as usize].folded = 1;
        w.game.seats[button as usize].leave_requested = 1;
        w.game.actionable_mask &= !seat_bit(button);
        w.game.pending_to_act_mask = 0;
        assert_eq!(w.game.phase, PHASE_PREFLOP);

        w.step(); // 自愈：live 只剩 1 → SETTLE（不再是无路可走的死状态）
        assert_eq!(w.game.phase, PHASE_SETTLE);
        assert!(w.game.pot > 0);
        w.step(); // Settle：写证明 + 释放离座者
        assert_eq!(w.game.phase, PHASE_IDLE);
        let s = &w.game.seats[button as usize];
        assert_eq!(s.status, fund::SEAT_LEFT);
        assert_eq!(s.stack, 0);
        // 弃牌者拿回未投入的剩余 stack；已投入的（ante+SB）留在池里归赢家。
        assert_eq!(s.owed_total, stack_before);
        assert_eq!(w.game.occupied_mask & seat_bit(button), 0);
        assert_eq!(w.proof.entries[0].status, PROOF_SETTLED);
        fund::assert_conservation_er(&w.game).unwrap();
    }

    /// 2026-10-09 回归（五 agent 同桌的 6020）：手牌**冻结后中途入座**的座位
    /// （有筹码、不在 hand_mask）在发牌时不得被 sync 清零——发牌只应影响本手
    /// 参与者，非参与者的 stack/手内字段原样保留、守恒保持。
    #[test]
    fn preflop_deal_preserves_side_seat_and_conservation() {
        let mut w = World::heads_up();
        w.step(); // Idle → Commit（冻结 mask = 0b011）
        assert_eq!(w.game.hand_mask, 0b011);
        // 中途入座：座 2 在冻结之后坐下（有筹码，不在本手）。
        seat_players(&mut w.game, 0b100, STACK);
        assert_eq!(w.game.occupied_mask, 0b111);
        {
            let mut hands = w.hands.as_mut();
            commit_and_reveal(&mut w.game, &mut hands, 0);
            commit_and_reveal(&mut w.game, &mut hands, 1);
        }
        w.step(); // → AwaitSeed
        w.fulfill(VrfTarget::Preflop, 0x90);
        let stack2 = w.game.seats[2].stack;
        let credited2 = w.game.seats[2].credited_total;
        w.step(); // 发牌（修复前：sync 清零座 2 筹码 → I-ER 破 → 6020）
        assert_eq!(w.game.phase, PHASE_PREFLOP);
        assert_eq!(w.game.seats[2].stack, stack2, "非本手座位的筹码不得被发牌清零");
        assert_eq!(w.game.seats[2].credited_total, credited2);
        assert_eq!(w.game.seats[2].in_hand, 0);
        assert_eq!(w.game.occupied_mask, 0b111);
        fund::assert_conservation_er(&w.game).unwrap();
    }
}


