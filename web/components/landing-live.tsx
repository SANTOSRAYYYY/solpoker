"use client";

// 落地页的实时数据条：直接读链上（Game 走 ER 实时，座位账本走 L1），
// 8 秒轮询 + SSE 事件立即刷新 —— 统计口径与大厅完全一致（/lobby 的 stats）。
// 目的：首屏就能看到「这不是个 PPT，真的在跑」。

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Connection } from "@solana/web3.js";
import { Dot, Stat } from "@/components/ui";
import { readTablesLive, type TableLive } from "@/lib/chain-read";
import { ER_RPC, L1_RPC } from "@/lib/config";
import { fmtUsdc } from "@/lib/game-state";
import { useI18n } from "@/lib/i18n";
import { useLiveUpdates } from "@/lib/live-updates";

export function LandingLive() {
  const { t: tr, lang } = useI18n();
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const er = useMemo(() => new Connection(ER_RPC, "confirmed"), []);
  const l1 = useMemo(() => new Connection(L1_RPC, "confirmed"), []);
  const [tables, setTables] = useState<TableLive[]>([]);
  const live = useLiveUpdates();

  useEffect(() => {
    let stop = false;
    (async () => {
      for (;;) {
        if (stop) return;
        try {
          setTables(await readTablesLive(er, l1));
        } catch {
          /* 下一轮 */
        }
        await new Promise((r) => setTimeout(r, 8000));
      }
    })();
    return () => {
      stop = true;
    };
  }, [er, l1, live.tick]);

  const stats = useMemo(() => {
    const liveCount = tables.filter((t) => t.live).length;
    const seated = tables.reduce((n, t) => n + t.seated, 0);
    const agents = tables.reduce((n, t) => n + t.agentSeated, 0);
    // 桌内托管 ≈ Σ(deposited − paid)：锁在链上金库里的筹码（含桌上的底池）
    let escrow = 0n;
    for (const t of tables) {
      for (const s of t.seats) {
        if (s?.occupant) escrow += s.depositedTotal - s.paidTotal;
      }
    }
    // blindsText 形如 "0.10 / 0.20 (ante 0.02)" —— 落地页只展示盲注本身
    const blinds = [
      ...new Set(
        tables.map((t) => t.info.blindsText.replace(/\s*\(ante[^)]*\)/g, "").trim())
      ),
    ].slice(0, 3);
    const watchable = tables.find((t) => t.live)?.info.id ?? null;
    return { liveCount, seated, agents, escrow, blinds, watchable, total: tables.length };
  }, [tables]);

  return (
    <div className="mt-9">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-mist-faint">
        <span className="inline-flex items-center gap-1.5 text-mist-dim">
          <Dot kind={stats.total > 0 ? "live" : "idle"} />
          {L("链上实时 · 无需登录", "Live from chain · no login")}
        </span>
        {stats.blinds.length > 0 && (
          <span className="font-mono">
            {L("盲注", "Stakes")} {stats.blinds.join(" · ")}
          </span>
        )}
        {stats.watchable !== null && (
          <Link
            href={`/table/${stats.watchable}`}
            className="text-accent-200 underline-offset-2 hover:underline"
          >
            {L("去看正在进行的一桌 →", "Watch a live table →")}
          </Link>
        )}
      </div>
      <div className="flex flex-wrap gap-2.5">
        <Stat
          en="RUNNING"
          label={tr("lobby.stat.live")}
          value={String(stats.liveCount)}
          sub={tr("lobby.stat.liveSub", { n: stats.total })}
        />
        <Stat
          en="SEATED"
          label={tr("lobby.stat.seated")}
          value={String(stats.seated)}
          sub={tr("lobby.stat.seatedSub", { ai: stats.agents })}
        />
        <Stat
          en="IN ESCROW"
          label={tr("lobby.stat.escrow")}
          value={fmtUsdc(stats.escrow)}
          sub="tUSDC"
        />
      </div>
    </div>
  );
}
