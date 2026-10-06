//! Stage 4 发牌协议：字节级规范实现（主设计文档 §8「发牌协议」的定稿版）。
//!
//! 本模块把设计级的 §8.2–8.6 落成固定字节格式：所有整数一律**大端**，
//! `‖` 表示字节拼接，字符串常量按 UTF-8 编码、不带结尾 0。
//!
//! 流水线（`DealSession` 的事件追加顺序，与 Python 参考实现
//! `reference/solpoker_deal.py`、测试向量 `vectors/v1/*.json` 三方逐字节一致）：
//!
//! 1. [`Transcript::new`]：`transcript_0 = sha256("solpoker/transcript/v1" ‖ program_id ‖ table ‖ hand_id)`；
//! 2. [`DealSession::new`]：追加 `HandStart`，再按座位升序为每个 set bit 追加 `SaltCommitted`
//!    （承诺值由揭示的盐现算：`sha256("solpoker/salt/v1" ‖ table ‖ hand_id ‖ player ‖ salt)`）；
//! 3. [`DealSession::deal_hole`]：追加 `VrfFulfilled(Preflop, attempt)`，
//!    然后按序追加翻前事件（`ForcedBet`×m 等，作为参数传入），再追加 `StreetStart(0)`，
//!    最后按「button 左侧第一位起顺时针、每人一张、两轮」抽 2n 张底牌，
//!    每张抽完立即追加 `HoleDealt(seat, draw_no)`（不含牌面）；
//! 4. [`DealSession::deal_street`]：追加 `VrfFulfilled(target, attempt)` 与 `StreetStart(street)`，
//!    再抽翻牌 3 张 / 转牌 1 张 / 河牌 1 张，每张追加 `BoardDealt(street, card, draw_no, vrf_src)`；
//! 5. [`DealSession::deal_runout`]：追加 `RunoutStarted` 与 `VrfFulfilled(Runout, attempt)`，
//!    用 `seed_runout` 补齐剩余公共牌；`BoardDealt.street` 记**实际街序**
//!    （board 第 1–3 张记 1=flop、第 4 张记 2=turn、第 5 张记 3=river），`vrf_src` 记 4=Runout，
//!    `draw_no` 连续编号。
//!
//! 链上游戏流（强制下注、玩家动作、超时、结算）在上述步骤之间通过
//! [`DealSession::append_event`] 注入 `ForcedBet` / `Action` / `Timeout` / `HandEnd` 等事件，
//! 同一 `Transcript` 持续滚动——每张牌的 `transcript_digest` 都是追加该牌事件**之前**的值。
//!
//! 抽牌（§8.4）：`msg = "solpoker-v1" ‖ table ‖ hand_id ‖ draw_no(u16) ‖ retry(u16) ‖ transcript_digest(32)`，
//! `v = BE_u64(HMAC-SHA256(key=seed_k, msg)[0..8])`；若 `v < 2^64 mod n` 则 `retry += 1` 重算
//! （拒绝采样消除取模偏差），否则 `index = v mod n`，从升序牌堆 `deck` 中取出第 `index` 张并删除。
//! `2^64 mod n` 按 `((1u128 << 64) % n as u128) as u64` 计算。

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::seats::{next_clockwise, nth_set_bit, popcount, seat_bit, MAX_SEATS};
use crate::vrf::VrfTarget;

/// HMAC-SHA256 的便捷别名（hmac 0.12 + sha2 0.10）。
type HmacSha256 = Hmac<Sha256>;

/// 标准牌堆大小（52 张）。
pub const DECK_SIZE: usize = 52;

/// `BoardDealt.street` / `StreetStart.street` 的 street 编码。
pub const STREET_PREFLOP: u8 = 0;
pub const STREET_FLOP: u8 = 1;
pub const STREET_TURN: u8 = 2;
pub const STREET_RIVER: u8 = 3;

// ---------------------------------------------------------------------------
// 牌面
// ---------------------------------------------------------------------------

/// 牌编号：`rank * 4 + suit`；rank 2..A = 0..12，suit ♣♦♥♠ = 0..3。
///
/// 越界返回 `None`（rank > 12 或 suit > 3）。
pub fn card_id(rank: u8, suit: u8) -> Option<u8> {
    if rank > 12 || suit > 3 {
        return None;
    }
    Some(rank * 4 + suit)
}

/// 牌编号 → rank（0..12 对应 2..A）。
pub fn card_rank(card: u8) -> u8 {
    card / 4
}

/// 牌编号 → suit（0..3 对应 ♣♦♥♠）。
pub fn card_suit(card: u8) -> u8 {
    card % 4
}

// ---------------------------------------------------------------------------
// 哈希原语
// ---------------------------------------------------------------------------

fn sha256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hmac_sha256_parts(key: &[u8; 32], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC-SHA256 接受任意长度密钥");
    for p in parts {
        mac.update(p);
    }
    mac.finalize().into_bytes().into()
}

// ---------------------------------------------------------------------------
// §8.2 盐承诺 / §8.3 盐聚合与逐街种子 / 第一手庄位
// ---------------------------------------------------------------------------

/// 盐承诺（§8.2）：
/// `C_i = sha256("solpoker/salt/v1" ‖ table ‖ hand_id ‖ player ‖ salt)`。
pub fn salt_commitment(
    table: &[u8; 32],
    hand_id: u64,
    player: &[u8; 32],
    salt: &[u8; 32],
) -> [u8; 32] {
    sha256_parts(&[
        b"solpoker/salt/v1",
        table,
        &hand_id.to_be_bytes(),
        player,
        salt,
    ])
}

/// 盐聚合摘要（§8.3）：
/// `sha256("solpoker/salts/v1" ‖ table ‖ hand_id ‖ hand_mask(u16) ‖ 按座位升序的每个 set bit:
/// seat(u8) ‖ occupancy_id(u64) ‖ occupant(32) ‖ salt(32))`。
///
/// 只聚合 `hand_mask` 内的座位，未入手的座位（`occupants` / `salts` / `occupancy_ids`
/// 对应下标的值）不影响结果。盐只按物理座位升序聚合，与到达顺序无关。
pub fn salt_digest(
    table: &[u8; 32],
    hand_id: u64,
    hand_mask: u16,
    occupants: &[[u8; 32]; MAX_SEATS as usize],
    occupancy_ids: &[u64; MAX_SEATS as usize],
    salts: &[[u8; 32]; MAX_SEATS as usize],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"solpoker/salts/v1");
    h.update(table);
    h.update(hand_id.to_be_bytes());
    h.update(hand_mask.to_be_bytes());
    for seat in 0..MAX_SEATS {
        if hand_mask & seat_bit(seat) != 0 {
            h.update([seat]);
            h.update(occupancy_ids[seat as usize].to_be_bytes());
            h.update(occupants[seat as usize]);
            h.update(salts[seat as usize]);
        }
    }
    h.finalize().into()
}

/// 逐街种子（§8.3）：`seed_k = sha256("solpoker/seed/v1" ‖ VRF_k ‖ salt_digest)`。
///
/// `k` 用 [`VrfTarget::to_u8`] 索引（Preflop=0 … Runout=4）。
pub fn seed_k(vrf_k: &[u8; 32], salt_digest: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"solpoker/seed/v1", vrf_k, salt_digest])
}

/// 第一手庄位的原始抽取值（§8.3）：
/// `BE_u64(HMAC-SHA256(key=seed_0, "solpoker-v1/button" ‖ table ‖ hand_id)[0..8])`。
pub fn button_pick_value(seed_0: &[u8; 32], table: &[u8; 32], hand_id: u64) -> u64 {
    let mac = hmac_sha256_parts(
        seed_0,
        &[b"solpoker-v1/button", table, &hand_id.to_be_bytes()],
    );
    u64::from_be_bytes(mac[0..8].try_into().expect("HMAC 输出至少 8 字节"))
}

/// 第一手庄位：`button_pick_value mod popcount(hand_mask)` 选中第 N 个 set bit（0 起，升序）。
///
/// 仅用于该桌第一次成功发底牌的手；之后庄位用 [`next_clockwise`] 顺时针轮转。
/// `hand_mask` 为空时返回 `None`。
pub fn button_pick(
    seed_0: &[u8; 32],
    table: &[u8; 32],
    hand_id: u64,
    hand_mask: u16,
) -> Option<u8> {
    let pc = popcount(hand_mask);
    if pc == 0 {
        return None;
    }
    let pick = (button_pick_value(seed_0, table, hand_id) % pc as u64) as u8;
    nth_set_bit(hand_mask, pick)
}

// ---------------------------------------------------------------------------
// §8.5 事件流与规范编码
// ---------------------------------------------------------------------------

