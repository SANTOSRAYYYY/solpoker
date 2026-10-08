//! Account state — full Stage 6 model (design §3.2; field set follows the
//! design exactly, sizes/ordering finalized here). All amounts are u64 base
//! units, all times are `Clock::unix_timestamp` seconds; integers serialized
//! big-endian where they enter hashes/seeds.
//!
//! VRF 状态机一律委托 `solpoker-core`（§6.2 V1 拆分）：链上 `VrfSlot` 只是
//! core 槽位的可序列化镜像，且**不保存 randomness**——未公开的 VRF 输出只存在于
//! 私有 Deck 账户（§3.2 字段纪律、§8.8）。镜像通过 `core_replay` 重放构造出
//! core `VrfSlot` 调用其 `arm`/`request`/`fulfill`/`retry`，再用 `sync_from_core`
//! 把结果状态写回，规则只有 core 一份。
//!
//! 决策记录（Stage 6 Phase 1）：Game 不再携带 `events: EventLog`，只保留
//! `transcript` 链式哈希——v1 的规范事件流可由 HandProof 的 ProofEntry 加上
//! Game 的公开字段重放推导；若后续需要完整事件字节，放在 ProofEntry 相邻的
//! 存储里，不进 Game。
//!
//! Zero-copy 决策记录（链上硬化重构）：Game / HandProof / Deck 改为
//! `#[account(zero_copy)]` Pod 账户——SBF 4096 字节栈预算装不下 borsh 的
//! 栈上反序列化（Game ≈ 1.5KB、HandProof ≈ 11KB），handler 帧与帧覆盖直接
//! 超限。所有内嵌类型（SeatState / ProofEntry / VrfSlot）同步改为
//! `#[zero_copy]`（`#[repr(C)]` + bytemuck Pod），字段按对齐降序排列、显式
//! 填充位补齐到对齐整数倍（bytemuck Pod derive 在编译期断言无隐式填充）。
//! bool 不是 Pod，一律改 u8（0/1）；无数据枚举（VrfState / VrfTarget）用
//! `#[repr(u8)]` + 手工 unsafe impl Pod（账户数据只由本程序经
//! `sync_from_core`/`Default` 写入，判别值恒合法——见各 impl 的 SAFETY 注记）。
//! Anchor 1.0 的 `#[account(zero_copy)]` 仍保留 8 字节 discriminator，账户
//! 布局 = discriminator ‖ repr(C) 字节；init 用 `space = 8 + size_of::<T>()`，
//! handler 里 `load_init()`，其余指令 `load()`/`load_mut()`。

use anchor_lang::prelude::*;

pub const MAX_SEATS: usize = 9;

/// devnet/mainnet TEE validator (context block v6 关键地址). Delegation must
/// name it explicitly — `validator: None` is never used.
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

// ---------------------------------------------------------------------------
// L1 accounts
// ---------------------------------------------------------------------------

/// Global program configuration (design §3.2). PDA ["config"], L1, never
/// delegated. Created once by `init_config`.
#[account]
#[derive(InitSpace)]
pub struct ProgramConfig {
    pub admin: Pubkey,
    /// rake 可能付到 ATA(treasury, mint)。
    pub treasury: Pubkey,
    /// MTEW…；委托时显式传入，禁止 None。
    pub tee_validator: Pubkey,
    /// 仅 D5 标准模式使用；原子模式不需要。
    pub gateway: Pubkey,
    /// PAUSED | ESCAPE_SUPPORTED | …
    pub flags: u32,
    pub version: u16,
    pub bump: u8,
    pub deleg_payer_bump: u8,
}

