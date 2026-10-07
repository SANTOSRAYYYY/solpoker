"use client";

import { useState } from "react";
import { HANDS } from "../data";
import { Badge, Chip, Dot, KV, PlayingCard, SectionTitle, type Suit } from "../ui";

const EVENTS = [
  ["HandStarted", "手牌开始 · 5rTn…q2Fs", "VRF 槽位 88 请求"],
  ["BlindsPosted", "盲注与前注 · 4XkQ…8pRt", "lin 0.1 / σ 0.2 / 前注 ×5"],
  ["ActionTaken ×11", "行动序列 · 9JtR…2xYe", "翻前 3-bet，翻牌 我下注 2.0"],
  ["BoardDealt", "公共牌揭示 · 7GrT…0aSq", "7♥ K♠ 3♦ 7♣ 2♠"],
  ["HandSettled", "结算 · 2PqL…5fVc", "底池 12.8 → 我（AA）"],
];

const PROOF_ROWS = [
  ["牌堆承诺 deck root", "3f9c…c21e"],
  ["VRF 输出", "槽位 88 · 8f21…77ad"],
  ["我（座 4）盐 提交", "4XkQ…8pRt ✓"],
  ["我（座 4）盐 揭示", "9JtR…2xYe ✓"],
  ["逐张复算", "52/52 一致"],
];

