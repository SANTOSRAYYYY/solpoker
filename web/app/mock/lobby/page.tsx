"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AGENTS, KIND_META, TABLES, type MockTable, type TableKind } from "../data";
import { Badge, Chip, ChipStack, Dot, KV, SectionTitle, Sparkbars, Stat } from "../ui";

type Filter = "all" | TableKind;

const FILTERS: { key: Filter; zh: string; en: string }[] = [
  { key: "all", zh: "全部", en: "ALL" },
  { key: "human", zh: "真人桌", en: "HUMAN" },
  { key: "mixed", zh: "混合桌", en: "MIXED" },
  { key: "agent", zh: "AI 桌", en: "AGENTS" },
];

/* 9 个座位点在椭圆上的坐标（百分比），与真实对局页座位排布一致 */
function seatPoint(i: number, n = 9) {
  const theta = (-90 + (360 / n) * i) * (Math.PI / 180);
  return { x: 50 + 43 * Math.cos(theta), y: 50 + 37 * Math.sin(theta) };
}

function MiniFelt({ t }: { t: MockTable }) {
  return (
    <div className="rail-quiet relative h-[120px] overflow-hidden rounded-t-[13px] p-[10px]">
      <div className="felt relative h-full w-full rounded-[50%/50%]">
        <span className="absolute inset-0 grid place-items-center">
          <span className="font-display text-[10px] tracking-[0.34em] text-white/25">
            {t.nameEn.toUpperCase()}
          </span>
        </span>
        {Array.from({ length: 9 }).map((_, i) => {
          const p = seatPoint(i);
          const occupied = t.occupied.includes(i);
          const isAgent = t.agents.includes(i);
          const mine = t.mySeat === i;
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
                border: mine ? "1.5px solid rgba(20,241,149,.9)" : "1px solid rgba(0,0,0,.4)",
              }}
            />
          );
        })}
        {/* 底池筹码示意 */}
        {t.phase === "live" && (
          <span className="absolute top-1/2 left-1/2 -translate-x-1/2 translate-y-[8px]">
            <Chip v={t.pot.toFixed(1)} color="cyan" size={22} />
          </span>
        )}
      </div>
    </div>
  );
}

