//! solpoker on-chain program — Stage 6 Phase 1 slice: full account model and
//! table setup instructions (design §3 账户模型, §4 权限矩阵, §11.1 建桌步骤).
//!
//! Scope:
//! - §3.2 full state: ProgramConfig / Table / SeatLedger (L1); Game /
//!   SeatState / HandProof / ProofEntry / Deck / PlayerHand (ER).
//! - §11.1 setup flow: `init_config` (once) → `create_table` (L1, per table)
//!   → `delegate_table` (L1, 13 accounts to TEE) → `init_permissions` (ER,
//!   Deck + PlayerHand×9 private permissions).
//! - §9 VRF 集成: `request_vrf` / `vrf_callback` / `retry_vrf` (unchanged).
//! - §6.2 V1 拆分: `act`/`advance` only arm the slot (Ready); the permissionless
//!   `request_vrf` performs the queue CPI.
//! - §5 资金流与守恒（Stage 6 Phase 2）: L1 侧 `sit_down` / `top_up` /
//!   `cash_out` / `sweep_rake` / `audit_table` / `set_session` /
//!   `revoke_session`；ER 侧 `take_seat` / `apply_deposits` / `stand_up`。
//!   守恒断言：I-ER 于每条 ER 资金指令结束，I-L1 于每条 L1 资金指令前后，
//!   I-X 由 `audit_table` 校验；纯逻辑集中在 `fund` 模块并有单元测试。
//! - §15 日志纪律: never log seeds/salts/randomness/cards; one `#[error_code]`
//!   with category-only messages.
//!
//! SDK signatures used here were verified against the published crate sources
//! (paths recorded in each module), per project discipline: do not invent API
//! signatures from memory.
//!
//! LAYOUT CONSTRAINT (Anchor 1.0): `#[program]` generates
//! `pub mod accounts { pub use crate::__client_accounts_<ix>::*; ... }`, and
//! `#[derive(Accounts)]` in 1.0.x places its `__client_accounts_*` /
//! `__cpi_client_accounts_*` modules NEXT TO the struct. The paths line up
//! only when every Accounts struct is defined at the crate root — verified
//! empirically 2026-10-05 after E0432 `unresolved import crate`. Handlers stay
//! in `src/instructions/`; only the context structs live here.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};
use ephemeral_rollups_sdk::anchor::{delegate, ephemeral};
use ephemeral_rollups_sdk::vrf::anchor::{vrf, vrf_callback};

pub mod auth;
pub mod errors;
pub mod fund;
pub mod hand;
pub mod instructions;
pub mod state;
pub mod vrf;

use state::{Deck, Game, HandProof, HandSecrets, PlayerHand, ProgramConfig, SeatLedger, Table};

// Program id pinned since Stage 0 deployment (docs/design/pubkeys.json); this
// is a real ID, not the placeholder, so PDAs and client config stay stable.
declare_id!("EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf");

// ---------------------------------------------------------------------------
// Instruction args
// ---------------------------------------------------------------------------

/// create_table 的完整牌桌配置（design §3.2 Table 字段；mint 走账户传入以做
/// owner 校验与 ATA 派生，table_id 进 seeds）。
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateTableArgs {
    pub table_id: u32,
    /// 0=Human 1=AgentOnly 2=Mixed
    pub kind: u8,
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
    pub heartbeat_s: u32,
    pub escape_stale_s: u32,
}

/// act 的玩家动作参数（§7.1；映射到 solpoker-core 的 engine::Action）。
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionArg {
    Fold,
    Check,
    Call,
    Bet(u64),
    /// 加注到的总目标额。
    RaiseTo(u64),
    AllIn,
}

// ---------------------------------------------------------------------------
// Accounts contexts (crate root — see LAYOUT CONSTRAINT above)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct RequestVrf<'info> {
    pub table: Account<'info, Table>,
    // No explicit owner override: these instructions execute on the ER, where
    // the delegated clone is owned by THIS program (the delegation program
    // only owns the L1-side record — smoke Stage 0 verified Anchor's default
    // crate::ID check passes on devnet-tee). L1-side readers of delegated
    // state (cash_out/sweep_rake, later phases) accept owner = DLP per §5.3.
    #[account(
        mut,
        seeds = [b"game", table.key().as_ref()],
        bump,
    )]
    pub game: AccountLoader<'info, Game>,
    /// Outer transaction signer paying the request (ER queue is free; the
    /// account still must be a signer for the VRF program's payer meta).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Nested VRF request accounts (queue + identity signer injected by the
    /// `#[vrf]` macro on `RequestVrfAccounts`).
    pub vrf: RequestVrfAccounts<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestVrfAccounts<'info> {
    /// VRF oracle queue. Devnet/mainnet ER queue:
    /// 5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc; local:
    /// Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT.
    /// CHECK: queue address is caller-chosen by design; the VRF program
    /// validates it against its own queue records. Must be WRITABLE — the
    /// queue appends the request (first on-chain run 2026-10-06 failed with
    /// "unauthorized writable account" until `mut` was added).
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RetryVrf<'info> {
    pub table: Account<'info, Table>,
    // ER-side instruction: delegated clone is owned by this program (see
    // RequestVrf note).
    #[account(
        mut,
        seeds = [b"game", table.key().as_ref()],
        bump,
    )]
    pub game: AccountLoader<'info, Game>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Nested VRF request accounts (same shape as `request_vrf`).
    pub vrf: RetryVrfAccounts<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RetryVrfAccounts<'info> {
    /// CHECK: caller-chosen queue; must match the queue used for the first
    /// request (keepers use the table's configured queue). WRITABLE, see
    /// RequestVrfAccounts.
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct VrfCallbackState<'info> {
    /// Private deck; only randomness lands here. Runs on the ER, where the
    /// clone is owned by this program (see RequestVrf note).
    #[account(mut)]
    pub deck: AccountLoader<'info, Deck>,
    /// Pending request slot to match against callback_args.
    #[account(mut)]
    pub game: AccountLoader<'info, Game>,
}

