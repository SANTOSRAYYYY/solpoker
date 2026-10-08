"use client";

// 官方站导航（落地页专用）：品牌 + 页内锚点 + 语言切换 + 主入口「进入大厅」。
// 与应用内导航（app-nav）分开：这里不挂钱包区，连接钱包发生在进入大厅之后。

import Link from "next/link";
import { SolMark } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

const ANCHORS: { href: string; zh: string; en: string }[] = [
  { href: "#why", zh: "为什么", en: "Why" },
  { href: "#how", zh: "怎么玩", en: "How" },
  { href: "#fair", zh: "公平性", en: "Fairness" },
  { href: "#agents", zh: "AI Agent", en: "Agents" },
  { href: "#faq", zh: "常见问题", en: "FAQ" },
];

/** 站内页面链接（锚点之外）：信任模型 / 产品文档。 */
const LINKS: { href: string; zh: string; en: string }[] = [
  { href: "/trust", zh: "信任", en: "Trust" },
  { href: "/docs", zh: "产品文档", en: "Docs" },
];

export function SiteNav() {
  const { lang, setLang, t } = useI18n();
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);

  return (
    <header className="sticky top-0 z-50 border-b border-accent-500/30 bg-[#08080f]/92 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-3 px-3 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <SolMark size={26} />
          <span className="text-brand hidden text-[18px] font-bold tracking-wide sm:inline">
            SolPoker
          </span>
          <span className="badge badge-plain ml-1 hidden font-mono lg:inline-flex">
            devnet-tee
          </span>
        </Link>

        <nav className="no-bar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {ANCHORS.map((a) => (
            <a
              key={a.href}
              href={a.href}
              className="title-cn shrink-0 rounded-md px-1.5 py-2 text-[12px] text-mist-dim transition-colors hover:text-mist sm:px-2 sm:text-[12.5px]"
            >
              {L(a.zh, a.en)}
            </a>
          ))}
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="title-cn shrink-0 rounded-md px-1.5 py-2 text-[12px] text-accent-200 transition-colors hover:text-mist sm:px-2 sm:text-[12.5px]"
            >
              {L(l.zh, l.en)}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
          <button
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
            title={t("lang.toggleTitle")}
            aria-label={t("lang.toggleTitle")}
            className="rounded-full border border-accent-500/30 bg-black/30 px-2.5 py-1.5 font-mono text-[11px] text-accent-200 hover:border-accent-500/60"
          >
            {t("lang.toggle")}
          </button>
          <Link href="/lobby" className="btn-casino btn-brand px-4 py-1.5 text-[12.5px]">
            {L("进入大厅", "Play now")}
          </Link>
        </div>
      </div>
    </header>
  );
}
