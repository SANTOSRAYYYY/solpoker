//! create_table — §11.1 第 1 步（L1，每张桌执行一次）。
//!
//! 创建核心账户：Table（完整配置）、TableVault = ATA(vault_auth, mint)、
//! CommitPayer（D8，0 字节程序 PDA + 0.05 SOL 运营注资）、Game、HandProof、
//! HandSecrets、Deck。SeatLedger×9 / PlayerHand×9 由 `create_seats` /
//! `create_hands` 分步创建——拆分的直接原因（2026-10-07 实测）：
//! 31 账户单一 create_table 的 `try_accounts` 帧超出 SBF 4096B 栈预算
//! （4112B，溢出 16B），溢出部分**污染 dispatcher 帧里的 args**——表现为
//! args 全部读成垃圾、ctx.accounts.table 被改写成无关账户。交易尺寸也逼近
//! 1,232B 上限（31 账户 + 签名 + args = 1,226B，只剩 6B 余量）。
//!
//! 栈帧纪律（SBF 4096B 预算）：
//! - Game / HandProof / HandSecrets / Deck 是 zero-copy AccountLoader 账户
//!   （init 约束只建账户，字段写入走 `load_init()` 就地，或零值即初态）。
//! - CommitPayer 的 create_account + 注资在 `#[inline(never)]` 辅助函数里。

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;

use crate::state::{Game, Table};
use crate::{CreateTable, CreateTableArgs};

/// CommitPayer 初始运营余额：0.05 SOL（D8；委托后支付 ER 内租金/费用，
/// ER 规则要求被修改的付款账户必须是委托账户——Stage 3 实测
/// `Feepayer was modified without being delegated`）。
const COMMIT_PAYER_FUND: u64 = 50_000_000;

pub fn handler(ctx: Context<CreateTable>, args: CreateTableArgs) -> Result<()> {
    let table_key = ctx.accounts.table.key();
    let (commit_payer_key, commit_payer_bump) =
        Pubkey::find_program_address(&[b"commit_payer", table_key.as_ref()], &crate::ID);

    init_table_fields(
        &mut ctx.accounts.table,
        &args,
        &ctx.accounts.admin.key(),
        &ctx.accounts.mint.key(),
        ctx.bumps.table,
        ctx.bumps.vault_auth,
        commit_payer_bump,
    );

    init_game(&ctx.accounts.game, table_key)?;

    // HandProof / HandSecrets / Deck：init 已清零，零值即初态（head=0、
    // 盐/VRF 全零），discriminator 由 Anchor 在 exit 时写入。拆分后三个账户
    // 都低于 10,240B 的 CPI 创建上限（3,720 / 7,304 / 472）。

    let admin = ctx.accounts.admin.to_account_info();
    let system_program = ctx.accounts.system_program.to_account_info();
    create_commit_payer(
        &admin,
        &system_program,
        &table_key,
        &ctx.accounts.commit_payer.to_account_info(),
        &commit_payer_key,
        commit_payer_bump,
    )
}

/// Table 字段初始化。
#[inline(never)]
fn init_table_fields(
    table: &mut Account<Table>,
    args: &CreateTableArgs,
    admin: &Pubkey,
    mint: &Pubkey,
    bump: u8,
    vault_auth_bump: u8,
    commit_payer_bump: u8,
) {
    table.table_id = args.table_id;
    table.admin = *admin;
    table.kind = args.kind;
    table.max_seats = crate::state::MAX_SEATS as u8;
    table.status = 0; // Active
    table.mint = *mint;
    table.sb = args.sb;
    table.bb = args.bb;
    table.ante = args.ante;
    table.min_buy_in_bb = args.min_buy_in_bb;
    table.max_buy_in_bb = args.max_buy_in_bb;
    table.rake_bps = args.rake_bps;
    table.rake_cap_bb = args.rake_cap_bb;
    table.rake_min_pot_bb = args.rake_min_pot_bb;
    table.action_timeout_s = args.action_timeout_s;
    table.commit_timeout_s = args.commit_timeout_s;
    table.reveal_timeout_s = args.reveal_timeout_s;
    table.vrf_timeout_s = args.vrf_timeout_s;
    table.vrf_max_attempts = args.vrf_max_attempts;
    table.max_strikes = args.max_strikes;
    table.commit_every_n_hands = args.commit_every_n_hands;
    table.heartbeat_s = args.heartbeat_s;
    table.escape_stale_s = args.escape_stale_s;
    table.rake_swept_total = 0;
    table.epoch = 0;
    table.bump = bump;
    table.vault_auth_bump = vault_auth_bump;
    table.commit_payer_bump = commit_payer_bump;
}

/// Game：init 已清零，零值即合法初态（phase=Idle、所有 mask=0、vrf 默认）。
/// to_act 用 0xFF 表示「无人行动」。zero-copy：`load_init()` 就地写字段。
#[inline(never)]
fn init_game(game_loader: &AccountLoader<Game>, table_key: Pubkey) -> Result<()> {
    let mut game = game_loader.load_init()?;
    game.table = table_key;
    game.to_act = u8::MAX;
    Ok(())
}

/// CommitPayer：地址断言 + create_account（space=0、owner=本程序、seeds
/// 签名，lamports 为 0 字节的免租额——与 Anchor init 完全一致）+ 0.05 SOL
/// 运营注资（D8）。
#[inline(never)]
fn create_commit_payer<'info>(
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    table_key: &Pubkey,
    commit_payer: &AccountInfo<'info>,
    expected_key: &Pubkey,
    bump: u8,
) -> Result<()> {
    require_keys_eq!(
        commit_payer.key(),
        *expected_key,
        anchor_lang::error::ErrorCode::ConstraintSeeds
    );
    let bump_b = [bump];
    let signer_seeds: &[&[u8]] = &[b"commit_payer", table_key.as_ref(), &bump_b];
    let rent = Rent::get()?.minimum_balance(0);
    invoke_signed(
        &system_instruction::create_account(payer.key, commit_payer.key, rent, 0, &crate::ID),
        &[payer.clone(), commit_payer.clone(), system_program.clone()],
        &[signer_seeds],
    )?;
    anchor_lang::system_program::transfer(
        CpiContext::new(
            anchor_lang::system_program::ID,
            anchor_lang::system_program::Transfer {
                from: payer.clone(),
                to: commit_payer.clone(),
            },
        ),
        COMMIT_PAYER_FUND,
    )
}
