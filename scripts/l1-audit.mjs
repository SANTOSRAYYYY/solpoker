// l1-audit — L1 侧审计视图（命令行版，引擎与 web 的 /api/l1-audit 一致）。
//
// 数据来源：Helius Enhanced「解析历史」（/v0/addresses/{addr}/transactions/）。
// 实测（2026-10-08）：Helius 对本程序返回 type/source=UNKNOWN、description 空 ——
// 它没有我们的 IDL，所以「语义标签」由我们自己从 L1 原始交易的日志里解
// （anchor 每个指令打 `Program log: Instruction: <Name>`）；Helius 提供的是
// 按地址聚合的完整签名列表 + 时间戳 + 费用 + 失败标记。
//
// 覆盖地址（表级时间线）：Table PDA、Game PDA、9 个 Seat PDA、HandReplay PDA。
// 可见的 L1 动作：建桌/入座/接座/离座/兑现/commit 快照/委托 ER/init_replay/注册代理…
// 行动（fold/call/raise）在 ER 上，不在这里 —— 见 /history 的行动流验证。
//
// 用法: node scripts/l1-audit.mjs [5,6,14]        # 默认读 NEXT_PUBLIC_TABLE_IDS
//       node scripts/l1-audit.mjs --json 14       # 机器可读输出
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { envValue, L1_RPC } from "./env.mjs";

const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const TUSDC_MINT = envValue("NEXT_PUBLIC_TUSDC_MINT", "9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const ids = (argv.filter((a) => /^[\d,]+$/.test(a))[0] ?? envValue("NEXT_PUBLIC_TABLE_IDS", "14"))
  .split(",").map((s) => Number(s.trim())).filter(Number.isInteger);

const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];

// 指令名（IDL snake）→ 中文标签
const LABEL = {
  create_table: "建桌", create_seats: "建座位", create_hands: "建手牌槽",
  init_config: "初始化配置", init_permissions: "初始化权限", init_replay: "初始化复算环",
  register_agent: "注册代理", update_agent: "更新代理", set_agent_status: "代理状态",
  set_agent_payout: "代理收款", pause_agent: "暂停代理", resume_agent: "恢复代理",
  revoke_agent: "吊销代理", allow_owner: "授权 owner", remove_owner: "移除 owner",
  sit_down: "入座", take_seat: "接座", stand_up: "离座", cash_out: "兑现", top_up: "补币",
  commit_salt: "盐承诺", reveal_salt: "盐揭示",
  delegate_table: "委托 ER", process_undelegation: "撤出 ER",
  commit_game: "提交快照", request_vrf: "请求随机数", retry_vrf: "重试随机数",
  vrf_callback: "随机数回调", debug_arm_vrf: "调试 arm VRF",
  advance: "推进阶段", act: "玩家行动", claim_timeout: "超时裁决",
  apply_deposits: "入账", sweep_rake: "抽水", audit_table: "审计",
  admin_force_stand_up: "管理强离", admin_set_members: "管理成员",
  set_session: "会话授权", revoke_session: "会话吊销",
  credit_x402_deposit: "x402 入账",
  refund_x402_deposit: "x402 退款",
};
const pascalToSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const KNOWN = new Set(idl.instructions.map((i) => i.name));
// TEE 验证者的 pubkey：它付钱的、只有 DLP + ComputeBudget 的交易 = PER 快照/委托流量
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

const keyed = envValue("HELIUS_RPC", "");
const heliusBase = keyed.includes("api-key=") ? new URL(keyed).origin : null;
const heliusKey = heliusBase ? new URL(keyed).searchParams.get("api-key") : null;
const source = heliusBase ? "helius-parsed" : "raw-rpc";

const conn = new Connection(L1_RPC, {
  commitment: "confirmed",
  fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(25000) }),
});

async function addressHistory(addr, limit = 12) {
  if (heliusBase) {
    const r = await fetch(`${heliusBase}/v0/addresses/${addr}/transactions/?api-key=${heliusKey}&limit=${limit}`,
      { signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error(`helius ${r.status}`);
    return (await r.json()).map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.timestamp, err: t.transactionError ?? null }));
  }
  const sigs = await conn.getSignaturesForAddress(new PublicKey(addr), { limit });
  return sigs.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, err: s.err }));
}

/** 从原始交易解码：指令名 + tUSDC 金额 + 付款人 + DLP 是否参与。 */
async function decodeTx(sig) {
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) return null;
  const logs = tx.meta?.logMessages ?? [];
  let ix = null;
  for (const l of logs) {
    const m = /^Program log: Instruction: (\w+)$/.exec(l);
    if (!m) continue;
    const snake = pascalToSnake(m[1]);
    if (KNOWN.has(snake)) { ix = snake; break; }
  }
  const inDlp = (tx.transaction.message.staticAccountKeys ?? []).some((k) => k.equals(DLP))
    || (tx.meta?.loadedAddresses?.writable ?? []).some((k) => k.equals(DLP))
    || (tx.meta?.loadedAddresses?.readonly ?? []).some((k) => k.equals(DLP));
  // tUSDC 移动量 = 正向 delta 之和（转账两边互为镜像，取正的一侧）
  let amount = 0n;
  const pre = new Map(), post = new Map();
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.mint === TUSDC_MINT) pre.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.mint === TUSDC_MINT) post.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
  for (const [i, v] of post) {
    const d = v - (pre.get(i) ?? 0n);
    if (d > 0n) amount += d;
  }
  const payer = tx.transaction.message.staticAccountKeys?.[0]?.toBase58() ?? "";
  return { ix, inDlp, validatorFee: payer === TEE_VALIDATOR.toBase58(), amount, payer, fee: tx.meta?.fee ?? 0, err: tx.meta?.err ?? null };
}