/// 强制下注类型（`ForcedBet.kind`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForcedBetKind {
    Ante,
    SmallBlind,
    BigBlind,
}

impl ForcedBetKind {
    pub const fn to_u8(self) -> u8 {
        match self {
            ForcedBetKind::Ante => 0,
            ForcedBetKind::SmallBlind => 1,
            ForcedBetKind::BigBlind => 2,
        }
    }
}

/// 玩家动作类型（`Action.kind`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionKind {
    Fold,
    Check,
    Call,
    Bet,
    Raise,
    AllIn,
}

impl ActionKind {
    pub const fn to_u8(self) -> u8 {
        match self {
            ActionKind::Fold => 0,
            ActionKind::Check => 1,
            ActionKind::Call => 2,
            ActionKind::Bet => 3,
            ActionKind::Raise => 4,
            ActionKind::AllIn => 5,
        }
    }
}

/// 结算结果类型（`HandEnd.result`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandResult {
    /// 正常结算。
    Settled,
    /// 本手作废（全额退款）。
    Void,
}

impl HandResult {
    pub const fn to_u8(self) -> u8 {
        match self {
            HandResult::Settled => 0,
            HandResult::Void => 1,
        }
    }
}

/// 作废原因（`HandVoid.reason`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoidReason {
    /// 有参与者未揭示/校验通过盐。
    MissingSalt,
    /// VRF 重试用尽。
    VrfExhausted,
}

impl VoidReason {
    pub const fn to_u8(self) -> u8 {
        match self {
            VoidReason::MissingSalt => 0,
            VoidReason::VrfExhausted => 1,
        }
    }
}

/// 公共牌街（`deal_street` 的目标街）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoardStreet {
    Flop,
    Turn,
    River,
}

impl BoardStreet {
    /// `StreetStart` / `BoardDealt` 里的 street 编码（1/2/3）。
    pub const fn street_u8(self) -> u8 {
        match self {
            BoardStreet::Flop => STREET_FLOP,
            BoardStreet::Turn => STREET_TURN,
            BoardStreet::River => STREET_RIVER,
        }
    }

    /// street 编码（1..3）→ [`BoardStreet`]；其他值返回 `None`。
    pub const fn from_street_u8(street: u8) -> Option<Self> {
        match street {
            STREET_FLOP => Some(BoardStreet::Flop),
            STREET_TURN => Some(BoardStreet::Turn),
            STREET_RIVER => Some(BoardStreet::River),
            _ => None,
        }
    }

    /// 本街使用的 VRF 目标（决定用哪一颗 seed）。
    pub const fn vrf_target(self) -> VrfTarget {
        match self {
            BoardStreet::Flop => VrfTarget::Flop,
            BoardStreet::Turn => VrfTarget::Turn,
            BoardStreet::River => VrfTarget::River,
        }
    }

    /// 本街发牌张数（翻牌 3、转牌 1、河牌 1）。
    pub const fn card_count(self) -> u8 {
        match self {
            BoardStreet::Flop => 3,
            BoardStreet::Turn | BoardStreet::River => 1,
        }
    }
}

/// §8.5 的事件类型（tag 见各变体注释）；`encode` 输出 `tag(u8) ‖ 固定宽度大端字段`。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// 0x01：hand_id(u64), button(u8), hand_mask(u16), stack\[9\](u64×9), occupancy_id\[9\](u64×9)。
    HandStart {
        hand_id: u64,
        button: u8,
        hand_mask: u16,
        stacks: [u64; MAX_SEATS as usize],
        occupancy_ids: [u64; MAX_SEATS as usize],
    },
    /// 0x02：seat(u8), C_i(32)。
    SaltCommitted { seat: u8, commitment: [u8; 32] },
    /// 0x03：target(u8), attempt(u8)（不含随机数本身）。
    VrfFulfilled { target: VrfTarget, attempt: u8 },
    /// 0x04：seat(u8), kind(u8)（0=ante, 1=SB, 2=BB）, amount(u64)。
    ForcedBet {
        seat: u8,
        kind: ForcedBetKind,
        amount: u64,
    },
    /// 0x05：seat(u8), draw_no(u16)（**不含牌面**）。
    HoleDealt { seat: u8, draw_no: u16 },
    /// 0x06：street(u8)（0=preflop, 1=flop, 2=turn, 3=river）。
    StreetStart { street: u8 },
    /// 0x07：seat(u8), kind(u8)（0=fold..5=allin）, amount(u64)。
    ///
    /// amount 仅 bet/raise/allin 非零；raise/allin 记「加注到」的总额。
    Action {
        seat: u8,
        kind: ActionKind,
        amount: u64,
    },
    /// 0x08：seat(u8), auto_kind(u8)。
    Timeout { seat: u8, auto_kind: u8 },
    /// 0x09：street(u8)（**实际街序** 1=flop, 2=turn, 3=river；runout 补发的牌也记
    /// 实际街序）, card(u8), draw_no(u16), vrf_src(u8)（正常街 1..3，runout 记 4=Runout）。
    BoardDealt {
        street: u8,
        card: u8,
        draw_no: u16,
        vrf_src: VrfTarget,
    },
    /// 0x0A：无字段（all-in 合并，开始 runout）。
    RunoutStarted,
    /// 0x0B：street(u8)（整条街无人行动被跳过）。
    StreetSkipped { street: u8 },
    /// 0x0C：result(u8)（0=settled, 1=void）, deltas\[9\](i64×9), rake(u64)。
    HandEnd {
        result: HandResult,
        deltas: [i64; MAX_SEATS as usize],
        rake: u64,
    },
    /// 0x0D：reason(u8)（0=missing_salt, 1=vrf_exhausted）。
    HandVoid { reason: VoidReason },
}

impl Event {
    /// 规范编码：`tag(u8) ‖ 固定宽度字段（大端）`。
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        match self {
            Event::HandStart {
                hand_id,
                button,
                hand_mask,
                stacks,
                occupancy_ids,
            } => {
                out.push(0x01);
                out.extend_from_slice(&hand_id.to_be_bytes());
                out.push(*button);
                out.extend_from_slice(&hand_mask.to_be_bytes());
                for s in stacks {
                    out.extend_from_slice(&s.to_be_bytes());
                }
                for o in occupancy_ids {
                    out.extend_from_slice(&o.to_be_bytes());
                }
            }
            Event::SaltCommitted { seat, commitment } => {
                out.push(0x02);
                out.push(*seat);
                out.extend_from_slice(commitment);
            }
            Event::VrfFulfilled { target, attempt } => {
                out.push(0x03);
                out.push(target.to_u8());
                out.push(*attempt);
            }
            Event::ForcedBet { seat, kind, amount } => {
                out.push(0x04);
                out.push(*seat);
                out.push(kind.to_u8());
                out.extend_from_slice(&amount.to_be_bytes());
            }
            Event::HoleDealt { seat, draw_no } => {
                out.push(0x05);
                out.push(*seat);
                out.extend_from_slice(&draw_no.to_be_bytes());
            }
            Event::StreetStart { street } => {
                out.push(0x06);
                out.push(*street);
            }
            Event::Action { seat, kind, amount } => {
                out.push(0x07);
                out.push(*seat);
                out.push(kind.to_u8());
                out.extend_from_slice(&amount.to_be_bytes());
            }
            Event::Timeout { seat, auto_kind } => {
                out.push(0x08);
                out.push(*seat);
                out.push(*auto_kind);
            }
            Event::BoardDealt {
                street,
                card,
                draw_no,
                vrf_src,
            } => {
                out.push(0x09);
                out.push(*street);
                out.push(*card);
                out.extend_from_slice(&draw_no.to_be_bytes());
                out.push(vrf_src.to_u8());
            }
            Event::RunoutStarted => {
                out.push(0x0A);
            }
            Event::StreetSkipped { street } => {
                out.push(0x0B);
                out.push(*street);
            }
            Event::HandEnd {
                result,
                deltas,
                rake,
            } => {
                out.push(0x0C);
                out.push(result.to_u8());
                for d in deltas {
                    out.extend_from_slice(&d.to_be_bytes());
                }
                out.extend_from_slice(&rake.to_be_bytes());
            }
            Event::HandVoid { reason } => {
                out.push(0x0D);
                out.push(reason.to_u8());
            }
        }
        out
    }
}

/// 滚动 transcript（§8.5）：`transcript_0 = sha256("solpoker/transcript/v1" ‖ program_id ‖ table ‖ hand_id)`，
/// `transcript_{n+1} = sha256(transcript_n ‖ encode(event_n))`。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transcript {
    digest: [u8; 32],
}