/// advance（§6.1/§6.2，ER，permissionless）：确定性阶段机。Deck 存随机数
/// 与抽牌状态，HandProof 写结算/作废证明，PlayerHand×9 供验盐、发底牌、
/// 读底牌结算与清零秘密（全部委托账户，ER 上归本程序所有）。
#[derive(Accounts)]
pub struct Advance<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(
        mut,
        seeds = [b"game", table.key().as_ref()],
        bump,
    )]
    pub game: AccountLoader<'info, Game>,
    #[account(
        mut,
        seeds = [b"deck", table.key().as_ref(), &table.epoch.to_be_bytes()],
        bump,
    )]
    pub deck: AccountLoader<'info, Deck>,
    #[account(
        mut,
        seeds = [b"proof", table.key().as_ref()],
        bump,
    )]
    pub hand_proof: AccountLoader<'info, HandProof>,
    #[account(
        mut,
        seeds = [b"secrets", table.key().as_ref()],
        bump,
    )]
    pub hand_secrets: AccountLoader<'info, HandSecrets>,
    #[account(mut, seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [0u8].as_ref()], bump)]
    pub hand0: Account<'info, PlayerHand>,
    #[account(mut, seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [1u8].as_ref()], bump)]
    pub hand1: Account<'info, PlayerHand>,
    #[account(mut, seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [2u8].as_ref()], bump)]
    pub hand2: Account<'info, PlayerHand>,
    #[account(mut, seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [3u8].as_ref()], bump)]
    pub hand3: Account<'info, PlayerHand>,
    #[account(mut, seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [4u8].as_ref()], bump)]
    pub hand4: Account<'info, PlayerHand>,
    #[account(mut, seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [5u8].as_ref()], bump)]
    pub hand5: Account<'info, PlayerHand>,
    #[account(mut, seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [6u8].as_ref()], bump)]
    pub hand6: Account<'info, PlayerHand>,
    #[account(mut, seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [7u8].as_ref()], bump)]
    pub hand7: Account<'info, PlayerHand>,
    #[account(mut, seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [8u8].as_ref()], bump)]
    pub hand8: Account<'info, PlayerHand>,
    pub caller: Signer<'info>,
}

/// commit_game（§10 / D8，ER，permissionless）：手与手之间把 Game + HandProof
/// 作为一个意图 commit 回 L1；intent payer 为已委托的 CommitPayer，
/// 必须传 canonical validator-scoped magic_fee_vault。
#[derive(Accounts)]
pub struct CommitGame<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(mut, seeds = [b"game", table.key().as_ref()], bump)]
    pub game: AccountLoader<'info, Game>,
    #[account(mut, seeds = [b"proof", table.key().as_ref()], bump)]
    pub hand_proof: AccountLoader<'info, HandProof>,
    /// CHECK: HandSecrets（与 HandProof 配套的盐/VRF 环，一并 commit）。
    #[account(mut, seeds = [b"secrets", table.key().as_ref()], bump)]
    pub hand_secrets: AccountLoader<'info, HandSecrets>,
    /// CHECK: 委托的 CommitPayer PDA，作为 intent payer 由程序 invoke_signed。
    #[account(mut, seeds = [b"commit_payer", table.key().as_ref()], bump)]
    pub commit_payer: UncheckedAccount<'info>,
    /// CHECK: magic context（validator 的意图上下文账户）。
    #[account(mut, address = ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: magic program。
    #[account(address = ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: canonical magic fee vault（handler 用 dlp_api 推导校验）。
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

// --- Stage 6 Phase 3: 手牌循环（design §6/§7/§8，ER） ---

/// commit_salt（§8.2，ER；occupant 或 session key）。
#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct CommitSalt<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(mut, seeds = [b"game", table.key().as_ref()], bump)]
    pub game: AccountLoader<'info, Game>,
    /// CHECK: SeatLedger 的 ER 只读克隆（会话鉴权；见 TakeSeat）。
    #[account(seeds = [b"seat", table.key().as_ref(), &[idx]], bump)]
    pub seat_ledger: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
}

/// reveal_salt（§8.2 / D6，ER；occupant 或 session key）。只写本人
/// PlayerHand，不引用 Game。
#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct RevealSalt<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    /// CHECK: SeatLedger 的 ER 只读克隆（ledger-only 鉴权，D6）。
    #[account(seeds = [b"seat", table.key().as_ref(), &[idx]], bump)]
    pub seat_ledger: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), &[idx]],
        bump,
    )]
    pub player_hand: Account<'info, PlayerHand>,
    pub signer: Signer<'info>,
}

/// act（§7.1，ER；occupant 或 session key）。
#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct Act<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(mut, seeds = [b"game", table.key().as_ref()], bump)]
    pub game: AccountLoader<'info, Game>,
    /// CHECK: SeatLedger 的 ER 只读克隆（会话鉴权；见 TakeSeat）。
    #[account(seeds = [b"seat", table.key().as_ref(), &[idx]], bump)]
    pub seat_ledger: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
}

/// claim_timeout（§6.3，ER，permissionless，截止时间过后）。
#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(mut, seeds = [b"game", table.key().as_ref()], bump)]
    pub game: AccountLoader<'info, Game>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct DebugArmVrf<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(
        mut,
        seeds = [b"game", table.key().as_ref()],
        bump,
        constraint = table.admin == admin.key() @ errors::SolpokerError::Unauthorized,
    )]
    pub game: AccountLoader<'info, Game>,
    pub admin: Signer<'info>,
}

// --- Stage 6 Phase 1: 建桌流程（design §11.1） ---

