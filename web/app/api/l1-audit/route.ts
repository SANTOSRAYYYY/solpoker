// /api/l1-audit — L1 侧审计视图（服务端）。
//
// 为什么在服务端：Helius 的解析历史 API（/v0/addresses/…）需要 API key；key 只存在
// 服务端的 HELIUS_RPC（web/.env.local，非 NEXT_PUBLIC），浏览器 bundle 里永远没有它。
//
// 数据流：对本桌的 12 个地址（Table/Game/9×Seat/Replay）各取一份 Helius 解析历史
// → 按签名去重合并 → 按 slot 倒序 → 对最近 N 笔取 L1 原始交易解出：
//   · 指令名（anchor 打 `Program log: Instruction: <Name>`，与我们 IDL 对齐）
//   · tUSDC 移动量（token balance 正向 delta）
//   · 付款人（区分玩家 vs TEE 验证者）、费用、失败标记
// Helius 没有本程序的 IDL，它的 type/description 恒为 UNKNOWN/空（已实测），
// 所以语义标签必须由我们自己解 —— 这里返回的就是解码后的标签。
//
// 覆盖范围：L1 动作（建桌/入座/接座/离座/兑现/commit 快照/委托 ER/init_replay…）。
// 玩家行动（fold/call/raise）发生在 ER，不在这里 —— 那是 /history「行动流验证」的活。
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "@/lib/idl/solpoker.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** serverless（Vercel）：12 个地址的解析历史 + 最近 N 笔原始交易，给足时间 */
export const maxDuration = 60;

const PROGRAM_ID = new PublicKey(idl.address);
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const TUSDC_MINT = "9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH";

const KNOWN = new Set((idl.instructions as { name: string }[]).map((i) => i.name));
const LABEL: Record<string, string> = {
  create_table: "建桌", create_seats: "建座位", create_hands: "建手牌槽",
  init_config: "初始化配置", init_permissions: "初始化权限", init_replay: "初始化复算环",
  register_agent: "注册代理", update_agent: "更新代理", set_agent_status: "代理状态",
  set_agent_payout: "代理收款", pause_agent: "暂停代理", resume_agent: "恢复代理",
  revoke_agent: "吊销代理", allow_owner: "授权 owner", remove_owner: "移除 owner",
  sit_down: "入座", take_seat: "接座", stand_up: "离座", cash_out: "兑现", top_up: "补币",
  commit_salt: "盐承诺", reveal_salt: "盐揭示",
  delegate_table: "委托 ER", process_undelegation: "撤出 ER",
  commit_game: "提交快照", request_vrf: "请求随机数", retry_vrf: "重试随机数",
  vrf_callback: "随机数回调", debug_arm_vrf: "调试 arm",
  advance: "推进阶段", act: "玩家行动", claim_timeout: "超时裁决",
  apply_deposits: "入账", sweep_rake: "抽水", audit_table: "审计",
  admin_force_stand_up: "管理强离", admin_set_members: "管理成员",
  set_session: "会话授权", revoke_session: "会话吊销", credit_x402_deposit: "x402 入账", refund_x402_deposit: "x402 退款",
};

const pascalToSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const u32le = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const pda = (seeds: (Uint8Array | Buffer)[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

const heliusKeyed = process.env.HELIUS_RPC ?? "";
const heliusBase = heliusKeyed.includes("api-key=") ? new URL(heliusKeyed).origin : null;
const heliusKey = heliusBase ? new URL(heliusKeyed).searchParams.get("api-key") : null;
const l1Url =
  process.env.HELIUS_RPC ?? process.env.NEXT_PUBLIC_L1_RPC ?? "https://rpc.magicblock.app/devnet";

export interface AuditItem {
  signature: string;
  slot: number;
  blockTime: number | null;
  accounts: string[];
  ix: string | null;
  label: string;
  kind: "game" | "per" | "other";
  amount: string | null;
  payer: string | null;
  fee: number | null;
  err: string | null;
}

const cache = new Map<number, { at: number; body: unknown }>();
const TTL_MS = 15_000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tableId = Number(url.searchParams.get("table") ?? 14);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 30), 60);
  if (!Number.isInteger(tableId) || tableId < 0) {
    return Response.json({ error: "table must be a non-negative integer" }, { status: 400 });
  }
  const headers = { "Cache-Control": "private, max-age=10" };
  const hit = cache.get(tableId);
  if (hit && Date.now() - hit.at < TTL_MS) return Response.json(hit.body, { headers });

  const conn = new Connection(l1Url, { commitment: "confirmed" });
  const table = pda([Buffer.from("table"), u32le(tableId)]);
  const addrs: [string, PublicKey][] = [
    ["Table", table],
    ["Game", pda([Buffer.from("game"), table.toBytes()])],
    ...Array.from({ length: 9 }, (_, i): [string, PublicKey] => [
      `Seat${i}`,
      pda([Buffer.from("seat"), table.toBytes(), new Uint8Array([i])]),
    ]),
    ["Replay", pda([Buffer.from("replay"), table.toBytes()])],
  ];

  async function addressHistory(addr: string) {
    if (heliusBase) {
      const r = await fetch(
        `${heliusBase}/v0/addresses/${addr}/transactions/?api-key=${heliusKey}&limit=12`,
        { signal: AbortSignal.timeout(20000) }
      );
      if (!r.ok) throw new Error(`helius ${r.status}`);
      const j = (await r.json()) as { signature: string; slot: number; timestamp: number | null; transactionError: unknown }[];
      return j.map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.timestamp, err: t.transactionError ?? null }));
    }
    const sigs = await conn.getSignaturesForAddress(new PublicKey(addr), { limit: 12 });
    return sigs.map((s) => ({
      signature: s.signature,
      slot: s.slot,
      blockTime: s.blockTime ?? null,
      err: s.err ?? null,
    }));
  }

  const seen = new Map<string, { signature: string; slot: number; blockTime: number | null; err: unknown; tags: string[] }>();
  await Promise.all(
    addrs.map(async ([label, a]) => {
      try {
        for (const t of await addressHistory(a.toBase58())) {
          const prev = seen.get(t.signature);
          if (!prev) seen.set(t.signature, { ...t, tags: [label] });
          else {
            prev.tags.push(label);
            prev.err = prev.err ?? t.err;
          }
        }
      } catch {
        /* 单地址失败不拖垮整页 */
      }
    })
  );
  const merged = [...seen.values()].sort((a, b) => b.slot - a.slot).slice(0, limit);

  const items: AuditItem[] = [];
  for (let i = 0; i < merged.length; i += 8) {
    const batch = merged.slice(i, i + 8);
    const dec = await Promise.all(
      batch.map(async (t) => {
        try {
          const tx = await conn.getTransaction(t.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          });
          if (!tx) return null;
          let ix: string | null = null;
          for (const l of tx.meta?.logMessages ?? []) {
            const m = /^Program log: Instruction: (\w+)$/.exec(l);
            if (!m) continue;
            const snake = pascalToSnake(m[1]);
            if (KNOWN.has(snake)) {
              ix = snake;
              break;
            }
          }
          const keys = [
            ...(tx.transaction.message.staticAccountKeys ?? []),
            ...(tx.meta?.loadedAddresses?.writable ?? []),
            ...(tx.meta?.loadedAddresses?.readonly ?? []),
          ];
          const inDlp = keys.some((k) => k.equals(DLP));
          const payer = tx.transaction.message.staticAccountKeys?.[0]?.toBase58() ?? null;
          let amount = 0n;
          const pre = new Map<number, bigint>();
          const post = new Map<number, bigint>();
          for (const b of tx.meta?.preTokenBalances ?? [])
            if (b.mint === TUSDC_MINT) pre.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
          for (const b of tx.meta?.postTokenBalances ?? [])
            if (b.mint === TUSDC_MINT) post.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
          for (const [idx, v] of post) {
            const d = v - (pre.get(idx) ?? 0n);
            if (d > 0n) amount += d;
          }
          return { ix, inDlp, payer, amount, fee: tx.meta?.fee ?? 0, err: tx.meta?.err ?? null };
        } catch {
          return null;
        }
      })
    );
    for (let k = 0; k < batch.length; k++) {
      const t = batch[k];
      const d = dec[k];
      const err = d?.err ?? t.err;
      const kind: AuditItem["kind"] = d?.ix ? "game" : d?.payer === TEE_VALIDATOR.toBase58() ? "per" : "other";
      items.push({
        signature: t.signature,
        slot: t.slot,
        blockTime: t.blockTime,
        accounts: t.tags,
        ix: d?.ix ?? null,
        label: d?.ix
          ? LABEL[d.ix] ?? d.ix
          : kind === "per"
            ? "PER 快照/委托"
            : d?.inDlp
              ? "含 DLP 调用"
              : "其他",
        kind,
        amount: d ? d.amount.toString() : null,
        payer: d?.payer ?? null,
        fee: d?.fee ?? null,
        err: err ? String(err) : null,
      });
    }
  }

  const body = {
    source: heliusBase ? "helius-parsed" : "raw-rpc",
    tableId,
    table: table.toBase58(),
    fetchedAt: Math.floor(Date.now() / 1000),
    items,
  };
  cache.set(tableId, { at: Date.now(), body });
  return Response.json(body, { headers });
}
