//! delegate_table — §11.1 第 2 步（L1，每张桌执行 14 次，每次一个账户）。
//!
//! 每次调用把 `del_index` 选中的一个常驻账户委托给 TEE validator（MTEW…，
//! 作为参数显式传入并对 `state::TEE_VALIDATOR` 断言；`validator: None`
//! 永远不用）：
//!
//! | del_index | 账户        | PDA seeds                                    |
//! |-----------|-------------|----------------------------------------------|
//! | 0         | CommitPayer | ["commit_payer", table]                      |
//! | 1         | Game        | ["game", table]                              |
//! | 2         | HandProof   | ["proof", table]                             |
//! | 3         | HandSecrets | ["secrets", table]                           |
//! | 4         | Deck        | ["deck", table, epoch (u16 BE)]              |
//! | 5..=13    | PlayerHand  | ["hand", table, epoch (u16 BE), idx-5]       |
//!
//! 建桌脚本在同一笔交易里连发 14 次调用（原来单指令委托 13 个账户的 handler
//! 帧远超 SBF 4096 字节栈预算——13 元素 (AccountInfo, seeds, buffer, record,
//! metadata) 数组 + 循环造成 15 处 "function call overwrites values in the
//! frame"，拆成单账户后帧里只有一份）。HandSecrets 是 2026-10-07 从
//! HandProof 拆出的第 14 个常驻账户（见 state.rs 偏差记录）。
//!
//! `commit_frequency_ms = u32::MAX`（§11.1：只允许显式 commit，
//! validator 不自动 crank——配合 CommitPayer + magic_fee_vault 的 D8 模型）。
//!
//! **为什么不用 `#[delegate]` 宏生成的 `delegate_target` 方法**：那些方法
//! 的签名是 `delegate_x(&self, payer: &Signer, …)`——要求付款人是外部签名
//! 者。而委托租金付款人是 L1-only 的 DelegPayer（D3，程序 PDA），只能用
//! seeds 签名。委托 CPI（`cpi_delegate`）把 payer 标为 signer meta，buffer
//! 的 create_account 也要 payer 签名，所以这里直接调
//! `ephemeral_rollups_sdk::cpi` / `utils` 原语，复刻
//! `cpi.rs::delegate_account_inner` 的流程，并在每个 `invoke_signed` 里
//! 追加 DelegPayer 的签名 seeds（源码核对：
//! ephemeral-rollups-sdk-0.17.3/src/cpi.rs、src/utils.rs）。

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use ephemeral_rollups_sdk::cpi;
use ephemeral_rollups_sdk::types::DelegateAccountArgs;
use ephemeral_rollups_sdk::utils;

use crate::errors::SolpokerError;
use crate::state::TEE_VALIDATOR;
use crate::DelegateTable;

/// §11.1：commit_frequency_ms = u32::MAX —— 禁止 validator 自动 commit，
/// 只有显式 commit（CommitPayer + validator-scoped magic_fee_vault，D8）。
const COMMIT_FREQUENCY_MS: u32 = u32::MAX;

pub fn handler(ctx: Context<DelegateTable>, validator: Pubkey, del_index: u8) -> Result<()> {
    require!(
        validator == TEE_VALIDATOR,
        SolpokerError::ValidatorNotAllowed
    );

    let table_key = ctx.accounts.table.key();
    let table_bytes = table_key.to_bytes();
    let epoch_bytes = ctx.accounts.table.epoch.to_be_bytes();

    // 按 del_index 重建被委托账户的 PDA seeds 并断言传入账户地址匹配（seeds
    // 校验从上下文约束搬到 handler——单账户上下文的 seeds 随 del_index 变化，
    // 无法静态表达）。
    let idx = [del_index.wrapping_sub(5)];
    let pda_seeds: Vec<&[u8]> = match del_index {
        0 => vec![b"commit_payer".as_ref(), table_bytes.as_ref()],
        1 => vec![b"game".as_ref(), table_bytes.as_ref()],
        2 => vec![b"proof".as_ref(), table_bytes.as_ref()],
        3 => vec![b"secrets".as_ref(), table_bytes.as_ref()],
        4 => vec![b"deck".as_ref(), table_bytes.as_ref(), epoch_bytes.as_ref()],
        5..=13 => vec![
            b"hand".as_ref(),
            table_bytes.as_ref(),
            epoch_bytes.as_ref(),
            idx.as_ref(),
        ],
        _ => return err!(SolpokerError::SeatMismatch),
    };
    let (expected_pda, _) = Pubkey::find_program_address(&pda_seeds, &crate::ID);
    require!(
        ctx.accounts.target.key() == expected_pda,
        SolpokerError::SeatMismatch
    );

    let dp_bump = [ctx.bumps.deleg_payer];
    let deleg_payer_seeds: &[&[u8]] = &[b"deleg_payer", &dp_bump];

    delegate_one(
        &ctx.accounts.target.to_account_info(),
        &pda_seeds,
        &ctx.accounts.deleg_payer.to_account_info(),
        deleg_payer_seeds,
        &ctx.accounts.owner_program.to_account_info(),
        &ctx.accounts.buffer_target.to_account_info(),
        &ctx.accounts.delegation_record_target.to_account_info(),
        &ctx.accounts.delegation_metadata_target.to_account_info(),
        &ctx.accounts.delegation_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        validator,
    )
}

