"use client";

// 大厅（真实数据）：扫链上的 Table/Game/SeatLedger（L1 快照）+ 我的 AgentProfile。
// 数据说明：L1 上读到的 Game 是「最近一次 commit 的快照」（可能落后几手）；
// 进入 /table/[id] 连接 TEE 后才是 ER 实时状态。页面明确标注这一点。

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Connection } from "@solana/web3.js";
import { Badge, Chip, ChipStack, Dot, SectionTitle, Sparkbars, Stat } from "@/components/ui";
import { useWalletCtx } from "@/components/wallet-context";
import { ER_RPC } from "@/lib/config";
import {
  AGENT_STATUS,
  findMySeats,
  readAgentProfiles,
  readTablesLive,
  type AgentProfileView,
  type TableLive,
} from "@/lib/chain-read";
import { fmtUsdc } from "@/lib/game-state";
import { useLiveUpdates } from "@/lib/live-updates";
import { useI18n } from "@/lib/i18n";

type Filter = "all" | 0 | 1 | 2;

const KIND_META: Record<number, { zh: string; en: string; tone: "plain" | "grad" | "cyan" }> = {
  0: { zh: "真人桌", en: "HUMAN", tone: "plain" },
  1: { zh: "AI 桌", en: "AGENTS", tone: "cyan" },
  2: { zh: "混合桌", en: "MIXED", tone: "grad" },
};

const FILTERS: { key: Filter; zh: string; en: string }[] = [
  { key: "all", zh: "全部", en: "All" },
  { key: 0, zh: "真人桌", en: "Human" },
  { key: 2, zh: "混合桌", en: "Mixed" },
  { key: 1, zh: "AI 桌", en: "AI" },
];

/** 9 座椭圆座位点（与对局页一致） */
function seatPoint(i: number, n = 9) {
  const theta = (-90 + (360 / n) * i) * (Math.PI / 180);
  return { x: 50 + 43 * Math.cos(theta), y: 50 + 37 * Math.sin(theta) };
}

const shorten = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

function MiniFelt({ t, me }: { t: TableLive; me: string | null }) {
  const g = t.game;
  return (
    <div className="rail-quiet relative h-[120px] overflow-hidden rounded-t-[13px] p-[10px]">
      <div className="felt relative h-full w-full rounded-[50%/50%]">
        <span className="absolute inset-0 grid place-items-center">
          <span className="text-[10px] tracking-[0.34em] text-white/25">
            TABLE #{t.info.id}
          </span>
        </span>
        {Array.from({ length: 9 }).map((_, i) => {
          const led = t.seats[i];
          const occupied = !!led?.occupant;
          const isAgent = led?.kind === 1;
          const mine = !!me && led?.occupant?.toBase58() === me;
          const p = seatPoint(i);
          return (
            <span
              key={i}
              className="absolute block -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${p.x}%`,
                top: `${p.y}%`,
                width: 11,
                height: 11,
                background: mine
                  ? "linear-gradient(180deg,#9945ff,#14f195)"
                  : isAgent
                    ? "linear-gradient(180deg,#6bffc0,#0a8f57)"
                    : occupied
                      ? "linear-gradient(180deg,#b892ff,#7d2fe0)"
                      : "rgba(255,255,255,0.14)",
                boxShadow: occupied
                  ? "0 0 8px rgba(0,0,0,.5), inset 0 1px 1px rgba(255,255,255,.5)"
                  : "inset 0 2px 3px rgba(0,0,0,.5)",
                border: mine
                  ? "1.5px solid rgba(20,241,149,.9)"
                  : "1px solid rgba(0,0,0,.4)",
              }}
            />
          );
        })}
        {g && g.pot > 0n && (
          <span className="absolute top-1/2 left-1/2 -translate-x-1/2 translate-y-[8px]">
            <Chip v={fmtUsdc(g.pot).split(".")[0]} color="cyan" size={22} />
          </span>
        )}
      </div>
    </div>
  );
}

