"use client";

import Link from "next/link";
import { useState } from "react";
import { BOARD, FEED, HOLE, TABLE_SEATS, type MockSeat } from "../data";
import { Badge, Chip, ChipStack, Dot, KV, PlayingCard, SectionTitle, SolMark } from "../ui";

const POT = 33.2;
const MY_CALL = 16.0;
const MY_STACK = 41.2;

/* 座位角度：我的座位固定在正下方（90°），其余按 60° 均匀分布 */
function seatPos(seatIdx: number, myIdx = 4, n = 6) {
  const step = 360 / n;
  const theta = (90 + step * (seatIdx - myIdx)) * (Math.PI / 180);
  return { x: 50 + 43 * Math.cos(theta), y: 50 + 36 * Math.sin(theta) };
}
/* 下注筹码：从座位向桌心收进 30% */
function betPos(seatIdx: number, myIdx = 4) {
  const p = seatPos(seatIdx, myIdx);
  return { x: p.x + (50 - p.x) * 0.34, y: p.y + (50 - p.y) * 0.34 };
}

const ACT_TONE: Record<string, string> = {
  acting: "text-accent-200",
  folded: "text-mist-faint",
  allin: "text-loss",
  waiting: "text-mist-dim",
  sitting: "text-mist-faint",
};

function SeatPlate({ s, myIdx = 4 }: { s: MockSeat; myIdx?: number }) {
  const p = seatPos(s.seat, myIdx);
  const isMe = s.kind === "me";
  const acting = s.act === "acting";
  const folded = s.act === "folded";
  return (
    <div
      className="absolute z-10 w-[152px] -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${p.x}%`, top: `${p.y}%` }}
    >
      <div
        className={`seat-plate flex items-center gap-2 px-2.5 py-2 ${acting ? "seat-acting" : ""} ${
          isMe ? "seat-me" : ""
        } ${folded ? "seat-folded" : ""}`}
      >
        <span
          className={`avatar h-9 w-9 shrink-0 text-[12px] ${s.kind === "agent" ? "avatar-agent" : ""}`}
        >
          {s.kind === "agent" ? "AI" : s.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-display text-[12.5px] font-bold tracking-wide text-mist">
              {s.name}
            </span>
            {isMe && <Badge tone="grad" className="!px-1.5 !text-[9px]">我</Badge>}
          </div>
          <div className="flex items-center gap-1 font-mono text-[11px] leading-tight">
            <Chip color={s.act === "allin" ? "purple" : "white"} size={13} />
            <span className={s.act === "allin" ? "text-loss" : "text-accent-200"}>
              {s.act === "allin" ? "全下" : s.stack.toFixed(2)}
            </span>
          </div>
        </div>
        {acting && (
          <span className="timer-ring shrink-0" style={{ ["--p" as string]: 0.47, ["--tr-size" as string]: "38px" }}>
            <span>14</span>
          </span>
        )}
      </div>
      {s.lastAction && (
        <div
          className={`mt-1 text-center font-mono text-[10.5px] tracking-wide ${ACT_TONE[s.act ?? "waiting"]}`}
        >
          {s.lastAction}
        </div>
      )}
    </div>
  );
}

function BetChips({ s, myIdx = 4 }: { s: MockSeat; myIdx?: number }) {
  if (!s.bet) return null;
  const p = betPos(s.seat, myIdx);
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2 animate-chip-pop"
      style={{ left: `${p.x}%`, top: `${p.y}%` }}
    >
      <Chip
        v={s.bet >= 10 ? s.bet.toFixed(0) : s.bet.toFixed(1)}
        color={s.act === "allin" ? "purple" : s.bet >= 2 ? "cyan" : "green"}
        size={30}
      />
    </div>
  );
}

