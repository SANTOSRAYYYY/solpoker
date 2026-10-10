//! Fund-flow shared logic (design §5): constants, pure seat-ledger transitions
//! used by both the L1 and ER instructions, the §5.3 Game-snapshot reader, and
//! the conservation invariant checks (I-ER / I-X). Everything here is pure
//! (no CPI, no Clock) so the unit-testable core of Phase 2 lives in this file
//! under `#[cfg(test)]`.
//!
//! Counter discipline (§5.1): each side only ever increases its own counters
//! and reads the other side's snapshot; transfer amounts always equal the
//! difference of the two sides. A staler snapshot only means a smaller
//! difference — money arrives later, never twice.

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::state::{AgentProfile, Game, SeatLedger, SeatState, AGENT_ACTIVE, MAX_SEATS};

/// 0.01 USDC at 6 decimals: sit_down / top_up granularity (§5.2.1, §5.2.3).
pub const CENT: u64 = 10_000;
/// D2: a session key lives at most 7 days from now.
pub const MAX_SESSION_TTL_S: i64 = 7 * 24 * 60 * 60;

// Table.status
pub const TABLE_ACTIVE: u8 = 0;
// Table.kind（三类桌，配套文档一 §2.2）：0=真人桌 1=AI 桌 2=混合桌
pub const TABLE_KIND_HUMAN_ONLY: u8 = 0;
pub const TABLE_KIND_AGENT_ONLY: u8 = 1;
pub const TABLE_KIND_MIXED: u8 = 2;
// SeatState.status
pub const SEAT_EMPTY: u8 = 0;
pub const SEAT_SEATED: u8 = 1;
pub const SEAT_LEFT: u8 = 2;
// SeatLedger.kind
pub const KIND_HUMAN: u8 = 0;
pub const KIND_AGENT: u8 = 1;
// Game.phase
pub const PHASE_IDLE: u8 = 0;

// ---------------------------------------------------------------------------
// Pure math (unit-tested)
// ---------------------------------------------------------------------------

/// Buy-in bounds in base units: [min_buy_in_bb × bb, max_buy_in_bb × bb].
pub fn buy_in_bounds(bb: u64, min_bb: u16, max_bb: u16) -> Result<(u64, u64)> {
    let min = bb.checked_mul(min_bb as u64).ok_or(SolpokerError::Overflow)?;
    let max = bb.checked_mul(max_bb as u64).ok_or(SolpokerError::Overflow)?;
    Ok((min, max))
}

/// §5.2.1: within bounds and a multiple of CENT.
pub fn is_valid_buy_in(amount: u64, min: u64, max: u64) -> bool {
    amount >= min && amount <= max && amount % CENT == 0
}

/// §5.2.2 take_seat: the seat's chips equal everything deposited on L1 that
/// has not been credited yet. Callers guarantee `ledger.occupancy_id >
/// seat.occupancy_id`, status Empty/Left, and `ledger.deposited_total >=
/// seat.credited_total` (I-B).
pub fn take_seat_transition(seat: &mut SeatState, ledger: &SeatLedger) {
    seat.stack = ledger.deposited_total - seat.credited_total;
    seat.credited_total = ledger.deposited_total;
    seat.status = SEAT_SEATED;
    seat.occupant = ledger.occupant;
    seat.kind = ledger.kind;
    seat.occupancy_id = ledger.occupancy_id;
    // Fresh-seat hygiene: no in-hand residue, no salt commits, no strikes.
    seat.in_hand = 0;
    seat.street_bet = 0;
    seat.folded = 0;
    seat.all_in = 0;
    seat.acted = 0;
    seat.strikes = 0;
    seat.leave_requested = 0;
    seat.salt_commit = [0; 32];
    seat.next_salt_commit = [0; 32];
}

/// §5.2.4 apply_deposits: `diff = clone.deposited − credited`,
/// `room = max_buy_in − stack`, `credit = min(diff, room)`; `stack += credit`,
/// `credited += diff`, `owed += diff − credit`. For a Left seat the room is
/// zero, so late top-ups go straight to owed and are returned by the next
/// cash_out (§5.2.6). A clone staler than credited is a no-op (never
/// double-credits — counters are monotone).
pub fn apply_deposits_transition(seat: &mut SeatState, deposited: u64, max_stack: u64) {
    if deposited <= seat.credited_total {
        return;
    }
    let diff = deposited - seat.credited_total;
    let room = if seat.status == SEAT_LEFT {
        0
    } else {
        max_stack.saturating_sub(seat.stack)
    };
    let credit = diff.min(room);
    seat.stack += credit;
    seat.credited_total = deposited; // == credited + diff
    seat.owed_total += diff - credit;
}

/// §5.2.5 stand_up at a hand boundary: uncredited deposits go straight to
/// owed (credited catches up to the observed deposited), then
/// `owed += stack`, `stack = 0`, status Left, salt commits cleared.
/// `deposited.max(credited)` keeps credited monotone even against a
/// pathologically stale clone.
pub fn stand_up_release(seat: &mut SeatState, deposited: u64) {
    let uncredited = deposited.saturating_sub(seat.credited_total);
    seat.owed_total += seat.stack + uncredited;
    seat.credited_total = deposited.max(seat.credited_total);
    seat.stack = 0;
    seat.status = SEAT_LEFT;
    seat.in_hand = 0;
    seat.street_bet = 0;
    seat.all_in = 0;
    seat.acted = 0;
    seat.leave_requested = 0;
    seat.salt_commit = [0; 32];
    seat.next_salt_commit = [0; 32];
}