/// 复刻 `delegate_account_inner`（ephemeral-rollups-sdk-0.17.3/src/cpi.rs），
/// 唯一区别：buffer 创建与委托 CPI 的签名 seeds 里追加 DelegPayer 的 seeds
/// （SDK 版本假设 payer 是外部签名者，只带被委托 PDA 的 seeds）。
#[allow(clippy::too_many_arguments)]
fn delegate_one<'info>(
    pda: &AccountInfo<'info>,
    pda_seeds: &[&[u8]],
    deleg_payer: &AccountInfo<'info>,
    deleg_payer_seeds: &[&[u8]],
    owner_program: &AccountInfo<'info>,
    buffer: &AccountInfo<'info>,
    delegation_record: &AccountInfo<'info>,
    delegation_metadata: &AccountInfo<'info>,
    delegation_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    validator: Pubkey,
) -> Result<()> {
    let pda_key = pda.key();
    let system_id = anchor_lang::solana_program::system_program::id();

    // Buffer PDA seeds：[DELEGATE_BUFFER_TAG, pda]，owner = 本程序
    // （与 #[delegate] 宏生成的 seeds 约束一致）。
    let buffer_seeds: &[&[u8]] = &[
        ephemeral_rollups_sdk::pda::DELEGATE_BUFFER_TAG,
        pda_key.as_ref(),
    ];
    let (_, buffer_bump) = Pubkey::find_program_address(buffer_seeds, &crate::ID);
    let buffer_bump = [buffer_bump];
    let mut buffer_signer = buffer_seeds.to_vec();
    buffer_signer.push(&buffer_bump);

    let (_, pda_bump) = Pubkey::find_program_address(pda_seeds, &crate::ID);
    let pda_bump = [pda_bump];
    let mut pda_signer = pda_seeds.to_vec();
    pda_signer.push(&pda_bump);

    // 1) 创建 buffer（0 lamports、owner = 本程序；SDK 语义）。payer 是
    //    DelegPayer PDA——它和 buffer 都在签名 seeds 里。
    let data_len = pda.data_len();
    invoke_signed(
        &system_instruction::create_account(
            &deleg_payer.key(),
            &buffer.key(),
            0,
            data_len as u64,
            &crate::ID,
        ),
        &[
            deleg_payer.clone(),
            buffer.clone(),
            system_program.clone(),
        ],
        &[&buffer_signer, deleg_payer_seeds],
    )?;

    // 2) PDA -> buffer 拷贝，然后 PDA 清零。
    {
        let src = pda.try_borrow_data()?;
        let mut dst = buffer.try_borrow_mut_data()?;
        dst.copy_from_slice(&src);
    }
    {
        let mut data = pda.try_borrow_mut_data()?;
        for b in data.iter_mut() {
            *b = 0;
        }
    }

    // 3) owner 移交 delegation program（先在本程序内 assign 给系统程序，
    //    再由系统 CPI assign 给 DLP——与 SDK 相同的两步）。
    if pda.owner != &system_id {
        pda.assign(&system_id);
    }
    if pda.owner != delegation_program.key {
        invoke_signed(
            &system_instruction::assign(&pda_key, delegation_program.key),
            &[pda.clone(), system_program.clone()],
            &[&pda_signer],
        )?;
    }

    // 4) 委托 CPI。payer（DelegPayer）与被委托 PDA 都是 signer meta，
    //    两者 seeds 都进 invoke_signed。
    let args = DelegateAccountArgs {
        commit_frequency_ms: COMMIT_FREQUENCY_MS,
        seeds: pda_seeds.iter().map(|s| s.to_vec()).collect(),
        validator: Some(validator),
    };
    cpi::cpi_delegate(
        deleg_payer,
        pda,
        owner_program,
        buffer,
        delegation_record,
        delegation_metadata,
        system_program,
        &[&pda_signer, deleg_payer_seeds],
        args,
    )?;

    // 5) 关闭 buffer，租金退还 DelegPayer（destination 不需要签名）。
    utils::close_pda_with_system_transfer(buffer, &[&buffer_signer], deleg_payer, system_program)?;

    Ok(())
}