/// init_config（一次性）：ProgramConfig PDA + DelegPayer（D3）。
#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + ProgramConfig::INIT_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, ProgramConfig>,
    /// CHECK: DelegPayer（D3）——0 字节系统账户 PDA ["deleg_payer"]，委托租金
    /// 的 L1 付款人。Anchor 的 `init` 会把 owner 设为本程序（那样它不能作为
    /// system transfer/create_account 的付款来源），所以账户在 handler 里用
    /// 系统 CPI 手工创建（owner = system program）。
    #[account(mut, seeds = [b"deleg_payer"], bump)]
    pub deleg_payer: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// create_table（§11.1 第 1 步，L1）：Table、TableVault、SeatLedger×9、
/// CommitPayer、Game、HandProof、Deck、PlayerHand×9。
#[derive(Accounts)]
#[instruction(args: CreateTableArgs)]
pub struct CreateTable<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Table::INIT_SPACE,
        seeds = [b"table", args.table_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub table: Account<'info, Table>,
    /// CHECK: vault_auth 不建账户（§3.1），只是签名 PDA ["vault_auth", table]；
    /// 这里传入是为了 ATA 派生与 bump 记录。
    #[account(seeds = [b"vault_auth", table.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    /// TableVault = ATA(vault_auth, mint)（§3.1，永不委托）。Anchor 的
    /// associated_token init 糖通过 ATA 程序 CPI 创建。
    #[account(
        init,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = vault_auth,
    )]
    pub vault: Account<'info, TokenAccount>,
    /// mint 校验：`Account<Mint>`（anchor-spl classic token）的 owner 检查即
    /// 要求 owner == spl_token::ID —— Token-2022 mint（可能带转账手续费或
    /// transfer hook 扩展）在这里直接被拒（§3.2 mint 注记；Token-2022 支持
    /// 是 E4 之后再做）。
    pub mint: Account<'info, Mint>,
    // --- ER 常驻账户（delegate_table 委托后生效）。Zero-copy 账户：无 borsh
    // 反序列化，init 用 8 + size_of（discriminator ‖ repr(C) 字节），handler
    // 里 load_init()。
    #[account(
        init,
        payer = admin,
        space = 8 + std::mem::size_of::<Game>(),
        seeds = [b"game", table.key().as_ref()],
        bump,
    )]
    pub game: AccountLoader<'info, Game>,
    // HandProof / HandSecrets 拆分后都低于 10,240B（3,720 / 7,304），直接
    // CPI init，不再需要 realloc_proof 的跨交易扩容（2026-10-07 拆分记录，
    // 见 state.rs）。
    #[account(
        init,
        payer = admin,
        space = 8 + std::mem::size_of::<HandProof>(),
        seeds = [b"proof", table.key().as_ref()],
        bump,
    )]
    pub hand_proof: AccountLoader<'info, HandProof>,
    #[account(
        init,
        payer = admin,
        space = 8 + std::mem::size_of::<HandSecrets>(),
        seeds = [b"secrets", table.key().as_ref()],
        bump,
    )]
    pub hand_secrets: AccountLoader<'info, HandSecrets>,
    // 新桌 epoch 恒为 0，seed 里直接写字面量（init 时读不到 table.epoch）。
    #[account(
        init,
        payer = admin,
        space = 8 + std::mem::size_of::<Deck>(),
        seeds = [b"deck", table.key().as_ref(), [0u8, 0u8].as_ref()],
        bump,
    )]
    pub deck: AccountLoader<'info, Deck>,
    /// CHECK: commit payer PDA（D8：程序所有、0 字节，委托后支付 ER 内
    /// 租金/费用——ER 规则要求被修改的付款账户必须是委托账户）。账户由
    /// handler 创建（create_account + 注资；把这份 init 闭包留在
    /// try_accounts 里会让生成的帧超过 SBF 4096 字节预算——只差 8 字节，
    // 但预算没有商量余地）；地址断言在创建辅助函数里做。
    #[account(mut)]
    pub commit_payer: UncheckedAccount<'info>,
    /// 过渡期门禁：签名者即 Table.admin（生产鉴权改走 ProgramConfig.admin，
    /// 后续 Phase 接入）。
    #[account(mut)]
    pub admin: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// create_seats（§11.1 第 1 步补，L1）：创建 SeatLedger×9。从 create_table
/// 拆出（31 账户单一 create_table 的 try_accounts 帧超 SBF 4096B 栈预算，
/// 溢出污染 args——2026-10-07 实测确诊，见 create_table.rs 模块头）。
#[derive(Accounts)]
pub struct CreateSeats<'info> {
    #[account(
        seeds = [b"table", table.table_id.to_le_bytes().as_ref()],
        bump = table.bump,
        constraint = table.admin == admin.key() @ errors::SolpokerError::Unauthorized,
    )]
    pub table: Account<'info, Table>,
    /// CHECK: SeatLedger PDA ["seat", table, 0]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub seat0: UncheckedAccount<'info>,
    /// CHECK: SeatLedger PDA ["seat", table, 1]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub seat1: UncheckedAccount<'info>,
    /// CHECK: SeatLedger PDA ["seat", table, 2]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub seat2: UncheckedAccount<'info>,
    /// CHECK: SeatLedger PDA ["seat", table, 3]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub seat3: UncheckedAccount<'info>,
    /// CHECK: SeatLedger PDA ["seat", table, 4]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub seat4: UncheckedAccount<'info>,
    /// CHECK: SeatLedger PDA ["seat", table, 5]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub seat5: UncheckedAccount<'info>,
    /// CHECK: SeatLedger PDA ["seat", table, 6]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub seat6: UncheckedAccount<'info>,
    /// CHECK: SeatLedger PDA ["seat", table, 7]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub seat7: UncheckedAccount<'info>,
    /// CHECK: SeatLedger PDA ["seat", table, 8]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub seat8: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// create_hands（§11.1 第 1 步补，L1）：创建 PlayerHand×9。拆分原因同上。
