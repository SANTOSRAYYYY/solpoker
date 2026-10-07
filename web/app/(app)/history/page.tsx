"use client";

// 手牌历史与验证（真实数据）
//
// 数据：HandProof（16 槽环形缓冲，每手一条：board / hole / deltas / transcript_final）
//      + HandSecrets（同槽：salts / vrf_out / vrf_mask）
//
// 本页能**当场复算**的（浏览器 WebCrypto，全部是真实链上数据）：
//   1) 结算守恒：Σ deltas == −rake，且每座 delta 与 occupancy_id 对得上；
//   2) 盐承诺：sha256("solpoker/salt/v1" ‖ table ‖ hand_id ‖ occupant ‖ salt)
//      —— 对**当前手**可直接与链上 Game.seats[i].salt_commit 比对（真·端到端）；
//   3) 盐摘要与逐街种子：salt_digest → seed_k = sha256("solpoker/seed/v1" ‖ VRF_k ‖ digest)。
//
// 尚不能在本页完成的：整手 52 张牌序复算还需要**该手的完整事件流**
// （每次下注/跟注都进 transcript，而 transcript_digest 是每张牌的抽取输入）。
// 事件流要重放 L1 交易历史 —— 这是 verify_hand 工具（scripts/agent）的下一步，
// 参考实现见 reference/solpoker_deal.py（Stage 4 三方逐字节一致）。

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Connection } from "@solana/web3.js";
import {
  Badge,
  Chip,
  Dot,
  KV,
  PlayingCard,
  SectionTitle,
  SolMark,
  type Suit,
} from "@/components/ui";
import { useWalletCtx } from "@/components/wallet-context";
import { ER_RPC } from "@/lib/config";
import { pdasFor } from "@/lib/solpoker-client";
import { fmtUsdc, type GameView } from "@/lib/game-state";
import {
  readHandProof,
  readHandSecrets,
  readGameLive,
  type ProofEntryView,
  type SecretsEntryView,
} from "@/lib/chain-read";
import { scanTables, type TableInfo } from "@/lib/tables";

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS: Suit[] = ["♠", "♥", "♦", "♣"];
const cardParts = (c: number) =>
  c >= 52 ? null : { rank: RANKS[c >> 2], suit: SUITS[c & 3] };

// ---------------------------------------------------------------- WebCrypto
const enc = new TextEncoder();
const cat = (...parts: Uint8Array[]) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u8 = (n: number) => new Uint8Array([n & 0xff]);
const u16be = (n: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, false);
  return b;
};
const u64be = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, false);
  return b;
};
const hex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const shortHex = (b: Uint8Array) => `${hex(b.slice(0, 4))}…${hex(b.slice(-2))}`;

async function sha256(...parts: Uint8Array[]) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", cat(...parts)));
}

/** C_i = sha256("solpoker/salt/v1" ‖ table ‖ hand_id(u64) ‖ player ‖ salt) */
async function saltCommitment(
  table: Uint8Array,
  handId: bigint,
  player: Uint8Array,
  salt: Uint8Array
) {
  return sha256(enc.encode("solpoker/salt/v1"), table, u64be(handId), player, salt);
}

/** salt_digest = sha256("solpoker/salts/v1" ‖ table ‖ hand_id ‖ hand_mask ‖ 每座(seat|occ_id|occupant|salt)) */
async function saltDigest(
  table: Uint8Array,
  handId: bigint,
  handMask: number,
  occupants: Uint8Array[],
  occupancyIds: bigint[],
  salts: Uint8Array[]
) {
  const parts: Uint8Array[] = [
    enc.encode("solpoker/salts/v1"),
    table,
    u64be(handId),
    u16be(handMask),
  ];
  for (let s = 0; s < 9; s++) {
    if ((handMask & (1 << s)) === 0) continue;
    parts.push(u8(s), u64be(occupancyIds[s]), occupants[s], salts[s]);
  }
  return sha256(...parts);
}