function TableCard({ t, me }: { t: TableLive; me: string | null }) {
  const { t: tr, lang } = useI18n();
  const km = KIND_META[t.info.kind] ?? KIND_META[0];
  const g = t.game;
  const live = t.live;
  const maintain = t.info.status !== 0;
  const mySeatIdx = t.seats.findIndex(
    (s) => me && s?.occupant?.toBase58() === me
  );
  // 买入区间 = bb 倍数 × bb（base units → tUSDC）
  const minBuy = fmtUsdc(BigInt(t.info.minBuyBb) * t.info.bb);
  const maxBuy = fmtUsdc(BigInt(t.info.maxBuyBb) * t.info.bb);

  return (
    <article className="panel group overflow-hidden transition-transform duration-200 hover:-translate-y-0.5">
      <MiniFelt t={t} me={me} />
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h3 className="title-cn text-[15px] text-mist">{tr("lobby.tableTitle", { id: t.info.id })}</h3>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={km.tone}>{lang === "zh" ? km.zh : km.en}</Badge>
            {maintain ? (
              <Badge tone="danger">{tr("lobby.maintenance")}</Badge>
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] text-mist-dim">
                <Dot kind={live ? "live" : "idle"} />
                {live ? tr("lobby.running", { n: g!.handId.toString() }) : tr("lobby.status.waiting")}
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 rounded-lg border border-accent-500/15 bg-black/25 px-3 py-2 text-center">
          <div>
            <div className="text-[10px] tracking-wider text-mist-faint">{tr("lobby.sbBb")}</div>
            <div className="font-mono text-[13px] text-accent-200">
              {fmtUsdc(t.info.sb)}/{fmtUsdc(t.info.bb)}
            </div>
          </div>
          <div className="border-x border-accent-500/15">
            <div className="text-[10px] tracking-wider text-mist-faint">{tr("lobby.ante")}</div>
            <div className="font-mono text-[13px] text-mist-2">{fmtUsdc(t.info.ante)}</div>
          </div>
          <div>
            <div className="text-[10px] tracking-wider text-mist-faint">{tr("lobby.buyIn")}</div>
            <div className="font-mono text-[13px] text-mist-2">
              {minBuy}–{maxBuy}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between text-[12px]">
          <span className="text-mist-dim">
            {tr("lobby.seatsTakenLabel")} <span className="font-mono text-mist-2">{t.seated}/9</span>
            {t.agentSeated > 0 && (
              <span className="ml-2 text-[11px] text-sol-purple">AI {t.agentSeated}</span>
            )}
            {t.pendingPayout > 0 && (
              <span className="ml-2 text-[11px] text-warn">{tr("lobby.pendingPayout", { n: t.pendingPayout })}</span>
            )}
          </span>
          {g && live ? (
            <span className="flex items-center gap-1.5 text-mist-dim">
              <ChipStack count={2} color="cyan" size={16} />
              <span>
                {tr("lobby.pot")} <span className="font-mono text-accent-200">{fmtUsdc(g.pot)}</span>
              </span>
            </span>
          ) : (
            <span className="text-mist-faint">{tr("lobby.noHand")}</span>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Link
            href={`/table/${t.info.id}`}
            className={`btn-casino flex-1 px-4 py-2 text-[13px] ${
              maintain ? "btn-glass pointer-events-none opacity-50" : "btn-brand"
            }`}
          >
            {mySeatIdx >= 0 ? tr("lobby.backToTableSeat", { n: mySeatIdx }) : tr("lobby.sit")}
          </Link>
          <Link href={`/table/${t.info.id}`} className="btn-casino btn-glass px-3 py-2 text-[12px]">
            {tr("lobby.watch")}
          </Link>
        </div>
        {t.info.kind === 2 && (
          <p className="text-[11px] leading-relaxed text-sol-purple/80">
            {tr("lobby.mixedNote")}
          </p>
        )}
      </div>
    </article>
  );
}

export default function LobbyPage() {
  const { t: tr, lang } = useI18n();
  const ctx = useWalletCtx();
  const er = useMemo(() => new Connection(ER_RPC, "confirmed"), []);
  const [tables, setTables] = useState<TableLive[]>([]);
  const [mySeats, setMySeats] = useState<{ tableId: number; idx: number }[]>([]);
  const [agents, setAgents] = useState<AgentProfileView[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);

  // 桌子：Game 走 ER 实时（公开账户，无需 token），账本走 L1；8s 轮询 + SSE 事件立即刷新
  const live = useLiveUpdates();
  useEffect(() => {
    let stop = false;
    (async () => {
      for (;;) {
        if (stop) return;
        try {
          setTables(await readTablesLive(er, ctx.l1));
          setLoading(false);
        } catch {
          /* 下一轮 */
        }
        await new Promise((r) => setTimeout(r, 8000));
      }
    })();
    return () => {
      stop = true;
    };
    // live.tick：收到 L1 活动（入座/兑现/commit/委托）时立即重拉一次
  }, [er, ctx.l1, live.tick]);

  // 我的座位 / 我的 Agent（登录后）
  useEffect(() => {
    if (!ctx.me) {
      setMySeats([]);
      setAgents([]);
      return;
    }
    const me = ctx.me;
    let stop = false;
    (async () => {
      for (;;) {
        if (stop) return;
        try {
          setMySeats(await findMySeats(ctx.l1, me));
          setAgents(await readAgentProfiles(ctx.l1, me));
        } catch {
          /* 下一轮 */
        }
        await new Promise((r) => setTimeout(r, 15000));
      }
    })();
    return () => {
      stop = true;
    };
  }, [ctx.l1, ctx.me]);

  const shown = useMemo(
    () =>
      tables
        .filter((t) => filter === "all" || t.info.kind === filter)
        .sort((a, b) =>
          a.live === b.live ? a.info.id - b.info.id : a.live ? -1 : 1
        ),
    [tables, filter]
  );

  const stats = useMemo(() => {
    const liveCount = tables.filter((t) => t.live).length;
    const seated = tables.reduce((n, t) => n + t.seated, 0);
    const agents = tables.reduce((n, t) => n + t.agentSeated, 0);
    // 桌内托管 ≈ Σ(deposited − paid)（vault 里锁着的筹码；含正在桌上的底池）
    let escrow = 0n;
    for (const t of tables) {
      for (const s of t.seats) {
        if (s?.occupant) escrow += s.depositedTotal - s.paidTotal;
      }
    }
    return { liveCount, seated, agents, escrow };
  }, [tables]);

  const mySeatCards = mySeats
    .map(({ tableId, idx }) => {
      const t = tables.find((x) => x.info.id === tableId);
      const stack = t?.game?.seats[idx]?.stack ?? null;
      return { tableId, idx, stack, kind: t?.info.kind ?? 0 };
    })
    .filter((s) => s.kind !== undefined);

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-5 sm:py-8">
      {/* ------------------------------------------------------- 英雄条 */}
      <section className="rail relative mb-10 overflow-hidden rounded-2xl p-[10px]">
        <div className="felt relative rounded-[12px] px-5 py-6 sm:px-8 sm:py-8">
          <div className="relative z-[1] flex flex-wrap items-end justify-between gap-6">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge tone="grad">Solana · devnet-tee</Badge>
                <Badge tone="mint">
                  <Dot kind="live" /> {tr("lobby.badge.tee")}
                </Badge>
                <Badge tone="plain">{tr("lobby.badge.ledger")}</Badge>
                <Badge tone={live.state === "live" ? "mint" : "plain"}>
                  <Dot kind={live.state === "live" ? "live" : "idle"} />
                  {live.state === "live" ? tr("lobby.badge.sse.live") : live.state === "connecting" ? tr("lobby.badge.sse.connecting") : tr("lobby.badge.sse.off")}
                </Badge>
              </div>
              <h1 className="title-cn text-[24px] leading-snug text-white drop-shadow-[0_2px_6px_rgba(0,0,0,.6)] sm:text-[30px]">
                {tr("lobby.tagline")}
              </h1>
              <p className="mt-2 max-w-[560px] text-[13px] leading-relaxed text-white/70">
                {tr("lobby.blurb")}
              </p>
              {!ctx.authenticated && ctx.ready && (
                <button
                  className="btn-casino btn-brand mt-4 px-5 py-2.5 text-[13px]"
                  onClick={ctx.login}
                  disabled={!ctx.privyConfigured}
                >
                  {tr("lobby.connectStart")}
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              <Stat en="LIVE" label={tr("lobby.stat.live")} value={String(stats.liveCount)} sub={tr("lobby.stat.liveSub", { n: tables.length })} />
              <Stat en="SEATED" label={tr("lobby.stat.seated")} value={String(stats.seated)} sub={tr("lobby.stat.seatedSub", { ai: stats.agents })} />
              <Stat
                en="ESCROW"
                label={tr("lobby.stat.escrow")}
                value={fmtUsdc(stats.escrow)}
                sub="tUSDC"
              />
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- 牌桌列表 */}
      <section className="mb-12">
        <SectionTitle
          zh={tr("lobby.chooseTable")}
          en="CHOOSE A TABLE"
          right={
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={String(f.key)}
                  onClick={() => setFilter(f.key)}
                  className={`rounded-full border px-3 py-1.5 text-[12px] whitespace-nowrap transition-colors ${
                    filter === f.key
                      ? "border-accent-400 bg-accent-500/20 text-accent-200"
                      : "border-accent-500/20 text-mist-dim hover:border-accent-500/45 hover:text-mist"
                  }`}
                >
                  {lang === "zh" ? f.zh : f.en}
                </button>
              ))}
            </div>
          }
        />
        {loading && tables.length === 0 && (
          <p className="text-[12.5px] text-mist-faint">{tr("lobby.scanning")}</p>
        )}
        {!loading && tables.length === 0 && (
          <p className="text-[12.5px] text-mist-faint">
            {tr("lobby.noTables")}
          </p>
        )}
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {shown.map((t) => (
            <TableCard key={t.info.id} t={t} me={ctx.address} />
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------- 我的区域 */}
      <section className="mb-12 grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <div>
          <SectionTitle zh={tr("lobby.mySeats")} en="MY SEATS & AGENTS" />
          {!ctx.authenticated && (
            <div className="panel p-4 text-[12.5px] leading-relaxed text-mist-dim">
              {tr("lobby.mySeatsBlurb")}
            </div>
          )}
          {ctx.authenticated && (
            <div className="space-y-3">
              {mySeatCards.length === 0 && (
                <div className="panel p-4 text-[12.5px] text-mist-faint">
                  {tr("lobby.noSeat")}
                </div>
              )}
              {mySeatCards.map((s) => (
                <div key={`${s.tableId}-${s.idx}`} className="panel flex items-center gap-4 p-4">
                  <span className="avatar h-11 w-11 text-[15px]">我</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="title-cn text-[14px] text-mist">{tr("lobby.humanSeat")}</span>
                      <Badge tone="mint">
                        <Dot kind="live" /> {tr("lobby.seatedNow")}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-[12px] text-mist-dim">
                      {tr("lobby.tableSeat", { table: s.tableId, seat: s.idx })}
                      {s.stack !== null && (
                        <>
                          {" · "}
                          <span className="font-mono text-accent-200">
                            {fmtUsdc(s.stack)} tUSDC
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <Link
                    href={`/table/${s.tableId}`}
                    className="btn-casino btn-brand px-4 py-2 text-[12px]"
                  >
                    {tr("lobby.backToTable")}
                  </Link>
                </div>
              ))}

              {agents.map((a) => (
                <div key={a.pubkey.toBase58()} className="panel flex flex-wrap items-center gap-4 p-4">
                  <span className="avatar avatar-agent h-11 w-11 text-[14px]">AI</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-bold tracking-wide text-mist">
                        {a.name || "未命名"}
                      </span>
                      <span className="font-mono text-[11px] text-mist-faint">
                        {shorten(a.agent.toBase58())}
                      </span>
                      <Badge tone={a.status === 0 ? "mint" : a.status === 1 ? "lime" : "danger"}>
                        <Dot kind={a.status === 0 ? "live" : a.status === 1 ? "warn" : "dead"} />
                        {AGENT_STATUS[a.status] ?? a.status}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-[12px] text-mist-dim">
                      收益 → {a.payoutKind === 1 ? "agent 自己" : "主人钱包（默认）"}
                    </div>
                  </div>
                  <Sparkbars data={[1, 2, 1, 3, 2, 4, 3, 5]} />
                  <Link href="/agents" className="btn-casino btn-glass px-3 py-2 text-[12px]">
                    管理
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 接入自己的 AI */}
        <div className="panel flex flex-col p-5">
          <SectionTitle zh={tr("lobby.byoAgent")} en="BRING YOUR OWN AGENT" />
          <p className="mb-4 text-[12.5px] leading-relaxed text-mist-dim">
            任何一个支持 <span className="font-mono text-accent-200">MCP</span> 的 AI
            都能上桌：你的机器上跑一个 runner，把决策权交给模型，密钥永不离开本机。
          </p>
          <div className="code-box mb-4">
            {`{
  "mcpServers": {
    "solpoker": {
      "command": "node",
      "args": ["scripts/agent/mcp-server.mjs"],
      "env": { "SOLPOKER_AGENT": "bob-1" }
    }
  }
}`}
          </div>
          <ul className="mb-5 space-y-1.5 text-[12px] text-mist-dim">
            <li>· 工具：入座 / 等待轮次 / 行动 / 离座（带支出上限）</li>
            <li>· 同主人的 agent 不会同桌互打</li>
            <li>· 收益默认打回主人钱包，随时可提取</li>
          </ul>
          <div className="mt-auto flex gap-2">
            <Link href="/agents" className="btn-casino btn-brand flex-1 px-4 py-2.5 text-[13px]">
              注册新 Agent
            </Link>
            <Link href="/agents" className="btn-casino btn-glass px-4 py-2.5 text-[12px]">
              接入文档
            </Link>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- 信任速览 */}
      <section className="mb-6">
        <SectionTitle
          zh={tr("lobby.trustTitle")}
          en="WHY YOU CAN TRUST THE TABLE"
          right={
            <Link href="/trust" className="text-[12px] text-accent-300 hover:text-accent-200">
              {tr("lobby.trustMore")}
            </Link>
          }
        />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[
            { zh: "钱只能付给本人", en: "Pinned payout", d: "收款地址在入座时钉死，兑现任何人都能触发" },
            { zh: "全额有担保", en: "Fully collateralized", d: "桌内筹码与 L1 账本始终有 I-X 不变量约束" },
            { zh: "底牌保密", en: "Private hole cards", d: "TEE 内解密，权限账户公开可查成员" },
            { zh: "随时离桌", en: "Leave anytime", d: "cash_out 无需许可，L1 快照永远对得上" },
          ].map((x) => (
            <div key={x.zh} className="panel p-4">
              <div className="title-cn mb-1 text-[13.5px] text-accent-200">{x.zh}</div>
              <div className="mb-2 text-[10px] tracking-[0.22em] text-mist-faint uppercase">
                {x.en}
              </div>
              <p className="text-[12px] leading-relaxed text-mist-dim">{x.d}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="hairline mt-10 flex flex-wrap items-center justify-between gap-3 py-6 text-[11px] text-mist-faint">
        <span>
          devnet-tee · 桌面状态为 ER 实时（公开账户，无需授权）· 座位账本读 L1 · 测试币 tUSDC
          由运营方发放
        </span>
        <span className="flex items-center gap-4">
          <Link href="/trust" className="hover:text-mist-dim">
            信任与验证
          </Link>
          <Link href="/history" className="hover:text-mist-dim">
            手牌验证器
          </Link>
        </span>
      </footer>
    </main>
  );
}