#[derive(Accounts)]
pub struct CreateHands<'info> {
    #[account(
        seeds = [b"table", table.table_id.to_le_bytes().as_ref()],
        bump = table.bump,
        constraint = table.admin == admin.key() @ errors::SolpokerError::Unauthorized,
    )]
    pub table: Account<'info, Table>,
    /// CHECK: PlayerHand PDA ["hand", table, 0, 0]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub hand0: UncheckedAccount<'info>,
    /// CHECK: PlayerHand PDA ["hand", table, 0, 1]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub hand1: UncheckedAccount<'info>,
    /// CHECK: PlayerHand PDA ["hand", table, 0, 2]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub hand2: UncheckedAccount<'info>,
    /// CHECK: PlayerHand PDA ["hand", table, 0, 3]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub hand3: UncheckedAccount<'info>,
    /// CHECK: PlayerHand PDA ["hand", table, 0, 4]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub hand4: UncheckedAccount<'info>,
    /// CHECK: PlayerHand PDA ["hand", table, 0, 5]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub hand5: UncheckedAccount<'info>,
    /// CHECK: PlayerHand PDA ["hand", table, 0, 6]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub hand6: UncheckedAccount<'info>,
    /// CHECK: PlayerHand PDA ["hand", table, 0, 7]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub hand7: UncheckedAccount<'info>,
    /// CHECK: PlayerHand PDA ["hand", table, 0, 8]；handler 派生并断言地址后创建。
    #[account(mut)]
    pub hand8: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// delegate_table（§11.1 第 2 步，L1）：每次调用委托**一个**常驻账户给 TEE
/// validator——`del_index` 选择目标：0=CommitPayer、1=Game、2=HandProof、
/// 3=Deck、4..=12=PlayerHand[del_index-4]。建桌脚本在同一笔交易里连发 13 次
/// 调用。拆分的动机：13 账户上下文 + 循环 CPI 的 handler 帧远超 SBF 4096 字节
/// 栈预算（帧覆盖告警 15 处）。
///
/// 委托租金由 L1-only 的 DelegPayer（D3，程序 PDA，seeds 签名）支付；
/// buffer/record/metadata 三类派生账户由 `#[delegate]` 宏生成并校验（seeds
/// 随 `target.key()` 动态派生）；被委托 PDA 本身的地址在 handler 里按
/// del_index 重建并断言。
///
/// 注意：`#[delegate]` 宏同时生成 `delegate_target(&Signer, …)` 方法，但那
/// 要求付款人是外部签名者；DelegPayer 是 PDA，所以 handler 直接调用
/// `ephemeral_rollups_sdk::cpi` 的原语并带上 DelegPayer 的签名 seeds
/// （见 instructions/delegate_table.rs）。
#[delegate]
#[derive(Accounts)]
#[instruction(validator: Pubkey, del_index: u8)]
pub struct DelegateTable<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    /// CHECK: DelegPayer（D3），seeds 约束即地址断言；租金付款人。
    #[account(mut, seeds = [b"deleg_payer"], bump)]
    pub deleg_payer: UncheckedAccount<'info>,
    /// CHECK: 本次调用要委托的单个账户（del_index 选择）；地址由 handler 按
    /// (table, epoch, del_index) 重建并断言。委托后 owner 移交 delegation
    /// program，因此必须是不序列化的 UncheckedAccount（见宏的 `del` 约束）。
    #[account(
        mut, del,
        constraint = table.admin == admin.key() @ errors::SolpokerError::Unauthorized,
    )]
    pub target: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
}

/// init_permissions（§11.1 第 3 步，ER）：Deck + PlayerHand×9 共 10 个 PER
/// 私有权限。幂等：已存在的权限账户跳过。
#[derive(Accounts)]
pub struct InitPermissions<'info> {
    #[account(
        seeds = [b"table", table.table_id.to_le_bytes().as_ref()],
        bump = table.bump,
        constraint = table.admin == admin.key() @ errors::SolpokerError::Unauthorized,
    )]
    pub table: Account<'info, Table>,
    /// CHECK: deck PDA；用 seeds 为权限创建 CPI 签名。
    #[account(seeds = [b"deck", table.key().as_ref(), &table.epoch.to_be_bytes()], bump)]
    pub deck: UncheckedAccount<'info>,
    /// CHECK: player hand PDA ×9（空座 members = []，换人时按 §11.2 更新）。
    #[account(seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [0u8].as_ref()], bump)]
    pub hand0: UncheckedAccount<'info>,
    /// CHECK: player hand PDA（seeds 约束即地址断言）。
    #[account(seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [1u8].as_ref()], bump)]
    pub hand1: UncheckedAccount<'info>,
    /// CHECK: player hand PDA（seeds 约束即地址断言）。
    #[account(seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [2u8].as_ref()], bump)]
    pub hand2: UncheckedAccount<'info>,
    /// CHECK: player hand PDA（seeds 约束即地址断言）。
    #[account(seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [3u8].as_ref()], bump)]
    pub hand3: UncheckedAccount<'info>,
    /// CHECK: player hand PDA（seeds 约束即地址断言）。
    #[account(seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [4u8].as_ref()], bump)]
    pub hand4: UncheckedAccount<'info>,
    /// CHECK: player hand PDA（seeds 约束即地址断言）。
    #[account(seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [5u8].as_ref()], bump)]
    pub hand5: UncheckedAccount<'info>,
    /// CHECK: player hand PDA（seeds 约束即地址断言）。
    #[account(seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [6u8].as_ref()], bump)]
    pub hand6: UncheckedAccount<'info>,
    /// CHECK: player hand PDA（seeds 约束即地址断言）。
    #[account(seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [7u8].as_ref()], bump)]
    pub hand7: UncheckedAccount<'info>,
    /// CHECK: player hand PDA（seeds 约束即地址断言）。
    #[account(seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), [8u8].as_ref()], bump)]
    pub hand8: UncheckedAccount<'info>,
    /// CHECK: 权限程序为 deck 派生的权限 PDA。seeds 校验在 handler 循环里
    /// 做（10 组 permission seeds 约束会把 try_accounts 的栈帧顶过 SBF
    /// 4096 字节预算；校验逻辑不变，只是换了位置）。
    #[account(mut)]
    pub permission_deck: UncheckedAccount<'info>,
    /// CHECK: 权限程序为各 PlayerHand 派生的权限 PDA；handler 里校验地址。
    #[account(mut)]
    pub permission_hand0: UncheckedAccount<'info>,
    /// CHECK: 权限程序为 PlayerHand 派生的权限 PDA；handler 里校验地址。
    #[account(mut)]
    pub permission_hand1: UncheckedAccount<'info>,
    /// CHECK: 权限程序为 PlayerHand 派生的权限 PDA；handler 里校验地址。
    #[account(mut)]
    pub permission_hand2: UncheckedAccount<'info>,
    /// CHECK: 权限程序为 PlayerHand 派生的权限 PDA；handler 里校验地址。
    #[account(mut)]
    pub permission_hand3: UncheckedAccount<'info>,
    /// CHECK: 权限程序为 PlayerHand 派生的权限 PDA；handler 里校验地址。
    #[account(mut)]
    pub permission_hand4: UncheckedAccount<'info>,
    /// CHECK: 权限程序为 PlayerHand 派生的权限 PDA；handler 里校验地址。
    #[account(mut)]
    pub permission_hand5: UncheckedAccount<'info>,
    /// CHECK: 权限程序为 PlayerHand 派生的权限 PDA；handler 里校验地址。
    #[account(mut)]
    pub permission_hand6: UncheckedAccount<'info>,
    /// CHECK: 权限程序为 PlayerHand 派生的权限 PDA；handler 里校验地址。
    #[account(mut)]
    pub permission_hand7: UncheckedAccount<'info>,
    /// CHECK: 权限程序为 PlayerHand 派生的权限 PDA；handler 里校验地址。
    #[account(mut)]
    pub permission_hand8: UncheckedAccount<'info>,
    /// CHECK: rent vault for ephemeral accounts (collects permission rent).
    #[account(mut, address = ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the magic program.
    #[account(address = ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: the permission program (access control, ACLseo…).
    #[account(address = ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: 委托的 commit payer PDA，付权限账户租金（Stage 3 实测：ER 要求
    /// 被扣款的付款人必须是委托账户，未委托的 deployer 会被拒）。
    #[account(
        mut,
        seeds = [b"commit_payer", table.key().as_ref()],
        bump,
    )]
    pub commit_payer: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// admin_set_members（§11.2 过渡版，ER，table.admin 门禁）：更新 Deck 或
