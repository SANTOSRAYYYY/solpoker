"use client";

// 测试币水龙头页（devnet）：连接钱包 → 一键补足 SOL + tUSDC → 去大厅开打。
// 服务端路由 /api/faucet 持有部署者私钥（只在服务器读取）；本页只提交地址与展示结果。

import Link from "next/link";
import { useState } from "react";
import { Badge, Dot, SectionTitle } from "@/components/ui";
import { useWalletCtx } from "@/components/wallet-context";
import { useI18n } from "@/lib/i18n";

const SOL_TARGET = 0.1;
const USDC_TARGET = 100;
const SOL_THRESHOLD = 0.01;
const USDC_THRESHOLD = 5;

type Phase =
  | { k: "idle" }
  | { k: "busy" }
  | { k: "done"; sig: string; sent: { sol: number; usdc: number } }
  | { k: "already"; balances: { sol: number; usdc: number } }
  | { k: "error"; msg: string; retryAfterS?: number };

export default function FaucetPage() {
  const { lang } = useI18n();
  const zh = lang === "zh";
  const L = (z: string, e: string) => (zh ? z : e);
  const ctx = useWalletCtx();
  const [phase, setPhase] = useState<Phase>({ k: "idle" });

  const sol = ctx.solBal;
  const usdc = ctx.usdcBal;
  const eligible =
    sol !== null && usdc !== null && (sol < SOL_THRESHOLD || usdc < USDC_THRESHOLD);

  const claim = async () => {
    if (!ctx.me) return;
    setPhase({ k: "busy" });
    try {
      const r = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: ctx.me.toBase58() }),
      });
      const j = (await r.json()) as {
        ok: boolean;
        sig?: string;
        sent?: { sol: number; usdc: number };
        already?: boolean;
        balances?: { sol: number; usdc: number };
        error?: string;
        retryAfterS?: number;
      };
      if (j.ok && j.already) {
        setPhase({ k: "already", balances: j.balances ?? { sol: 0, usdc: 0 } });
      } else if (j.ok && j.sig) {
        setPhase({ k: "done", sig: j.sig, sent: j.sent ?? { sol: 0, usdc: 0 } });
      } else {
        setPhase({ k: "error", msg: j.error ?? "unknown", retryAfterS: j.retryAfterS });
      }
    } catch (e) {
      setPhase({ k: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <main className="mx-auto max-w-[880px] px-4 py-8 sm:px-5">
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="title-cn text-[24px] text-mist">
            {L("测试币水龙头", "Testnet faucet")}
          </h1>
          <Badge tone="grad">devnet</Badge>
          <Badge tone="lime">{L("不承载真实价值", "no real value")}</Badge>
        </div>
        <p className="mt-1.5 max-w-[720px] text-[13px] leading-relaxed text-mist-dim">
          {L(
            "玩桌需要两种测试币：SOL（链上手续费）与 tUSDC（买入筹码）。本页一键补足 —— 余额低于阈值才发，一次补到 0.1 SOL + 100 tUSDC。",
            "Playing needs two test tokens: SOL for on-chain fees and tUSDC for buy-ins. Top up both here — issued only when your balance falls below the threshold, topping up to 0.1 SOL + 100 tUSDC."
          )}
        </p>
      </div>

      <section className="panel p-5">
        <SectionTitle
          zh={L("领取", "Claim")}
          en="GET TEST TOKENS"
          right={
            <span className="text-[11px] text-mist-faint">
              {L("同一网络 10 分钟冷却", "10-minute cooldown per network")}
            </span>
          }
        />

        {!ctx.me ? (
          <>
            <p className="text-[12.5px] leading-relaxed text-mist-dim">
              {L(
                "先连接钱包 —— 测试币会发放到你选择的 Solana 地址。",
                "Connect a wallet first — tokens are issued to your selected Solana address."
              )}
            </p>
            <button
              className="btn-casino btn-brand mt-3 w-full py-2.5 text-[13px] sm:w-auto sm:px-8"
              onClick={ctx.login}
              disabled={!ctx.privyConfigured}
            >
              {L("连接钱包", "Connect wallet")}
            </button>
          </>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rail-quiet p-3.5">
                <div className="text-[11px] tracking-widest text-mist-faint">SOL</div>
                <div className="mt-1 font-mono text-[16px] text-mist">
                  {sol === null ? "…" : sol.toFixed(4)}
                </div>
                <div className="mt-0.5 text-[11px] text-mist-faint">
                  {L(`低于 ${SOL_THRESHOLD} 可补到 ${SOL_TARGET}`, `below ${SOL_THRESHOLD} → tops up to ${SOL_TARGET}`)}
                </div>
              </div>
              <div className="rail-quiet p-3.5">
                <div className="text-[11px] tracking-widest text-mist-faint">tUSDC</div>
                <div className="mt-1 font-mono text-[16px] text-mist">
                  {usdc === null ? "…" : usdc.toFixed(2)}
                </div>
                <div className="mt-0.5 text-[11px] text-mist-faint">
                  {L(`低于 ${USDC_THRESHOLD} 可补到 ${USDC_TARGET}`, `below ${USDC_THRESHOLD} → tops up to ${USDC_TARGET}`)}
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                className="btn-casino btn-brand px-7 py-2.5 text-[13.5px]"
                onClick={claim}
                disabled={phase.k === "busy"}
              >
                {phase.k === "busy"
                  ? L("发放中…", "Sending…")
                  : L("领取：补足到 0.1 SOL + 100 tUSDC", "Claim: top up to 0.1 SOL + 100 tUSDC")}
              </button>
              {eligible === false && (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-mist-faint">
                  <Dot kind="live" />
                  {L("当前余额充足，无需领取", "Balances are sufficient — nothing to top up")}
                </span>
              )}
            </div>

            {phase.k === "done" && (
              <div className="mt-4 rounded-lg border border-mint-500/30 bg-mint-500/6 px-4 py-3 text-[12.5px] text-mist-2">
                {L("已发放", "Sent")}{" "}
                <span className="font-mono text-win">
                  {phase.sent.sol.toFixed(4)} SOL + {phase.sent.usdc.toFixed(2)} tUSDC
                </span>
                {" · "}
                <a
                  className="text-accent-200 underline-offset-2 hover:underline"
                  href={`https://solscan.io/tx/${phase.sig}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {phase.sig.slice(0, 16)}… ↗
                </a>
                <div className="mt-2">
                  <Link href="/lobby" className="btn-casino btn-mint px-4 py-1.5 text-[12px]">
                    {L("去大厅开打 →", "Go to the lobby →")}
                  </Link>
                </div>
              </div>
            )}
            {phase.k === "already" && (
              <p className="mt-4 rounded-lg border border-cyanx-500/25 bg-cyanx-500/6 px-4 py-3 text-[12.5px] text-mist-dim">
                {L(
                  `余额已充足（${phase.balances.sol.toFixed(4)} SOL / ${phase.balances.usdc.toFixed(2)} tUSDC），先去打两把再来。`,
                  `Balances are sufficient (${phase.balances.sol.toFixed(4)} SOL / ${phase.balances.usdc.toFixed(2)} tUSDC) — go play a few hands first.`
                )}
              </p>
            )}
            {phase.k === "error" && (
              <p className="mt-4 rounded-lg border border-loss/30 bg-loss/8 px-4 py-3 text-[12.5px] text-loss">
                {phase.retryAfterS
                  ? L(
                      `冷却中：约 ${Math.ceil(phase.retryAfterS / 60)} 分钟后再试。`,
                      `Cooling down: try again in about ${Math.ceil(phase.retryAfterS / 60)} min.`
                    )
                  : `${L("发放失败", "Claim failed")}：${phase.msg}`}
              </p>
            )}
          </>
        )}
      </section>

      <section className="panel mt-5 p-5">
        <SectionTitle zh={L("说明", "Notes")} en="GOOD TO KNOW" />
        <ul className="space-y-2 text-[12.5px] leading-relaxed text-mist-dim">
          <li className="flex gap-2.5">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400/70" />
            <span>
              {L(
                "只发到 devnet：tUSDC 的铸币权在运营方手里，仅测试网有效，不承载任何真实价值。",
                "Devnet only: the tUSDC mint authority sits with the operator, and the token has no real value."
              )}
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400/70" />
            <span>
              {L(
                "余额式补足：只有 SOL 低于 0.01 或 tUSDC 低于 5 才会发放，所以玩光了回来还能再领。",
                "Balance-based: tokens are issued only when SOL is under 0.01 or tUSDC under 5 — come back whenever you run out."
              )}
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400/70" />
            <span>
              {L("第一次入座还会用到会话密钥（预充 0.001 SOL 付手续费）—— 上面的 SOL 已包含它。", "Your first sit-down also funds a session key (0.001 SOL) — the SOL above covers it.")}
            </span>
          </li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/docs/quickstart"
            className="rounded-md border border-accent-500/35 px-3 py-1.5 text-[11.5px] text-accent-200 hover:bg-accent-500/10"
          >
            {L("快速开始（文档） →", "Quickstart (docs) →")}
          </Link>
          <Link
            href="/docs/money"
            className="rounded-md border border-accent-500/35 px-3 py-1.5 text-[11.5px] text-accent-200 hover:bg-accent-500/10"
          >
            {L("资金与托管 →", "Money & escrow →")}
          </Link>
        </div>
      </section>
    </main>
  );
}