impl Transcript {
    pub fn new(program_id: &[u8; 32], table: &[u8; 32], hand_id: u64) -> Self {
        Self {
            digest: sha256_parts(&[
                b"solpoker/transcript/v1",
                program_id,
                table,
                &hand_id.to_be_bytes(),
            ]),
        }
    }

    /// 追加一条事件，滚动 digest。
    pub fn append(&mut self, event: &Event) {
        self.digest = sha256_parts(&[&self.digest, &event.encode()]);
    }

    /// 当前 digest（抽牌时绑定的是「追加该牌事件之前」的这个值）。
    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }
}

// ---------------------------------------------------------------------------
// §8.4 抽牌机
// ---------------------------------------------------------------------------

/// 拒绝采样阈值：`2^64 mod n`（`((1u128 << 64) % n as u128) as u64`）。
///
/// `v < threshold` 时丢弃重来，消除 `v mod n` 的取模偏差。
/// `n == 1` 时阈值 0（`v mod 1` 无偏差，永不重试）。
pub fn rejection_threshold(n: usize) -> u64 {
    debug_assert!(n >= 1, "牌堆为空时不应抽牌");
    ((1u128 << 64) % n as u128) as u64
}

/// 单次抽样的原始值（§8.4）：
/// `v = BE_u64(HMAC-SHA256(key=seed, "solpoker-v1" ‖ table ‖ hand_id ‖ draw_no ‖ retry ‖ transcript_digest)[0..8])`。
pub fn draw_value(
    seed: &[u8; 32],
    table: &[u8; 32],
    hand_id: u64,
    draw_no: u16,
    retry: u16,
    transcript_digest: &[u8; 32],
) -> u64 {
    let mac = hmac_sha256_parts(
        seed,
        &[
            b"solpoker-v1",
            table,
            &hand_id.to_be_bytes(),
            &draw_no.to_be_bytes(),
            &retry.to_be_bytes(),
            transcript_digest,
        ],
    );
    u64::from_be_bytes(mac[0..8].try_into().expect("HMAC 输出至少 8 字节"))
}

/// 一次成功抽牌的结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawOutcome {
    /// 抽到的牌编号（0..51）。
    pub card: u8,
    /// 本次抽牌的 `draw_no`（一手内连续编号）。
    pub draw_no: u16,
    /// 最终接受的 `retry` 值（0 = 第一次就通过拒绝采样）。
    pub retry: u16,
}

/// 抽牌机：有序牌堆 + `draw_no` + 滚动 transcript。
///
/// 每次 [`DrawMachine::draw`] 先用**当前** transcript digest 抽样，抽出后再把对应事件
/// 追加进 transcript——因此下一张牌绑定的 digest 已包含上一张（§8.4 尾部规则）。
#[derive(Clone, Debug)]
pub struct DrawMachine {
    table: [u8; 32],
    hand_id: u64,
    /// 升序有序牌堆的剩余部分。
    deck: Vec<u8>,
    draw_no: u16,
    transcript: Transcript,
    /// 测试钩子（对齐 Python 参考实现的 `force_retry`）：这些 `draw_no` 的第一次
    /// 候选被强制视为拒绝，以 retry=1 重算。拒绝采样自然触发概率 ≤ 51/2^64，
    /// 无法暴力搜索，测试向量借此确定性覆盖重抽路径。**链上永不应设置**。
    force_retry: Vec<u16>,
}

impl DrawMachine {
    /// 新建：满牌堆、`draw_no = 0`、transcript = transcript_0。
    pub fn new(program_id: &[u8; 32], table: &[u8; 32], hand_id: u64) -> Self {
        Self {
            table: *table,
            hand_id,
            deck: (0..DECK_SIZE as u8).collect(),
            draw_no: 0,
            transcript: Transcript::new(program_id, table, hand_id),
            force_retry: Vec::new(),
        }
    }

    /// 设置强制重抽的 `draw_no` 列表（测试钩子，见 [`DrawMachine::force_retry`]）。
    pub fn set_force_retry(&mut self, draw_nos: &[u16]) {
        self.force_retry = draw_nos.to_vec();
    }

    /// 当前 transcript digest。
    pub fn transcript_digest(&self) -> [u8; 32] {
        self.transcript.digest()
    }

    /// 追加一条游戏流事件（ForcedBet/Action/Timeout/HandEnd 等），不影响牌堆与 draw_no。
    pub fn append_event(&mut self, event: &Event) {
        self.transcript.append(event);
    }

    /// 下一个 `draw_no`。
    pub fn draw_no(&self) -> u16 {
        self.draw_no
    }

    /// 牌堆剩余张数。
    pub fn remaining(&self) -> usize {
        self.deck.len()
    }

    /// 抽一张牌：以当前 transcript digest 抽样（含拒绝采样），成功后追加 `make_event`
    /// 生成的事件（`HoleDealt` / `BoardDealt`），再推进 `draw_no`。
    pub fn draw(
        &mut self,
        seed: &[u8; 32],
        make_event: impl FnOnce(u8, u16) -> Event,
    ) -> DrawOutcome {
        assert!(!self.deck.is_empty(), "牌堆已空，无法继续抽牌");
        let digest = self.transcript.digest();
        let table = self.table;
        let hand_id = self.hand_id;
        let out = self
            .draw_impl(|draw_no, retry| draw_value(seed, &table, hand_id, draw_no, retry, &digest));
        self.transcript.append(&make_event(out.card, out.draw_no));
        out
    }

    /// 抽牌主循环（抽样函数可注入，便于测试拒绝采样分支）。
    fn draw_impl(&mut self, mut v_of: impl FnMut(u16, u16) -> u64) -> DrawOutcome {
        let mut retry = 0u16;
        loop {
            let n = self.deck.len();
            let v = v_of(self.draw_no, retry);
            // 测试钩子：force_retry 命中的 draw_no 强制拒绝首个候选（retry==0）。
            let forced = retry == 0 && self.force_retry.contains(&self.draw_no);
            if forced || v < rejection_threshold(n) {
                retry += 1;
                continue;
            }
            let index = (v % n as u64) as usize;
            let card = self.deck.remove(index);
            let draw_no = self.draw_no;
            self.draw_no += 1;
            return DrawOutcome {
                card,
                draw_no,
                retry,
            };
        }
    }
}

// ---------------------------------------------------------------------------
// 编排：一手牌的发牌流水线
// ---------------------------------------------------------------------------

/// 一手牌的全部输入（盐为已揭示值；`vrf[k]` 按 [`VrfTarget::to_u8`] 索引）。
#[derive(Clone, Debug)]
pub struct HandInputs {
    pub program_id: [u8; 32],
    pub table: [u8; 32],
    pub hand_id: u64,
    pub hand_mask: u16,
    pub stacks: [u64; MAX_SEATS as usize],
    pub occupancy_ids: [u64; MAX_SEATS as usize],
    pub occupants: [[u8; 32]; MAX_SEATS as usize],
    pub salts: [[u8; 32]; MAX_SEATS as usize],
    pub vrf: [[u8; 32]; 5],
}

/// 一次发牌的记录（底牌或公共牌）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DealRecord {
    /// 抽到的牌编号。
    pub card: u8,
    /// 连续编号。
    pub draw_no: u16,
    /// 拒绝采样最终接受的 retry 值。
    pub retry: u16,
    /// 底牌：座位；公共牌：`None`。
    pub seat: Option<u8>,
    /// 公共牌：street 编码（1=flop, 2=turn, 3=river, 4=runout）；底牌：`None`。
    pub street: Option<u8>,
    /// 公共牌：所用 VRF 目标（`board_src`）；底牌：`None`。
    pub vrf_src: Option<VrfTarget>,
}

/// [`DealSession::new`] 可拒绝的情形。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DealError {
    /// `hand_mask` 的 set bit 数不在 2..=9（D7.1）。
    InvalidMask,
    /// 庄位不在 `hand_mask` 内。
    ButtonNotInMask,
}

/// 计算第一手庄位（§8.3）：`seed_0` 现算后按 `mod popcount` 映射到第 N 个 set bit。
///
/// 仅用于该桌第一次成功发底牌的手；之后用 [`next_clockwise`] 轮转。
pub fn first_button(inputs: &HandInputs) -> Option<u8> {
    let digest = salt_digest(
        &inputs.table,
        inputs.hand_id,
        inputs.hand_mask,
        &inputs.occupants,
        &inputs.occupancy_ids,
        &inputs.salts,
    );
    let seed0 = seed_k(&inputs.vrf[0], &digest);
    button_pick(&seed0, &inputs.table, inputs.hand_id, inputs.hand_mask)
}