/// PlayerHand[i] 的 PER 成员。权限的 authority 是被权限账户自身（创建时由
/// PDA 签名），所以只能由本程序以 PDA invoke_signed 更新。
/// 背景：devnet-tee 拒绝「写 PER 私有账户而签名者非成员」的交易（顶层
/// InvalidWritableAccount）；Anchor 对 mut borsh 账户成功退出时无条件写回，
/// 因此 advance 的 crank 签名者必须是 deck + 全部 hand 的成员。
/// 成员模型（Stage 6）：deck ← [crank/admin]（绝不加玩家——含全部盐与 VRF
/// 输出）；hand_i ← [crank/admin, 占用者_i]（自读无害，reveal 需要）。
#[derive(Accounts)]
pub struct AdminSetMembers<'info> {
    #[account(
        seeds = [b"table", table.table_id.to_le_bytes().as_ref()],
        bump = table.bump,
        constraint = table.admin == admin.key() @ errors::SolpokerError::Unauthorized,
    )]
    pub table: Account<'info, Table>,
    /// CHECK: 目标账户（deck 或 hand PDA）；handler 内按 target_index 推导断言。
    pub target: UncheckedAccount<'info>,
    /// CHECK: 目标账户的 permission PDA；handler 内断言。
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: 委托的 commit payer PDA，付 PER 费用（ER 要求付款人已委托）。
    #[account(
        mut,
        seeds = [b"commit_payer", table.key().as_ref()],
        bump,
    )]
    pub commit_payer: UncheckedAccount<'info>,
    /// CHECK: rent vault for ephemeral accounts.
    #[account(mut, address = ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the magic program.
    #[account(address = ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: the permission program (access control, ACLseo…)。
    #[account(address = ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
}

// --- Stage 6 Phase 2: 资金流与守恒（design §5） ---
// L1 资金指令的 TableVault 一律是 ATA(vault_auth, mint)，地址用显式
// get_associated_token_address 约束钉死；mint 用 Account<Mint> 传入以取
// decimals（transfer_checked 需要）。委托账户（Game）在 L1 上以
// UncheckedAccount 传入，owner/discriminator/长度由 fund::read_game_snapshot
// 手工校验（§5.3）；SeatLedger 在 ER 上以只读克隆传入，同款手工校验。

/// sit_down（§5.2.1，L1）：占用者钱包签名，买入 USDC → TableVault。
#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct SitDown<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(mut, seeds = [b"seat", table.key().as_ref(), &[idx]], bump)]
    pub seat: Account<'info, SeatLedger>,
    /// CHECK: vault_auth 签名 PDA（不建账户，§3.1）；此处仅作 ATA 派生。
    #[account(seeds = [b"vault_auth", table.key().as_ref()], bump = table.vault_auth_bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(
        mut,
        address = anchor_spl::associated_token::get_associated_token_address(&vault_auth.key(), &mint.key()),
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = table.mint)]
    pub mint: Account<'info, Mint>,
    /// 占用者本人的 ATA（资金来源）。
    #[account(
        mut,
        address = anchor_spl::associated_token::get_associated_token_address(&payer.key(), &mint.key()),
    )]
    pub player_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// top_up（§5.2.3，L1）：占用者本人补码。
