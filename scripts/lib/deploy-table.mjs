// 单桌部署的共享实现（create-table.mjs 与 deploy-tables.mjs 共用同一份代码）。
//
// 流程：create_table → create_seats → create_hands → init_replay → delegate×15
//       → ER init_permissions。全步骤幂等（已存在的账户/已委托的 target 自动跳过），
//       可断点续跑。
//
// 关键约束（血泪教训，勿改）：
// - vault（ATA(vault_auth, mint)）由 create_table 的 init 约束创建，**不要预建** ——
//   预建会让 Anchor init 撞车（IllegalOwner），且 ATA owner 是 vaultAuth PDA、无法关闭，
//   该桌号会永久不可用。
// - 委托必须显式指定 TEE 验证者（绝不 validator: None）。
import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";

export const ER_CU = 1_400_000;
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
export const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
export const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
/** 每次 delegate 锁定的 lamports（含手续费）。2026-10-08 实测：177 次委托共消耗
 *  562,903,920 lamports ≈ 3.18M/次（委托记录 + 元数据租金；undelegate 时大部分可退）。 */
export const PER_DELEGATION_LAMPORTS = 3_200_000;

const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/** 一桌的全部 PDA（与 web/lib/solpoker-client.ts 的 pdasFor 对齐）。
 *
 *  注意：权限账户（permission）派生在 **ACL 权限程序** 下，不是我们程序——所以用
 *  `pdaWith(seeds, program)` 显式传程序。2026-10-08 的坑：这里曾写成
 *  `pda(seeds, PERMISSION_PROGRAM)`，而局部 `pda` 只接受一个参数（程序恒为本程序），
 *  于是客户端派生出错误的权限 PDA，程序端断言（按 ACL 正确派生）失败报
 *  `SeatMismatch(6010)`，被我误判成「devnet ER 故障」查了半天。**改这一行时务必
 *  跑 `node scripts/er-perm-probe.mjs <id>` 复验。 */
export function tablePdas(programId, tableId) {
  const pdaWith = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
  const pda = (seeds) => pdaWith(seeds, programId);
  const table = pda([Buffer.from("table"), u32le(tableId)]);
  return {
    table,
    vaultAuth: pda([Buffer.from("vault_auth"), table.toBuffer()]),
    game: pda([Buffer.from("game"), table.toBuffer()]),
    handProof: pda([Buffer.from("proof"), table.toBuffer()]),
    handSecrets: pda([Buffer.from("secrets"), table.toBuffer()]),
    deck: pda([Buffer.from("deck"), table.toBuffer(), Buffer.from([0, 0])]),
    commitPayer: pda([Buffer.from("commit_payer"), table.toBuffer()]),
    replay: pda([Buffer.from("replay"), table.toBuffer()]),
    seat: (i) => pda([Buffer.from("seat"), table.toBuffer(), Buffer.from([i])]),
    hand: (i) => pda([Buffer.from("hand"), table.toBuffer(), Buffer.from([0, 0]), Buffer.from([i])]),
    permission: (acc) => pdaWith([Buffer.from("permission:"), acc.toBuffer()], PERMISSION_PROGRAM),
  };
}

export async function sendAndConfirm(conn, ixs, signers, label, cu = null) {
  const tx = new Transaction();
  if (cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const t0 = Date.now();
  for (;;) {
    const st = await conn.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
      return { sig, ms: Date.now() - t0 };
    }
    if (Date.now() - t0 > 120000) throw new Error(`${label} confirmation timeout`);
    await new Promise((r) => setTimeout(r, 700));
  }
}

/**
 * 部署/补齐一桌（幂等）。返回 { created, delegated, skippedDelegations }。
 * @param cfg { id, sb, bb, ante, kind, conns:{l1,er}, programs:{l1,er}, programId, deployer, idl, log }
 */