// --explain <sig>：打印一笔交易的原始日志与解码过程（排查标签为何是「其他」）
const explainIdx = argv.indexOf("--explain");
if (explainIdx >= 0) {
  const sig = argv[explainIdx + 1];
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) { console.error("交易不存在"); process.exit(1); }
  console.log("程序（前 8 个静态账户）:", tx.transaction.message.staticAccountKeys.slice(0, 8).map((k) => k.toBase58()).join("\n  "));
  console.log("\nProgram log: Instruction 行:");
  for (const l of tx.meta?.logMessages ?? []) if (/Instruction:/.test(l)) console.log("  ", l);
  const d = await decodeTx(sig);
  console.log("\n解码:", JSON.stringify({ ...d, amount: d?.amount?.toString() }, null, 1));
  process.exit(0);
}

const out = [];
for (const id of ids) {
  const table = pda([Buffer.from("table"), u32le(id)]);
  const replay = pda([Buffer.from("replay"), table.toBuffer()]);
  const addrs = [
    ["Table", table],
    ["Game", pda([Buffer.from("game"), table.toBuffer()])],
    ...Array.from({ length: 9 }, (_, i) => [`Seat${i}`, pda([Buffer.from("seat"), table.toBuffer(), Buffer.from([i])])]),
    ["Replay", replay],
  ];
  const seen = new Map();
  for (const [label, a] of addrs) {
    let hist = [];
    try { hist = await addressHistory(a.toBase58()); } catch (e) { console.warn(`  ${label} 历史失败: ${e.message}`); continue; }
    for (const t of hist) {
      if (!t.signature) continue;
      const prev = seen.get(t.signature);
      const tags = (prev?.tags ?? []);
      if (!prev) seen.set(t.signature, { ...t, tags: [label] });
      else { prev.tags.push(label); prev.err = prev.err ?? t.err; }
    }
  }
  const merged = [...seen.values()].sort((a, b) => b.slot - a.slot).slice(0, 30);
  const items = [];
  for (let i = 0; i < merged.length; i += 8) {
    const batch = merged.slice(i, i + 8);
    const dec = await Promise.all(batch.map((t) => decodeTx(t.signature).catch(() => null)));
    for (let k = 0; k < batch.length; k++) {
      const t = batch[k], d = dec[k];
      items.push({
        signature: t.signature, slot: t.slot, blockTime: t.blockTime, accounts: t.tags,
        ix: d?.ix ?? null, inDlp: d?.inDlp ?? false, validatorFee: d?.validatorFee ?? false,
        amount: d ? d.amount.toString() : null,
        payer: d?.payer ?? null, fee: d?.fee ?? null, err: (d?.err ?? t.err) ? String(d?.err ?? t.err) : null,
      });
    }
  }
  out.push({ tableId: id, table: table.toBase58(), items });
}

if (asJson) {
  console.log(JSON.stringify({ source, generatedAt: new Date().toISOString(), tables: out }, null, 1));
} else {
  for (const t of out) {
    console.log(`\n=== 桌 #${t.tableId}  L1 审计（来源: ${source}）  table=${t.table.slice(0, 8)}… ===`);
    if (!t.items.length) { console.log("  （无 L1 历史）"); continue; }
    for (const it of t.items) {
      const when = it.blockTime ? new Date(it.blockTime * 1000).toISOString().replace("T", " ").slice(5, 16) : "   —   ";
      const label = it.ix
        ? (LABEL[it.ix] ?? it.ix)
        : it.validatorFee
          ? "PER 快照/委托"
          : it.inDlp
            ? "含 DLP 调用"
            : "其他";
      const amt = it.amount && it.amount !== "0" ? `${(Number(it.amount) / 1e6).toFixed(2)} tUSDC` : "—";
      console.log(
        `  ${String(it.slot).padEnd(12)} ${when}  ${label.padEnd(10, "　")} ${amt.padStart(12)}  ` +
        `${it.signature.slice(0, 8)}…${it.signature.slice(-4)}  [${it.accounts.slice(0, 3).join(",")}]` +
        (it.err ? `  ⚠ ${it.err.slice(0, 40)}` : "")
      );
    }
  }
  console.log(`\n共 ${out.reduce((n, t) => n + t.items.length, 0)} 笔（每桌上限 30）。`);
}
