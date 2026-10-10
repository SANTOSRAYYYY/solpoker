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
import { verifyVector, webCrypto, dealFromReplay, verifyActionStream } from "@/lib/deal-verify.mjs";
import { fetchHandEvents } from "@/lib/act-log.mjs";
import { DEAL_VECTORS } from "@/lib/vectors";
import {
  readGameLive,
  readHandProofLive,
  readHandProof,
  readHandSecrets,
  readHandReplay,
  readHandSecretsLive,
  type ProofEntryView,
  type ReplayEntryView,
  type SecretsEntryView,
} from "@/lib/chain-read";
import { scanTables, type TableInfo } from "@/lib/tables";
import { useLiveUpdates } from "@/lib/live-updates";
import { useL1Audit, solscanTx, auditTone, fmtAuditAmount } from "@/lib/l1-audit";
import { useI18n } from "@/lib/i18n";

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
  const { t: tr } = useI18n();
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
          <span className="text-[13px] font-bold text-mist">
            {tr("history.handRow", { n: entry.handId.toString() })}
          </span>
          {entry.status === 1 && <Badge tone="danger" className="!px-2 !text-[10px]">{tr("history.void")}</Badge>}
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
        <span className="ml-1 text-[10.5px] text-mist-faint">{tr("history.slot", { n: idx })}</span>
      </div>
    </button>
  );
}