/** seed_k = sha256("solpoker/seed/v1" ‖ VRF_k ‖ salt_digest) */
async function streetSeed(vrfK: Uint8Array, digest: Uint8Array) {
  return sha256(enc.encode("solpoker/seed/v1"), vrfK, digest);
}

// ---------------------------------------------------------------- 组件
function HandRow({
  entry,
  idx,
  selected,
  onPick,
}: {
  entry: ProofEntryView;
  idx: number;
  selected: boolean;
  onPick: () => void;
}) {
  const won = entry.deltas.some((d) => d > 0n);
  return (
    <button
      onClick={onPick}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected
          ? "border-accent-400/70 bg-accent-500/12"
          : "border-transparent hover:border-accent-500/25 hover:bg-white/[0.03]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-bold text-mist">手 #{entry.handId.toString()}</span>
          {entry.status === 1 && <Badge tone="danger" className="!px-2 !text-[10px]">作废</Badge>}
        </span>
        <span className="font-mono text-[11px] text-mist-faint">
          {entry.settledAt > 0n
            ? new Date(Number(entry.settledAt) * 1000).toISOString().slice(5, 16).replace("T", " ")
            : "—"}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        {entry.board.slice(0, 5).map((c, i) => {
          const p = cardParts(c);
          return p ? (
            <PlayingCard key={i} rank={p.rank} suit={p.suit} w={22} />
          ) : (
            <span key={i} className="pcard-slot inline-block" style={{ ["--pc-w" as string]: "22px" }} />
          );
        })}
        <span className="ml-1 text-[10.5px] text-mist-faint">槽 {idx}</span>
      </div>
    </button>
  );
}