#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct TopUp<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(mut, seeds = [b"seat", table.key().as_ref(), &[idx]], bump)]
    pub seat: Account<'info, SeatLedger>,
    /// CHECK: vault_auth 签名 PDA；此处仅作 ATA 派生。
    #[account(seeds = [b"vault_auth", table.key().as_ref()], bump = table.vault_auth_bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(
        mut,
        address = anchor_spl::associated_token::get_associated_token_address(&vault_auth.key(), &mint.key()),
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = table.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        address = anchor_spl::associated_token::get_associated_token_address(&payer.key(), &mint.key()),
    )]
    pub player_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// take_seat（§5.2.2，ER，permissionless）：把 L1 买入计入 ER 筹码。
#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct TakeSeat<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(mut, seeds = [b"game", table.key().as_ref()], bump)]
    pub game: AccountLoader<'info, Game>,
    /// CHECK: SeatLedger 的 ER 只读克隆（D1：L1 账户，永不委托）。地址由
    /// seeds 钉死；owner/discriminator/字段由 fund::read_seat_ledger_clone
    /// 手工校验。
    #[account(seeds = [b"seat", table.key().as_ref(), &[idx]], bump)]
    pub seat_ledger: UncheckedAccount<'info>,
    /// PlayerHand PDA；Phase 2 只读校验「已清零」（PER 成员替换是 Phase 3）。
    #[account(seeds = [b"hand", table.key().as_ref(), &table.epoch.to_be_bytes(), &[idx]], bump)]
    pub player_hand: Account<'info, PlayerHand>,
    pub caller: Signer<'info>,
}

/// apply_deposits（§5.2.4，ER，permissionless）：补码入账 / 超额转 owed。
#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct ApplyDeposits<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(mut, seeds = [b"game", table.key().as_ref()], bump)]
    pub game: AccountLoader<'info, Game>,
    /// CHECK: SeatLedger 的 ER 只读克隆（见 TakeSeat）。
    #[account(seeds = [b"seat", table.key().as_ref(), &[idx]], bump)]
    pub seat_ledger: UncheckedAccount<'info>,
    pub caller: Signer<'info>,
}

/// stand_up（§5.2.5，ER）：session key 或占用者钱包签名。
#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct StandUp<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    #[account(mut, seeds = [b"game", table.key().as_ref()], bump)]
    pub game: AccountLoader<'info, Game>,
    /// CHECK: SeatLedger 的 ER 只读克隆（会话鉴权 + 未计入补码；见 TakeSeat）。
    #[account(seeds = [b"seat", table.key().as_ref(), &[idx]], bump)]
    pub seat_ledger: UncheckedAccount<'info>,
    pub signer: Signer<'info>,
}

/// cash_out（§5.2.6，L1，permissionless）：按 Game 快照兑付 owed。
#[derive(Accounts)]
#[instruction(idx: u8)]
pub struct CashOut<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    /// CHECK: Game 快照（§5.3）：地址由 seeds 钉死，owner ∈ {DELeGG…, 本程序}、
    /// discriminator、borsh 均由 fund::read_game_snapshot 手工校验。委托期间
    /// 数据是最后一次 commit 的快照。
    #[account(seeds = [b"game", table.key().as_ref()], bump)]
    pub game: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"seat", table.key().as_ref(), &[idx]], bump)]
    pub seat: Account<'info, SeatLedger>,
    /// CHECK: vault_auth PDA，出金转账的签名权威。
    #[account(seeds = [b"vault_auth", table.key().as_ref()], bump = table.vault_auth_bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(
        mut,
        address = anchor_spl::associated_token::get_associated_token_address(&vault_auth.key(), &mint.key()),
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = table.mint)]
    pub mint: Account<'info, Mint>,
    /// X7：只付 ATA(SeatLedger.payout, mint)。
    #[account(
        mut,
        address = anchor_spl::associated_token::get_associated_token_address(&seat.payout, &mint.key()),
    )]
    pub payout_ata: Account<'info, TokenAccount>,
    pub caller: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// sweep_rake（§5.2.7，L1，permissionless）：按快照把 rake 划到 treasury。
#[derive(Accounts)]
pub struct SweepRake<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProgramConfig>,
    #[account(mut, seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    /// CHECK: Game 快照（§5.3，见 CashOut）。
    #[account(seeds = [b"game", table.key().as_ref()], bump)]
    pub game: UncheckedAccount<'info>,
    /// CHECK: vault_auth PDA，出金转账的签名权威。
    #[account(seeds = [b"vault_auth", table.key().as_ref()], bump = table.vault_auth_bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(
        mut,
        address = anchor_spl::associated_token::get_associated_token_address(&vault_auth.key(), &mint.key()),
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = table.mint)]
    pub mint: Account<'info, Mint>,
    /// ATA(ProgramConfig.treasury, mint)。
    #[account(
        mut,
        address = anchor_spl::associated_token::get_associated_token_address(&config.treasury, &mint.key()),
    )]
    pub treasury_ata: Account<'info, TokenAccount>,
    pub caller: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// audit_table（§5.4 I-X，L1，permissionless，只读）。