/// L1 table configuration (design §3.2). PDA ["table", table_id (u32 LE)].
/// Never delegated; carries every tunable so parameters live on-chain, not in
/// code (§2 设计原则 5)。
#[account]
#[derive(InitSpace)]
pub struct Table {
    pub table_id: u32,
    /// Stage 6 过渡期保留：create_table / delegate_table / debug_arm_vrf 仍以
    /// 此 key 的签名为门禁；生产鉴权（ProgramConfig.admin）在后续 Phase 接入。
    pub admin: Pubkey,
    /// 0=Human 1=AgentOnly 2=Mixed
    pub kind: u8,
    pub max_seats: u8,
    /// 0=Active 1=Maintenance 2=Escaping 3=Escaped
    pub status: u8,
    /// tUSDC / Circle USDC；create_table 拒绝非 classic SPL-Token mint
    /// （Token-2022 转账手续费 / transfer hook 扩展，E4 之后再支持）。
    pub mint: Pubkey,
    pub sb: u64,
    pub bb: u64,
    pub ante: u64,
    pub min_buy_in_bb: u16,
    pub max_buy_in_bb: u16,
    pub rake_bps: u16,
    pub rake_cap_bb: u16,
    pub rake_min_pot_bb: u16,
    pub action_timeout_s: u16,
    pub commit_timeout_s: u16,
    pub reveal_timeout_s: u16,
    pub vrf_timeout_s: u16,
    pub vrf_max_attempts: u8,
    pub max_strikes: u8,
    pub commit_every_n_hands: u8,
    /// 有资金在桌、又没有新 commit 时的心跳间隔（秒）。
    pub heartbeat_s: u32,
    /// 快照超过这么久没更新，才允许发起逃生（秒）。
    pub escape_stale_s: u32,
    /// 已划到 treasury 的 rake 累计（只增）。
    pub rake_swept_total: u64,
    /// 逃生后 +1（§5.4）；是 Deck / PlayerHand PDA seeds 的一部分。
    pub epoch: u16,
    pub bump: u8,
    pub vault_auth_bump: u8,
    pub commit_payer_bump: u8,
}

/// L1 半边座位账本（design §3.2 / D1）。PDA ["seat", table, idx (u8)]，
/// **永不委托**；金额跨层只增不减，按差额入账。
#[account]
#[derive(InitSpace)]
pub struct SeatLedger {
    pub table: Pubkey,
    pub idx: u8,
    /// Pubkey::default() 表示空座。
    pub occupant: Pubkey,
    /// 每次新入座 +1。
    pub occupancy_id: u64,
    /// 0=Human 1=Agent
    pub kind: u8,
    /// kind = Agent 时等于 AgentProfile.owner。
    pub agent_owner: Pubkey,
    /// D2 会话 key。
    pub session_key: Pubkey,
    pub session_expires_at: i64,
    /// X7：cash_out 只付 ATA(payout, mint)；入座时固定。
    pub payout: Pubkey,
    /// 入座与补码的累计（跨所有占用者，只增）。
    pub deposited_total: u64,
    /// cash_out 的累计（只增）。
    pub paid_total: u64,
    pub bump: u8,
}