export default function HistoryPage() {
  const ctx = useWalletCtx();
  const er = useMemo(() => new Connection(ER_RPC, "confirmed"), []);

  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tableId, setTableId] = useState<number | null>(null);
  const [entries, setEntries] = useState<(ProofEntryView | null)[]>([]);
  const [secrets, setSecrets] = useState<(SecretsEntryView | null)[]>([]);
  const [game, setGame] = useState<GameView | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [check, setCheck] = useState<
    | { phase: "idle" }
    | { phase: "running" }
    | {
        phase: "done";
        digest: string;
        seeds: string[];
        commits: { seat: number; computed: string; onchain: string | null; ok: boolean | null }[];
        conservation: { sum: string; rake: string; ok: boolean };
      }
  >({ phase: "idle" });

  // 桌列表
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const all = await scanTables(ctx.l1);
        if (stop) return;
        setTables(all);
        setTableId((cur) => cur ?? all[0]?.id ?? null);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      stop = true;
    };
  }, [ctx.l1]);

  // 该桌的 proof + secrets + 实时 game（用于「当前手」的链上承诺比对）
  useEffect(() => {
    if (tableId === null) return;
    let stop = false;
    (async () => {
      for (;;) {
        if (stop) return;
        try {
          const [proof, sec, live] = await Promise.all([
            readHandProof(ctx.l1, tableId),
            readHandSecrets(ctx.l1, tableId),
            readGameLive(er, ctx.l1, tableId).catch(() => null),
          ]);
          setEntries(proof?.entries ?? []);
          setSecrets(sec ?? []);
          setGame(live?.game ?? null);
          setSel((cur) => (cur === null && proof ? proof.entries.findIndex((e) => e) : cur));
        } catch {
          /* 下一轮 */
        }
        await new Promise((r) => setTimeout(r, 10000));
      }
    })();
    return () => {
      stop = true;
    };
  }, [ctx.l1, er, tableId]);

  const entry = sel !== null ? entries[sel] ?? null : null;
  const secret = sel !== null ? secrets[sel] ?? null : null;

  const liveEntries = useMemo(
    () => entries.map((e, i) => ({ e, i })).filter((x): x is { e: ProofEntryView; i: number } => !!x.e),
    [entries]
  );

  /** 当场复算：守恒 + 盐摘要 + 逐街种子 +（若为当前手）链上承诺比对 */
  const runCheck = useCallback(async () => {
    if (!entry || tableId === null) return;
    setCheck({ phase: "running" });
    try {
      const tableBytes = pdasFor(tableId).table.toBytes();
      // 守恒：Σ deltas == −rake
      let sum = 0n;
      for (let i = 0; i < 9; i++) {
        if ((entry.handMask & (1 << i)) === 0) continue;
        sum += entry.deltas[i];
      }
      const conservation = {
        sum: sum.toString(),
        rake: entry.rake.toString(),
        ok: sum === -entry.rake,
      };

      if (!secret) {
        setCheck({
          phase: "done",
          digest: "(无 HandSecrets：该槽没有盐记录)",
          seeds: [],
          commits: [],
          conservation,
        });
        return;
      }

      // HandSecrets 不存 occupant；只有「当前手」能从实时 Game 里拿到 9 个 occupant，
      // 因此盐摘要与承诺只对当前手可算（历史手的 occupant 需要重放交易历史）。
      const isCurrent = game !== null && entry.handId === game.handId;
      if (!isCurrent || !game) {
        setCheck({
          phase: "done",
          digest: "(历史手缺少 occupant 字段，salt_digest 需要交易历史重放)",
          seeds: [],
          commits: [],
          conservation,
        });
        return;
      }

      const occupants = Array.from({ length: 9 }, (_, i) =>
        game.seats[i].occupant.toBytes()
      );
      const occupancyIds = entry.occupancyIds.map((v) => v);

      const digest = await saltDigest(
        tableBytes,
        entry.handId,
        entry.handMask,
        occupants,
        occupancyIds,
        secret.salts
      );
      const seeds: string[] = [];
      for (let k = 0; k < 5; k++) {
        if ((secret.vrfMask & (1 << k)) === 0) continue;
        const s = await streetSeed(secret.vrfOut[k], digest);
        seeds.push(`seed_${k} = ${shortHex(s)}（sha256("solpoker/seed/v1" ‖ VRF_${k} ‖ digest)）`);
      }

      const commits: { seat: number; computed: string; onchain: string | null; ok: boolean | null }[] = [];
      for (let s = 0; s < 9; s++) {
        if ((entry.handMask & (1 << s)) === 0) continue;
        const c = await saltCommitment(tableBytes, entry.handId, occupants[s], secret.salts[s]);
        const onchainHex = hex(game.seats[s].saltCommit);
        commits.push({
          seat: s,
          computed: shortHex(c),
          onchain: shortHex(game.seats[s].saltCommit),
          ok: onchainHex === hex(c),
        });
      }
      setCheck({ phase: "done", digest: shortHex(digest), seeds, commits, conservation });
    } catch (e) {
      setCheck({ phase: "idle" });
      // eslint-disable-next-line no-console
      console.error("复算失败", e);
    }
  }, [entry, secret, tableId, game]);

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-5 sm:py-8">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="title-cn text-[24px] text-mist">手牌历史与验证</h1>
          <p className="mt-1 max-w-[720px] text-[13px] leading-relaxed text-mist-dim">
            每一手都在 L1 留下 HandProof（牌面/输赢/事件链摘要）与 HandSecrets（盐与 VRF）。
            浏览器里能当场复算的东西都放在下面 —— 没做到的也写清楚了。
          </p>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-mist-dim">
          牌桌
          <select
            value={tableId ?? ""}
            onChange={(e) => {
              setTableId(Number(e.target.value));
              setSel(null);
              setCheck({ phase: "idle" });
            }}
            className="rounded-lg border border-accent-500/30 bg-black/40 px-3 py-2 font-mono text-[12px] text-accent-200 outline-none"
          >
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                #{t.id} · {t.kind === 2 ? "混合" : t.kind === 1 ? "AI" : "真人"} ·{" "}
                {t.blindsText}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* ---------------------------------------------------- 手牌列表 */}
        <section className="panel max-h-[720px] overflow-hidden p-3">
          <div className="scroll-thin max-h-[700px] space-y-1 overflow-y-auto pr-1">
            {liveEntries.map(({ e, i }) => (
              <HandRow
                key={i}
                entry={e}
                idx={i}
                selected={sel === i}
                onPick={() => {
                  setSel(i);
                  setCheck({ phase: "idle" });
                }}
              />
            ))}
            {liveEntries.length === 0 && (
              <p className="p-3 text-[12px] text-mist-faint">
                这张桌还没有结算过的手牌（HandProof 是 16 槽环形缓冲）。
              </p>
            )}
          </div>
        </section>

        {/* ---------------------------------------------------- 详情 + 验证 */}
        <section className="space-y-5">
          {entry ? (
            <>
              <div className="panel p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <h2 className="title-cn text-[17px] text-mist">
                      手牌 #{entry.handId.toString()}
                    </h2>
                    <Badge tone="plain">桌 #{tableId}</Badge>
                    {entry.status === 1 ? (
                      <Badge tone="danger">作废（未结算）</Badge>
                    ) : (
                      <Badge tone="mint">
                        <Dot kind="live" /> 已结算
                      </Badge>
                    )}
                  </div>
                  <span className="font-mono text-[11.5px] text-mist-faint">
                    {entry.settledAt > 0n
                      ? new Date(Number(entry.settledAt) * 1000).toISOString().slice(0, 16).replace("T", " ")
                      : "—"}
                  </span>
                </div>

                <div className="mb-4 flex flex-wrap items-end gap-6">
                  <div>
                    <div className="mb-1.5 text-[11px] text-mist-faint">公共牌</div>
                    <div className="flex gap-1.5">
                      {entry.board.map((c, i) => {
                        const p = cardParts(c);
                        return p ? (
                          <PlayingCard key={i} rank={p.rank} suit={p.suit} w={46} />
                        ) : (
                          <span
                            key={i}
                            className="pcard-slot inline-block"
                            style={{ ["--pc-w" as string]: "46px" }}
                          />
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-xl border border-accent-500/15 bg-black/25 px-4 py-3">
                    <div className="mb-2 text-[11px] tracking-widest text-mist-faint">
                      结算明细（delta = 本手净变）
                    </div>
                    {Array.from({ length: 9 }, (_, k) => k)
                      .filter((i) => (entry.handMask & (1 << i)) !== 0)
                      .map((i) => (
                        <KV key={i} k={`座 ${i} · occ ${entry.occupancyIds[i].toString()}`} mono>
                          <span
                            className={
                              entry.deltas[i] > 0n
                                ? "text-win"
                                : entry.deltas[i] < 0n
                                  ? "text-loss"
                                  : "text-mist-faint"
                            }
                          >
                            {entry.deltas[i] > 0n ? "+" : ""}
                            {fmtUsdc(entry.deltas[i])}
                          </span>
                        </KV>
                      ))}
                    <KV k="抽水 rake" mono>
                      {fmtUsdc(entry.rake)}
                    </KV>
                  </div>
                  <div className="rounded-xl border border-accent-500/15 bg-black/25 px-4 py-3">
                    <div className="mb-2 text-[11px] tracking-widest text-mist-faint">
                      发牌证明（链上字段）
                    </div>
                    <KV k="事件链摘要" mono>
                      {shortHex(entry.transcriptFinal)}
                    </KV>
                    <KV k="庄位按钮" mono>
                      {entry.button}
                    </KV>
                    <KV k="hand_mask" mono>
                      0x{entry.handMask.toString(16).padStart(3, "0")}
                    </KV>
                    <KV k="盐/VRF 记录">
                      {secret ? (
                        <span className="text-win">✓ 同槽 HandSecrets</span>
                      ) : (
                        <span className="text-mist-faint">— 无</span>
                      )}
                    </KV>
                    {secret && (
                      <KV k="VRF mask" mono>
                        0x{secret.vrfMask.toString(16)}（用到 {secret.vrfMask.toString(2).split("1").length - 1} 个）
                      </KV>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    className="btn-casino btn-brand px-5 py-2.5 text-[13px]"
                    onClick={runCheck}
                    disabled={check.phase === "running"}
                  >
                    {check.phase === "running" ? "复算中…" : "当场复算（守恒 / 盐摘要 / 种子）"}
                  </button>
                  <a
                    href="https://github.com/SANTOSRAYYYY/solpoker/blob/main/reference/solpoker_deal.py"
                    target="_blank"
                    rel="noreferrer"
                    className="btn-casino btn-glass px-4 py-2.5 text-[12.5px]"
                  >
                    参考验证器（Python）↗
                  </a>
                </div>

                {check.phase === "done" && (
                  <div className="mt-4 space-y-2 rounded-xl border border-accent-500/20 bg-black/30 p-4 font-mono text-[11.5px] leading-relaxed">
                    <div className="flex items-center gap-2 text-mist">
                      <Badge tone={check.conservation.ok ? "mint" : "danger"}>
                        {check.conservation.ok ? "守恒 ✓" : "守恒 ✗"}
                      </Badge>
                      <span className="text-mist-dim">
                        Σ deltas = {fmtUsdc(BigInt(check.conservation.sum))} · rake ={" "}
                        {fmtUsdc(BigInt(check.conservation.rake))}（应互为相反数）
                      </span>
                    </div>
                    <div className="text-mist-dim">salt_digest = {check.digest}</div>
                    {check.seeds.map((s, i) => (
                      <div key={i} className="text-mist-dim">
                        {s}
                      </div>
                    ))}
                    {check.commits.length > 0 && (
                      <div className="pt-1">
                        <div className="mb-1 text-mist-faint">
                          盐承诺（仅当前手能与链上 Game 比对）：
                        </div>
                        {check.commits.map((c) => (
                          <div key={c.seat} className="flex items-center gap-2">
                            <span className="text-mist-dim">
                              座 {c.seat}: 复算 {c.computed}
                            </span>
                            <span className={c.ok ? "text-win" : "text-loss"}>
                              · 链上 {c.onchain} {c.ok ? "✓ 一致" : "✗ 不一致"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 事件流 / 下一步 */}
              <div className="panel p-5">
                <SectionTitle zh="还没做到的：整手 52 张复算" en="What's still missing" />
                <p className="text-[12.5px] leading-relaxed text-mist-dim">
                  每张牌的抽取输入里包含 <span className="font-mono">transcript_digest</span>
                  （从 HandStart 到该张牌之前的所有事件：盲注、每次下注/跟注/加注）。
                  HandProof 只存最终摘要，所以完整复算需要重放**该手的 L1 交易历史**。
                  这是 <span className="font-mono">verify_hand</span> 工具的下一步，
                  参考实现在{" "}
                  <a
                    href="https://github.com/SANTOSRAYYYY/solpoker/blob/main/reference/solpoker_deal.py"
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent-200 hover:underline"
                  >
                    reference/solpoker_deal.py
                  </a>
                  （Stage 4 已与 Rust 逐字节一致）。
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-lg border border-mint/25 bg-mint/5 p-3 text-[12px] text-mist-dim">
                    ✓ 已可验证：守恒 · 盐摘要 · 种子 · 当前手承诺
                  </div>
                  <div className="rounded-lg border border-warn/25 bg-warn/5 p-3 text-[12px] text-mist-dim">
                    ⏳ 待做：事件流重放 → 52 张牌序
                  </div>
                  <div className="rounded-lg border border-accent-500/25 bg-accent-500/5 p-3 text-[12px] text-mist-dim">
                    ✓ 已可验证：L1 上的一切都在（tx 历史可自行抓取）
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="panel p-6 text-[12.5px] text-mist-faint">
              左侧选一手牌查看证明。
            </div>
          )}

          <div className="panel flex items-center gap-3 p-4 text-[11.5px] text-mist-faint">
            <SolMark size={18} />
            <span>
              数据源：L1 HandProof/HandSecrets（16 手环形缓冲）+ ER 实时 Game（公开账户）。
              每手结束后 commit 回 L1，历史交易在 Solscan 可查。
            </span>
          </div>
        </section>
      </div>
    </main>
  );
}
