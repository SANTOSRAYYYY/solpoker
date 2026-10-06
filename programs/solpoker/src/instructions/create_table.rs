//! create_table — L1 test-harness instruction (Stage 2/3).
//!
//! Creates the three accounts the Stage 2 VRF slice needs: Table (L1, never
//! delegated), Game and Deck (L1 until delegate_game moves them to the ER).
//! The full production version (§11.1) also creates TableVault, SeatLedger×9,
//! CommitPayer, HandProof and PlayerHand×9; this harness only covers what the
//! VRF path touches. Admin-gated via `Table.admin`.

use anchor_lang::prelude::*;

use crate::state::{Deck, Game, Table};
use crate::CreateTable;

pub fn handler(ctx: Context<CreateTable>, table_id: u32) -> Result<()> {
    let table = &mut ctx.accounts.table;
    table.table_id = table_id;
    table.admin = ctx.accounts.admin.key();
    table.vrf_timeout_s = 10; // E1 defaults; tune on-chain after latency probes
    table.vrf_max_attempts = 3;
    table.epoch = 0;
    table.bump = ctx.bumps.table;

    let game = &mut ctx.accounts.game;
    game.table = table.key();
    game.hand_id = 0;
    game.board = [0u8; 5];
    game.board_len = 0;
    game.vrf = Default::default();
    game.seats = Default::default();

    let deck = &mut ctx.accounts.deck;
    deck.hand_id = 0;
    deck.vrf_out = [[0u8; 32]; 5];
    deck.vrf_attempt_used = [0u8; 5];

    // CommitPayer (D8 的测试台雏形)：委托到 ER 后由它支付 ER 内的租金/费用
    // （ER 规则：被修改的付款账户必须是委托账户——Stage 3 实测
    // `Feepayer was modified without being delegated`）。create_account 由
    // Anchor 的 init 完成，lamports 由 space=0 + 显式转账补足。
    let commit_payer = &ctx.accounts.commit_payer;
    let fund: u64 = 50_000_000; // 0.05 SOL，测试台足够
    anchor_lang::system_program::transfer(
        CpiContext::new(
            anchor_lang::system_program::ID,
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.admin.to_account_info(),
                to: commit_payer.to_account_info(),
            },
        ),
        fund,
    )?;

    Ok(())
}

// Context struct lives at the crate root (Anchor 1.0 layout constraint).
// See lib.rs `CreateTable`.
#[allow(dead_code)]
fn _assert_types(_: &Table, _: &Game, _: &Deck) {}