#[derive(Accounts)]
pub struct AuditTable<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    /// CHECK: Game 快照（§5.3，见 CashOut）。
    #[account(seeds = [b"game", table.key().as_ref()], bump)]
    pub game: UncheckedAccount<'info>,
    /// CHECK: vault_auth PDA；此处仅作 ATA 派生。
    #[account(seeds = [b"vault_auth", table.key().as_ref()], bump = table.vault_auth_bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(
        address = anchor_spl::associated_token::get_associated_token_address(&vault_auth.key(), &table.mint),
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: SeatLedger PDA（L1，永不委托）；地址由 seeds 钉死，owner/
    /// discriminator/长度由 fund::read_seat_ledger_l1 在 handler 里校验。
    /// 不用 `Account<SeatLedger>`：9 份 borsh 反序列化会把 try_accounts 的
    /// 栈帧顶过 SBF 4096 字节预算。
    #[account(seeds = [b"seat", table.key().as_ref(), [0u8].as_ref()], bump)]
    pub seat0: UncheckedAccount<'info>,
    /// CHECK: 见 seat0。
    #[account(seeds = [b"seat", table.key().as_ref(), [1u8].as_ref()], bump)]
    pub seat1: UncheckedAccount<'info>,
    /// CHECK: 见 seat0。
    #[account(seeds = [b"seat", table.key().as_ref(), [2u8].as_ref()], bump)]
    pub seat2: UncheckedAccount<'info>,
    /// CHECK: 见 seat0。
    #[account(seeds = [b"seat", table.key().as_ref(), [3u8].as_ref()], bump)]
    pub seat3: UncheckedAccount<'info>,
    /// CHECK: 见 seat0。
    #[account(seeds = [b"seat", table.key().as_ref(), [4u8].as_ref()], bump)]
    pub seat4: UncheckedAccount<'info>,
    /// CHECK: 见 seat0。
    #[account(seeds = [b"seat", table.key().as_ref(), [5u8].as_ref()], bump)]
    pub seat5: UncheckedAccount<'info>,
    /// CHECK: 见 seat0。
    #[account(seeds = [b"seat", table.key().as_ref(), [6u8].as_ref()], bump)]
    pub seat6: UncheckedAccount<'info>,
    /// CHECK: 见 seat0。
    #[account(seeds = [b"seat", table.key().as_ref(), [7u8].as_ref()], bump)]
    pub seat7: UncheckedAccount<'info>,
    /// CHECK: 见 seat0。
    #[account(seeds = [b"seat", table.key().as_ref(), [8u8].as_ref()], bump)]
    pub seat8: UncheckedAccount<'info>,
    pub caller: Signer<'info>,
}

/// set_session（D2，L1）：占用者设置/替换会话密钥。
#[derive(Accounts)]
pub struct SetSession<'info> {
    #[account(
        mut,
        seeds = [b"seat", seat.table.as_ref(), &[seat.idx]],
        bump = seat.bump,
    )]
    pub seat: Account<'info, SeatLedger>,
    pub payer: Signer<'info>,
}

/// revoke_session（D2，L1）：占用者撤销会话密钥。
#[derive(Accounts)]
pub struct RevokeSession<'info> {
    #[account(
        mut,
        seeds = [b"seat", seat.table.as_ref(), &[seat.idx]],
        bump = seat.bump,
    )]
    pub seat: Account<'info, SeatLedger>,
    pub payer: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[ephemeral]
#[program]
pub mod solpoker {
    use super::*;

    /// Permissionless VRF request (ER). Only succeeds when `Game.vrf` is Ready;
    /// transitions the slot to Pending atomically with the CPI.
    pub fn request_vrf(ctx: Context<RequestVrf>) -> Result<()> {
        instructions::request_vrf::handler(ctx)
    }

    /// VRF fulfillment callback. Authenticated by the scoped VRF identity PDA
    /// (injected by `#[vrf_callback]`); stale/mismatched requests are ignored
    /// with `Ok(())`. Only writes randomness into Deck — never logs it.
    pub fn vrf_callback(
        ctx: Context<VrfCallbackState>,
        randomness: [u8; 32],
        callback_args: Vec<u8>,
    ) -> Result<()> {
        instructions::vrf_callback::handler(ctx, randomness, callback_args)
    }

    /// Permissionless retry after `vrf_timeout_s` elapsed since `requested_at`.
    /// Increments the attempt and re-requests with a fresh caller_seed.
    pub fn retry_vrf(ctx: Context<RetryVrf>) -> Result<()> {
        instructions::retry_vrf::handler(ctx)
    }

    /// Deterministic phase machine (§6.1/§6.2, ER, permissionless). One
    /// transition per call: freeze hand_mask → arm VRF_0 → verify salts & deal
    /// hole → deal streets/runout → settle or void → HandProof + zero secrets.
    /// Never issues VRF CPIs (V1 拆分: request_vrf/retry_vrf do).
    pub fn advance(ctx: Context<Advance>, hand_id: u64) -> Result<()> {
        instructions::advance::handler(ctx, hand_id)
    }

    /// 手与手之间把 Game + HandProof commit 回 L1（§10 / D8，ER，
    /// permissionless；intent payer = 委托的 CommitPayer + canonical
    /// magic_fee_vault）。
    pub fn commit_game(ctx: Context<CommitGame>) -> Result<()> {
        instructions::commit_game::handler(ctx)
    }

    /// 一次性全局初始化（§11.1 前置）：ProgramConfig + DelegPayer。
    pub fn init_config(
        ctx: Context<InitConfig>,
        treasury: Pubkey,
        tee_validator: Pubkey,
        gateway: Pubkey,
    ) -> Result<()> {
        instructions::init_config::handler(ctx, treasury, tee_validator, gateway)
    }

    /// §11.1 第 1 步（L1）：创建一张桌的全部账户。
    pub fn create_table(ctx: Context<CreateTable>, args: CreateTableArgs) -> Result<()> {
        instructions::create_table::handler(ctx, args)
    }

    /// §11.1 第 1 步补（L1）：创建 SeatLedger×9（拆自 create_table——
    /// try_accounts 帧溢出修复，见 create_table.rs 模块头）。
    pub fn create_seats(ctx: Context<CreateSeats>) -> Result<()> {
        instructions::create_seats::handler(ctx)
    }

    /// §11.1 第 1 步补（L1）：创建 PlayerHand×9（拆自 create_table，同上）。
    pub fn create_hands(ctx: Context<CreateHands>) -> Result<()> {
        instructions::create_hands::handler(ctx)
    }

    /// §11.1 第 2 步（L1）：每次调用委托一个常驻账户（del_index 选择：
    /// 0=CommitPayer、1=Game、2=HandProof、3=HandSecrets、4=Deck、
    /// 5..=13=PlayerHand[i-5]）。建桌脚本在一笔交易里连发 14 次。
    pub fn delegate_table(
        ctx: Context<DelegateTable>,
        validator: Pubkey,
        del_index: u8,
    ) -> Result<()> {
        instructions::delegate_table::handler(ctx, validator, del_index)
    }