/// 底牌发放顺序（§8.4）：从 button 左侧第一位（顺时针下一位）开始的
/// `popcount(hand_mask)` 个座位，顺时针排列。
///
/// 第 k 张底牌（0 起）发给 `hole_order(...)[k % n]`，即每人一张、两轮。
pub fn hole_order(button: u8, hand_mask: u16) -> Option<Vec<u8>> {
    let start = next_clockwise(button, hand_mask)?;
    let n = popcount(hand_mask);
    let mut order = Vec::with_capacity(n as usize);
    let mut cur = start;
    for _ in 0..n {
        order.push(cur);
        cur = next_clockwise(cur, hand_mask)?;
    }
    Some(order)
}

/// 一手牌的发牌会话（编排层）。
///
/// 构造时追加 `HandStart` 与按座位升序的全部 `SaltCommitted`；
/// 之后 [`deal_hole`](DealSession::deal_hole) / [`deal_street`](DealSession::deal_street) /
/// [`deal_runout`](DealSession::deal_runout) 三个步骤可分别调用，步骤之间链上可通过
/// [`append_event`](DealSession::append_event) 注入游戏流事件，transcript 持续滚动。
#[derive(Clone, Debug)]
pub struct DealSession {
    machine: DrawMachine,
    hand_mask: u16,
    button: u8,
    players: u8,
    salt_digest: [u8; 32],
    /// 逐街种子，按 `VrfTarget::to_u8` 索引。
    seeds: [[u8; 32]; 5],
    /// 已发出的公共牌张数（runout 据此补齐到 5）。
    board_count: u8,
}

impl DealSession {
    /// 开局：校验 mask/button，计算 `salt_digest` 与五颗 seed，
    /// 追加 `HandStart` + 每个 set bit（升序）的 `SaltCommitted`。
    pub fn new(inputs: &HandInputs, button: u8) -> Result<Self, DealError> {
        let players = popcount(inputs.hand_mask);
        if !(2..=MAX_SEATS).contains(&players) {
            return Err(DealError::InvalidMask);
        }
        if inputs.hand_mask & seat_bit(button) == 0 {
            return Err(DealError::ButtonNotInMask);
        }
        let salt_digest = salt_digest(
            &inputs.table,
            inputs.hand_id,
            inputs.hand_mask,
            &inputs.occupants,
            &inputs.occupancy_ids,
            &inputs.salts,
        );
        let mut seeds = [[0u8; 32]; 5];
        for (k, seed) in seeds.iter_mut().enumerate() {
            *seed = seed_k(&inputs.vrf[k], &salt_digest);
        }
        let mut machine = DrawMachine::new(&inputs.program_id, &inputs.table, inputs.hand_id);
        machine.append_event(&Event::HandStart {
            hand_id: inputs.hand_id,
            button,
            hand_mask: inputs.hand_mask,
            stacks: inputs.stacks,
            occupancy_ids: inputs.occupancy_ids,
        });
        for seat in 0..MAX_SEATS {
            if inputs.hand_mask & seat_bit(seat) != 0 {
                let commitment = salt_commitment(
                    &inputs.table,
                    inputs.hand_id,
                    &inputs.occupants[seat as usize],
                    &inputs.salts[seat as usize],
                );
                machine.append_event(&Event::SaltCommitted { seat, commitment });
            }
        }
        Ok(Self {
            machine,
            hand_mask: inputs.hand_mask,
            button,
            players,
            salt_digest,
            seeds,
            board_count: 0,
        })
    }

    /// 发底牌：追加 `VrfFulfilled(Preflop, attempt)`，按序追加 `preflop_events`
    /// （通常为 `ForcedBet`×m：ante/SB/BB；链上若有翻前 `Timeout` 也放在这里），
    /// 再追加 `StreetStart(0)`，最后按 [`hole_order`] 抽 2n 张，
    /// 每张追加 `HoleDealt(seat, draw_no)`。返回按抽取顺序的记录。
    pub fn deal_hole(&mut self, vrf_attempt: u8, preflop_events: &[Event]) -> Vec<DealRecord> {
        self.machine.append_event(&Event::VrfFulfilled {
            target: VrfTarget::Preflop,
            attempt: vrf_attempt,
        });
        for ev in preflop_events {
            self.machine.append_event(ev);
        }
        self.machine.append_event(&Event::StreetStart {
            street: STREET_PREFLOP,
        });
        let order = hole_order(self.button, self.hand_mask).expect("mask 已在 new 校验");
        let n = self.players as usize;
        let seed = self.seeds[VrfTarget::Preflop.to_u8() as usize];
        let mut out = Vec::with_capacity(2 * n);
        for k in 0..2 * n {
            let seat = order[k % n];
            let o = self
                .machine
                .draw(&seed, |_card, draw_no| Event::HoleDealt { seat, draw_no });
            out.push(DealRecord {
                card: o.card,
                draw_no: o.draw_no,
                retry: o.retry,
                seat: Some(seat),
                street: None,
                vrf_src: None,
            });
        }
        out
    }