export default function HistoryMock() {
  const [sel, setSel] = useState(0);
  const h = HANDS[sel];
  const win = h.delta >= 0;

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-5 sm:py-8">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="title-cn text-[24px] text-mist">手牌历史与验证</h1>
          <p className="mt-1 text-[13px] text-mist-dim">
            每一手都在 L1 留下了完整的事件与承诺；用开源验证器可以复算每一张牌。
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-casino btn-ghost px-4 py-2.5 text-[12.5px]">全部牌桌</button>
          <button className="btn-casino btn-ghost px-4 py-2.5 text-[12.5px]">只看我赢的</button>
          <button className="btn-casino btn-ghost px-4 py-2.5 text-[12.5px]">仅未验证</button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
        {/* ---------------------------------------------------- 左：手牌列表 */}
        <section className="panel max-h-[720px] overflow-hidden p-3">
          <div className="scroll-thin max-h-[700px] space-y-1 overflow-y-auto pr-1">
            {HANDS.map((x, i) => {
              const w = x.delta >= 0;
              const active = i === sel;
              return (
                <button
                  key={x.id}
                  onClick={() => setSel(i)}
                  className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    active
                      ? "border-accent-400/70 bg-accent-500/12"
                      : "border-transparent hover:border-accent-500/25 hover:bg-white/[0.03]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className="font-display text-[13px] font-bold text-mist">{x.id}</span>
                      <span className="font-mono text-[10.5px] text-mist-faint">
                        #{x.tableId} · {x.players} 人
                      </span>
                    </span>
                    <span
                      className={`font-display text-[13px] font-bold ${w ? "text-win" : "text-loss"}`}
                    >
                      {w ? "+" : ""}
                      {x.delta.toFixed(1)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5">
                      {x.mine.map((c, j) => (
                        <PlayingCard
                          key={j}
                          rank={c[0]}
                          suit={c[1] as Suit}
                          w={22}
                        />
                      ))}
                      <span className="ml-1 text-[10.5px] text-mist-faint">{x.when}</span>
                    </span>
                    {x.verified ? (
                      <Badge tone="mint" className="!px-2 !text-[10px]">
                        ✓ 已验证
                      </Badge>
                    ) : (
                      <Badge tone="lime" className="!px-2 !text-[10px]">
                        待验证
                      </Badge>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* ---------------------------------------------------- 右：详情 + 验证 */}
        <section className="space-y-5">
          <div className="panel p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h2 className="title-cn text-[17px] text-mist">手牌 {h.id}</h2>
                <Badge tone="plain">紫晶厅 #{h.tableId}</Badge>
                <span className="text-[12px] text-mist-faint">{h.when}</span>
              </div>
              {h.verified ? (
                <Badge tone="mint">
                  <Dot kind="live" /> 发牌与结算均已验证
                </Badge>
              ) : (
                <Badge tone="lime">
                  <Dot kind="warn" /> 等待 L1 确认
                </Badge>
              )}
            </div>

            <div className="mb-4 flex flex-wrap items-end gap-6">
              <div>
                <div className="mb-1.5 text-[11px] text-mist-faint">公共牌</div>
                <div className="flex gap-1.5">
                  {h.board.map((c, i) => (
                    <PlayingCard key={i} rank={c[0]} suit={c[1] as Suit} w={46} />
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1.5 text-[11px] text-mist-faint">我的手牌</div>
                <div className="flex gap-1.5">
                  {h.mine.map((c, i) => (
                    <PlayingCard key={i} rank={c[0]} suit={c[1] as Suit} w={46} />
                  ))}
                </div>
              </div>
              {h.shown && (
                <div>
                  <div className="mb-1.5 text-[11px] text-mist-faint">摊牌亮出</div>
                  <div className="flex gap-4">
                    {h.shown.map((s) => (
                      <div key={s.name} className="flex items-center gap-1.5">
                        {s.cards.map((c, i) => (
                          <PlayingCard key={i} rank={c[0]} suit={c[1] as Suit} w={34} />
                        ))}
                        <span className="ml-1 text-[11.5px] text-mist-dim">{s.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-accent-500/15 bg-black/25 px-4 py-3">
                <div className="mb-2 text-[11px] tracking-widest text-mist-faint">结算明细</div>
                <KV k="底池" mono>
                  {h.pot.toFixed(1)} tUSDC
                </KV>
                <KV k="抽水" mono>
                  −{(h.pot * 0.025).toFixed(2)}
                </KV>
                <KV k="我的净赢" mono>
                  <span className={win ? "text-win" : "text-loss"}>
                    {win ? "+" : ""}
                    {h.delta.toFixed(2)}
                  </span>
                </KV>
                <KV k="守恒校验">
                  <span className="text-win">✓ {h.players} 人合计 ±0</span>
                </KV>
              </div>
              <div className="rounded-xl border border-accent-500/15 bg-black/25 px-4 py-3">
                <div className="mb-2 text-[11px] tracking-widest text-mist-faint">发牌证明</div>
                {PROOF_ROWS.map(([k, v]) => (
                  <KV key={k} k={k} mono>
                    {v}
                  </KV>
                ))}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <a href="https://solscan.io/" className="btn-casino btn-brand px-4 py-2.5 text-[12.5px]">
                在 Solscan 查看 {h.sig}
              </a>
              <button className="btn-casino btn-ghost px-4 py-2.5 text-[12.5px]">本地复算</button>
              <button className="btn-casino btn-ghost px-4 py-2.5 text-[12.5px]">导出 JSON</button>
            </div>
          </div>

          {/* 事件流 */}
          <div className="panel p-5">
            <SectionTitle zh="L1 事件流" en="On-chain event trail" />
            <ol className="relative ml-3 space-y-4 border-l border-accent-500/25 pl-5">
              {EVENTS.map(([name, sig, d], i) => (
                <li key={i} className="relative">
                  <span className="absolute -left-[26px] mt-1 grid h-3 w-3 place-items-center rounded-full border border-accent-400/70 bg-ink-900" />
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-[12px] text-accent-200">{name}</span>
                    <span className="font-mono text-[11px] text-mist-faint">{sig}</span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-mist-dim">{d}</div>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-[11.5px] leading-relaxed text-mist-faint">
              提示：只有公开事件保留在 L1；底牌、盐与随机数在结算后按协议公开，可用于复算（§8.7）。
            </p>
          </div>
        </section>
      </div>

      {/* ---------------------------------------------------- 验证器说明 */}
      <section className="mt-10">
        <SectionTitle zh="独立验证，只需三步" en="Verify it yourself" />
        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              n: "01",
              zh: "取到承诺与输入",
              d: "从 L1 读这一手的 Game 快照、HandProof、VRF 输出与双方揭示的盐——全部是公开数据。",
            },
            {
              n: "02",
              zh: "复算 52 张牌序",
              d: "用与程序里完全相同的洗牌算法重放：改一张牌，牌堆承诺就变。验证器会逐张比对。",
            },
            {
              n: "03",
              zh: "复算结算",
              d: "按事件流重放每条街的行动，检查底池、边池、抽水与守恒：任何人多拿一枚筹码都会被发现。",
            },
          ].map((s) => (
            <div key={s.n} className="panel p-5">
              <div className="mb-2 flex items-center gap-3">
                <span className="text-brand font-display text-[26px] font-bold">{s.n}</span>
                <span className="title-cn text-[13.5px] text-mist">{s.zh}</span>
              </div>
              <p className="text-[12px] leading-relaxed text-mist-dim">{s.d}</p>
            </div>
          ))}
        </div>
        <div className="panel mt-4 flex flex-wrap items-center gap-3 p-4">
          <span className="text-[12.5px] text-mist-dim">粘贴 hand_id 或选择桌号 + 手号：</span>
          <input
            placeholder="#128 或 3f9c…c21e"
            className="min-w-[240px] flex-1 rounded-lg border border-accent-500/30 bg-black/40 px-3 py-2 font-mono text-[12px] text-accent-200 outline-none placeholder:text-mist-faint/60"
          />
          <button className="btn-casino btn-mint px-5 py-2.5 text-[13px]">开始验证</button>
          <span className="flex items-center gap-2 text-[11.5px] text-mist-faint">
            <Chip color="cyan" size={18} /> 验证器源码在仓库 scripts/verify/
          </span>
        </div>
      </section>
    </main>
  );
}