/// x402 标准模式的入账凭据（配套文档一 §4.3；2026-10-08 落地）。
/// PDA ["x402", sig_lo, sig_hi]（付款交易签名的两半）——`init` 语义保证
/// 同一笔付款不可能被网关重复入账。记录付款人/桌/座/金额/时间与完整签名，
/// **供任何人事后审计**：拿 `sig` 去 L1 查那笔交易，核对「付款人 → TableVault」
/// 的转账金额 ≥ `amount`（/history 的 L1 审计视图即为此准备）。
/// 这是 x402 标准模式里唯一信任网关的地方，但可完全审计（同 §9.4 的说明）。
#[account]
#[derive(InitSpace)]
pub struct DepositRecord {
    pub payer: Pubkey,
    pub table: Pubkey,
    pub seat_idx: u8,
    pub amount: u64,
    pub credited_at: i64,
    /// 付款交易签名（64 字节）。
    pub sig: [u8; 64],
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// ER accounts (delegated to TEE_VALIDATOR)
// ---------------------------------------------------------------------------

/// ER game state (design §3.2). PDA ["game", table]，公开。While delegated,
/// the account owner is the delegation program on L1; ER 上的克隆归本程序所有。
///
/// Zero-copy Pod（见模块头决策记录）。字段按对齐降序排列：32 字节数组 →
/// u64/i64 → VrfSlot → SeatState×9 → u32 → u16 → 小数组 → u8 标志；总大小
/// 1544 字节（8 的整数倍，无隐式填充）。`button_initialized` /
/// `maintenance_requested` 是 u8（0/1）。
#[account(zero_copy)]
#[repr(C)]
pub struct Game {
    pub table: Pubkey,
    /// 事件流链式哈希；v1 不存完整事件字节（见模块头决策记录）。
    pub transcript: [u8; 32],
    pub hand_id: u64,
    /// 本手所有投入（含 ante）。
    pub pot: u64,
    pub current_bet: u64,
    pub last_full_raise: u64,
    pub action_deadline: i64,
    pub phase_deadline: i64,
    /// 累计 rake（只增）。
    pub rake_total: u64,
    pub last_commit_at: i64,
    /// VRF request slot (design §3.2)。solpoker-core `VrfSlot` 的公开镜像，
    /// 不带 randomness——秘密绝不落在公开账户（§3.2 字段纪律）。
    pub vrf: VrfSlot,
    pub seats: [SeatState; MAX_SEATS],
    /// X8：本手内每个改变局面的事件 +1，每手开始归零；act 必须带上。
    pub action_seq: u32,
    pub occupied_mask: u16,
    pub hand_mask: u16,
    pub live_mask: u16,
    pub actionable_mask: u16,
    pub pending_to_act_mask: u16,
    pub board: [u8; 5],
    /// 每张公共牌来自哪个 VRF（deck_index 编码）。
    pub board_src: [u8; 5],
    /// 0=Idle 1=Commit 2=AwaitSeed 3=Preflop 4=AwaitStreet 5=Betting
    /// 6=AwaitRunout 7=Settle 8=Void
    pub phase: u8,
    pub street: u8,
    pub button: u8,
    /// u8（0/1；bool 不是 Pod）。
    pub button_initialized: u8,
    pub board_len: u8,
    pub to_act: u8,
    pub hands_since_commit: u8,
    /// u8（0/1；bool 不是 Pod）。
    pub maintenance_requested: u8,
}

/// ER 半边座位账本（design §3.2 / D1），内嵌在 Game 里。Zero-copy Pod；
/// `folded` / `all_in` / `acted` / `leave_requested` 是 u8（0/1）。`_pad0`
/// 把结构补齐到 152 字节（8 的整数倍）。
#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
pub struct SeatState {
    pub occupant: Pubkey,
    /// 承诺值公开；盐本身在私有 PlayerHand 里，不在这里。
    pub salt_commit: [u8; 32],
    pub next_salt_commit: [u8; 32],
    pub occupancy_id: u64,
    pub stack: u64,
    /// 已计入筹码的入座与补码累计（只增）。
    pub credited_total: u64,
    /// 已释放、等待 L1 兑付的累计（只增）。
    pub owed_total: u64,
    pub in_hand: u64,
    pub street_bet: u64,
    /// 0=Human 1=Agent
    pub kind: u8,
    /// 0=Empty 1=Seated 2=Left
    pub status: u8,
    /// u8（0/1；bool 不是 Pod）。
    pub folded: u8,
    /// u8（0/1；bool 不是 Pod）。
    pub all_in: u8,
    /// u8（0/1；bool 不是 Pod）。
    pub acted: u8,
    pub strikes: u8,
    /// u8（0/1；bool 不是 Pod）。
    pub leave_requested: u8,
    /// 显式填充：152 = 8×19。
    pub _pad0: u8,
}

/// ER deck state (private account, members = [] per §4). PDA
/// ["deck", table, epoch (u16 BE)]。只有 VRF 回调与发牌/结算指令可写。
///
/// Stage 6 Phase 3 起携带 §3.2/§8.8 的整手秘密与抽牌状态：`salts`（AwaitSeed
/// 从 PlayerHand 复制，供后续各街重算 seed_k）、`used_mask`（已抽牌位图，
/// 核心 `DrawMachine` 剩余牌堆的持久化形式）、`draw_no`（一手内连续编号）。
/// 三者让跨指令的确定性重建成为可能——`advance` 每次用它们 + Game.transcript
/// 把抽牌机状态恢复出来，逐字节对齐 `solpoker_core::deal`（hand.rs 有 parity
/// 测试钉死）。手牌结束（Settle/Void）时全部清零。
///
/// Zero-copy Pod；总大小 472 字节（8 的整数倍）。
#[account(zero_copy)]
#[repr(C)]
pub struct Deck {
    pub hand_id: u64,
    /// 已抽出的牌位图（bit c = 牌 c 已发出）。
    pub used_mask: u64,
    /// 下一张牌的 draw_no（§8.4，一手内连续编号）。
    pub draw_no: u16,
    /// Raw VRF outputs per draw: [preflop, flop, turn, river, runout].
    /// Written only by `vrf_callback`; never logged (§15). Cleared at hand end.
    pub vrf_out: [[u8; 32]; 5],
    /// 本手已揭示的盐（AwaitSeed 校验通过后从 PlayerHand 复制）。
    pub salts: [[u8; 32]; MAX_SEATS],
    /// Which attempt produced each entry (for HandProof audit, §8.7).
    pub vrf_attempt_used: [u8; 5],
    /// 显式填充：472 = 8×59。
    pub _pad: u8,
}

/// ER 私有底牌账户（design §3.2）。PDA ["hand", table, epoch (u16 BE), idx]，
/// is_private = true，members = [当前占用者钱包]（空座时 members = []，
/// 换人按 §11.2 顺序替换）。体积很小，保持 borsh。
#[account]
#[derive(InitSpace)]
pub struct PlayerHand {
    pub hand_id: u64,
    /// 0xFF 表示没有牌。
    pub cards: [u8; 2],
    /// D6：揭示交易只写这里。
    pub salt: [u8; 32],
    pub salt_hand_id: u64,
}

/// ER 公开手牌证明环形缓冲（design §3.2）。PDA ["proof", table]，16 手环形。
/// Zero-copy Pod；拆分后总大小 16×232 + 8 = 3,720 字节（盐/VRF 在 HandSecrets）。
#[account(zero_copy)]
#[repr(C)]
#[derive(Default)]
pub struct HandProof {
    pub entries: [ProofEntry; 16],
    pub head: u8,
    /// 显式填充。
    pub _pad: [u8; 7],
}

/// 单手结算/作废的证明（元数据部分）。**设计偏差记录（2026-10-07）**：
/// 设计的 ProofEntry 是单账户 680B×16 ≈ 10.9KB——超过 CPI create_account
/// 的 10,240B 上限，且委托程序的 buffer 同样受限，链上无法创建/委托。所以
/// 把「盐与 VRF 输出」拆到 HandSecrets（["secrets", table]），本结构只留
/// 元数据；验证一手牌时两个账户都要读（§8.7 步骤 2 改为从 HandSecrets 取盐
/// 和 VRF）。公开的数据一字节不少。
/// Zero-copy Pod；`_pad` 把结构补齐到 232 字节（8 的整数倍）。
#[zero_copy]
#[derive(Default, Debug)]
pub struct ProofEntry {
    pub hand_id: u64,
    pub rake: u64,
    pub settled_at: i64,
    pub occupancy_ids: [u64; MAX_SEATS],
    pub deltas: [i64; MAX_SEATS],
    pub transcript_final: [u8; 32],
    pub hole: [[u8; 2]; MAX_SEATS],
    pub hand_mask: u16,
    pub board: [u8; 5],
    /// 0=Settled 1=Void
    pub status: u8,
    pub button: u8,
    /// 显式填充：232 = 8×29。
    pub _pad: [u8; 5],
}

/// 盐与 VRF 输出的环形缓冲（从 HandProof 拆出，见 ProofEntry 的偏差记录）。
/// PDA ["secrets", table]。16 条，与 HandProof.head 同步推进。
#[account(zero_copy)]
#[repr(C)]
#[derive(Default)]
pub struct HandSecrets {
    pub entries: [SecretsEntry; 16],
}

/// 每手的盐与 VRF（456 字节 × 16 = 7,296 + 8 = 7,304，低于 10,240 上限）。
#[zero_copy]
#[derive(Default, Debug)]
pub struct SecretsEntry {
    pub salts: [[u8; 32]; MAX_SEATS],
    pub vrf_out: [[u8; 32]; 5],
    /// 用到了哪几个 VRF（bit i = deck_index i）。
    pub vrf_mask: u8,
    /// 显式填充：456 = 8×57。
    pub _pad: [u8; 7],
}

// ---------------------------------------------------------------------------
// HandReplay（§8.7 落地，2026-10-08）：让「整手 52 张复算」只用链上数据就能做
// ---------------------------------------------------------------------------
//
// 背景：整手复算的输入 = salt_digest + 每张牌抽取前的 transcript_digest + VRF 输出 + 盐。
// v1 只存了 transcript_final（最终哈希），哈希不可逆，所以历史手牌无法复算
// （见 docs/design/hand-replay-design.md）。本账户补上那两个**中间摘要**：
//
//   - salt_digest：有它 + HandSecrets 的 VRF 输出即可算出 5 个 seed_k；
//   - draw_digest[k]：第 k 条街**第一张牌抽取前**的 transcript 摘要。街内后续牌的
//     前置摘要可由「牌序 + 该街的 HoleDealt/BoardDealt 事件」确定性重建。
//
// 为什么不扩 HandProof/Deck：那会改既有账户大小 → 老桌全部失效。独立账户则零影响：
// 新程序部署后给每桌补一次 init_replay 即可开始记录，历史手牌只是「没有 replay」。
//
// 尺寸：ReplayEntry 504 字节（8×63）× 8 手 = 4,032 + head(1) + pad(7) + disc(8)
// = 4,048 字节 ≪ 10,240（CPI create_account 上限）。
#[account(zero_copy)]
#[repr(C)]
#[derive(Default)]
pub struct HandReplay {
    pub entries: [ReplayEntry; REPLAY_RING],
    pub head: u8,
    pub _pad: [u8; 7],
}

/// replay 环长度（与 HandProof 的 16 手不同步：完整复算数据只保最近 8 手）。
pub const REPLAY_RING: usize = 8;

#[zero_copy]
#[derive(Default, Debug)]
pub struct ReplayEntry {
    /// 槽位归属：写入时与 game.hand_id 比对（0 = 空槽）。
    pub hand_id: u64,
    /// **v2**：每条街**结束时**（该街最后一个事件之后）的 transcript 摘要。
    /// 有了它 + 链下公开的事件流，任何人都能验证"这条行动序列确实产生了这条
    /// transcript"，并一路对到 HandProof.transcript_final（设计 §7）。
    /// v1 里这 288 字节是 occupants —— 弃用理由：对历史手牌的 salt_digest 自检，
    /// 价值低于"事件流可验证"；当前手的 occupant 仍可从实时 Game 读到。
    pub street_end: [[u8; 32]; 4],
    /// bit k = street_end[k] 有效。
    pub streets_ended: u8,
    /// 这 288 字节区的剩余部分（v2 未用，置零）。拆成两个数组：bytemuck 只对
    /// ≤32 的数组有 Pod/Default 实现。
    pub _occ_pad_a: [[u8; 32]; 4],
    pub _occ_pad_b: [u8; 31],
    /// salt_digest = sha256("solpoker/salts/v1" ‖ table ‖ hand_id ‖ hand_mask ‖ 每座 …)
    pub salt_digest: [u8; 32],
    /// [preflop, flop, turn, river, runout] 各街第一张牌抽取前的 transcript。
    pub draw_digest: [[u8; 32]; 5],
    /// 每个 VRF 目标实际用的 attempt（重建 VrfFulfilled 事件需要）。
    pub vrf_attempt_used: [u8; 5],
    /// 0=Settled 1=Void（与 ProofEntry.status 同义）。
    pub status: u8,
    /// bit k = 该街确实发过牌（draw_digest[k] 有效）。
    pub streets_used: u8,
    /// 布局版本：0 = v1（同一段 288B 是 occupants），2 = v2（street_end + mask）。
    pub layout_ver: u8,
    /// 显式填充：504 = 8×63（**v2 不改变账户大小** → 老账户无需重建/重新 init）。
    pub _pad: [u8; 8],
}

// ---------------------------------------------------------------------------
// VRF slot mirror (unchanged — see module docs)
// ---------------------------------------------------------------------------

/// Core VRF slot states (solpoker-core `VrfState`), persisted inside Game.
/// Lifecycle per §6.2 / §9: act/advance sets Ready (arm), request_vrf sets
/// Pending, vrf_callback sets Fulfilled (randomness in Deck), advance
/// consumes Fulfilled and resets to Idle; retry exhaustion lands on Void and
/// the settlement path voids the hand.
///
/// `#[repr(u8)]`（判别值 0..=4，与 borsh 时代顺序一致）。bytemuck 不为枚举
/// derive Pod，下面手工 impl：
// SAFETY: 无数据枚举 + repr(u8)，大小 1 无填充；账户数据只会由本程序经
// `sync_from_core` / `VrfSlot::default` 写入（判别值恒在 0..=4），init/zero
// 清零后读到 Idle（0，合法）。除账户字节外没有任何途径构造越界判别值。
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum VrfState {
    Idle,
    Ready,
    Pending,
    Fulfilled,
    Void,
}

unsafe impl bytemuck::Zeroable for VrfState {}
// SAFETY: 见类型文档——单字节 repr(u8) 无数据枚举，写入侧恒为合法判别值。
unsafe impl bytemuck::Pod for VrfState {}

/// Which VRF draw a street needs. Wire encoding MUST match
/// `solpoker_core::vrf::VrfTarget::to_u8` (Preflop=0..Runout=4) because it
/// feeds `caller_seed` (pinned CI vector in solpoker-core).
/// `#[repr(u8)]` + 手工 Pod impl（SAFETY 注记同 VrfState）。
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum VrfTarget {
    Preflop,
    Flop,
    Turn,
    River,
    Runout,
}

unsafe impl bytemuck::Zeroable for VrfTarget {}
// SAFETY: 见类型文档——单字节 repr(u8) 无数据枚举，写入侧恒为合法判别值。
unsafe impl bytemuck::Pod for VrfTarget {}

impl VrfTarget {
    /// Index into `Deck.vrf_out` / `Deck.vrf_attempt_used`
    /// ([preflop, flop, turn, river, runout]).
    pub fn deck_index(self) -> usize {
        match self {
            VrfTarget::Preflop => 0,
            VrfTarget::Flop => 1,
            VrfTarget::Turn => 2,
            VrfTarget::River => 3,
            VrfTarget::Runout => 4,
        }
    }

    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(VrfTarget::Preflop),
            1 => Some(VrfTarget::Flop),
            2 => Some(VrfTarget::Turn),
            3 => Some(VrfTarget::River),
            4 => Some(VrfTarget::Runout),
            _ => None,
        }
    }

    pub fn to_core(self) -> solpoker_core::vrf::VrfTarget {
        match self {
            VrfTarget::Preflop => solpoker_core::vrf::VrfTarget::Preflop,
            VrfTarget::Flop => solpoker_core::vrf::VrfTarget::Flop,
            VrfTarget::Turn => solpoker_core::vrf::VrfTarget::Turn,
            VrfTarget::River => solpoker_core::vrf::VrfTarget::River,
            VrfTarget::Runout => solpoker_core::vrf::VrfTarget::Runout,
        }
    }

    pub fn from_core(t: solpoker_core::vrf::VrfTarget) -> Self {
        match t {
            solpoker_core::vrf::VrfTarget::Preflop => VrfTarget::Preflop,
            solpoker_core::vrf::VrfTarget::Flop => VrfTarget::Flop,
            solpoker_core::vrf::VrfTarget::Turn => VrfTarget::Turn,
            solpoker_core::vrf::VrfTarget::River => VrfTarget::River,
            solpoker_core::vrf::VrfTarget::Runout => VrfTarget::Runout,
        }
    }
}

