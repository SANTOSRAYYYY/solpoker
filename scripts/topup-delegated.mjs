// 给「已委托」账户补 lamports（MagicBlock skill 的 lamports-topup 流程）。
//
// 为什么需要：委托账户的手续费（Commit 费用、fee-vault 路径的 live debit）从 **ER 副本**的
// lamports 扣；余额垫底时 commit 会整包失败（InsufficientFunds/ForRent），L1 侧充值无效，
// ER 上也禁止普通转账 —— 唯一正规路径是本脚本用的 Ephemeral SPL Token 一次性 lamports PDA：
//   建 PDA([b"lamports", payer, destination, salt]) → payer 注资 → 委托 → ER 消费并记到目标账户。
//
// 用法（仓库根目录）：
//   node scripts/topup-delegated.mjs 22                 # 只补桌 22
//   node scripts/topup-delegated.mjs 20,21,22           # 多桌
//   node scripts/topup-delegated.mjs 5,6,7,8,9,11,12,14,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34
//   TARGET_SOL=0.12 MIN_SOL=0.10 node scripts/topup-delegated.mjs 22   # 覆盖默认
//
// 默认 TARGET=0.12 / MIN=0.10（2026-10-09 修正）：旧的 0.05/0.02 有真 bug ——
// handSecrets（7.3KB）的免租下限 ≈0.0508 SOL **高于旧目标 0.05**，且旧 MIN=0.02
// 会把已经跌破下限的它判为"够用"跳过，导致 commit 反复
// InsufficientFundsForRent{account_index:3}。大账户 floor 参考：handSecrets
// ~0.051 / handReplay ~0.028 / handProof ~0.026 — 0.12 目标给足余量。
//
// 覆盖账户（每桌 5 个）：commitPayer（手续费付款人，最关键）+ game/handProof/handSecrets/handReplay。
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAuthToken, lamportsDelegatedTransferIx, deriveLamportsPda,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import * as env from "./env.mjs";

const pid = new PublicKey("EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf");
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (s) => PublicKey.findProgramAddressSync(s, pid)[0];

const ids = (process.argv[2] ?? "22").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const TARGET = BigInt(Math.round(Number(process.env.TARGET_SOL ?? 0.12) * 1e9));
const MIN = BigInt(Math.round(Number(process.env.MIN_SOL ?? 0.10) * 1e9));

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const l1 = new Connection(env.L1_RPC, "confirmed");
const { token } = await getAuthToken(env.ER_BASE_URL, deployer.publicKey, async (m) =>
  (await import("tweetnacl")).default.sign.detached(m, deployer.secretKey)
);
const er = new Connection(`${env.ER_BASE_URL}?token=${token}`, "confirmed");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function erLamports(acc) {
  const a = await er.getAccountInfo(acc).catch(() => null);
  return a ? BigInt(a.lamports) : null;
}

let topped = 0, skipped = 0, failed = 0;
for (const id of ids) {
  const table = pda([Buffer.from("table"), u32(id)]);
  const targets = {
    commitPayer: pda([Buffer.from("commit_payer"), table.toBuffer()]),
    game: pda([Buffer.from("game"), table.toBuffer()]),
    handProof: pda([Buffer.from("proof"), table.toBuffer()]),
    handSecrets: pda([Buffer.from("secrets"), table.toBuffer()]),
    handReplay: pda([Buffer.from("replay"), table.toBuffer()]),
  };
  for (const [name, acc] of Object.entries(targets)) {
    const cur = await erLamports(acc);
    if (cur === null) { console.log(`#${id} ${name}: ER 上不存在，跳过`); continue; }
    if (cur >= MIN) { skipped++; console.log(`#${id} ${name}: ER ${(Number(cur) / 1e9).toFixed(6)} ≥ 阈值，跳过`); continue; }
    const amount = TARGET - cur; // 补到目标
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const [lamportsPda] = deriveLamportsPda(deployer.publicKey, acc, salt);
    // 每个逻辑请求留痕（skill 要求：salt/PDA/金额先落盘，未知结果可对账）
    fs.appendFileSync("tmp-topup-log.jsonl", JSON.stringify({
      table: id, account: name, destination: acc.toBase58(), lamportsPda: lamportsPda.toBase58(),
      amount: Number(amount), salt: Buffer.from(salt).toString("hex"), at: new Date().toISOString(),
    }) + "\n");
    try {
      const ix = lamportsDelegatedTransferIx(deployer.publicKey, acc, amount, salt);
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      tx.add(ix);
      tx.feePayer = deployer.publicKey;
      tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
      tx.sign(deployer);
      const sig = await l1.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      let ok = false;
      for (let i = 0; i < 60; i++) {
        const s = (await l1.getSignatureStatuses([sig])).value[0];
        if (s?.err) { console.log(`✗ #${id} ${name}:`, JSON.stringify(s.err).slice(0, 90)); break; }
        if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") { ok = true; break; }
        await sleep(700);
      }
      if (ok) {
        topped++;
        console.log(`✓ #${id} ${name}: +${(Number(amount) / 1e9).toFixed(4)} SOL → 目标 ${(Number(TARGET) / 1e9)} SOL（${sig.slice(0, 12)}…）`);
      } else failed++;
    } catch (e) {
      failed++;
      console.log(`✗ #${id} ${name}: ${String(e.message ?? e).slice(0, 140)}`);
    }
    await sleep(400);
  }
}
console.log(`\n完成：补 ${topped} 个账户 / 跳过 ${skipped} / 失败 ${failed}`);
process.exit(0);
