"use client";

// 应用导航（真实页面）：品牌 + 主导航 + 钱包区（登录 / 地址选择 / 余额）。
// 钱包选择保留：Privy 可能同时给出内嵌钱包与外部 Solana 钱包，两者地址不同。

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Badge, Dot, SolMark } from "@/components/ui";
import { useWalletCtx } from "@/components/wallet-context";

const NAV = [
  { href: "/", zh: "大厅", en: "LOBBY" },
  { href: "/agents", zh: "我的 Agent", en: "AGENTS" },
  { href: "/history", zh: "手牌验证", en: "HISTORY" },
  { href: "/trust", zh: "信任", en: "TRUST" },
];

export function AppNav() {
  const path = usePathname();
  const ctx = useWalletCtx();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-accent-500/30 bg-[#08080f]/92 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-3 sm:gap-5 sm:px-5">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <SolMark size={26} />
          <span className="text-brand text-[18px] font-bold tracking-wide sm:text-[19px]">
            SolPoker
          </span>
          <Badge tone="grad" className="ml-1 hidden lg:inline-flex">
            devnet-tee
          </Badge>
        </Link>

        <nav className="no-bar flex flex-1 items-center gap-0.5 overflow-x-auto">
          {NAV.map((n) => {
            const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`group relative shrink-0 rounded-md px-2 py-2 transition-colors xl:px-2.5 ${
                  active ? "text-accent-200" : "text-mist-dim hover:text-mist"
                }`}
              >
                <span className="title-cn text-[12.5px] sm:text-[13px]">{n.zh}</span>
                <span className="ml-1.5 hidden text-[9px] tracking-[0.16em] opacity-60 2xl:inline">
                  {n.en}
                </span>
                {active && (
                  <span className="absolute inset-x-2 -bottom-[1px] h-[2px] rounded-full bg-gradient-to-r from-accent-500/0 via-accent-400 to-accent-500/0" />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {!ctx.ready && (
            <span className="rounded-full border border-accent-500/30 px-3 py-1.5 text-[11px] text-mist-faint">
              加载中…
            </span>
          )}

          {ctx.ready && !ctx.authenticated && (
            <button
              className="btn-casino btn-brand px-4 py-1.5 text-[12.5px]"
              onClick={ctx.login}
              disabled={!ctx.privyConfigured}
            >
              连接钱包
            </button>
          )}

          {ctx.ready && ctx.authenticated && ctx.me && (
            <div className="relative">
              <button
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-2 rounded-full border border-accent-500/30 bg-black/40 px-3 py-1.5 hover:border-accent-500/60"
              >
                <Dot kind="live" />
                <span className="font-mono text-[11px] text-mist-2">
                  {ctx.address!.slice(0, 4)}…{ctx.address!.slice(-4)}
                </span>
                <span className="font-mono text-[11px] text-accent-200">
                  {ctx.usdcBal === null ? "…" : ctx.usdcBal.toFixed(2)}
                </span>
              </button>
              {open && (
                <div className="panel absolute right-0 mt-2 w-[300px] p-3">
                  <div className="mb-2 text-[11px] tracking-widest text-mist-faint">
                    钱包 / WALLETS
                  </div>
                  <div className="space-y-1.5">
                    {ctx.options.map((o) => (
                      <button
                        key={o.address}
                        onClick={() => {
                          ctx.pick(o.address);
                          setOpen(false);
                        }}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-[12px] transition-colors ${
                          o.address === ctx.address
                            ? "border-accent-400/70 bg-accent-500/12"
                            : "border-mist/10 hover:border-accent-500/35"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-mist">{o.name}</span>
                          <span className="text-[10px] text-mist-faint">{o.kindLabel}</span>
                        </div>
                        <div className="font-mono text-[10.5px] text-mist-faint">
                          {o.address.slice(0, 4)}…{o.address.slice(-4)}
                        </div>
                      </button>
                    ))}
                    {ctx.options.length === 0 && (
                      <p className="text-[11.5px] text-mist-faint">
                        未检测到 Solana 钱包，刷新页面或重新登录。
                      </p>
                    )}
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-mist/10 pt-2.5">
                    <span className="font-mono text-[11px] text-mist-dim">
                      SOL {ctx.solBal === null ? "…" : ctx.solBal.toFixed(3)}
                    </span>
                    <button
                      className="text-[11.5px] text-mist-dim hover:text-loss"
                      onClick={() => {
                        setOpen(false);
                        ctx.logout();
                      }}
                    >
                      退出登录
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