function TableCard({ t }: { t: MockTable }) {
  const km = KIND_META[t.kind];
  const live = t.phase === "live";
  return (
    <article className="panel group overflow-hidden transition-transform duration-200 hover:-translate-y-0.5">
      <MiniFelt t={t} />
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h3 className="title-cn text-[15px] text-mist">{t.name}</h3>
            <span className="font-mono text-[11px] text-mist-faint">#{t.id}</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={km.tone}>{km.zh}</Badge>
            <span className="flex items-center gap-1.5 text-[11px] text-mist-dim">
              <Dot kind={live ? "live" : "idle"} />
              {live ? `进行中 · 手 #${t.handNo}` : "等待中"}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 rounded-lg border border-accent-500/15 bg-black/25 px-3 py-2 text-center">
          <div>
            <div className="text-[10px] tracking-wider text-mist-faint">盲注 SB/BB</div>
            <div className="font-display text-[13px] text-accent-200">
              {t.sb}/{t.bb}
            </div>
          </div>
          <div className="border-x border-accent-500/15">
            <div className="text-[10px] tracking-wider text-mist-faint">前注 ANTE</div>
            <div className="font-display text-[13px] text-mist-2">{t.ante}</div>
          </div>
          <div>
            <div className="text-[10px] tracking-wider text-mist-faint">买入 BUY-IN</div>
            <div className="font-display text-[13px] text-mist-2">
              {t.minBuy}–{t.maxBuy}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between text-[12px]">
          <span className="text-mist-dim">
            入座 <span className="font-mono text-mist-2">{t.occupied.length}/9</span>
            {t.agents.length > 0 && (
              <span className="ml-2 text-[11px] text-sol-purple">
                AI {t.agents.length}
              </span>
            )}
          </span>
          {live ? (
            <span className="flex items-center gap-1.5 text-mist-dim">
              <ChipStack count={2} color="purple" size={16} />
              <span>
                底池 <span className="font-mono text-accent-200">{t.pot.toFixed(1)}</span>
                <span className="ml-2 text-mist-faint">均 {t.avgPot.toFixed(1)}</span>
              </span>
            </span>
          ) : (
            <span className="text-mist-faint">无进行中对局</span>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button className="btn-casino btn-brand flex-1 px-4 py-2 text-[13px]">
            入座 {t.mySeat === undefined ? "" : "· 已就座"}
          </button>
          <button className="btn-casino btn-glass px-3 py-2 text-[12px]">观战</button>
        </div>
        {t.kind === "mixed" && (
          <p className="text-[11px] leading-relaxed text-sol-purple/80">
            混合桌：入座前需确认与 AI 同桌的规则（一真人 vs 一 agent，座位不固定）
          </p>
        )}
      </div>
    </article>
  );
}

export default function LobbyMock() {
  const [filter, setFilter] = useState<Filter>("all");
  const tables = useMemo(
    () =>
      TABLES.filter((t) => filter === "all" || t.kind === filter).sort((a, b) =>
        a.phase === b.phase ? a.id - b.id : a.phase === "live" ? -1 : 1,
      ),
    [filter],
  );

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-5 sm:py-8">
      {/* ---------------------------------------------------------- 英雄条 */}
      <section className="rail relative mb-10 overflow-hidden rounded-2xl p-[10px]">
        <div className="felt relative rounded-[12px] px-5 py-6 sm:px-8 sm:py-8">
          <div className="relative z-[1] flex flex-wrap items-end justify-between gap-6">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Badge tone="grad">Solana · devnet-tee</Badge>
                <Badge tone="mint">
                  <Dot kind="live" /> TEE 证明已验证
                </Badge>
              </div>
              <h1 className="title-cn text-[24px] leading-snug text-white drop-shadow-[0_2px_6px_rgba(0,0,0,.6)] sm:text-[30px]">
                私密德州扑克 · 链上可验证
              </h1>
              <p className="mt-2 max-w-[560px] text-[13px] leading-relaxed text-white/70">
                底牌只在 TEE 内解密，发牌由 VRF 与双方盐共同锁定；每一手都能用开源验证器复算。
                坐下即托管，随时可离桌兑现。
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Stat en="TABLES" label="进行中" value="4" sub="共 6 张" />
              <Stat en="HANDS" label="今日手数" value="216" sub="24h" />
              <Stat en="ESCROW" label="锁仓" value="184.6" sub="tUSDC" />
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- 桌子列表 */}
      <section className="mb-12">
        <SectionTitle
          zh="选择牌桌"
          en="Choose a table"
          right={
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`rounded-full border px-3 py-1.5 text-[12px] whitespace-nowrap transition-colors ${
                    filter === f.key
                      ? "border-accent-400 bg-accent-500/20 text-accent-200"
                      : "border-accent-500/20 text-mist-dim hover:border-accent-500/45 hover:text-mist"
                  }`}
                >
                  {f.zh}
                </button>
              ))}
            </div>
          }
        />
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {tables.map((t) => (
            <TableCard key={t.id} t={t} />
          ))}
        </div>
      </section>

      {/* ---------------------------------------------------------- 我的区域 */}
      <section className="mb-12 grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <div>
          <SectionTitle zh="我的牌局与 Agent" en="My seats & agents" />
          <div className="space-y-3">
            {/* 我的真人座位 */}
            <div className="panel flex items-center gap-4 p-4">
              <span className="avatar h-11 w-11 text-[15px]">我</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="title-cn text-[14px] text-mist">真人座位</span>
                  <Badge tone="mint">
                    <Dot kind="live" /> 在座
                  </Badge>
                </div>
                <div className="mt-0.5 text-[12px] text-mist-dim">
                  红木厅 #9 · 座位 3 ·{" "}
                  <span className="font-mono text-accent-200">42.50 tUSDC</span>
                </div>
              </div>
              <Link href="/mock/table" className="btn-casino btn-brand px-4 py-2 text-[12px]">
                回到牌桌
              </Link>
              <button className="btn-casino btn-ghost px-3 py-2 text-[12px]">兑现</button>
            </div>

            {/* Agent 卡片 */}
            {AGENTS.map((a) => (
              <div key={a.name} className="panel flex items-center gap-4 p-4">
                <span className="avatar avatar-agent h-11 w-11 text-[14px]">AI</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[14px] font-bold tracking-wide text-mist">
                      {a.name}
                    </span>
                    <span className="font-mono text-[11px] text-mist-faint">{a.addr}</span>
                    <Badge tone={a.status === "ACTIVE" ? "felt" : "amber"}>
                      <Dot kind={a.status === "ACTIVE" ? "live" : "warn"} />
                      {a.status}
                    </Badge>
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-[12px] text-mist-dim">
                    {a.tableId ? (
                      <span>
                        紫晶厅 #{a.tableId} · 座 {a.seat} ·{" "}
                        <span className="font-mono text-accent-200">{a.stack.toFixed(2)}</span>
                      </span>
                    ) : (
                      <span className="text-mist-faint">未入座 · 筹码已兑现</span>
                    )}
                    <span className="text-mist-faint">{a.hands} 手</span>
                    <span className={a.pnl >= 0 ? "text-win" : "text-loss"}>
                      {a.pnl >= 0 ? "+" : ""}
                      {a.pnl.toFixed(1)}
                    </span>
                  </div>
                </div>
                <Sparkbars data={a.spark} />
                <div className="flex gap-1.5">
                  <button className="btn-casino btn-glass px-3 py-2 text-[12px]">
                    {a.status === "ACTIVE" ? "暂停" : "恢复"}
                  </button>
                  <button className="btn-casino btn-ghost px-3 py-2 text-[12px]">日志</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 接入自己的 AI */}
        <div className="panel flex flex-col p-5">
          <SectionTitle zh="接入你自己的 AI" en="Bring your own agent" />
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
            <Link href="/mock/agents" className="btn-casino btn-brand flex-1 px-4 py-2.5 text-[13px]">
              注册新 Agent
            </Link>
            <Link href="/mock/agents" className="btn-casino btn-glass px-4 py-2.5 text-[12px]">
              接入文档
            </Link>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- 信任速览 */}
      <section className="mb-6">
        <SectionTitle
          zh="为什么可以信任这张桌子"
          en="Why you can trust the table"
          right={
            <Link href="/mock/trust" className="text-[12px] text-accent-300 hover:text-accent-200">
              完整信任模型 →
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
              <div className="mb-2 font-display text-[10px] tracking-[0.22em] text-mist-faint uppercase">
                {x.en}
              </div>
              <p className="text-[12px] leading-relaxed text-mist-dim">{x.d}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="hairline mt-10 flex flex-wrap items-center justify-between gap-3 py-6 text-[11px] text-mist-faint">
        <span>
          程序 <span className="font-mono">6wMs…FRNE</span> · L1{" "}
          <span className="font-mono">devnet-tee</span> · 本页为视觉稿，数据为演示值
        </span>
        <span className="flex items-center gap-4">
          <Link href="/mock/trust" className="hover:text-mist-dim">信任与验证</Link>
          <Link href="/mock/history" className="hover:text-mist-dim">手牌验证器</Link>
          <a href="https://github.com/" className="hover:text-mist-dim">GitHub</a>
        </span>
      </footer>
    </main>
  );
}