function TableCanvas() {
  return (
    <div className="relative mx-auto aspect-[1.9/1] w-full max-w-[1020px] select-none">
      <div className="rail absolute inset-0 rounded-[50%] p-[3.1%]">
        <div className="felt relative h-full w-full rounded-[50%]">
          {/* 状态 HUD：左上阶段 / 右上 VRF */}
          <div className="absolute top-[13%] left-[13%] flex flex-col items-start gap-1.5">
            <Badge tone="brand">转牌 TURN · 第 4 街</Badge>
            <Badge tone="plain">底池 33.2 · 均 5.1</Badge>
          </div>
          <div className="absolute top-[13%] right-[13%] flex flex-col items-end gap-1.5">
            <Badge tone="grad">
              <Dot kind="live" /> VRF 已揭示
            </Badge>
            <Badge tone="plain">手 #8 · 6 人</Badge>
          </div>

          {/* 桌心：底池 + 公共牌 */}
          <div className="absolute top-[44%] left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2.5">
            <div className="flex items-center gap-3">
              <span className="holo px-3 py-1 font-display text-[12px] font-bold tracking-wide">
                底池 POT
              </span>
              <span className="font-display text-[22px] font-bold text-white drop-shadow-[0_2px_4px_rgba(0,0,0,.7)]">
                {POT.toFixed(1)}
              </span>
              <ChipStack count={2} color="cyan" size={24} />
            </div>
            <div className="flex gap-1.5">
              {Array.from({ length: 5 }).map((_, i) =>
                i < BOARD.length ? (
                  <PlayingCard
                    key={i}
                    rank={BOARD[i].rank}
                    suit={BOARD[i].suit}
                    w={62}
                    className="animate-card-deal"
                    style={{ animationDelay: `${i * 90}ms` }}
                  />
                ) : (
                  <PlayingCard key={i} empty w={62} className="opacity-70" />
                ),
              )}
            </div>
          </div>

          {/* 庄家按钮：靠近 momo 座位 */}
          <span className="holo absolute left-[22.5%] top-[63%] grid h-7 w-7 place-items-center font-display text-[12px] font-bold">
            D
          </span>

          {TABLE_SEATS.map((s) => (
            <BetChips key={`b${s.seat}`} s={s} />
          ))}
          {TABLE_SEATS.map((s) => (
            <SeatPlate key={s.seat} s={s} />
          ))}

          {/* 我的底牌（仅本机解密） */}
          <div
            className="absolute left-1/2 top-[62%] flex -translate-x-1/2 gap-1.5"
            style={{ transform: "translateX(-50%) rotate(-2deg)" }}
          >
            {HOLE.map((c, i) => (
              <PlayingCard
                key={i}
                rank={c.rank}
                suit={c.suit}
                w={52}
                className="animate-card-deal shadow-[0_10px_22px_rgba(0,0,0,.6)]"
                style={{ animationDelay: `${600 + i * 110}ms`, rotate: i ? "5deg" : "-5deg" }}
              />
            ))}
            <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] whitespace-nowrap text-sol-green/90">
              仅本机解密
            </span>
          </div>
        </div>
      </div>

      {/* 桌上品牌水印 */}
      <span className="pointer-events-none absolute top-[22%] left-1/2 flex -translate-x-1/2 items-center gap-2.5 opacity-45">
        <SolMark size={20} />
        <span
          className="font-display text-[11px] tracking-[0.5em] text-white/60"
          style={{ fontFamily: "var(--font-body)" }}
        >
          SOLPOKER · PRIVATE
        </span>
      </span>
    </div>
  );
}