export default function HistoryPage() {
  const { t: tr } = useI18n();
  const ctx = useWalletCtx();
  const er = useMemo(() => new Connection(ER_RPC, "confirmed"), []);

  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tableId, setTableId] = useState<number | null>(null);
  const [entries, setEntries] = useState<(ProofEntryView | null)[]>([]);
  // 复算输入的数据源（审计 M2/H6）：L1 已提交快照 vs ER 实时态。
  const [proofSource, setProofSource] = useState<"L1" | "ER">("L1");
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
  /** HandReplay（§8.7 整手复算输入；委托账户 → 从 ER 读） */
  const [replay, setReplay] = useState<
    { entries: (ReplayEntryView | null)[]; source: "er" | "l1" } | null
  >(null);
  /** 整手复算结果 */
  const [full, setFull] = useState<
    | { phase: "idle" }
    | { phase: "running" }
    | { phase: "done"; ok: boolean; draws: number; matched: number; diffs: string[] }
  >({ phase: "idle" });
  /** 行动流验证结果（从 ER 交易日志重建行动序列 → 对 street_end / transcript_final） */
  const [stream, setStream] = useState<
    | { phase: "idle" }
    | { phase: "running" }
    | {
        phase: "done";
        ok: boolean;
        events: number;
        perStreet: { street: number; actions: number; closed: boolean }[];
        diffs: string[];
      }
  >({ phase: "idle" });
  /** 引擎自检：用页面同一套 deal-verify 跑 Stage-4 向量 */
  const [engine, setEngine] = useState<
    | { phase: "idle" }
    | { phase: "running" }
    | {
        phase: "done";
        results: { name: string; ok: boolean; board: string; button: number; diffs: string[] }[];
      }
  >({ phase: "idle" });

  /** L1 审计视图：表级时间线（服务端 Helius 解析历史 + 我们自己的指令解码） */
  const live = useLiveUpdates();
  const audit = useL1Audit(tableId, live.tick);

  // 桌列表（附每桌已结算手牌数：读 HandProof 的 head 字段）
  const [handCounts, setHandCounts] = useState<Record<number, number>>({});
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const all = await scanTables(ctx.l1);
        if (stop) return;
        setTables(all);
        // 6 路并发读 head（每桌一次账户读；白名单 23 桌 ≈ 一次延迟）
        const counts: Record<number, number> = {};
        const limit = 6;
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(limit, all.length) }, async () => {
            for (;;) {
              const i = next++;
              if (i >= all.length) return;
              const t = all[i];
              try {
                const acc = await ctx.l1.getAccountInfo(pdasFor(t.id).handProof);
                if (acc && acc.data.length >= 3728) counts[t.id] = acc.data[3720];
              } catch {
                /* 单桌失败不影响其它 */
              }
            }
          })
        );
        if (stop) return;
        setHandCounts(counts);
        // 默认选「有手牌里 id 最小」的桌；全都没有手牌才退回第一张
        setTableId((cur) => {
          if (cur !== null) return cur;
          // 默认选「手牌最多」的桌（并列取 id 最小）——最能说明问题的桌优先
          let best: number | null = null;
          let bestCount = 0;
          for (const t of all) {
            const c = counts[t.id] ?? 0;
            if (c > bestCount || (c === bestCount && c > 0 && best !== null && t.id < best)) {
              if (c > 0) {
                best = t.id;
                bestCount = c;
              }
            }
          }
          return best ?? all[0]?.id ?? null;
        });
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
          // 2026-10-10（审计 M2/H6）：复算输入**优先取 L1**（commit 后的快照，
          // 被审计方无法事后伪造）；L1 还没有这手（未提交）才回落 ER，
          // 界面用徽章标注数据源。
          const [l1Proof, l1Sec, l1Rep, live] = await Promise.all([
            readHandProof(ctx.l1, tableId),
            readHandSecrets(ctx.l1, tableId),
            readHandReplay(ctx.l1, ctx.l1, tableId).catch(() => null),
            readGameLive(er, ctx.l1, tableId).catch(() => null),
          ]);
          let proof = l1Proof;
          let sec = l1Sec;
          let rep = l1Rep;
          let src: "L1" | "ER" = "L1";
          if (!proof || proof.entries.every((e) => !e)) {
            src = "ER";
            [proof, sec, rep] = await Promise.all([
              readHandProofLive(er, ctx.l1, tableId),
              readHandSecretsLive(er, ctx.l1, tableId),
              readHandReplay(er, ctx.l1, tableId).catch(() => null),
            ]);
          }
          setProofSource(src);
          setEntries(proof?.entries ?? []);
          setSecrets(sec ?? []);
          setGame(live?.game ?? null);
          setReplay(rep);
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
  /** 这一手在 replay 环里对应哪条（按 hand_id 匹配，不靠槽位猜） */
  const replayEntry = useMemo(() => {
    if (!entry || !replay) return null;
    return replay.entries.find((r) => r && r.handId === entry.handId) ?? null;
  }, [entry, replay]);

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
          digest: tr("history.noSecrets"),
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
          digest: tr("history.noOccupant"),
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
          <h1 className="title-cn text-[24px] text-mist">{tr("history.title")}</h1>
          {/* 2026-10-10（审计 M2/H6）：复算输入的数据源徽章——L1=已提交快照（可信），
              ER=被审计方实时态（尚未提交，未过 L1 核验）。 */}
          <span
            className={`mt-1 inline-block rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] ${
              proofSource === "L1"
                ? "border-win/35 bg-win/10 text-win"
                : "border-warn/40 bg-warn/10 text-warn"
            }`}
            title={
              proofSource === "L1"
                ? "数据源：L1 已提交快照"
                : "数据源：ER 实时态（尚未提交到 L1，未过 L1 核验）"
            }
          >
            {proofSource === "L1" ? "数据源: L1 ✓" : "数据源: ER（未核验）"}
          </span>
          <p className="mt-1 max-w-[720px] text-[13px] leading-relaxed text-mist-dim">
            {tr("history.blurb")}
          </p>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-mist-dim">
          {tr("history.table")}
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
                #{t.id} · {t.kind === 2 ? tr("history.kindMixed") : t.kind === 1 ? tr("history.kindAI") : tr("history.kindHuman")} ·{" "}
                {t.blindsText}
                {(handCounts[t.id] ?? 0) > 0
                  ? " · " + tr("history.nHands", { n: handCounts[t.id] })
                  : " · " + tr("history.noHands")}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* ---------------------------------------------------- 手牌列表 */}
        <section className={`panel overflow-hidden p-3 ${liveEntries.length > 0 ? "max-h-[720px]" : ""}`}>
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
                {tr("history.emptyList")}
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
                      {tr("history.hand", { n: entry.handId.toString() })}
                    </h2>
                    <Badge tone="plain">{tr("history.tableN", { n: tableId ?? "" })}</Badge>
                    {entry.status === 1 ? (
                      <Badge tone="danger">{tr("history.voidUnsettled")}</Badge>
                    ) : (
                      <Badge tone="mint">
                        <Dot kind="live" /> {tr("history.settled")}
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
                    <div className="mb-1.5 text-[11px] text-mist-faint">{tr("history.board")}</div>
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
                      {tr("history.settlement")}
                    </div>
                    {Array.from({ length: 9 }, (_, k) => k)
                      .filter((i) => (entry.handMask & (1 << i)) !== 0)
                      .map((i) => (
                        <KV key={i} k={`${tr("history.seatN", { n: i })} · occ ${entry.occupancyIds[i].toString()}`} mono>
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
                    <KV k={tr("history.rake")} mono>
                      {fmtUsdc(entry.rake)}
                    </KV>
                  </div>
                  <div className="rounded-xl border border-accent-500/15 bg-black/25 px-4 py-3">
                    <div className="mb-2 text-[11px] tracking-widest text-mist-faint">
                      {tr("history.proofFields")}
                    </div>
                    <KV k={tr("history.eventChain")} mono>
                      {shortHex(entry.transcriptFinal)}
                    </KV>
                    <KV k={tr("history.button")} mono>
                      {entry.button}
                    </KV>
                    <KV k="hand_mask" mono>
                      0x{entry.handMask.toString(16).padStart(3, "0")}
                    </KV>
                    <KV k={tr("history.saltVrf")}>
                      {secret ? (
                        <span className="text-win">{tr("history.sameSlot")}</span>
                      ) : (
                        <span className="text-mist-faint">{tr("history.none")}</span>
                      )}
                    </KV>
                    {secret && (
                      <KV k="VRF mask" mono>
                        0x{secret.vrfMask.toString(16)}{tr("history.usedSuffix", { n: secret.vrfMask.toString(2).split("1").length - 1 })}
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
                    {check.phase === "running" ? tr("history.recalcRunning") : tr("history.recalc")}
                  </button>
                  <button
                    className="btn-casino btn-mint px-5 py-2.5 text-[13px]"
                    disabled={full.phase === "running" || !replayEntry || !secret || !entry}
                    onClick={async () => {
                      if (!replayEntry || !secret || !entry || !game) return;
                      setFull({ phase: "running" });
                      try {
                        const r = await dealFromReplay(webCrypto, {
                          // 引擎要 hex32（不是 base58）
                          table: [...pdasFor(tableId!).table.toBytes()]
                            .map((b) => b.toString(16).padStart(2, "0"))
                            .join(""),
                          handId: entry.handId.toString(),
                          handMask: entry.handMask,
                          button: entry.button,
                          occupancyIds: entry.occupancyIds.map((x) => x.toString()),
                          occupants: replayEntry.occupants.map((o) =>
                            o
                              ? [...o.toBytes()]
                                  .map((b) => b.toString(16).padStart(2, "0"))
                                  .join("")
                              : null
                          ),
                          saltDigest: [...replayEntry.saltDigest]
                            .map((b) => b.toString(16).padStart(2, "0"))
                            .join(""),
                          drawDigest: replayEntry.drawDigest.map((d) =>
                            [...d].map((b) => b.toString(16).padStart(2, "0")).join("")
                          ),
                          streetsUsed: replayEntry.streetsUsed,
                          vrfOut: secret.vrfOut.map((d) =>
                            [...d].map((b) => b.toString(16).padStart(2, "0")).join("")
                          ),
                          salts: secret.salts.map((d) =>
                            [...d].map((b) => b.toString(16).padStart(2, "0")).join("")
                          ),
                          board: entry.board,
                          hole: entry.hole,
                          // v2 条目不含 occupants：salt_digest 无法独立复算（引擎会记 note）
                          skipSaltDigestCheck: !(replayEntry.occupants ?? []).some(Boolean),
                        } as never);
                        const matched = r.draws.filter(
                          (d) => d.expected === undefined || d.expected === d.card
                        ).length;
                        setFull({
                          phase: "done",
                          ok: r.ok,
                          draws: r.draws.length,
                          matched,
                          diffs: r.diffs,
                        });
                      } catch (e) {
                        setFull({
                          phase: "done",
                          ok: false,
                          draws: 0,
                          matched: 0,
                          diffs: [String(e instanceof Error ? e.message : e)],
                        });
                      }
                    }}
                  >
                    {full.phase === "running" ? tr("history.fullRunning") : tr("history.full")}
                  </button>
                  {!replayEntry && (
                    <span className="text-[11.5px] text-warn">
                      {tr("history.noReplay")}
                    </span>
                  )}
                  <a
                    href="https://github.com/SANTOSRAYYYY/solpoker/blob/main/reference/solpoker_deal.py"
                    target="_blank"
                    rel="noreferrer"
                    className="btn-casino btn-glass px-4 py-2.5 text-[12.5px]"
                  >
                    {tr("history.pyRef")}
                  </a>
                </div>

                {full.phase === "done" && (
                  <div className="mt-3 rounded-xl border border-accent-500/20 bg-black/30 p-4 font-mono text-[11.5px] leading-relaxed">
                    <div className="flex items-center gap-2">
                      <Badge tone={full.ok ? "mint" : "danger"}>
                        {full.ok ? tr("history.fullOk") : tr("history.fullFail")}
                      </Badge>
                      <span className="text-mist-dim">
                        {tr("history.matchedN", { n: full.matched, total: full.draws })}
                      </span>
                    </div>
                    {full.diffs.slice(0, 6).map((d, i) => (
                      <div key={i} className="mt-1 text-loss">
                        {d}
                      </div>
                    ))}
                  </div>
                )}

                {/* 行动流验证（§7）：从 ER 交易日志重建行动序列 → 对街锚点与 transcript_final */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    className="btn-casino btn-glass px-5 py-2.5 text-[13px]"
                    disabled={
                      stream.phase === "running" ||
                      !replayEntry ||
                      !entry ||
                      replayEntry.layoutVer !== 2
                    }
                    onClick={async () => {
                      if (!replayEntry || !entry || tableId === null) return;
                      setStream({ phase: "running" });
                      try {
                        const gamePda = pdasFor(tableId).game;
                        const { events } = await fetchHandEvents(
                          webCrypto,
                          er,
                          gamePda,
                          entry.handId,
                          { limit: 500 }
                        );
                        const r = await verifyActionStream(webCrypto, {
                          table: [...pdasFor(tableId).table.toBytes()]
                            .map((b) => b.toString(16).padStart(2, "0"))
                            .join(""),
                          handId: entry.handId.toString(),
                          handMask: entry.handMask,
                          button: entry.button,
                          saltDigest: [...replayEntry.saltDigest]
                            .map((b) => b.toString(16).padStart(2, "0"))
                            .join(""),
                          drawDigest: replayEntry.drawDigest.map((d) =>
                            [...d].map((b) => b.toString(16).padStart(2, "0")).join("")
                          ),
                          streetEnd: replayEntry.streetEnd.map((d) =>
                            [...d].map((b) => b.toString(16).padStart(2, "0")).join("")
                          ),
                          streetsUsed: replayEntry.streetsUsed,
                          vrfOut: secret
                            ? secret.vrfOut.map((d) =>
                                [...d].map((b) => b.toString(16).padStart(2, "0")).join("")
                              )
                            : [],
                          vrfAttemptUsed: replayEntry.vrfAttemptUsed,
                          events,
                          deltas: entry.deltas.map((x) => x.toString()),
                          rake: entry.rake.toString(),
                          transcriptFinal: [...entry.transcriptFinal]
                            .map((b) => b.toString(16).padStart(2, "0"))
                            .join(""),
                        } as never);
                        setStream({
                          phase: "done",
                          ok: r.ok,
                          events: events.length,
                          perStreet: r.perStreet,
                          diffs: r.diffs,
                        });
                      } catch (e) {
                        setStream({
                          phase: "done",
                          ok: false,
                          events: 0,
                          perStreet: [],
                          diffs: [String(e instanceof Error ? e.message : e)],
                        });
                      }
                    }}
                  >
                    {stream.phase === "running" ? tr("history.streamRunning") : tr("history.stream")}
                  </button>
                  {replayEntry && replayEntry.layoutVer !== 2 && (
                    <span className="text-[11.5px] text-warn">
                      {tr("history.noAnchors")}
                    </span>
                  )}
                </div>
                {stream.phase === "done" && (
                  <div className="mt-3 rounded-xl border border-accent-500/20 bg-black/30 p-4 font-mono text-[11.5px] leading-relaxed">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={stream.ok ? "mint" : "danger"}>
                        {stream.ok ? tr("history.streamOk") : tr("history.streamFail")}
                      </Badge>
                      <span className="text-mist-dim">
                        {tr("history.eventsN", { n: stream.events })} ·{" "}
                        {stream.perStreet
                          .map((s) => tr("history.perStreet", { street: s.street, actions: s.actions, mark: s.closed ? "✓" : "✗" }))
                          .join(" ")}
                      </span>
                    </div>
                    <div className="mt-1 text-mist-faint">
                      {tr("history.streamWhy")}
                    </div>
                    {stream.diffs.slice(0, 5).map((d, i) => (
                      <div key={i} className="mt-1 text-loss">
                        {d}
                      </div>
                    ))}
                  </div>
                )}

                {check.phase === "done" && (
                  <div className="mt-4 space-y-2 rounded-xl border border-accent-500/20 bg-black/30 p-4 font-mono text-[11.5px] leading-relaxed">
                    <div className="flex items-center gap-2 text-mist">
                      <Badge tone={check.conservation.ok ? "mint" : "danger"}>
                        {check.conservation.ok ? tr("history.conservOk") : tr("history.conservFail")}
                      </Badge>
                      <span className="text-mist-dim">
                        Σ deltas = {fmtUsdc(BigInt(check.conservation.sum))} · rake ={" "}
                        {tr("history.rakePair", { n: fmtUsdc(BigInt(check.conservation.rake)) })}
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
                          {tr("history.saltCommit")}
                        </div>
                        {check.commits.map((c) => (
                          <div key={c.seat} className="flex items-center gap-2">
                            <span className="text-mist-dim">
                              {tr("history.computedOnchain", { computed: c.computed, onchain: c.onchain ?? "—" })}
                            </span>
                            <span className={c.ok ? "text-win" : "text-loss"}>
                              {c.ok ? tr("history.match") : tr("history.mismatch")}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 现状说明：能算什么、还差什么 */}
              <div className="panel p-5">
                <SectionTitle zh={tr("history.covTitle")} en="COVERAGE" />
                <p className="text-[12.5px] leading-relaxed text-mist-dim">{tr("history.cov1")}</p>
                <p className="mt-2 text-[12.5px] leading-relaxed text-mist-dim">{tr("history.cov2")}</p>
                <p className="mt-2 text-[12.5px] leading-relaxed text-mist-dim">{tr("history.cov3")}</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-lg border border-mint/25 bg-mint/5 p-3 text-[12px] text-mist-dim">
                    {tr("history.covHave")}
                  </div>
                  <div className="rounded-lg border border-warn/25 bg-warn/5 p-3 text-[12px] text-mist-dim">
                    {tr("history.covGap")}
                  </div>
                  <div className="rounded-lg border border-accent-500/25 bg-accent-500/5 p-3 text-[12px] text-mist-dim">
                    {tr("history.covAnchor")}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="panel p-6 text-[12.5px] text-mist-faint">
              <span className="text-[12.5px] text-mist-faint">{tr("history.pickHand")}</span>
            </div>
          )}

          <div className="panel flex items-center gap-3 p-4 text-[11.5px] text-mist-faint">
            <SolMark size={18} />
            <span>{tr("history.dataSource")}</span>
          </div>
        </section>
      </div>

      <section className="panel p-6">
        <SectionTitle zh={tr("history.engineTitle")} en="ENGINE SELF-TEST" />
        <p className="text-[12.5px] leading-relaxed text-mist-dim">{tr("history.engineBlurb")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            className="btn-casino btn-brand px-5 py-2.5 text-[13px]"
            disabled={engine.phase === "running"}
            onClick={async () => {
              setEngine({ phase: "running" });
              const results = [];
              for (const v of DEAL_VECTORS) {
                try {
                  const { diffs, got } = await verifyVector(webCrypto, v);
                  results.push({
                    name: v.name,
                    ok: diffs.length === 0,
                    board: got.board.join(","),
                    button: got.button,
                    diffs,
                  });
                } catch (e) {
                  results.push({
                    name: v.name,
                    ok: false,
                    board: "—",
                    button: -1,
                    diffs: [String(e instanceof Error ? e.message : e)],
                  });
                }
              }
              setEngine({ phase: "done", results });
            }}
          >
            {engine.phase === "running" ? tr("history.engineRunning") : tr("history.engineRun")}
          </button>
          <span className="text-[11.5px] text-mist-faint">
            {tr("history.engineCli")}<span className="font-mono">node scripts/agent/deal-verify-selftest.mjs</span>
          </span>
        </div>
        {engine.phase === "done" && (
          <div className="mt-3 space-y-1 font-mono text-[11.5px]">
            {engine.results.map((r) => (
              <div key={r.name} className="flex flex-wrap items-baseline gap-2">
                <Badge tone={r.ok ? "mint" : "danger"}>{r.ok ? "PASS" : "FAIL"}</Badge>
                <span className="text-mist-dim">{r.name}</span>
                <span className="text-mist-faint">
                  board=[{r.board}] button={r.button}
                </span>
                {!r.ok && <span className="text-loss">{r.diffs[0]}</span>}
              </div>
            ))}
            <div className={engine.results.every((r) => r.ok) ? "pt-1 text-win" : "pt-1 text-loss"}>
              {engine.results.every((r) => r.ok)
                ? tr("history.engineOk", { n: engine.results.length, total: engine.results.length })
                : tr("history.engineFail")}
            </div>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------- L1 审计视图 */}
      <section className="panel mt-8 p-5">
        <SectionTitle
          zh={tr("history.auditTitle")}
          en="L1 AUDIT TRAIL · TABLE-LEVEL"
          right={
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={audit.view?.source === "helius-parsed" ? "cyan" : "plain"}>
                {audit.view?.source === "helius-parsed" ? tr("history.auditHelius") : tr("history.auditRaw")}
              </Badge>
              <Badge tone={live.state === "live" ? "mint" : "plain"}>
                {live.state === "live" ? tr("history.auditLive") : live.state === "connecting" ? tr("history.auditConnecting") : tr("history.auditManual")}
              </Badge>
              <button
                className="btn-casino px-3 py-1.5 text-[12px]"
                disabled={audit.state === "loading"}
                onClick={audit.refresh}
              >
                {audit.state === "loading" ? tr("history.auditLoading") : tr("history.auditRefresh")}
              </button>
            </div>
          }
        />
        <p className="mb-4 max-w-[860px] text-[12.5px] leading-relaxed text-mist-dim">
          {tr("history.auditProsePrefix")} <span className="font-mono">L1</span> {tr("history.auditProseMid")}
          <span className="font-mono">
            {audit.view ? `${audit.view.table.slice(0, 8)}…` : "—"}
          </span>
          {tr("history.auditProseBody")}
        </p>
        {audit.state === "error" && (
          <p className="text-[12px] text-loss">{tr("history.auditFail")}</p>
        )}
        {audit.view && audit.view.items.length === 0 && (
          <p className="text-[12px] text-mist-faint">{tr("history.auditEmpty")}</p>
        )}
        {audit.view && audit.view.items.length > 0 && (
          <div className="scroll-thin max-h-[420px] space-y-1 overflow-y-auto pr-1">
            {audit.view.items.map((it) => (
              <div
                key={it.signature}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-accent-500/10 bg-black/25 px-3 py-1.5 font-mono text-[11.5px]"
              >
                <Badge tone={auditTone(it.kind)}>{it.label}</Badge>
                <span className="text-mist-faint">{it.slot}</span>
                <span className="text-mist-faint">
                  {it.blockTime
                    ? new Date(it.blockTime * 1000).toISOString().slice(5, 16).replace("T", " ")
                    : "—"}
                </span>
                {fmtAuditAmount(it.amount) && (
                  <span className="text-accent-200">{fmtAuditAmount(it.amount)} tUSDC</span>
                )}
                <span className="text-mist-faint">[{it.accounts.join(",")}]</span>
                {it.err && <span className="text-loss">⚠ {it.err.slice(0, 40)}</span>}
                <a
                  href={solscanTx(it.signature)}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-accent-300 underline decoration-dotted hover:text-accent-200"
                >
                  {it.signature.slice(0, 8)}…{it.signature.slice(-4)} ↗
                </a>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
