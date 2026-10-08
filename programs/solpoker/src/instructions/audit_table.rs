//! audit_table — §5.4 I-X（L1；permissionless；只读）。
//!
//! 校验跨层守恒（TableVault 余额 ≥ 右侧全部之和）：
//!
//! ```text
//! Σ(deposited − credited_快照) + Σ stack_快照 + (rake_快照 − rake_swept) + Σ(owed_快照 − paid)
//! ```
//!
//! 并报告盈余（≥ 0；盈余来自直接向 TableVault 转账，程序不动用它）。
//! 任何计数器对倒挂（credited_快照 > deposited 等）或余额不足都报错。CI 与 keeper 定期调用。
//!
//! 栈帧纪律：Game 快照是零拷贝借用（fund::read_game_snapshot 返回
//! Ref<Game>，不再把 1544 字节的 Game 拷上栈）；9 份 SeatLedger 在
//! handler 里逐份手工校验读取（上下文里是 UncheckedAccount——9 份 borsh
//! 反序列化会把 try_accounts 顶过 SBF 4096 字节预算）。

use anchor_lang::prelude::*;

use crate::errors::SolpokerError;
use crate::fund;
use crate::state::{SeatLedger, MAX_SEATS};
use crate::AuditTable;

pub fn handler(ctx: Context<AuditTable>) -> Result<()> {
    let table = &ctx.accounts.table;
    let snap = fund::read_game_snapshot(ctx.accounts.game.as_ref())?;

    let ledger0 = fund::read_seat_ledger_l1(&ctx.accounts.seat0.to_account_info())?;
    let ledger1 = fund::read_seat_ledger_l1(&ctx.accounts.seat1.to_account_info())?;
    let ledger2 = fund::read_seat_ledger_l1(&ctx.accounts.seat2.to_account_info())?;
    let ledger3 = fund::read_seat_ledger_l1(&ctx.accounts.seat3.to_account_info())?;
    let ledger4 = fund::read_seat_ledger_l1(&ctx.accounts.seat4.to_account_info())?;
    let ledger5 = fund::read_seat_ledger_l1(&ctx.accounts.seat5.to_account_info())?;
    let ledger6 = fund::read_seat_ledger_l1(&ctx.accounts.seat6.to_account_info())?;
    let ledger7 = fund::read_seat_ledger_l1(&ctx.accounts.seat7.to_account_info())?;
    let ledger8 = fund::read_seat_ledger_l1(&ctx.accounts.seat8.to_account_info())?;
    let ledgers: [&SeatLedger; MAX_SEATS] = [
        &ledger0, &ledger1, &ledger2, &ledger3, &ledger4, &ledger5, &ledger6, &ledger7, &ledger8,
    ];
    let required = fund::required_vault_backing(&ledgers, &snap, table.rake_swept_total)?;

    let balance = ctx.accounts.vault.amount as u128;
    require!(balance >= required, SolpokerError::Conservation);
    // Surplus is fine (direct vault transfers, §5.4); only a deficit errors.
    msg!("audit_table: surplus={}", balance - required);
    Ok(())
}