function ActionDock() {
  const [raise, setRaise] = useState(23.2);
  return (
    <div className="panel mx-auto mt-5 flex w-full max-w-[1020px] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
      <span className="timer-ring" style={{ ["--p" as string]: 0.47 }}>
        <span>14</span>
      </span>
      <div className="flex gap-2">
        <button className="btn-casino btn-danger px-5 py-2.5 text-[13px]">
          弃牌 <span className="ml-1 font-display text-[10px] opacity-70">FOLD</span>
        </button>
        <button className="btn-casino btn-glass px-5 py-2.5 text-[13px]">
          过牌 <span className="ml-1 font-display text-[10px] opacity-70">CHECK</span>
        </button>
        <button className="btn-casino btn-mint px-5 py-2.5 text-[13px]">
          跟注 {MY_CALL.toFixed(1)}
        </button>
      </div>

      <div className="min-w-[300px] flex-1">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[11px] text-mist-faint">
            加注到 <span className="font-mono text-accent-200">{raise.toFixed(1)}</span> tUSDC
          </span>
          <span className="font-mono text-[10.5px] text-mist-faint">
            最小 16.0 · 你的筹码 {MY_STACK.toFixed(1)}
          </span>
        </div>
        <input
          type="range"
          min={16}
          max={MY_STACK}
          step={0.2}
          value={raise}
          onChange={(e) => setRaise(Number(e.target.value))}
          className="h-1.5 w-full cursor-pointer accent-sol-purple"
        />
        <div className="mt-2 flex items-center gap-1.5">
          {["最小", "½ 底池", "¾ 底池", "底池", "全下"].map((p, i) => (
            <button
              key={p}
              onClick={() => setRaise(i === 0 ? 16 : i === 4 ? MY_STACK : Number((POT * [0, 0.5, 0.75, 1][i] + MY_CALL).toFixed(1)))}
              className="btn-casino btn-ghost px-2.5 py-1 !text-[11px]"
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <button className="btn-casino btn-brand px-6 py-3 text-[14px]">
        确认加注 <span className="font-display text-[11px] opacity-80">RAISE</span>
      </button>
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="space-y-4">
      <section className="panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="title-cn text-[13px] text-mist">我的手牌</span>
          <Badge tone="mint">仅本机可见</Badge>
        </div>
        <div className="flex items-center gap-3">
          {HOLE.map((c, i) => (
            <PlayingCard key={i} rank={c.rank} suit={c.suit} w={64} className="animate-card-deal" style={{ animationDelay: `${i * 110}ms` }} />
          ))}
          <div className="text-[12px] leading-relaxed text-mist-dim">
            <div className="text-accent-200">一对 A</div>
            <div className="text-mist-faint">顶对 · 无同花听牌</div>
          </div>
        </div>
      </section>

      <section className="panel p-4">
        <SectionTitle zh="本手信息" en="Hand info" />
        <KV k="手牌编号" mono>
          #8
        </KV>
        <KV k="阶段">转牌（第 4 街）</KV>
        <KV k="盲注 / 前注">
          <span className="font-mono">0.1 / 0.2 / 0.02</span>
        </KV>
        <KV k="底池" mono>
          {POT.toFixed(1)} tUSDC
        </KV>
        <KV k="我的投入" mono>
          6.4 tUSDC
        </KV>
        <KV k="我的位置">BTN（按钮）</KV>
        <KV k="行动剩余">
          <span className="text-accent-200">14s / 30s</span>
        </KV>
      </section>

      <section className="panel p-4">
        <SectionTitle zh="发牌证明" en="Provably fair" />
        <KV k="牌堆承诺" mono>
          3f9c…c21e
        </KV>
        <KV k="VRF 槽位" mono>
          88 · 已揭示
        </KV>
        <KV k="盐 提交 / 揭示">
          <span className="text-win">✓ 已提交</span> ·{" "}
          <span className="text-win">✓ 已揭示</span>
        </KV>
        <KV k="本手结算">未结算</KV>
        <Link
          href="/mock/history"
          className="mt-3 block rounded-lg border border-accent-500/35 py-2 text-center text-[12px] text-accent-200 hover:bg-accent-500/10"
        >
          在验证器中打开本手 →
        </Link>
      </section>

      <section className="panel flex max-h-[420px] flex-col p-4">
        <SectionTitle zh="行动记录" en="Action feed" />
        <div className="scroll-thin -mr-2 space-y-1.5 overflow-y-auto pr-2">
          {[...FEED].reverse().map((f, i) => (
            <div key={i} className="flex items-baseline gap-2 text-[11.5px] leading-relaxed">
              <span className="font-mono text-[10px] text-mist-faint">{f.t}</span>
              <span className="shrink-0 text-mist-faint">{f.who}</span>
              <span
                className={
                  f.tone === "gold"
                    ? "text-accent-200"
                    : f.tone === "red"
                      ? "text-loss"
                      : f.tone === "felt"
                        ? "text-win"
                        : f.tone === "blue"
                          ? "text-sol-purple"
                          : "text-mist-dim"
                }
              >
                {f.what}
              </span>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

/* ------------------------------------------------------- 弹窗/状态 组件示例 */
function Samples() {
  return (
    <section className="mt-12">
      <SectionTitle zh="弹窗与状态" en="Modals & states" />
      <div className="grid gap-5 lg:grid-cols-3">
        {/* 混合桌入座确认（X11） */}
        <div className="panel p-5">
          <div className="mb-3 flex items-center gap-2">
            <Badge tone="grad">X11 · 混合桌</Badge>
            <span className="text-[11px] text-mist-faint">入座确认</span>
          </div>
          <h4 className="title-cn mb-3 text-[15px] text-mist">确认入座 紫晶厅 #11</h4>
          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-accent-400/60 bg-accent-500/10 p-3">
              <input type="radio" defaultChecked className="mt-1 accent-sol-purple" />
              <span>
                <span className="block text-[12.5px] text-mist">以真人身份入座</span>
                <span className="block text-[11px] text-mist-dim">
                  与 2 个 AI agent 同桌；底牌仅你可见
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-accent-500/20 p-3">
              <input type="radio" className="mt-1 accent-sol-purple" />
              <span>
                <span className="block text-[12.5px] text-mist">以 Agent 身份入座：bob-1</span>
                <span className="block text-[11px] text-mist-dim">
                  由你的 AI 决策，收益打回主人钱包
                </span>
              </span>
            </label>
          </div>
          <label className="mt-3 flex items-start gap-2 text-[11.5px] text-mist-dim">
            <input type="checkbox" defaultChecked className="mt-0.5 accent-sol-purple" />
            我已了解：本桌含 AI 对手，同一主人的 agent 不会与我同桌（§2.3）
          </label>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[12px] text-mist-dim">买入</span>
            <input
              defaultValue="20.0"
              className="w-24 rounded-md border border-accent-500/30 bg-black/40 px-2 py-1.5 text-right font-mono text-[12px] text-accent-200 outline-none"
            />
            <span className="text-[11px] text-mist-faint">tUSDC（20–200）</span>
          </div>
          <div className="mt-4 flex gap-2">
            <button className="btn-casino btn-brand flex-1 py-2.5 text-[13px]">确认入座</button>
            <button className="btn-casino btn-glass px-4 py-2.5 text-[12px]">取消</button>
          </div>
        </div>

        {/* 手牌结算 */}
        <div className="panel p-5">
          <div className="mb-3 flex items-center gap-2">
            <Badge tone="mint">手牌结算</Badge>
            <span className="text-[11px] text-mist-faint">#128 · 紫晶厅</span>
          </div>
          <h4 className="title-cn mb-3 text-[15px] text-mist">你赢得了这个底池</h4>
          <div className="mb-4 rounded-xl border border-sol-green/30 bg-sol-green/10 p-4 text-center">
            <div className="text-[11px] tracking-widest text-mist-dim">净赢得</div>
            <div className="font-display text-[30px] font-bold text-win">+8.20</div>
            <div className="text-[11px] text-mist-dim">tUSDC → 打回你的钱包</div>
          </div>
          <div className="space-y-1">
            <KV k="底池" mono>
              12.8 tUSDC
            </KV>
            <KV k="抽水（2.5% 上限 3bb）" mono>
              −0.32
            </KV>
            <KV k="对手亮牌" mono>
              K♦9♦ / Q♠Q♥
            </KV>
            <KV k="结算校验">守恒 ✓ 6 名玩家合计 ±0</KV>
          </div>
          <button className="btn-casino btn-ghost mt-4 w-full py-2.5 text-[12px]">
            查看发牌证明 →
          </button>
        </div>

        {/* 离座 & 自动离座 */}
        <div className="panel space-y-5 p-5">
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Badge tone="danger">E3 · 手牌进行中</Badge>
            </div>
            <h4 className="title-cn mb-2 text-[15px] text-mist">确认离座？</h4>
            <p className="text-[12px] leading-relaxed text-mist-dim">
              手牌进行中离座将<span className="text-loss">立即弃牌</span>。
              本手结束后，你的全部筹码（41.2 tUSDC）将自动兑现到钱包。
            </p>
            <div className="mt-3 flex gap-2">
              <button className="btn-casino btn-danger flex-1 py-2.5 text-[13px]">
                弃牌并离座
              </button>
              <button className="btn-casino btn-glass px-4 py-2.5 text-[12px]">继续打</button>
            </div>
          </div>
          <div className="divider" />
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Badge tone="lime">A7 · 自动离座</Badge>
            </div>
            <p className="text-[12px] leading-relaxed text-mist-dim">
              你的筹码为 0。本手结算后系统将自动离座，已结算的 0.00 tUSDC
              会打到你的钱包，再次入座即可继续。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function TableMock() {
  return (
    <main className="mx-auto max-w-[1400px] px-4 pt-4 pb-16">
      {/* 顶栏 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent-500/20 bg-black/30 px-3 py-2.5 sm:gap-3 sm:px-4">
        <div className="flex items-center gap-2 sm:gap-3">
          <Link href="/mock/lobby" className="shrink-0 text-[12px] text-mist-dim hover:text-mist">
            ← <span className="hidden sm:inline">大厅</span>
          </Link>
          <span className="hidden h-4 w-px bg-accent-500/25 sm:block" />
          <span className="title-cn shrink-0 text-[15px] whitespace-nowrap text-mist">紫晶厅</span>
          <span className="font-mono text-[11px] text-mist-faint">#11</span>
          <Badge tone="grad">混合桌</Badge>
          <span className="hidden font-mono text-[11px] whitespace-nowrap text-mist-dim md:inline">
            盲注 0.1/0.2 · 前注 0.02
          </span>
          <Badge tone="brand" className="hidden md:inline-flex">
            手 #8
          </Badge>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <Badge tone="mint" className="hidden lg:inline-flex">
            <Dot kind="live" /> TEE 已验证
          </Badge>
          <span className="rounded-lg border border-accent-500/30 bg-black/40 px-2.5 py-1.5 font-mono text-[11.5px] whitespace-nowrap text-mist-2">
            我的筹码 <span className="text-accent-200">41.20</span>
          </span>
          <button className="btn-casino btn-glass px-2.5 py-1.5 text-[12px] whitespace-nowrap">
            兑现
          </button>
          <button className="btn-casino btn-ghost px-2.5 py-1.5 text-[12px] whitespace-nowrap">
            离座
          </button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="no-bar overflow-x-auto">
          <div className="min-w-[680px]">
            <TableCanvas />
            <ActionDock />
          </div>
        </div>
        <Sidebar />
      </div>

      <Samples />
    </main>
  );
}
