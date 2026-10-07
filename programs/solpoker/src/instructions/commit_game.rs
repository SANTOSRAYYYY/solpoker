//! commit_game — ER（permissionless）。在手与手之间（phase == Idle 且 pot == 0）
//! 把 Game 和 HandProof 作为一个意图 commit 回 L1（设计 §10 / D8）：
//! intent payer 固定为本桌已委托的 CommitPayer PDA（程序 invoke_signed），
//! 并传入 validator-scoped canonical `magic_fee_vault`（
//! `PDA(["magic-fee-vault", tee_validator], Delegation Program)`，
//! 用 `dlp_api::pda::magic_fee_vault_pda_from_validator` 校验）。
//!
//! 外层发送者可以是任何 keeper/玩家；Deck、PlayerHand 永不 commit（§10）。
//! 禁止在 CommitPayer 余额不足时回退 plain path——整个意图原子失败。

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::dlp_api;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::errors::SolpokerError;
use crate::fund::{PHASE_IDLE, TABLE_ACTIVE};
use crate::state::TEE_VALIDATOR;
use crate::CommitGame;

pub fn handler(ctx: Context<CommitGame>) -> Result<()> {
    let table = &ctx.accounts.table;
    require!(table.status == TABLE_ACTIVE, SolpokerError::BadPhase);

    // 只在手与手之间 commit（pot = 0，§10）。
    let game = ctx.accounts.game.load()?;
    require!(game.phase == PHASE_IDLE && game.pot == 0, SolpokerError::BadPhase);
    drop(game);

    let table_key = table.key();
    let table_bytes = table_key.to_bytes();
    let bump = ctx.bumps.commit_payer;

    // canonical fee vault：["magic-fee-vault", tee_validator] under DLP。
    let expected_vault =
        dlp_api::pda::magic_fee_vault_pda_from_validator(&TEE_VALIDATOR);
    require_keys_eq!(
        ctx.accounts.magic_fee_vault.key(),
        expected_vault,
        SolpokerError::BadFeeVault
    );

    MagicIntentBundleBuilder::new(
        ctx.accounts.commit_payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .magic_fee_vault(ctx.accounts.magic_fee_vault.to_account_info())
    .commit(&[
        ctx.accounts.game.to_account_info(),
        ctx.accounts.hand_proof.to_account_info(),
        ctx.accounts.hand_secrets.to_account_info(),
    ])
    .build_and_invoke_signed(&[&[b"commit_payer", table_bytes.as_ref(), &[bump]]])?;

    // last_commit_at 由结算/advance 路径维护；commit 后 hands_since_commit 归零。
    let mut game = ctx.accounts.game.load_mut()?;
    game.hands_since_commit = 0;
    game.last_commit_at = Clock::get()?.unix_timestamp;

    Ok(())
}
