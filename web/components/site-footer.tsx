"use client";

// 官方站页脚：产品入口（Platform）+ 资源（Resources）+ 测试网诚实声明。

import Link from "next/link";
import { SolMark } from "@/components/ui";
import { PROGRAM_ID } from "@/lib/config";
import { useI18n } from "@/lib/i18n";

const REPO = "https://github.com/SANTOSRAYYYY/solpoker";

export function SiteFooter() {
  const { lang } = useI18n();
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);

  const platform = [
    { href: "/lobby", zh: "大厅", en: "Lobby" },
    { href: "/agents", zh: "我的 Agent", en: "My Agents" },
    { href: "/history", zh: "手牌验证", en: "Hand history" },
    { href: "/trust", zh: "信任模型", en: "Trust model" },
  ];
  const resources = [
    { href: REPO, zh: "GitHub 源码", en: "GitHub" },
    { href: `${REPO}/blob/main/docs/dealing-protocol.zh.md`, zh: "发牌协议", en: "Dealing protocol" },
    { href: `${REPO}/blob/main/docs/runbook-testnet.md`, zh: "运维手册", en: "Operator runbook" },
    {
      href: `https://solscan.io/account/${PROGRAM_ID.toBase58()}?cluster=devnet`,
      zh: "程序账户",
      en: "Program account",
    },
  ];

  return (
    <footer className="border-t border-mist/8 bg-black/25">
      <div className="mx-auto max-w-[1200px] px-4 py-10 sm:px-6">
        <div className="flex flex-wrap gap-x-16 gap-y-8">
          <div className="max-w-[300px]">
            <div className="flex items-center gap-2.5">
              <SolMark size={24} />
              <span className="text-brand text-[17px] font-bold tracking-wide">SolPoker</span>
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-mist-faint">
              {L(
                "隐私德州扑克：底牌在 TEE 内解密，发牌由 VRF 与双方盐锁定，每一手都可在链上复算。",
                "Private Texas Hold'em: cards decrypt in a TEE, the deal is locked by VRF and both salts, and every hand is recomputable on-chain."
              )}
            </p>
          </div>

          <div>
            <div className="title-cn mb-3 text-[12px] text-mist-dim">
              {L("产品", "Platform")}
            </div>
            <ul className="space-y-2">
              {platform.map((x) => (
                <li key={x.href}>
                  <Link href={x.href} className="text-[12.5px] text-mist-dim hover:text-mist">
                    {L(x.zh, x.en)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="title-cn mb-3 text-[12px] text-mist-dim">
              {L("资源", "Resources")}
            </div>
            <ul className="space-y-2">
              {resources.map((x) => (
                <li key={x.href}>
                  <a
                    href={x.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12.5px] text-mist-dim hover:text-mist"
                  >
                    {L(x.zh, x.en)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-9 flex flex-wrap items-center justify-between gap-3 border-t border-mist/8 pt-5 text-[11px] text-mist-faint">
          <span>
            {L(
              "运行于 Solana devnet + MagicBlock devnet-tee，使用测试币 tUSDC —— 不承载真实价值。",
              "Runs on Solana devnet + MagicBlock devnet-tee with test tUSDC — it carries no real value."
            )}
          </span>
          <span className="font-mono">© 2026 SolPoker · devnet-tee</span>
        </div>
      </div>
    </footer>
  );
}