/// Public mirror of the core VRF slot (see module docs). `attempt` is 1-based
/// (core convention). `requested_at` is 0 unless state == Pending.
/// Zero-copy Pod；`_pad` 把结构补齐到 16 字节。
#[zero_copy]
#[derive(Debug, PartialEq, Eq)]
pub struct VrfSlot {
    pub requested_at: i64,
    pub state: VrfState,
    pub target: VrfTarget,
    pub attempt: u8,
    /// 显式填充：16 = 8×2。
    pub _pad: [u8; 5],
}

impl Default for VrfSlot {
    fn default() -> Self {
        VrfSlot {
            requested_at: 0,
            state: VrfState::Idle,
            target: VrfTarget::Preflop,
            attempt: 0,
            _pad: [0; 5],
        }
    }
}

impl VrfSlot {
    /// Reconstruct a core `VrfSlot` from the persisted mirror by replaying
    /// the recorded transitions. Returns None for Fulfilled/Void, which have
    /// no legal VRF transitions until advance resets the slot — callers map
    /// that to their "wrong state" error or ignore rule.
    pub fn core_replay(&self) -> Option<solpoker_core::vrf::VrfSlot> {
        use solpoker_core::vrf::VrfSlot as CoreSlot;
        let mut s = CoreSlot::new();
        match self.state {
            VrfState::Idle => Some(s),
            VrfState::Ready => {
                s.arm(self.target.to_core()).ok()?;
                Some(s)
            }
            VrfState::Pending => {
                s.arm(self.target.to_core()).ok()?;
                s.request(self.attempt, self.requested_at).ok()?;
                Some(s)
            }
            VrfState::Fulfilled | VrfState::Void => {
                // Fulfilled would need the stored randomness to reconstruct and
                // Void is terminal; neither has transitions here.
                None
            }
        }
    }