export async function deployTable(cfg) {
  const { id, sb, bb, ante, kind, conns, programs, programId, deployer, log } = cfg;
  const logf = log ?? (() => {});
  const p = tablePdas(programId, id);
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const vault = getAssociatedTokenAddressSync(TUSDC_MINT, p.vaultAuth, true);

  // 1) 桌面核心账户
  let created = false;
  if (!(await conns.l1.getAccountInfo(p.table))) {
    created = true;
    if (await conns.l1.getAccountInfo(vault)) {
      throw new Error(`桌号 ${id} 不可用：vault ATA 已存在但 Table 不存在（曾误预建）——换桌号`);
    }
    const args = {
      tableId: id, kind,
      sb: new BN(Math.round(sb * 1e6).toString()),
      bb: new BN(Math.round(bb * 1e6).toString()),
      ante: new BN(Math.round(ante * 1e6).toString()),
      minBuyInBb: 100, maxBuyInBb: 1000,
      rakeBps: 250, rakeCapBb: 3, rakeMinPotBb: 1,
      actionTimeoutS: 30, commitTimeoutS: 60, revealTimeoutS: 30,
      vrfTimeoutS: 10, vrfMaxAttempts: 3, maxStrikes: 3,
      commitEveryNHands: 1, heartbeatS: 1800, escapeStaleS: 7200,
    };
    const { sig, ms } = await sendAndConfirm(
      conns.l1,
      [
        await programs.l1.methods.createTable(args).accounts({
          table: p.table, vaultAuth: p.vaultAuth, vault, mint: TUSDC_MINT,
          game: p.game, handProof: p.handProof, handSecrets: p.handSecrets,
          deck: p.deck, commitPayer: p.commitPayer, admin: deployer.publicKey,
        }).instruction(),
      ],
      [deployer], "create_table (L1)"
    );
    logf(`✓ 桌 #${id} create_table (${ms}ms, ${sig.slice(0, 12)}…)`);
    await sendAndConfirm(
      conns.l1,
      [
        await programs.l1.methods.createSeats().accounts({
          table: p.table,
          seat0: p.seat(0), seat1: p.seat(1), seat2: p.seat(2), seat3: p.seat(3), seat4: p.seat(4),
          seat5: p.seat(5), seat6: p.seat(6), seat7: p.seat(7), seat8: p.seat(8),
          admin: deployer.publicKey,
        }).instruction(),
      ],
      [deployer], "create_seats (L1)"
    );
    await sendAndConfirm(
      conns.l1,
      [
        await programs.l1.methods.createHands().accounts({
          table: p.table,
          hand0: p.hand(0), hand1: p.hand(1), hand2: p.hand(2), hand3: p.hand(3), hand4: p.hand(4),
          hand5: p.hand(5), hand6: p.hand(6), hand7: p.hand(7), hand8: p.hand(8),
          admin: deployer.publicKey,
        }).instruction(),
      ],
      [deployer], "create_hands (L1)"
    );
    logf(`✓ 桌 #${id} seats+hands`);
  } else {
    logf(`… 桌 #${id} 已存在（继续补齐）`);
  }

  // 2) §8.7 整手复算账户
  if (!(await conns.l1.getAccountInfo(p.replay))) {
    await sendAndConfirm(
      conns.l1,
      [await programs.l1.methods.initReplay().accounts({ table: p.table, replay: p.replay, admin: deployer.publicKey }).instruction()],
      [deployer], "init_replay (L1)"
    );
    logf(`✓ 桌 #${id} init_replay`);
  }

  // 3) 委托 ×15（14 = HandReplay；逐个判 DLP owner，可断点续跑）
  const targets = [p.commitPayer, p.game, p.handProof, p.handSecrets, p.deck,
    ...Array.from({ length: 9 }, (_, i) => p.hand(i)), p.replay];
  const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
  const [delegPayer] = PublicKey.findProgramAddressSync([Buffer.from("deleg_payer")], programId);
  let delegated = 0;
  let skipped = 0;
  for (let di = 0; di < targets.length; di++) {
    const info = await conns.l1.getAccountInfo(targets[di]);
    if (info?.owner.equals(DLP)) { skipped++; continue; }
    await sendAndConfirm(
      conns.l1,
      [
        await programs.l1.methods.delegateTable(TEE_VALIDATOR, di).accounts({
          table: p.table, delegPayer, target: targets[di], admin: deployer.publicKey,
        }).instruction(),
      ],
      [deployer], `delegate_table[${di}] (L1)`
    );
    delegated++;
  }
  if (delegated) logf(`✓ 桌 #${id} 委托 ${delegated} 个账户（跳过 ${skipped} 已委托）`);

  // 4) ER 权限（幂等）。两个已知坑（2026-10-08 实测）：
  //    · ER token 有效期有限（长批次里会中途过期 → 401 InvalidToken）；
  //    · **刚委托完立即建权限会被拒绝**（ACL 侧 Custom 6010；要等委托在 ER
  //      侧同步完成，实测隔几分钟再跑就成功）——所以这里带退避重试；批量
  //      场景下更自然的顺序是「先全部走 L1，再统一建权限」（重跑本脚本即是）。
  let erOk = false;
  const backoffMs = [0, 15_000, 30_000, 60_000, 60_000, 60_000];
  for (let attempt = 0; attempt < backoffMs.length && !erOk; attempt++) {
    if (backoffMs[attempt] > 0) await new Promise((r) => setTimeout(r, backoffMs[attempt]));
    try {
      const fresh = attempt > 0 && cfg.refreshEr ? cfg.refreshEr() : null;
      const programsEr = fresh?.program ?? programs.er;
      const connEr = fresh?.conn ?? conns.er;
      if (!(await connEr.getAccountInfo(p.permission(p.deck)))) {
        await sendAndConfirm(
          connEr,
          [
            await programsEr.methods.initPermissions().accounts({
              table: p.table, deck: p.deck,
              hand0: p.hand(0), hand1: p.hand(1), hand2: p.hand(2), hand3: p.hand(3), hand4: p.hand(4),
              hand5: p.hand(5), hand6: p.hand(6), hand7: p.hand(7), hand8: p.hand(8),
              permissionDeck: p.permission(p.deck),
              permissionHand0: p.permission(p.hand(0)), permissionHand1: p.permission(p.hand(1)),
              permissionHand2: p.permission(p.hand(2)), permissionHand3: p.permission(p.hand(3)),
              permissionHand4: p.permission(p.hand(4)), permissionHand5: p.permission(p.hand(5)),
              permissionHand6: p.permission(p.hand(6)), permissionHand7: p.permission(p.hand(7)),
              permissionHand8: p.permission(p.hand(8)),
              vault: EPHEMERAL_VAULT, commitPayer: p.commitPayer, admin: deployer.publicKey,
            }).instruction(),
          ],
          [deployer], "init_permissions (ER)", ER_CU
        );
        logf(`✓ 桌 #${id} init_permissions (ER)`);
      }
      erOk = true;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (attempt === 0 && /InvalidToken|401|Unauthorized/i.test(msg) && cfg.refreshEr) {
        logf(`… 桌 #${id} ER token 过期，重新认证重试`);
        continue;
      }
      logf(`⚠ 桌 #${id} ER 权限未完成：${msg}（重跑 deploy-tables.mjs 可续）`);
    }
  }
  return { created, delegated, skippedDelegations: skipped, erOk };
}