    /// §11.1 第 3 步（ER）：创建 Deck + PlayerHand×9 的 PER 私有权限（幂等）。
    pub fn init_permissions(ctx: Context<InitPermissions>) -> Result<()> {
        instructions::init_permissions::handler(ctx)
    }

    /// admin_set_members（§11.2 过渡版，ER）：更新 Deck/PlayerHand 的 PER
    /// 成员列表；target_index 0 = deck，1..=9 = hand[i-1]。
    pub fn admin_set_members(
        ctx: Context<AdminSetMembers>,
        target_index: u8,
        member_pubkeys: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::admin_set_members::handler(ctx, target_index, member_pubkeys)
    }

    /// Test harness（Stage 2/3 保留，后续 Phase 移除）：ER 上手动 arm VRF
    /// 槽位（生产路径是 advance 的 phase 机决定 arm）。
    pub fn debug_arm_vrf(ctx: Context<DebugArmVrf>, target: u8) -> Result<()> {
        instructions::debug_arm_vrf::handler(ctx, target)
    }

    // --- Stage 6 Phase 2: 资金流与守恒（design §5） ---

    /// §5.2.1（L1）：入座。占用者 ATA → TableVault，写 SeatLedger，
    /// deposited_total += buy_in。断言 I-L1。
    pub fn sit_down(
        ctx: Context<SitDown>,
        idx: u8,
        buy_in: u64,
        session_key: Pubkey,
        session_expires_at: i64,
    ) -> Result<()> {
        instructions::sit_down::handler(ctx, idx, buy_in, session_key, session_expires_at)
    }

    /// §5.2.3（L1）：占用者本人补码，deposited_total += amount。断言 I-L1。
    pub fn top_up(ctx: Context<TopUp>, idx: u8, amount: u64) -> Result<()> {
        instructions::top_up::handler(ctx, idx, amount)
    }

    /// §5.2.2（ER，permissionless）：读 SeatLedger 克隆，把买入计入筹码。
    /// 断言 I-ER。
    pub fn take_seat(ctx: Context<TakeSeat>, idx: u8) -> Result<()> {
        instructions::take_seat::handler(ctx, idx)
    }

    /// §5.2.4（ER，permissionless）：补码入账，超额部分记 owed。断言 I-ER。
    pub fn apply_deposits(ctx: Context<ApplyDeposits>, idx: u8) -> Result<()> {
        instructions::apply_deposits::handler(ctx, idx)
    }

    /// §5.2.5（ER；session key 或占用者签名）：手牌中 = 立即 fold；手牌边界
    /// = owed += stack、状态 Left、安排 commit。断言 I-ER。
    pub fn stand_up(ctx: Context<StandUp>, idx: u8) -> Result<()> {
        instructions::stand_up::handler(ctx, idx)
    }

    /// §5.2.6（L1，permissionless）：按 Game 快照付 owed − paid 到
    /// ATA(payout, mint)；条件满足时释放座位。断言 I-L1、I-B。
    pub fn cash_out(ctx: Context<CashOut>, idx: u8) -> Result<()> {
        instructions::cash_out::handler(ctx, idx)
    }

    /// §5.2.7（L1，permissionless）：按快照把 rake 划到 treasury ATA。
    /// 断言 I-L1、I-B。
    pub fn sweep_rake(ctx: Context<SweepRake>) -> Result<()> {
        instructions::sweep_rake::handler(ctx)
    }

    /// §5.4（L1，permissionless，只读）：校验 I-X 跨层守恒并报告盈余。
    pub fn audit_table(ctx: Context<AuditTable>) -> Result<()> {
        instructions::audit_table::handler(ctx)
    }

    /// D2（L1，占用者）：设置/替换 session_key 与有效期（≤ now + 7 天）。
    pub fn set_session(
        ctx: Context<SetSession>,
        session_key: Pubkey,
        session_expires_at: i64,
    ) -> Result<()> {
        instructions::session::set_handler(ctx, session_key, session_expires_at)
    }

    /// D2（L1，占用者）：撤销 session_key。
    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        instructions::session::revoke_handler(ctx)
    }

    // --- Stage 6 Phase 3: 手牌循环（design §6/§7/§8，ER） ---

    /// §8.2（ER；occupant 或 session key）：提交本手（phase Idle/Commit）或
    /// 下一手（进行中，写 next_salt_commit）的盐承诺。
    pub fn commit_salt(
        ctx: Context<CommitSalt>,
        idx: u8,
        hand_id: u64,
        commitment: [u8; 32],
    ) -> Result<()> {
        instructions::commit_salt::handler(ctx, idx, hand_id, commitment)
    }

    /// §8.2 / D6（ER；occupant 或 session key）：揭示盐，只写本人 PlayerHand。
    pub fn reveal_salt(
        ctx: Context<RevealSalt>,
        idx: u8,
        hand_id: u64,
        salt: [u8; 32],
    ) -> Result<()> {
        instructions::reveal_salt::handler(ctx, idx, hand_id, salt)
    }

    /// §7.1（ER；occupant 或 session key）：fold/check/call/bet/raise/all-in。
    /// 参数带 hand_id + action_seq（X8）。断言 I-ER。
    pub fn act(
        ctx: Context<Act>,
        idx: u8,
        hand_id: u64,
        action_seq: u32,
        action: ActionArg,
    ) -> Result<()> {
        instructions::act::handler(ctx, idx, hand_id, action_seq, action)
    }

    /// §6.3（ER，permissionless，截止时间过后）：能 check 就 check，否则
    /// fold；记超时次数。断言 I-ER。
    pub fn claim_timeout(ctx: Context<ClaimTimeout>, hand_id: u64) -> Result<()> {
        instructions::claim_timeout::handler(ctx, hand_id)
    }
}