    /// Persist the result of a core transition back into the mirror.
    pub fn sync_from_core(&mut self, core: &solpoker_core::vrf::VrfSlot) {
        use solpoker_core::vrf::VrfState as CoreState;
        self.state = match core.state() {
            CoreState::Idle => VrfState::Idle,
            CoreState::Ready => VrfState::Ready,
            CoreState::Pending => VrfState::Pending,
            CoreState::Fulfilled => VrfState::Fulfilled,
            CoreState::Void => VrfState::Void,
        };
        self.target = VrfTarget::from_core(core.target());
        self.attempt = core.attempt();
        self.requested_at = core.requested_at();
    }
}

// ---------------------------------------------------------------------------
// Agent 身份（Stage 8 / 配套文档一 §2.1）
// ---------------------------------------------------------------------------

/// ProgramConfig.flags 位：开启后 register_agent 要求 OwnerAllowlist 存在
/// （主网 KYC 白名单；devnet 保持 0）。
pub const FLAG_REQUIRE_OWNER_KYC: u32 = 1 << 0;

/// AgentProfile.status
pub const AGENT_ACTIVE: u8 = 0;
pub const AGENT_PAUSED: u8 = 1;
pub const AGENT_REVOKED: u8 = 2;
pub const AGENT_BANNED: u8 = 3;

