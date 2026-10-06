//! solpoker on-chain program — Stage 2 slice (VRF in the TEE Ephemeral Rollup).
//!
//! Scope (design doc `solpoker-stage1-design.md`):
//! - §9 VRF 集成: `request_vrf` / `vrf_callback` / `retry_vrf`
//! - §6.2 V1 拆分: `act`/`advance` only arm the slot (Ready); the permissionless
//!   `request_vrf` performs the queue CPI. Queue failure rolls back only this
//!   instruction — the poker action from the earlier act/advance transaction is
//!   already committed and the slot stays armed.
//! - §3.2 minimal account fields: Game (with `vrf: VrfSlot`, `hand_id`), Deck
//!   (`vrf_out`, `vrf_attempt_used`, `hand_id`), Table, seats as stubs.
//! - §15 日志纪律: never log seeds/salts/randomness/cards; one `#[error_code]`
//!   with category-only messages.
//!
//! SDK signatures used here were verified against the published crate sources
//! (paths recorded in each module and in the README), per project discipline:
//! do not invent API signatures from memory.
//!
//! LAYOUT CONSTRAINT (Anchor 1.0): `#[program]` generates
//! `pub mod accounts { pub use crate::__client_accounts_<ix>::*; ... }`, and
//! `#[derive(Accounts)]` in 1.0.x places its `__client_accounts_*` /
//! `__cpi_client_accounts_*` modules NEXT TO the struct. The paths line up
//! only when every Accounts struct is defined at the crate root — verified
//! empirically 2026-10-05 after E0432 `unresolved import crate`. Handlers stay
//! in `src/instructions/`; only the context structs live here.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{delegate, ephemeral};
use ephemeral_rollups_sdk::vrf::anchor::{vrf, vrf_callback};

pub mod errors;
pub mod instructions;
pub mod state;
pub mod vrf;

use state::{Deck, Game, Table};

// Program id pinned since Stage 0 deployment (docs/design/pubkeys.json); this
// is a real ID, not the placeholder, so PDAs and client config stay stable.
declare_id!("EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf");

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
    // state (cash_out/sweep_rake, Stage 6) accept owner = DLP per §5.3.
    #[account(
        mut,
        seeds = [b"game", table.key().as_ref()],
        bump,
    )]
    pub game: Account<'info, Game>,
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
    pub game: Account<'info, Game>,
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
    pub deck: Account<'info, Deck>,
    /// Pending request slot to match against callback_args.
    #[account(mut)]
    pub game: Account<'info, Game>,
}

#[derive(Accounts)]
pub struct Advance<'info> {
    #[account(mut)]
    pub game: Account<'info, Game>,
}

// --- Stage 2/3 test harness contexts (production versions in Stage 5/6) ---

#[derive(Accounts)]
#[instruction(table_id: u32)]
pub struct CreateTable<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Table::INIT_SPACE,
        seeds = [b"table", table_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub table: Account<'info, Table>,
    #[account(
        init,
        payer = admin,
        space = 8 + Game::INIT_SPACE,
        seeds = [b"game", table.key().as_ref()],
        bump,
    )]
    pub game: Account<'info, Game>,
    #[account(
        init,
        payer = admin,
        space = 8 + Deck::INIT_SPACE,
        seeds = [b"deck", table.key().as_ref(), [0u8, 0u8].as_ref()],
        bump,
    )]
    pub deck: Account<'info, Deck>,
    /// CHECK: commit payer PDA（D8 测试台雏形：程序所有、0 字节，委托后支付
    /// ER 内租金/费用——ER 规则要求被修改的付款账户必须是委托账户）。
    #[account(
        init,
        payer = admin,
        space = 0,
        seeds = [b"commit_payer", table.key().as_ref()],
        bump,
    )]
    pub commit_payer: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateGame<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    /// CHECK: game PDA; ownership moves to the delegation program.
    #[account(
        mut, del,
        seeds = [b"game", table.key().as_ref()],
        bump,
        constraint = table.admin == admin.key() @ errors::SolpokerError::Unauthorized,
    )]
    pub game: UncheckedAccount<'info>,
    /// CHECK: deck PDA (epoch 0 seeds at creation); ownership moves to the delegation program.
    #[account(
        mut, del,
        seeds = [b"deck", table.key().as_ref(), &table.epoch.to_be_bytes()],
        bump,
    )]
    pub deck: UncheckedAccount<'info>,
    /// CHECK: commit payer PDA; delegated so it can pay ER-side rents/fees.
    #[account(
        mut, del,
        seeds = [b"commit_payer", table.key().as_ref()],
        bump,
    )]
    pub commit_payer: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
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
    pub game: Account<'info, Game>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitPermissions<'info> {
    #[account(seeds = [b"table", table.table_id.to_le_bytes().as_ref()], bump = table.bump)]
    pub table: Account<'info, Table>,
    /// CHECK: deck PDA; signs the permission-creation CPI via its seeds.
    #[account(
        seeds = [b"deck", table.key().as_ref(), &table.epoch.to_be_bytes()],
        bump,
        constraint = table.admin == admin.key() @ errors::SolpokerError::Unauthorized,
    )]
    pub deck: UncheckedAccount<'info>,
    /// CHECK: permission PDA derived by the permission program for deck.
    #[account(
        mut,
        seeds = [b"permission:", deck.key().as_ref()],
        bump,
        seeds::program = permission_program.key(),
    )]
    pub permission: UncheckedAccount<'info>,
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

    /// Deterministic advancement stub (§6.2). Stage 4/5 fills in dealing,
    /// betting-round and settlement transitions from solpoker-core; this slice
    /// only demonstrates the arm hook that sets `VrfSlot = Ready`.
    pub fn advance(ctx: Context<Advance>) -> Result<()> {
        instructions::advance::handler(ctx)
    }

    /// Test harness (Stage 2/3): create Table + Game + Deck PDAs on L1.
    pub fn create_table(ctx: Context<CreateTable>, table_id: u32) -> Result<()> {
        instructions::create_table::handler(ctx, table_id)
    }

    /// Test harness (Stage 2/3): delegate Game + Deck to the TEE validator.
    pub fn delegate_game(ctx: Context<DelegateGame>, validator: Pubkey) -> Result<()> {
        instructions::delegate_game::handler(ctx, validator)
    }

    /// Test harness (Stage 2/3, ER): arm the VRF slot (production arms via
    /// the advance phase machine).
    pub fn debug_arm_vrf(ctx: Context<DebugArmVrf>, target: u8) -> Result<()> {
        instructions::debug_arm_vrf::handler(ctx, target)
    }

    /// Stage 3 (ER): create the PER private permission for Deck
    /// (is_private = true, members = []).
    pub fn init_permissions(ctx: Context<InitPermissions>) -> Result<()> {
        instructions::init_permissions::handler(ctx)
    }
}
