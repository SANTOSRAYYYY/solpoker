"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Badge, Dot, SolMark } from "./ui";

const NAV = [
  { href: "/mock/lobby", zh: "大厅", en: "LOBBY" },
  { href: "/mock/table", zh: "对局", en: "TABLE" },
  { href: "/mock/agents", zh: "我的 Agent", en: "AGENTS" },
  { href: "/mock/history", zh: "手牌验证", en: "HISTORY" },
  { href: "/mock/trust", zh: "信任", en: "TRUST" },
];

export function MockNav() {
  const path = usePathname();
  const [lang, setLang] = useState<"zh" | "en">("zh");

  return (
    <header className="sticky top-0 z-50 border-b border-accent-500/30 bg-[#08080f]/92 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-[1180px] items-center gap-3 px-3 sm:gap-5 sm:px-5">
        <Link href="/mock/lobby" className="flex shrink-0 items-center gap-2.5">
          <SolMark size={26} />
          <span className="text-brand text-[18px] font-bold tracking-wide sm:text-[19px]">
            SolPoker
          </span>
          <Badge tone="danger" className="ml-1 hidden lg:inline-flex">
            视觉稿 MOCK
          </Badge>
        </Link>

        <nav className="no-bar flex flex-1 items-center gap-0.5 overflow-x-auto">
          {NAV.map((n) => {
            const active = path.startsWith(n.href);
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
          {/* 中英切换（正式版接线 i18n；此处为视觉演示） */}
          <div className="flex overflow-hidden rounded-full border border-accent-500/35">
            {(["zh", "en"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={`px-2.5 py-1 text-[11px] font-semibold tracking-wider uppercase transition-colors ${
                  lang === l
                    ? "bg-accent-500/25 text-accent-200"
                    : "text-mist-faint hover:text-mist-dim"
                }`}
              >
                {l}
              </button>
            ))}
          </div>

          {/* 钱包胶囊（演示） */}
          <span className="hidden items-center gap-2 rounded-full border border-accent-500/30 bg-black/30 px-3 py-1.5 md:flex">
            <Dot kind="live" />
            <span className="font-mono text-[11px] text-mist-2">7xKX…9fQm</span>
            <span className="font-mono text-[11px] text-accent-300">42.50</span>
          </span>

          <Link
            href="/"
            className="hidden rounded-full border border-accent-500/30 px-3 py-1.5 text-[11px] text-mist-dim transition-colors hover:text-mist lg:block"
          >
            现网版 →
          </Link>
        </div>
      </div>
    </header>
  );
}