/// 管理员清座（admin_force_stand_up，2026-10-07）：弃置座位（密钥丢失等）
/// 的运营侧回收。**资金纪律：筹码全额转入该座位自己的 `owed_total`——只有
/// 占用者固定的 payout 地址能通过 cash_out 领取，管理员/金库一分钱也碰不到。**
/// `credited_total` 不动（未计入的补码留给后续 apply_deposits 归入 owed，
/// §5.1 单调性——与 close_hand 的自动离座同款）；strikes 清零。
pub fn force_release(seat: &mut SeatState) {
    seat.owed_total = seat.owed_total.saturating_add(seat.stack);
    seat.stack = 0;
    seat.status = SEAT_LEFT;
    seat.leave_requested = 0;
    seat.in_hand = 0;
    seat.street_bet = 0;
    seat.folded = 0;
    seat.all_in = 0;
    seat.acted = 0;
    seat.salt_commit = [0; 32];
    seat.next_salt_commit = [0; 32];
    seat.strikes = 0;
}

// ---------------------------------------------------------------------------
// Agent 身份校验（Stage 8，配套文档一 §2.2/§2.3；纯函数可单测）
// ---------------------------------------------------------------------------

/// 入座身份校验。`agent = Some(profile)` 按 agent 入席（须 Active）；
/// `None` 按真人。`ledgers` 为该桌全部 9 个座位的 L1 账本。
///
/// 规则（§2.2 三类桌 + §2.3 同主人）：
/// - 真人桌（0）只许真人；AI 桌（1）只许 agent；混合桌（2）两者皆可；
/// - 所有桌：同一 occupant 不得已在该桌其他座位；
/// - AI/混合桌：新 agent 的 owner 不得等于任一已坐 agent 的 owner；
/// - 混合桌：新 agent 的 owner 不得等于任一已坐真人的 occupant；
/// - 混合桌：新真人的 occupant 不得等于任一已坐 agent 的 owner。
pub fn check_sit_identity(
    table_kind: u8,
    caller: &Pubkey,
    agent: Option<&AgentProfile>,
    ledgers: &[SeatLedger],
) -> Result<()> {
    let agent_owner = match agent {
        Some(p) => {
            require!(p.status == AGENT_ACTIVE, SolpokerError::AgentNotActive);
            require_keys_eq!(p.agent, *caller, SolpokerError::AgentProfileMismatch);
            Some(p.owner)
        }
        None => None,
    };
    match table_kind {
        TABLE_KIND_HUMAN_ONLY => require!(agent_owner.is_none(), SolpokerError::KindNotAllowed),
        TABLE_KIND_AGENT_ONLY => require!(agent_owner.is_some(), SolpokerError::KindNotAllowed),
        TABLE_KIND_MIXED => {}
        _ => return err!(SolpokerError::KindNotAllowed),
    }

    for l in ledgers.iter() {
        if l.occupant == Pubkey::default() {
            continue;
        }
        // 所有桌：同一 occupant 不得已在该桌其他座位。
        require_keys_neq!(l.occupant, *caller, SolpokerError::AlreadySeated);
        match (agent_owner, l.kind) {
            (Some(owner), KIND_AGENT) => {
                // AI/混合桌：主人不得与任一已坐 agent 的主人相同。
                require_keys_neq!(owner, l.agent_owner, SolpokerError::SameOwner);
            }
            (Some(owner), KIND_HUMAN) => {
                require!(table_kind == TABLE_KIND_MIXED, SolpokerError::KindNotAllowed);
                // 混合桌：agent 的主人不得是任一已坐真人。
                require_keys_neq!(owner, l.occupant, SolpokerError::SameOwner);
            }
            (None, KIND_AGENT) => {
                require!(table_kind == TABLE_KIND_MIXED, SolpokerError::KindNotAllowed);
                // 混合桌：真人不得是任一已坐 agent 的主人。
                require_keys_neq!(*caller, l.agent_owner, SolpokerError::SameOwner);
            }
            (None, _) => {}
            // 防御：账本 kind 非法值（正常写入恒为 Human/Agent）。
            (Some(_), _) => return err!(SolpokerError::KindNotAllowed),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Snapshot readers (§5.3)
// ---------------------------------------------------------------------------

/// Owner check shared by both snapshot kinds: the account is either delegated
/// (owner = delegation program DELeGG…) or not (owner = this program).
fn check_snapshot_owner(owner: &Pubkey) -> Result<()> {
    require!(
        owner == &crate::ID || owner == &ephemeral_rollups_sdk::consts::DELEGATION_PROGRAM_ID,
        SolpokerError::BadSnapshot
    );
    Ok(())
}

/// §5.3 steps 3–4: length + discriminator check + zero-copy read of raw Game
/// account data. Game is a Pod account: the layout is the 8-byte Anchor
/// discriminator followed by the `repr(C)` bytes, so the snapshot is a single
/// bounds-checked copy (`pod_read_unaligned` — alignment of the host-side
/// borrow is not guaranteed, and the copy is one memcpy, not a recursive
/// borsh walk). Pure — separated from the AccountInfo plumbing so the
/// offset/length/discriminator checks are unit-testable.
pub fn deserialize_game_snapshot(data: &[u8]) -> Result<Game> {
    const SIZE: usize = std::mem::size_of::<Game>();
    require!(data.len() >= 8 + SIZE, SolpokerError::BadSnapshot);
    require!(
        &data[..8] == Game::DISCRIMINATOR,
        SolpokerError::BadSnapshot
    );
    Ok(bytemuck::pod_read_unaligned(&data[8..8 + SIZE]))
}

/// §5.3 Game snapshot on L1 (or anywhere a delegated Game is passed raw).
/// Step 1 (address == PDA(["game", table])) is enforced by the context's
/// seeds constraint; this does steps 2–4.
///
/// Returns a zero-copy borrow of the on-account Pod layout (discriminator ‖
/// repr(C) bytes), NOT an owned copy — a `Game` is 1544 bytes and copying it
/// onto the stack is exactly what blew the SBF frame budget in the L1 fund
/// handlers. The 8-byte alignment required by `bytemuck::from_bytes` is the
/// same invariant `AccountLoader::load` relies on for on-chain account data.
///
/// NOTE: while delegated, the account data is the LAST COMMIT's snapshot.
/// A cash_out before the first commit after a stand_up may see a stale
/// snapshot and pay less than the final owed; the remainder is paid by a
/// later cash_out after the next commit. Safe because every counter is
/// monotone (§5.1).
pub fn read_game_snapshot<'a, 'info>(
    game_ai: &'a AccountInfo<'info>,
) -> Result<std::cell::Ref<'a, Game>> {
    check_snapshot_owner(game_ai.owner)?;
    const SIZE: usize = std::mem::size_of::<Game>();
    let data = game_ai.try_borrow_data()?;
    require!(data.len() >= 8 + SIZE, SolpokerError::BadSnapshot);
    require!(
        &data[..8] == Game::DISCRIMINATOR,
        SolpokerError::BadSnapshot
    );
    Ok(std::cell::Ref::map(data, |d| {
        bytemuck::from_bytes::<Game>(&d[8..8 + SIZE])
    }))
}

/// L1 只读 SeatLedger（audit_table）：owner == 本程序 + discriminator + 长度
/// + borsh（L1 账本永不委托，所以不接受 DLP owner——与 ER 克隆读取不同）。
/// 2026-10-10（审计 P1-3）：**必须绑定本桌**——此前不校验 `ledger.table`，
/// 传入别桌账本即可让 §2.2/§2.3 身份扫描全看到无害占用者（同主人同桌、
/// 一钱包多座对刷由此可绕）。
#[inline(never)]
pub fn read_seat_ledger_l1(ai: &AccountInfo, table_key: &Pubkey) -> Result<SeatLedger> {
    require!(ai.owner == &crate::ID, SolpokerError::BadSnapshot);
    let data = ai.try_borrow_data()?;
    require!(
        data.len() >= 8 + SeatLedger::INIT_SPACE,
        SolpokerError::BadSnapshot
    );
    let mut slice: &[u8] = &data;
    let ledger =
        SeatLedger::try_deserialize(&mut slice).map_err(|_| SolpokerError::BadSnapshot)?;
    require!(ledger.table == *table_key, SolpokerError::SeatMismatch);
    Ok(ledger)
}

/// ER-side read of the SeatLedger clone (D1: the ledger itself is L1-only and
/// never delegated; the ER sees a read-only clone). Address is pinned by the
/// context seeds constraint; here we check owner, discriminator, length, and
/// that the embedded table/idx fields match what the caller asked for.
pub fn read_seat_ledger_clone(
    ai: &AccountInfo,
    table_key: &Pubkey,
    idx: u8,
) -> Result<SeatLedger> {
    check_snapshot_owner(ai.owner)?;
    let data = ai.try_borrow_data()?;
    require!(
        data.len() >= 8 + SeatLedger::INIT_SPACE,
        SolpokerError::BadSnapshot
    );
    let mut slice: &[u8] = &data;
    let ledger =
        SeatLedger::try_deserialize(&mut slice).map_err(|_| SolpokerError::BadSnapshot)?;
    require!(
        ledger.table == *table_key && ledger.idx == idx,
        SolpokerError::SeatMismatch
    );
    Ok(ledger)
}

// ---------------------------------------------------------------------------
// Conservation invariants (§5.4)
// ---------------------------------------------------------------------------

/// I-ER: Σ credited_total == Σ stack + pot + rake_total + Σ owed_total.
/// Asserted at the end of every ER fund instruction. Uses u128 accumulators
/// so the check itself cannot overflow.
pub fn assert_conservation_er(game: &Game) -> Result<()> {
    let mut credited: u128 = 0;
    let mut rhs: u128 = (game.pot as u128) + (game.rake_total as u128);
    for s in game.seats.iter() {
        credited += s.credited_total as u128;
        rhs += (s.stack as u128) + (s.owed_total as u128);
    }
    require!(credited == rhs, SolpokerError::Conservation);
    Ok(())
}

/// I-X required backing (§5.4): the vault must hold at least
/// Σ(deposited − credited_快照) + Σ stack_快照 + (rake_快照 − rake_swept)
/// + Σ(owed_快照 − paid).
///
/// `deposited`/`paid` are the LIVE L1 SeatLedger counters; `credited`/`stack`/
/// `owed`/`rake` come from the Game snapshot. Any counter pair that violates
/// the snapshot ordering (credited_快照 > deposited, owed_快照 < paid,
/// rake_快照 < rake_swept) is itself a conservation break and errors.
pub fn required_vault_backing(
    ledgers: &[&SeatLedger],
    snap: &Game,
    rake_swept: u64,
) -> Result<u128> {
    require!(ledgers.len() == MAX_SEATS, SolpokerError::SeatMismatch);
    required_vault_backing_iter(
        ledgers.iter().map(|l| (l.deposited_total, l.paid_total)),
        snap,
        rake_swept,
    )
}

/// 与 [`required_vault_backing`] 同一个公式，但计数器由调用方逐座提供
/// （顺序 = 座位 0..8）。存在的理由：把 9 份 `SeatLedger`（203B each）作为
/// 局部变量声明会顶穿 SBF 的 4096 字节栈上限，**把栈上的指令入参尾部冲掉**
/// ——2026-10-08 `refund_x402_deposit` 实测：RefundRecord.sig 的后 24 字节
/// 变成别处数据（PDA 推导只用前 32+32 字节，所以仍然通过校验，极隐蔽）。
/// 审计/退款路径务必用本函数 + [`read_seat_counters`]。
pub fn required_vault_backing_iter<I>(
    counters: I,
    snap: &Game,
    rake_swept: u64,
) -> Result<u128>
where
    I: IntoIterator<Item = (u64, u64)>,
{
    require!(snap.rake_total >= rake_swept, SolpokerError::Conservation);
    let mut req: u128 = (snap.rake_total - rake_swept) as u128;
    let mut n = 0usize;
    for (deposited, paid) in counters {
        require!(n < MAX_SEATS, SolpokerError::SeatMismatch);
        let s = &snap.seats[n];
        require!(deposited >= s.credited_total, SolpokerError::Conservation);
        require!(s.owed_total >= paid, SolpokerError::Conservation);
        req += (deposited - s.credited_total) as u128;
        req += s.stack as u128;
        req += (s.owed_total - paid) as u128;
        n += 1;
    }
    require!(n == MAX_SEATS, SolpokerError::SeatMismatch);
    Ok(req)
}

/// 零拷贝读取 L1 SeatLedger 的 (deposited_total, paid_total)（只借字节，不把
/// 203B 的结构体搬上栈 —— 见 [`required_vault_backing_iter`] 的理由）。
/// 字段偏移由 `seat_ledger_counter_offsets_match_borsh` 单测钉死。
///
/// 2026-10-10（审计 P0-2）：**必须绑定本桌本座**（`table_key` + 位置 `idx`）。
/// 此前只查 owner/discriminator，调用方可传任意桌的账本压低 I-X 下限 ——
/// refund 由此可把待结资金退到任意地址、audit 失真。
#[inline(never)]
pub fn read_seat_counters(ai: &AccountInfo, table_key: &Pubkey, idx: u8) -> Result<(u64, u64)> {
    require!(ai.owner == &crate::ID, SolpokerError::BadSnapshot);
    let data = ai.try_borrow_data()?;
    require!(
        data.len() >= 8 + SeatLedger::INIT_SPACE,
        SolpokerError::BadSnapshot
    );
    require!(&data[..8] == SeatLedger::DISCRIMINATOR, SolpokerError::BadSnapshot);
    require!(
        &data[SEAT_TABLE_OFF..SEAT_TABLE_OFF + 32] == table_key.as_ref(),
        SolpokerError::SeatMismatch
    );
    require!(data[SEAT_IDX_OFF] == idx, SolpokerError::SeatMismatch);
    let mut dep = [0u8; 8];
    dep.copy_from_slice(&data[SEAT_DEPOSITED_OFF..SEAT_DEPOSITED_OFF + 8]);
    let mut paid = [0u8; 8];
    paid.copy_from_slice(&data[SEAT_PAID_OFF..SEAT_PAID_OFF + 8]);
    Ok((u64::from_le_bytes(dep), u64::from_le_bytes(paid)))
}

/// SeatLedger 在**账户数据**里的字段偏移（含 8 字节 discriminator）。
/// 由单测与 borsh 序列化结果比对钉死（改结构体会立刻测挂）。
pub const SEAT_DEPOSITED_OFF: usize = 186;
pub const SEAT_PAID_OFF: usize = 194;
/// ER 克隆读取用的占用者偏移（同样由单测钉死）。
pub const SEAT_OCCUPANT_OFF: usize = 41;
/// occupancy_id 偏移。
pub const SEAT_OCCUPANCY_ID_OFF: usize = 73;
/// 账本所属桌的偏移（审计 P0-2 的绑定校验用；同样由单测钉死）。
pub const SEAT_TABLE_OFF: usize = 8;
/// 座位号的偏移（同上）。
pub const SEAT_IDX_OFF: usize = 40;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{VrfSlot, AGENT_BANNED, AGENT_PAUSED, AGENT_REVOKED};

    const BB: u64 = 100_000; // 0.10 USDC big blind
    const MIN_BB: u16 = 100;
    const MAX_BB: u16 = 1000;
    const MAX_STACK: u64 = BB * MAX_BB as u64; // 100_000_000

    fn sample_game() -> Game {
        Game {
            table: Pubkey::default(),
            hand_id: 0,
            phase: PHASE_IDLE,
            street: 0,
            button: 0,
            button_initialized: 0,
            seats: [SeatState::default(); MAX_SEATS],
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

    fn sample_ledger(idx: u8) -> SeatLedger {
        SeatLedger {
            table: Pubkey::default(),
            idx,
            occupant: Pubkey::new_unique(),
            occupancy_id: 1,
            kind: KIND_HUMAN,
            agent_owner: Pubkey::default(),
            session_key: Pubkey::new_unique(),
            session_expires_at: 1_000_000,
            payout: Pubkey::new_unique(),
            deposited_total: 0,
            paid_total: 0,
            bump: 255,
        }
    }

    // --- Stage 8 §2.2/§2.3：入座身份校验 -------------------------------------

    fn profile(agent: Pubkey, owner: Pubkey, status: u8) -> AgentProfile {
        AgentProfile {
            agent,
            owner,
            payout_kind: 0,
            status,
            name: [0u8; 32],
            meta_uri: [0u8; 96],
            registered_at: 0,
            bump: 255,
        }
    }

    fn led(occupant: Pubkey, kind: u8, agent_owner: Pubkey) -> SeatLedger {
        SeatLedger {
            occupant,
            kind,
            agent_owner,
            ..sample_ledger(0)
        }
    }

    #[test]
    fn sit_identity_table_kinds() {
        let human = Pubkey::new_unique();
        let agent_kp = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let p = profile(agent_kp, owner, AGENT_ACTIVE);
        let empty: Vec<SeatLedger> = vec![];

        // 真人桌（0）：真人可坐、agent 拒绝
        assert!(check_sit_identity(TABLE_KIND_HUMAN_ONLY, &human, None, &empty).is_ok());
        assert!(check_sit_identity(TABLE_KIND_HUMAN_ONLY, &agent_kp, Some(&p), &empty).is_err());
        // AI 桌（1）：agent 可坐、真人拒绝
        assert!(check_sit_identity(TABLE_KIND_AGENT_ONLY, &agent_kp, Some(&p), &empty).is_ok());
        assert!(check_sit_identity(TABLE_KIND_AGENT_ONLY, &human, None, &empty).is_err());
        // 混合桌（2）：两者皆可
        assert!(check_sit_identity(TABLE_KIND_MIXED, &agent_kp, Some(&p), &empty).is_ok());
        assert!(check_sit_identity(TABLE_KIND_MIXED, &human, None, &empty).is_ok());
    }

    #[test]
    fn sit_identity_same_owner_rules() {
        let owner = Pubkey::new_unique();
        let other_owner = Pubkey::new_unique();
        let agent_kp = Pubkey::new_unique();
        let p = profile(agent_kp, owner, AGENT_ACTIVE);

        // 已坐 agent（owner 相同）→ 新 agent 被拒（AI 桌与混合桌都适用）
        let seated = vec![led(Pubkey::new_unique(), KIND_AGENT, owner)];
        assert!(check_sit_identity(TABLE_KIND_AGENT_ONLY, &agent_kp, Some(&p), &seated).is_err());
        assert!(check_sit_identity(TABLE_KIND_MIXED, &agent_kp, Some(&p), &seated).is_err());
        // owner 不同 → 通过
        let seated2 = vec![led(Pubkey::new_unique(), KIND_AGENT, other_owner)];
        assert!(check_sit_identity(TABLE_KIND_AGENT_ONLY, &agent_kp, Some(&p), &seated2).is_ok());

        // 混合桌：新 agent 的 owner == 已坐真人 → 拒绝
        let human_seated = vec![led(owner, KIND_HUMAN, Pubkey::default())];
        assert!(check_sit_identity(TABLE_KIND_MIXED, &agent_kp, Some(&p), &human_seated).is_err());

        // 混合桌：新真人的 occupant == 已坐 agent 的 owner → 拒绝
        // （seated 里的 agent 主人正是 owner）
        assert!(check_sit_identity(TABLE_KIND_MIXED, &owner, None, &seated).is_err());
        // 无关真人 → 通过
        assert!(check_sit_identity(TABLE_KIND_MIXED, &Pubkey::new_unique(), None, &seated2).is_ok());
    }

    #[test]
    fn sit_identity_rejects_inactive_and_duplicate() {
        let owner = Pubkey::new_unique();
        let agent_kp = Pubkey::new_unique();
        // 非 Active（暂停/封禁/注销）一律拒绝
        for st in [AGENT_PAUSED, AGENT_REVOKED, AGENT_BANNED] {
            let p = profile(agent_kp, owner, st);
            assert!(
                check_sit_identity(TABLE_KIND_AGENT_ONLY, &agent_kp, Some(&p), &[]).is_err(),
                "status {st} 必须拒绝"
            );
        }
        // 同一 occupant 已在该桌其他座位 → 拒绝（任何桌型）
        let p = profile(agent_kp, owner, AGENT_ACTIVE);
        let dup = vec![led(agent_kp, KIND_AGENT, owner)];
        assert!(check_sit_identity(TABLE_KIND_AGENT_ONLY, &agent_kp, Some(&p), &dup).is_err());
        let dup_human = vec![led(agent_kp, KIND_HUMAN, Pubkey::default())];
        assert!(check_sit_identity(TABLE_KIND_MIXED, &agent_kp, None, &dup_human).is_err());
        // profile 与签名者不匹配 → 拒绝
        let p2 = profile(Pubkey::new_unique(), owner, AGENT_ACTIVE);
        assert!(check_sit_identity(TABLE_KIND_AGENT_ONLY, &agent_kp, Some(&p2), &[]).is_err());
    }

    // --- buy-in bounds & CENT multiples (§5.2.1 / §5.2.3) ---

    #[test]
    fn buy_in_bounds_math() {
        let (min, max) = buy_in_bounds(BB, MIN_BB, MAX_BB).unwrap();
        assert_eq!(min, 10_000_000);
        assert_eq!(max, 100_000_000);
        // overflow is reported, not wrapped
        assert!(buy_in_bounds(u64::MAX, 2, 3).is_err());
    }

    #[test]
    fn buy_in_validation() {
        let (min, max) = buy_in_bounds(BB, MIN_BB, MAX_BB).unwrap();
        assert!(is_valid_buy_in(min, min, max)); // exact min
        assert!(is_valid_buy_in(max, min, max)); // exact max
        assert!(!is_valid_buy_in(min - CENT, min, max)); // below min
        assert!(!is_valid_buy_in(max + CENT, min, max)); // above max
        assert!(!is_valid_buy_in(min + 1, min, max)); // not a CENT multiple
        assert!(!is_valid_buy_in(0, min, max));
    }

    // --- apply_deposits min(diff, room) math (§5.2.4) ---

    #[test]
    fn apply_deposits_partial_room() {
        let mut seat = SeatState {
            status: SEAT_SEATED,
            stack: 500_000,
            credited_total: 500_000,
            ..SeatState::default()
        };
        // diff = 1_000_000, room = MAX_STACK − 500_000 ⇒ credit = room-side only
        apply_deposits_transition(&mut seat, 1_500_000, 1_000_000);
        assert_eq!(seat.stack, 1_000_000); // filled to the cap
        assert_eq!(seat.credited_total, 1_500_000); // credited catches ALL of diff
        assert_eq!(seat.owed_total, 500_000); // excess refunded via cash_out
    }

    #[test]
    fn apply_deposits_full_room_and_stale_clone() {
        let mut seat = SeatState {
            status: SEAT_SEATED,
            stack: 10_000,
            credited_total: 10_000,
            ..SeatState::default()
        };
        apply_deposits_transition(&mut seat, 60_000, MAX_STACK);
        assert_eq!(seat.stack, 60_000);
        assert_eq!(seat.credited_total, 60_000);
        assert_eq!(seat.owed_total, 0);
        // stale clone (deposited < credited): strict no-op, nothing double-credits
        apply_deposits_transition(&mut seat, 20_000, MAX_STACK);
        assert_eq!(seat.stack, 60_000);
        assert_eq!(seat.credited_total, 60_000);
    }

    #[test]
    fn apply_deposits_left_seat_goes_straight_to_owed() {
        let mut seat = SeatState {
            status: SEAT_LEFT,
            credited_total: 100_000,
            ..SeatState::default()
        };
        apply_deposits_transition(&mut seat, 130_000, MAX_STACK);
        assert_eq!(seat.stack, 0);
        assert_eq!(seat.credited_total, 130_000);
        assert_eq!(seat.owed_total, 30_000);
    }

    // --- take_seat / stand_up transitions + I-ER across a full lifecycle ---

    #[test]
    fn er_lifecycle_preserves_conservation() {
        let mut game = sample_game();
        assert_conservation_er(&game).unwrap(); // genesis: 0 == 0

        // sit_down 500_000 happened on L1; take_seat credits it on ER.
        let mut ledger = sample_ledger(0);
        ledger.deposited_total = 500_000;
        take_seat_transition(&mut game.seats[0], &ledger);
        assert_eq!(game.seats[0].stack, 500_000);
        assert_eq!(game.seats[0].status, SEAT_SEATED);
        assert_eq!(game.seats[0].occupancy_id, 1);
        assert_conservation_er(&game).unwrap();

        // top_up 1_000_000 on L1; apply_deposits caps the stack, rest to owed.
        ledger.deposited_total = 1_500_000;
        apply_deposits_transition(&mut game.seats[0], ledger.deposited_total, 1_000_000);
        assert_conservation_er(&game).unwrap();

        // stand_up at a hand boundary releases stack + nothing uncredited.
        stand_up_release(&mut game.seats[0], ledger.deposited_total);
        assert_eq!(game.seats[0].stack, 0);
        assert_eq!(game.seats[0].status, SEAT_LEFT);
        assert_eq!(game.seats[0].owed_total, 1_500_000);
        assert_eq!(game.seats[0].salt_commit, [0; 32]);
        assert_conservation_er(&game).unwrap();

        // next occupant (same SeatLedger: occupancy 2, new buy-in 200_000).
        ledger.occupancy_id = 2;
        ledger.deposited_total = 1_700_000;
        take_seat_transition(&mut game.seats[0], &ledger);
        assert_eq!(game.seats[0].stack, 200_000); // only the NEW money
        assert_eq!(game.seats[0].owed_total, 1_500_000); // old owed untouched
        assert_conservation_er(&game).unwrap();
    }

    #[test]
    fn stand_up_release_credits_uncredited_deposits() {
        let mut seat = SeatState {
            status: SEAT_SEATED,
            stack: 400_000,
            credited_total: 400_000,
            ..SeatState::default()
        };
        // a top_up of 50_000 landed on L1 but was never applied on ER
        stand_up_release(&mut seat, 450_000);
        assert_eq!(seat.stack, 0);
        assert_eq!(seat.credited_total, 450_000);
        assert_eq!(seat.owed_total, 450_000);
    }

    #[test]
    fn conservation_check_catches_imbalance() {
        let mut game = sample_game();
        game.seats[0].credited_total = 100;
        // stack/pot/rake/owed all zero ⇒ RHS short by 100
        assert!(assert_conservation_er(&game).is_err());
        game.seats[0].stack = 100;
        assert!(assert_conservation_er(&game).is_ok());
    }

    // --- Game snapshot read: offsets / discriminator / length (§5.3) ---

    /// Build the on-account byte layout for a Game snapshot: 8-byte Anchor
    /// discriminator ‖ repr(C) Pod bytes (zero-copy layout).
    fn game_account_bytes(g: &Game) -> Vec<u8> {
        let mut buf = Vec::with_capacity(8 + std::mem::size_of::<Game>());
        buf.extend_from_slice(Game::DISCRIMINATOR);
        buf.extend_from_slice(bytemuck::bytes_of(g));
        buf
    }

    #[test]
    fn game_snapshot_roundtrip() {
        let mut g = sample_game();
        g.rake_total = 123_456;
        g.seats[3].credited_total = 7;
        g.seats[3].stack = 7;
        g.seats[8].owed_total = 42;
        let buf = game_account_bytes(&g);
        assert_eq!(buf.len(), 8 + std::mem::size_of::<Game>()); // fixed-size layout
        let back = deserialize_game_snapshot(&buf).unwrap();
        assert_eq!(back.rake_total, 123_456);
        assert_eq!(back.seats[3].credited_total, 7);
        assert_eq!(back.seats[8].owed_total, 42);
    }

    #[test]
    fn game_snapshot_rejects_bad_discriminator_and_length() {
        let g = sample_game();
        let buf = game_account_bytes(&g);
        // corrupted discriminator
        let mut bad = buf.clone();
        bad[0] ^= 0xFF;
        assert!(deserialize_game_snapshot(&bad).is_err());
        // truncated below 8 + size_of::<Game>()
        assert!(deserialize_game_snapshot(&buf[..8]).is_err());
        assert!(deserialize_game_snapshot(&buf[..buf.len() - 1]).is_err());
        // empty
        assert!(deserialize_game_snapshot(&[]).is_err());
    }

    // --- I-X required backing ---

    #[test]
    fn required_backing_arithmetic() {
        let snap = {
            let mut g = sample_game();
            g.rake_total = 300;
            g.seats[0].credited_total = 1_000;
            g.seats[0].stack = 900;
            g.seats[0].owed_total = 100;
            g.seats[1].credited_total = 500;
            g.seats[1].stack = 500;
            g
        };
        let mut l0 = sample_ledger(0);
        l0.deposited_total = 1_200; // 200 not yet credited (fresh top_up)
        l0.paid_total = 40; // part of owed already paid
        let l1 = {
            let mut l = sample_ledger(1);
            l.deposited_total = 500;
            l
        };
        let l2 = sample_ledger(2);
        let l3 = sample_ledger(3);
        let l4 = sample_ledger(4);
        let l5 = sample_ledger(5);
        let l6 = sample_ledger(6);
        let l7 = sample_ledger(7);
        let l8 = sample_ledger(8);
        let ledgers: [&SeatLedger; MAX_SEATS] = [&l0, &l1, &l2, &l3, &l4, &l5, &l6, &l7, &l8];
        // 200 uncredited + (900+500) stack + (300−250) rake + (100−40) owed
        let req = required_vault_backing(&ledgers, &snap, 250).unwrap();
        assert_eq!(req, 200 + 1400 + 50 + 60);
    }

    #[test]
    fn required_backing_rejects_counter_inversions() {
        let snap = {
            let mut g = sample_game();
            g.seats[0].credited_total = 1_000;
            g
        };
        let l0 = sample_ledger(0); // deposited 0 < credited 1000 ⇒ violation
        let l1 = sample_ledger(1);
        let l2 = sample_ledger(2);
        let l3 = sample_ledger(3);
        let l4 = sample_ledger(4);
        let l5 = sample_ledger(5);
        let l6 = sample_ledger(6);
        let l7 = sample_ledger(7);
        let l8 = sample_ledger(8);
        let ledgers: [&SeatLedger; MAX_SEATS] = [&l0, &l1, &l2, &l3, &l4, &l5, &l6, &l7, &l8];
        assert!(required_vault_backing(&ledgers, &snap, 0).is_err());
        // rake_swept ahead of the snapshot is also a violation
        let snap2 = sample_game();
        assert!(required_vault_backing(&ledgers, &snap2, 1).is_err());
    }

    /// 硬编码的账户字段偏移必须与 borsh 布局一致：
    /// read_seat_counters / ER 克隆读取都靠这些常量（栈溢出修复引入），
    /// 改动 SeatLedger 字段顺序必须让本测试失败。
    #[test]
    fn seat_ledger_counter_offsets_match_borsh() {
        let mut l = sample_ledger(0);
        l.deposited_total = 0x1122_3344_5566_7788;
        l.paid_total = 0x99AA_BBCC_DDEE_FF00;
        let mut buf = Vec::new();
        l.serialize(&mut buf).unwrap();
        // Anchor 账户 = discriminator(8) + borsh
        let mut acct = Vec::new();
        acct.extend_from_slice(SeatLedger::DISCRIMINATOR);
        acct.extend_from_slice(&buf);
        assert_eq!(acct.len(), 8 + SeatLedger::INIT_SPACE);
        let read_u64 = |off: usize| {
            let mut b = [0u8; 8];
            b.copy_from_slice(&acct[off..off + 8]);
            u64::from_le_bytes(b)
        };
        assert_eq!(read_u64(SEAT_DEPOSITED_OFF), l.deposited_total);
        assert_eq!(read_u64(SEAT_PAID_OFF), l.paid_total);
        assert_eq!(&acct[SEAT_OCCUPANT_OFF..SEAT_OCCUPANT_OFF + 32], l.occupant.as_ref());
        assert_eq!(read_u64(SEAT_OCCUPANCY_ID_OFF), l.occupancy_id);
        // read_seat_counters 与切片版一致（同一公式、同一偏移）
        assert_eq!(read_seat_counters_from_data(&acct).unwrap(), (l.deposited_total, l.paid_total));
    }

    /// 审计 P0-2 回归：账本读取必须绑定本桌本座（refund/audit 的 I-X 下限
    /// 依赖这一点；此前可传别桌账本把下限压低、把待结资金退给任意地址）。
    #[test]
    fn read_seat_counters_binds_table_and_idx() {
        let mut l = sample_ledger(3);
        l.table = Pubkey::new_unique();
        l.deposited_total = 777;
        l.paid_total = 55;
        let mut buf = Vec::new();
        l.serialize(&mut buf).unwrap();
        let mut data = Vec::new();
        data.extend_from_slice(SeatLedger::DISCRIMINATOR);
        data.extend_from_slice(&buf);
        let key = Pubkey::new_unique();
        let owner = crate::ID;
        let mut lamports = 1u64;
        let ai = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
        // 正确绑定：可读。
        assert_eq!(read_seat_counters(&ai, &l.table, 3).unwrap(), (777, 55));
        // 错桌 / 错座位：拒绝。
        assert!(read_seat_counters(&ai, &Pubkey::new_unique(), 3).is_err());
        assert!(read_seat_counters(&ai, &l.table, 4).is_err());
    }

    /// 迭代版与切片版必须给出完全相同的要求（单一公式的保障）。
    #[test]
    fn required_backing_iter_equals_slice_version() {
        let mut ledgers = Vec::new();
        for i in 0..MAX_SEATS as u8 {
            let mut l = sample_ledger(i);
            l.deposited_total = 1_000_000 + i as u64 * 1_111;
            l.paid_total = i as u64 * 101;
            ledgers.push(l);
        }
        let refs: Vec<&SeatLedger> = ledgers.iter().collect();
        let mut snap = sample_game();
        for (i, s) in snap.seats.iter_mut().enumerate() {
            s.credited_total = (i as u64) * 500;
            // owed 必须 ≥ paid（I-X 的前提），所以 owed 取 paid 的两倍量级
            s.owed_total = (i as u64) * 200 + 10;
            s.stack = 1_000 + i as u64 * 7;
        }
        snap.rake_total = 5_000;
        let a = required_vault_backing(&refs, &snap, 1_000).unwrap();
        let b = required_vault_backing_iter(
            ledgers.iter().map(|l| (l.deposited_total, l.paid_total)),
            &snap,
            1_000,
        )
        .unwrap();
        assert_eq!(a, b);
    }

    /// 与 [`read_seat_counters`] 相同的解析逻辑，作用于内存字节（单元测试用）。
    fn read_seat_counters_from_data(data: &[u8]) -> Result<(u64, u64)> {
        require!(
            data.len() >= 8 + SeatLedger::INIT_SPACE,
            SolpokerError::BadSnapshot
        );
        require!(&data[..8] == SeatLedger::DISCRIMINATOR, SolpokerError::BadSnapshot);
        let mut dep = [0u8; 8];
        dep.copy_from_slice(&data[SEAT_DEPOSITED_OFF..SEAT_DEPOSITED_OFF + 8]);
        let mut paid = [0u8; 8];
        paid.copy_from_slice(&data[SEAT_PAID_OFF..SEAT_PAID_OFF + 8]);
        Ok((u64::from_le_bytes(dep), u64::from_le_bytes(paid)))
    }
}