/// Agent 身份档案（配套文档一 §2.1）。PDA ["agent", agent_pubkey]，L1，永不
/// 委托；注册由 agent 与主人双签、主人付租金。`name`/`meta_uri` 一律视为
/// 不可信文本（前端与工具按纯文本渲染，不进日志）。
#[account]
#[derive(InitSpace)]
pub struct AgentProfile {
    /// agent 自己的钱包：付款、签 sit_down、读底牌。
    pub agent: Pubkey,
    /// 主人钱包（主网须在 OwnerAllowlist 内）。
    pub owner: Pubkey,
    /// 0=Owner（默认，X7）1=Agent；只有主人能改，只影响之后的入座。
    pub payout_kind: u8,
    /// AGENT_ACTIVE | AGENT_PAUSED | AGENT_REVOKED | AGENT_BANNED
    pub status: u8,
    /// 显示名（不可信文本）。
    pub name: [u8; 32],
    /// 可选：模型、作者、主页（不可信文本）。
    pub meta_uri: [u8; 96],
    pub registered_at: i64,
    pub bump: u8,
}

/// 主网 KYC 白名单条目。PDA ["owner_ok", owner]，admin 创建。存在即通过
/// （删除账户 = 撤销）。
#[account]
#[derive(InitSpace)]
pub struct OwnerAllowlist {
    pub owner: Pubkey,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// HandReplay 布局钉子：尺寸与槽位数写死在测试里，改动必须显式过这里。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod replay_layout_tests {
    use super::*;