    /// 发一条街（翻/转/河）：追加 `VrfFulfilled(target, attempt)` 与 `StreetStart(street)`，
    /// 抽 3/1/1 张公共牌，每张追加 `BoardDealt(street, card, draw_no, vrf_src)`。
    pub fn deal_street(&mut self, street: BoardStreet, vrf_attempt: u8) -> Vec<DealRecord> {
        let target = street.vrf_target();
        self.machine.append_event(&Event::VrfFulfilled {
            target,
            attempt: vrf_attempt,
        });
        self.machine.append_event(&Event::StreetStart {
            street: street.street_u8(),
        });
        let seed = self.seeds[target.to_u8() as usize];
        let street_u8 = street.street_u8();
        let count = street.card_count();
        let mut out = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let o = self.machine.draw(&seed, |card, draw_no| Event::BoardDealt {
                street: street_u8,
                card,
                draw_no,
                vrf_src: target,
            });
            self.board_count += 1;
            out.push(DealRecord {
                card: o.card,
                draw_no: o.draw_no,
                retry: o.retry,
                seat: None,
                street: Some(street_u8),
                vrf_src: Some(target),
            });
        }
        out
    }

    /// all-in 合并后的 runout（§8.6）：追加 `RunoutStarted` 与
    /// `VrfFulfilled(Runout, attempt)`，用 `seed_runout` 把公共牌补齐到 5 张；
    /// `BoardDealt.street` 记**实际街序**（第 1–3 张公共牌记 1=flop、第 4 张记
    /// 2=turn、第 5 张记 3=river），`vrf_src` 记 `Runout`。`draw_no` 接续编号，
    /// 每张仍绑定最新 transcript。
    ///
    /// 已发满 5 张时返回空 vec（幂等，不产生事件）。
    pub fn deal_runout(&mut self, vrf_attempt: u8) -> Vec<DealRecord> {
        let remaining = 5u8.saturating_sub(self.board_count);
        if remaining == 0 {
            return Vec::new();
        }
        self.machine.append_event(&Event::RunoutStarted);
        self.machine.append_event(&Event::VrfFulfilled {
            target: VrfTarget::Runout,
            attempt: vrf_attempt,
        });
        let seed = self.seeds[VrfTarget::Runout.to_u8() as usize];
        let mut out = Vec::with_capacity(remaining as usize);
        for _ in 0..remaining {
            // 实际街序：公共牌张数 0..2 → flop，3 → turn，4 → river。
            let street = match self.board_count {
                0..=2 => STREET_FLOP,
                3 => STREET_TURN,
                _ => STREET_RIVER,
            };
            let o = self.machine.draw(&seed, |card, draw_no| Event::BoardDealt {
                street,
                card,
                draw_no,
                vrf_src: VrfTarget::Runout,
            });
            self.board_count += 1;
            out.push(DealRecord {
                card: o.card,
                draw_no: o.draw_no,
                retry: o.retry,
                seat: None,
                street: Some(street),
                vrf_src: Some(VrfTarget::Runout),
            });
        }
        out
    }

    /// 注入游戏流事件（ForcedBet/Action/Timeout/StreetSkipped/HandEnd/HandVoid 等），
    /// transcript 滚动、牌堆不动。
    pub fn append_event(&mut self, event: &Event) {
        self.machine.append_event(event);
    }

    /// 测试钩子透传（对齐 Python 参考实现的 `force_retry`）：这些 `draw_no` 的
    /// 第一次候选被强制拒绝，以 retry=1 重算。**链上永不应调用**。
    pub fn set_force_retry(&mut self, draw_nos: &[u16]) {
        self.machine.set_force_retry(draw_nos);
    }

    /// 当前 transcript digest。
    pub fn transcript_digest(&self) -> [u8; 32] {
        self.machine.transcript_digest()
    }

    /// 本手的盐聚合摘要。
    pub fn salt_digest(&self) -> [u8; 32] {
        self.salt_digest
    }

    /// 逐街种子（按 [`VrfTarget`] 取）。
    pub fn seed(&self, target: VrfTarget) -> [u8; 32] {
        self.seeds[target.to_u8() as usize]
    }

    /// 庄位。
    pub fn button(&self) -> u8 {
        self.button
    }

    /// 参与人数（`popcount(hand_mask)`）。
    pub fn players(&self) -> u8 {
        self.players
    }

    /// 下一个 `draw_no`。
    pub fn draw_no(&self) -> u16 {
        self.machine.draw_no()
    }

    /// 已发出的公共牌张数。
    pub fn board_count(&self) -> u8 {
        self.board_count
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const PROGRAM: [u8; 32] = [0x22; 32];
    const TABLE: [u8; 32] = [0x11; 32];
    const HAND_ID: u64 = 7;

    fn hex32(hex: &str) -> [u8; 32] {
        assert_eq!(hex.len(), 64);
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
        }
        out
    }

    /// 钉死测试向量用的固定输入（mask = 座位 0、2；独立 .NET 实现复算，见各断言注释）。
    fn pinned_inputs() -> HandInputs {
        let mut occupants = [[0u8; 32]; 9];
        occupants[0] = [0x30; 32];
        occupants[2] = [0x32; 32];
        let mut salts = [[0u8; 32]; 9];
        salts[0] = [0x50; 32];
        salts[2] = [0x52; 32];
        let mut vrf = [[0u8; 32]; 5];
        for (k, v) in vrf.iter_mut().enumerate() {
            *v = [0x90 + k as u8; 32];
        }
        HandInputs {
            program_id: PROGRAM,
            table: TABLE,
            hand_id: HAND_ID,
            hand_mask: 0x0005,
            stacks: [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008],
            occupancy_ids: [11, 12, 13, 14, 15, 16, 17, 18, 19],
            occupants,
            salts,
            vrf,
        }
    }

    /// 通用输入生成器：每个座位都有确定性盐/身份，mask 任选。
    fn mk_inputs(mask: u16) -> HandInputs {
        let mut occupants = [[0u8; 32]; 9];
        let mut salts = [[0u8; 32]; 9];
        let mut occupancy_ids = [0u64; 9];
        let mut stacks = [0u64; 9];
        for seat in 0..9usize {
            occupants[seat] = [0x40 + seat as u8; 32];
            salts[seat] = [0x60 + seat as u8; 32];
            occupancy_ids[seat] = seat as u64 + 1;
            stacks[seat] = 1000 + seat as u64;
        }
        let mut vrf = [[0u8; 32]; 5];
        for (k, v) in vrf.iter_mut().enumerate() {
            *v = [0x90 + k as u8; 32];
        }
        HandInputs {
            program_id: PROGRAM,
            table: TABLE,
            hand_id: HAND_ID,
            hand_mask: mask,
            stacks,
            occupancy_ids,
            occupants,
            salts,
            vrf,
        }
    }

    // ------------------------------------------------------------------
    // 牌面
    // ------------------------------------------------------------------

    #[test]
    fn card_id_rank_suit_roundtrip() {
        assert_eq!(card_id(0, 0), Some(0)); // 2♣
        assert_eq!(card_id(0, 3), Some(3)); // 2♠
        assert_eq!(card_id(12, 0), Some(48)); // A♣
        assert_eq!(card_id(12, 3), Some(51)); // A♠
        assert_eq!(card_id(13, 0), None);
        assert_eq!(card_id(0, 4), None);
        for card in 0..52u8 {
            assert_eq!(card_id(card_rank(card), card_suit(card)), Some(card));
        }
    }

    // ------------------------------------------------------------------
    // §8.2 / §8.3 钉死向量（.NET SHA256/HMAC-SHA256 独立复算）
    // ------------------------------------------------------------------

    #[test]
    fn salt_commitment_matches_pinned_vector() {
        // C_0 = sha256("solpoker/salt/v1" ‖ 0x11*32 ‖ 0000000000000007 ‖ 0x30*32 ‖ 0x50*32)
        let c0 = salt_commitment(&TABLE, HAND_ID, &[0x30; 32], &[0x50; 32]);
        assert_eq!(
            c0,
            hex32("73697da9d38f1f21ed07370fc4785f738b78b65667bf8be1e22b5061f2cd5808")
        );
        let c2 = salt_commitment(&TABLE, HAND_ID, &[0x32; 32], &[0x52; 32]);
        assert_eq!(
            c2,
            hex32("017e6bfaf8e8618dbabf4f5e9a99d6f76e45bf99a8353a518fad30be8d064a80")
        );
    }

    #[test]
    fn salt_digest_matches_pinned_vector() {
        let inputs = pinned_inputs();
        let d = salt_digest(
            &TABLE,
            HAND_ID,
            inputs.hand_mask,
            &inputs.occupants,
            &inputs.occupancy_ids,
            &inputs.salts,
        );
        // sha256("solpoker/salts/v1" ‖ table ‖ hand_id ‖ 0005
        //        ‖ 00 ‖ occ11 ‖ 0x30*32 ‖ 0x50*32 ‖ 02 ‖ occ13 ‖ 0x32*32 ‖ 0x52*32)
        assert_eq!(
            d,
            hex32("803729cc19f24db2b6e40144cc1c29c96fd567ca5c0b1c315f1a520fdd97888d")
        );
    }

    #[test]
    fn salt_digest_ignores_seats_outside_mask() {
        let inputs = pinned_inputs();
        let base = salt_digest(
            &TABLE,
            HAND_ID,
            inputs.hand_mask,
            &inputs.occupants,
            &inputs.occupancy_ids,
            &inputs.salts,
        );
        // 改动 mask 外座位（5 号）的盐/身份/occupancy_id，digest 不变。
        let mut other = pinned_inputs();
        other.salts[5] = [0xEE; 32];
        other.occupants[5] = [0xEE; 32];
        other.occupancy_ids[5] = 999;
        let d2 = salt_digest(
            &TABLE,
            HAND_ID,
            other.hand_mask,
            &other.occupants,
            &other.occupancy_ids,
            &other.salts,
        );
        assert_eq!(base, d2);
        // 改动 mask 内座位的盐，digest 必须变。
        let mut third = pinned_inputs();
        third.salts[2][0] ^= 1;
        let d3 = salt_digest(
            &TABLE,
            HAND_ID,
            third.hand_mask,
            &third.occupants,
            &third.occupancy_ids,
            &third.salts,
        );
        assert_ne!(base, d3);
    }

    #[test]
    fn seed_k_matches_pinned_vectors() {
        let digest = hex32("803729cc19f24db2b6e40144cc1c29c96fd567ca5c0b1c315f1a520fdd97888d");
        let expected = [
            "ccd1eb2e38c7bba99c816882cf0954025cb40981cd686450e387f7b31fb7cc73",
            "d2302d0b585a7c8f8d895396dc0dab353f2310d55ca9634183f8644a5df3477e",
            "991fad6caeec021e16165b7a94948f8693bf7249918e522a306c75f4d19af006",
            "f4367734f9b01f53d60905f5884960f76acdcca9147d0d4599e19bd9d85c438e",
            "66ccc25fd9ea7de340d59e076c1ebaf33639225ba036964bae0b22f31d0ab72a",
        ];
        for (k, exp) in expected.iter().enumerate() {
            let vrf = [0x90 + k as u8; 32];
            assert_eq!(seed_k(&vrf, &digest), hex32(exp), "seed_{k} 不匹配");
        }
    }

    #[test]
    fn button_pick_matches_pinned_vector_and_maps_to_set_bit() {
        let seed0 = hex32("ccd1eb2e38c7bba99c816882cf0954025cb40981cd686450e387f7b31fb7cc73");
        // BE_u64(HMAC-SHA256(seed_0, "solpoker-v1/button" ‖ table ‖ hand_id)[0..8])
        assert_eq!(
            button_pick_value(&seed0, &TABLE, HAND_ID),
            17200387869398103218
        );
        // 17200387869398103218 mod 2 = 0 → 第 0 个 set bit = 座位 0。
        assert_eq!(button_pick(&seed0, &TABLE, HAND_ID, 0x0005), Some(0));
        // 空 mask。
        assert_eq!(button_pick(&seed0, &TABLE, HAND_ID, 0), None);
        // 单人 mask：任何 seed 都映射到唯一 set bit。
        assert_eq!(button_pick(&seed0, &TABLE, HAND_ID, 0b1_0000_0000), Some(8));
    }

    #[test]
    fn button_pick_maps_to_nth_set_bit_for_both_picks() {
        // 稀疏双人 mask {0, 6}：扫 seed 直到两种 pick 都出现，验证映射恒为第 N 个 set bit。
        let mask = 0b0_0100_0001;
        let mut seen = [false; 2];
        for b in 0u8..=255 {
            let mut seed = [0u8; 32];
            seed[0] = b;
            let raw = button_pick_value(&seed, &TABLE, HAND_ID);
            let pick = (raw % 2) as usize;
            let seat = button_pick(&seed, &TABLE, HAND_ID, mask).unwrap();
            assert_eq!(
                seat,
                [0u8, 6u8][pick],
                "pick={pick} 应映射到第 {pick} 个 set bit"
            );
            seen[pick] = true;
            if seen[0] && seen[1] {
                break;
            }
        }
        assert!(
            seen[0] && seen[1],
            "256 个 seed 内应同时覆盖 pick=0 与 pick=1"
        );
    }

    #[test]
    fn first_button_derives_from_inputs() {
        let inputs = pinned_inputs();
        assert_eq!(first_button(&inputs), Some(0));
    }

    // ------------------------------------------------------------------
    // §8.5 事件编码（逐字节）
    // ------------------------------------------------------------------

    #[test]
    fn event_encoding_is_byte_exact() {
        // HandStart：1 + 8 + 1 + 2 + 72 + 72 = 156 字节。
        let hs = Event::HandStart {
            hand_id: 7,
            button: 0,
            hand_mask: 0x0005,
            stacks: [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008],
            occupancy_ids: [11, 12, 13, 14, 15, 16, 17, 18, 19],
        }
        .encode();
        assert_eq!(hs.len(), 156);
        // tag ‖ hand_id(8) ‖ button ‖ hand_mask(2) = 12 字节头。
        assert_eq!(&hs[0..12], &[0x01, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 5]);
        // stack[0] = 1000 大端。
        assert_eq!(&hs[12..20], &1000u64.to_be_bytes());
        // occupancy_id[8] = 19 收尾。
        assert_eq!(&hs[148..156], &19u64.to_be_bytes());

        let sc = Event::SaltCommitted {
            seat: 2,
            commitment: [0xAB; 32],
        }
        .encode();
        assert_eq!(sc.len(), 34);
        assert_eq!(&sc[0..2], &[0x02, 0x02]);
        assert_eq!(&sc[2..34], &[0xAB; 32]);

        assert_eq!(
            Event::VrfFulfilled {
                target: VrfTarget::Runout,
                attempt: 3
            }
            .encode(),
            vec![0x03, 0x04, 0x03]
        );

        let fb = Event::ForcedBet {
            seat: 1,
            kind: ForcedBetKind::SmallBlind,
            amount: 50,
        }
        .encode();
        assert_eq!(fb.len(), 11);
        assert_eq!(&fb[0..3], &[0x04, 0x01, 0x01]);
        assert_eq!(&fb[3..11], &50u64.to_be_bytes());

        assert_eq!(
            Event::HoleDealt {
                seat: 2,
                draw_no: 3
            }
            .encode(),
            vec![0x05, 0x02, 0x00, 0x03]
        );

        assert_eq!(Event::StreetStart { street: 1 }.encode(), vec![0x06, 0x01]);

        let act = Event::Action {
            seat: 0,
            kind: ActionKind::Raise,
            amount: 200,
        }
        .encode();
        assert_eq!(act.len(), 11);
        assert_eq!(&act[0..3], &[0x07, 0x00, 0x04]);
        assert_eq!(&act[3..11], &200u64.to_be_bytes());

        assert_eq!(
            Event::Timeout {
                seat: 3,
                auto_kind: 1
            }
            .encode(),
            vec![0x08, 0x03, 0x01]
        );

        assert_eq!(
            Event::BoardDealt {
                street: 1,
                card: 7,
                draw_no: 4,
                vrf_src: VrfTarget::Flop
            }
            .encode(),
            vec![0x09, 0x01, 0x07, 0x00, 0x04, 0x01]
        );

        assert_eq!(Event::RunoutStarted.encode(), vec![0x0A]);
        assert_eq!(
            Event::StreetSkipped { street: 2 }.encode(),
            vec![0x0B, 0x02]
        );

        let mut deltas = [0i64; 9];
        deltas[0] = 150;
        deltas[1] = -150;
        let he = Event::HandEnd {
            result: HandResult::Settled,
            deltas,
            rake: 5,
        }
        .encode();
        // 1 + 1 + 72 + 8 = 82 字节；i64 负数按大端补码。
        assert_eq!(he.len(), 82);
        assert_eq!(&he[0..2], &[0x0C, 0x00]);
        assert_eq!(&he[2..10], &150i64.to_be_bytes());
        assert_eq!(&he[10..18], &(-150i64).to_be_bytes());
        assert_eq!(&he[74..82], &5u64.to_be_bytes());

        assert_eq!(
            Event::HandVoid {
                reason: VoidReason::VrfExhausted
            }
            .encode(),
            vec![0x0D, 0x01]
        );
    }

    // ------------------------------------------------------------------
    // §8.4 拒绝采样
    // ------------------------------------------------------------------

    #[test]
    fn rejection_threshold_math() {
        // 2^64 mod n（.NET BigInteger 复算）。
        assert_eq!(rejection_threshold(52), 16);
        assert_eq!(rejection_threshold(2), 0); // 永不重试
        assert_eq!(rejection_threshold(3), 1);
        assert_eq!(rejection_threshold(51), 1);
        assert_eq!(rejection_threshold(1), 0);
    }

    #[test]
    fn draw_retries_when_v_below_threshold() {
        // 构造 first v < 2^64 mod 52 = 16 的输入：注入抽样函数，第一次返回 15。
        let mut m = DrawMachine::new(&PROGRAM, &TABLE, HAND_ID);
        let out = m.draw_impl(|_draw_no, retry| if retry == 0 { 15 } else { 1_000_000 });
        assert_eq!(out.retry, 1, "v=15 < 16 应触发一次拒绝采样");
        assert_eq!(out.draw_no, 0);
        // 第二次 v=1_000_000：index = 1_000_000 mod 52 = 40，牌堆未动 → 牌 40。
        assert_eq!(out.card, 40);
        assert_eq!(m.draw_no(), 1);
        assert_eq!(m.remaining(), 51);
    }

    #[test]
    fn draw_accepts_v_equal_to_threshold() {
        // 边界：v == threshold 不拒绝（条件是严格小于）。
        let mut m = DrawMachine::new(&PROGRAM, &TABLE, HAND_ID);
        let out = m.draw_impl(|_, _| 16);
        assert_eq!(out.retry, 0);
        assert_eq!(out.card, 16); // 16 mod 52 = 16
    }

    #[test]
    fn draw_value_binds_retry_and_draw_no_and_digest() {
        let seed = [0x90u8; 32];
        let digest = [0x55u8; 32];
        let base = draw_value(&seed, &TABLE, HAND_ID, 0, 0, &digest);
        assert_ne!(base, draw_value(&seed, &TABLE, HAND_ID, 0, 1, &digest)); // retry 进 msg
        assert_ne!(base, draw_value(&seed, &TABLE, HAND_ID, 1, 0, &digest)); // draw_no 进 msg
        assert_ne!(
            base,
            draw_value(&seed, &TABLE, HAND_ID, 0, 0, &[0x56u8; 32])
        ); // digest 进 msg
        assert_eq!(base, draw_value(&seed, &TABLE, HAND_ID, 0, 0, &digest)); // 确定性
    }

    #[test]
    fn force_retry_hook_rejects_first_candidate() {
        // 测试钩子（对齐 Python 的 force_retry）：draw_no=0 的首个候选被强制拒绝，
        // 无论其 v 是否低于阈值；第二张候选以 retry=1 真实重算。
        let seed = [0x90u8; 32];
        let mut m = DrawMachine::new(&PROGRAM, &TABLE, HAND_ID);
        m.set_force_retry(&[0]);
        let digest = m.transcript_digest();
        // 找到 retry>=1 起第一个通过拒绝采样的候选。
        let mut expected_retry = 1u16;
        let mut v = draw_value(&seed, &TABLE, HAND_ID, 0, expected_retry, &digest);
        while v < rejection_threshold(52) {
            expected_retry += 1;
            v = draw_value(&seed, &TABLE, HAND_ID, 0, expected_retry, &digest);
        }
        let out = m.draw(&seed, |card, dn| Event::BoardDealt {
            street: STREET_FLOP,
            card,
            draw_no: dn,
            vrf_src: VrfTarget::Flop,
        });
        assert_eq!(out.retry, expected_retry, "首个候选必须被强制拒绝");
        assert_eq!(
            out.card,
            (v % 52) as u8,
            "应接受 retry=1 起首个过采样的候选"
        );
        assert_eq!(out.draw_no, 0);
        // draw_no=1 不在钩子里：retry 归零。
        let d1 = m.transcript_digest();
        let v_next = draw_value(&seed, &TABLE, HAND_ID, 1, 0, &d1);
        let out2 = m.draw(&seed, |card, dn| Event::BoardDealt {
            street: STREET_FLOP,
            card,
            draw_no: dn,
            vrf_src: VrfTarget::Flop,
        });
        assert_eq!(out2.draw_no, 1);
        if v_next >= rejection_threshold(51) {
            assert_eq!(out2.retry, 0);
        }
    }

    // ------------------------------------------------------------------
    // 全流程钉死向量（transcript / 底牌 / 翻牌，.NET 独立复算）
    // ------------------------------------------------------------------

    #[test]
    fn transcript_prelude_matches_pinned_vectors() {
        // transcript_0 = sha256("solpoker/transcript/v1" ‖ 0x22*32 ‖ 0x11*32 ‖ 07)
        let t = Transcript::new(&PROGRAM, &TABLE, HAND_ID);
        assert_eq!(
            t.digest(),
            hex32("f4418c38152e86afb7a6269809e558a45b7bc05c7a7be364d00979d42cebd23f"),
            "transcript_0"
        );
    }

    #[test]
    fn full_deal_matches_pinned_vectors() {
        let inputs = pinned_inputs();
        let button = first_button(&inputs).unwrap();
        assert_eq!(button, 0);
        let mut sess = DealSession::new(&inputs, button).unwrap();

        // HandStart + SaltCommitted×2 之后。
        assert_eq!(
            sess.transcript_digest(),
            hex32("ccd3c028686edb03bab0cb421b2a81318545e099fe154e85aa1e5cce8edee82a"),
            "t_after_salts"
        );
        assert_eq!(
            sess.salt_digest(),
            hex32("803729cc19f24db2b6e40144cc1c29c96fd567ca5c0b1c315f1a520fdd97888d")
        );
        assert_eq!(
            sess.seed(VrfTarget::Runout),
            hex32("66ccc25fd9ea7de340d59e076c1ebaf33639225ba036964bae0b22f31d0ab72a")
        );

        // 底牌：button=0 → 起点为顺时针下一位 seat 2，座位序 [2,0] 交替；
        // 事件序 VrfFulfilled(Preflop,1) → StreetStart(0) → HoleDealt×4（无强制注）。
        let hole = sess.deal_hole(1, &[]);
        assert_eq!(hole.len(), 4);
        let expect = [(2u8, 43u8), (0, 48), (2, 32), (0, 5)];
        for (i, rec) in hole.iter().enumerate() {
            assert_eq!(rec.draw_no, i as u16);
            assert_eq!(rec.retry, 0);
            assert_eq!(rec.seat, Some(expect[i].0));
            assert_eq!(rec.card, expect[i].1, "draw {i}");
        }
        assert_eq!(
            sess.transcript_digest(),
            hex32("26aeb6d74cdcd1fc7bbbbec160a20a814839bd0ab5f139cc389ed3c635ef6f53"),
            "t_after_hole"
        );

        // 翻牌：VrfFulfilled(Flop,1) + StreetStart(1) 后抽 3 张。
        let flop = sess.deal_street(BoardStreet::Flop, 1);
        assert_eq!(flop.len(), 3);
        assert_eq!(
            flop.iter().map(|r| r.card).collect::<Vec<_>>(),
            vec![38, 9, 15]
        );
        for (i, rec) in flop.iter().enumerate() {
            assert_eq!(rec.draw_no, 4 + i as u16);
            assert_eq!(rec.street, Some(STREET_FLOP));
            assert_eq!(rec.vrf_src, Some(VrfTarget::Flop));
        }
        assert_eq!(
            sess.transcript_digest(),
            hex32("eb48051888a08d96abd0c6f6547c5509d48348ba3f7b02e2185533d1d19aa3ca"),
            "t_final"
        );
        assert_eq!(sess.draw_no(), 7);
        assert_eq!(sess.board_count(), 3);
    }

    // ------------------------------------------------------------------
    // 底牌顺序：2 / 3 / 9 人与稀疏 mask
    // ------------------------------------------------------------------

    fn hole_seat_order(mask: u16, button: u8) -> Vec<u8> {
        let inputs = mk_inputs(mask);
        let mut sess = DealSession::new(&inputs, button).unwrap();
        sess.deal_hole(1, &[])
            .iter()
            .map(|r| r.seat.unwrap())
            .collect()
    }

    #[test]
    fn hole_order_two_players() {
        // mask {0,2}，button=2 → 起点 seat 0，交替 [0,2,0,2]。
        assert_eq!(hole_seat_order(0b101, 2), vec![0, 2, 0, 2]);
        // button=0 → 起点 seat 2，交替 [2,0,2,0]。
        assert_eq!(hole_seat_order(0b101, 0), vec![2, 0, 2, 0]);
    }

    #[test]
    fn hole_order_three_players() {
        // mask {0,1,2}，button=0 → 起点 1：[1,2,0] 两轮。
        assert_eq!(hole_seat_order(0b111, 0), vec![1, 2, 0, 1, 2, 0]);
        // button=2 → 起点绕回 0：[0,1,2] 两轮。
        assert_eq!(hole_seat_order(0b111, 2), vec![0, 1, 2, 0, 1, 2]);
    }

    #[test]
    fn hole_order_nine_players_full_ring() {
        // 满员 9 人，button=4 → 起点 5：[5,6,7,8,0,1,2,3,4] 两轮。
        let expect: Vec<u8> = [5, 6, 7, 8, 0, 1, 2, 3, 4]
            .into_iter()
            .cycle()
            .take(18)
            .collect();
        assert_eq!(hole_seat_order(0x1FF, 4), expect);
    }

    #[test]
    fn hole_order_sparse_masks() {
        // 稀疏 9 席 {2,6,8}：button=8 → 绕回起点 2：[2,6,8] 两轮。
        assert_eq!(hole_seat_order(0b1_0100_0100, 8), vec![2, 6, 8, 2, 6, 8]);
        // {0,6} 双人稀疏：button=0 → 起点 6：[6,0,6,0]。
        assert_eq!(hole_seat_order(0b0_0100_0001, 0), vec![6, 0, 6, 0]);
    }

    // ------------------------------------------------------------------
    // transcript 确定性 / 连续性
    // ------------------------------------------------------------------

    #[test]
    fn transcript_is_deterministic_and_order_sensitive() {
        let a_inputs = mk_inputs(0b111);
        let mut a = DealSession::new(&a_inputs, 0).unwrap();
        a.deal_hole(1, &[]);
        a.deal_street(BoardStreet::Flop, 1);
        let da = a.transcript_digest();

        let mut b = DealSession::new(&a_inputs, 0).unwrap();
        b.deal_hole(1, &[]);
        b.deal_street(BoardStreet::Flop, 1);
        assert_eq!(da, b.transcript_digest(), "相同输入必须得到相同 transcript");

        // 事件顺序敏感：交换两条事件顺序，digest 不同。
        let mut t1 = Transcript::new(&PROGRAM, &TABLE, HAND_ID);
        let e1 = Event::StreetStart { street: 1 };
        let e2 = Event::RunoutStarted;
        t1.append(&e1);
        t1.append(&e2);
        let mut t2 = Transcript::new(&PROGRAM, &TABLE, HAND_ID);
        t2.append(&e2);
        t2.append(&e1);
        assert_ne!(t1.digest(), t2.digest());

        // 强制注事件（在 VrfFulfilled(0) 与 StreetStart(0) 之间注入）改变后续抽牌
        // 绑定的 transcript。
        let forced = [Event::ForcedBet {
            seat: 1,
            kind: ForcedBetKind::BigBlind,
            amount: 100,
        }];
        let mut c = DealSession::new(&a_inputs, 0).unwrap();
        c.deal_hole(1, &forced);
        c.deal_street(BoardStreet::Flop, 1);
        assert_ne!(da, c.transcript_digest());

        // deal_hole 的 preflop_events 等价于手动按序 append_event 后再抽：
        // 用裸 DrawMachine 手动重放 VrfFulfilled → forced → StreetStart(0) → 第一张底牌，
        // 必须与 deal_hole(1, &[forced]) 的第一张牌逐字节一致。
        let mut with_forced = DealSession::new(&a_inputs, 0).unwrap();
        let first = with_forced.deal_hole(1, &forced)[0];

        let mut m = DrawMachine::new(&PROGRAM, &TABLE, HAND_ID);
        m.append_event(&Event::HandStart {
            hand_id: HAND_ID,
            button: 0,
            hand_mask: 0b111,
            stacks: a_inputs.stacks,
            occupancy_ids: a_inputs.occupancy_ids,
        });
        let digest0 = salt_digest(
            &TABLE,
            HAND_ID,
            0b111,
            &a_inputs.occupants,
            &a_inputs.occupancy_ids,
            &a_inputs.salts,
        );
        for seat in 0..MAX_SEATS {
            if 0b111u16 & seat_bit(seat) != 0 {
                m.append_event(&Event::SaltCommitted {
                    seat,
                    commitment: salt_commitment(
                        &TABLE,
                        HAND_ID,
                        &a_inputs.occupants[seat as usize],
                        &a_inputs.salts[seat as usize],
                    ),
                });
            }
        }
        m.append_event(&Event::VrfFulfilled {
            target: VrfTarget::Preflop,
            attempt: 1,
        });
        m.append_event(&forced[0]);
        m.append_event(&Event::StreetStart {
            street: STREET_PREFLOP,
        });
        let seed0 = seed_k(&a_inputs.vrf[0], &digest0);
        // button=0、mask {0,1,2}：第一张底牌发给 seat 1。
        let o = m.draw(&seed0, |_c, dn| Event::HoleDealt {
            seat: 1,
            draw_no: dn,
        });
        assert_eq!(first.card, o.card);
        assert_eq!(first.draw_no, o.draw_no);
        assert_eq!(first.retry, o.retry);
        assert_eq!(with_forced.draw_no(), 6);
        let _ = m.transcript_digest(); // 完整 transcript 一致性由钉死向量与 vectors parity 覆盖
    }

    #[test]
    fn draw_no_is_continuous_into_runout() {
        // 2 人：底牌 0..3，翻牌 4..6；翻牌后 all-in 合并 → runout 补 7、8。
        // runout 的 BoardDealt.street 记实际街序：第 4 张公共牌 = turn(2)，第 5 张 = river(3)。
        let inputs = mk_inputs(0b101);
        let mut sess = DealSession::new(&inputs, 0).unwrap();
        sess.deal_hole(1, &[]);
        sess.deal_street(BoardStreet::Flop, 1);
        let runout = sess.deal_runout(1);
        assert_eq!(runout.len(), 2);
        assert_eq!(runout[0].draw_no, 7);
        assert_eq!(runout[1].draw_no, 8);
        assert_eq!(runout[0].street, Some(STREET_TURN));
        assert_eq!(runout[1].street, Some(STREET_RIVER));
        for rec in &runout {
            assert_eq!(rec.vrf_src, Some(VrfTarget::Runout));
        }
        assert_eq!(sess.board_count(), 5);
        assert_eq!(sess.draw_no(), 9);
        // 已满 5 张，runout 幂等为空。
        assert!(sess.deal_runout(1).is_empty());
    }

    #[test]
    fn runout_from_preflop_deals_all_five_board_cards() {
        // 翻前直接 all-in：runout 一次补 5 张，draw_no 4..8，全部绑 seed_runout，
        // street 记实际街序 [1,1,1,2,3]。
        let inputs = mk_inputs(0b101);
        let mut sess = DealSession::new(&inputs, 0).unwrap();
        sess.deal_hole(1, &[]);
        let runout = sess.deal_runout(2);
        assert_eq!(runout.len(), 5);
        let streets: Vec<u8> = runout.iter().map(|r| r.street.unwrap()).collect();
        assert_eq!(streets, vec![1, 1, 1, 2, 3]);
        for (i, rec) in runout.iter().enumerate() {
            assert_eq!(rec.draw_no, 4 + i as u16);
            assert_eq!(rec.vrf_src, Some(VrfTarget::Runout));
        }
        assert_eq!(sess.draw_no(), 9);
    }

    #[test]
    fn runout_binds_updated_transcript_between_cards() {
        // runout 内每张牌绑定「上一张牌事件已追加」的 transcript：
        // 与手动逐张模拟（每次重取 digest）结果一致。
        let inputs = mk_inputs(0b111);
        let mut sess = DealSession::new(&inputs, 0).unwrap();
        sess.deal_hole(1, &[]);
        let auto = sess.deal_runout(1);

        // 手动模拟：同一 prelude，逐张取 digest 抽样 + 追加 BoardDealt。
        let mut m = DrawMachine::new(&PROGRAM, &TABLE, HAND_ID);
        m.append_event(&Event::HandStart {
            hand_id: HAND_ID,
            button: 0,
            hand_mask: 0b111,
            stacks: inputs.stacks,
            occupancy_ids: inputs.occupancy_ids,
        });
        for seat in 0..MAX_SEATS {
            if 0b111u16 & seat_bit(seat) != 0 {
                m.append_event(&Event::SaltCommitted {
                    seat,
                    commitment: salt_commitment(
                        &TABLE,
                        HAND_ID,
                        &inputs.occupants[seat as usize],
                        &inputs.salts[seat as usize],
                    ),
                });
            }
        }
        m.append_event(&Event::VrfFulfilled {
            target: VrfTarget::Preflop,
            attempt: 1,
        });
        m.append_event(&Event::StreetStart {
            street: STREET_PREFLOP,
        });
        let order = hole_order(0, 0b111).unwrap();
        let seed0 = seed_k(&inputs.vrf[0], &sess.salt_digest());
        for k in 0..6usize {
            let seat = order[k % 3];
            m.draw(&seed0, |_c, dn| Event::HoleDealt { seat, draw_no: dn });
        }
        m.append_event(&Event::RunoutStarted);
        m.append_event(&Event::VrfFulfilled {
            target: VrfTarget::Runout,
            attempt: 1,
        });
        let seedr = seed_k(&inputs.vrf[4], &sess.salt_digest());
        let mut manual = Vec::new();
        // 实际街序：第 1–3 张记 flop(1)，第 4 张 turn(2)，第 5 张 river(3)。
        for (i, street) in [1u8, 1, 1, 2, 3].into_iter().enumerate() {
            let _ = i;
            let o = m.draw(&seedr, |card, dn| Event::BoardDealt {
                street,
                card,
                draw_no: dn,
                vrf_src: VrfTarget::Runout,
            });
            manual.push(o.card);
        }
        assert_eq!(
            auto.iter().map(|r| r.card).collect::<Vec<_>>(),
            manual,
            "deal_runout 必须逐张绑定更新后的 transcript"
        );
        assert_eq!(sess.transcript_digest(), m.transcript_digest());
    }

    #[test]
    fn nine_player_full_hand_uses_draw_no_up_to_22() {
        // 9 人：底牌 0..17，翻 18..20，转 21，河 22（§8.4 上界）。
        let inputs = mk_inputs(0x1FF);
        let mut sess = DealSession::new(&inputs, 8).unwrap();
        let hole = sess.deal_hole(1, &[]);
        assert_eq!(hole.len(), 18);
        assert_eq!(hole[17].draw_no, 17);
        let flop = sess.deal_street(BoardStreet::Flop, 1);
        assert_eq!(flop[0].draw_no, 18);
        assert_eq!(flop[2].draw_no, 20);
        let turn = sess.deal_street(BoardStreet::Turn, 1);
        assert_eq!(turn[0].draw_no, 21);
        let river = sess.deal_street(BoardStreet::River, 1);
        assert_eq!(river[0].draw_no, 22);
        assert_eq!(sess.draw_no(), 23);
        // 23 张牌互不相同（一副牌内抽样）。
        let mut cards: Vec<u8> = hole
            .iter()
            .chain(flop.iter())
            .chain(turn.iter())
            .chain(river.iter())
            .map(|r| r.card)
            .collect();
        cards.sort_unstable();
        cards.dedup();
        assert_eq!(cards.len(), 23);
    }

    #[test]
    fn new_rejects_bad_mask_and_foreign_button() {
        let inputs = mk_inputs(0b001); // 单人
        assert_eq!(
            DealSession::new(&inputs, 0).unwrap_err(),
            DealError::InvalidMask
        );
        let inputs = mk_inputs(0b101);
        assert_eq!(
            DealSession::new(&inputs, 1).unwrap_err(), // 座位 1 不在 mask
            DealError::ButtonNotInMask
        );
    }
}