    #[test]
    fn replay_entry_is_504_bytes_and_account_fits_cpi_limit() {
        // ReplayEntry：8 + 288 + 32 + 160 + 5 + 1 + 1 + 9 = 504（8 的整数倍，无隐式填充）
        assert_eq!(core::mem::size_of::<ReplayEntry>(), 504);
        // HandReplay：8 × 504 + 1(head) + 7(pad) = 4,040；加 8 字节 discriminator = 4,048
        assert_eq!(core::mem::size_of::<HandReplay>(), 4040);
        assert_eq!(8 + core::mem::size_of::<HandReplay>(), 4048);
        // CPI create_account 上限 10,240：留足余量
        assert!(8 + core::mem::size_of::<HandReplay>() < 10_240);
        assert_eq!(REPLAY_RING, 8);
    }

    #[test]
    fn replay_slot_cycles_over_ring() {
        // 槽位 = hand_id % RING（hand.rs 的 replay_slot 与之同义）
        let slot = |h: u64| (h as usize) % REPLAY_RING;
        assert_eq!(slot(1), 1);
        assert_eq!(slot(8), 0);
        assert_eq!(slot(9), 1);
        // 相邻两手永不撞槽
        for h in 1u64..64 {
            assert_ne!(slot(h), slot(h + 1));
        }
    }
}
