"use client";

// 文档内容渲染器：把 DocPage.blocks 按当前语言渲染（GitBook 风格的排版）。
// 锚点规则与 tocOf() 保持一致：h2/h3 的 id = `s-${块下标}`。

import Link from "next/link";
import { Badge } from "@/components/ui";
import type { Block, DocPage, L } from "@/lib/docs";
import { useI18n } from "@/lib/i18n";

export function DocBlocks({ page }: { page: DocPage }) {
  const { lang } = useI18n();
  const zh = lang === "zh";
  const T = (l: L) => (zh ? l.zh : l.en);

  return (
    <div>
      {page.blocks.map((b, i) => (
        <BlockView key={i} b={b} idx={i} zh={zh} T={T} />
      ))}
    </div>
  );
}

function BlockView({
  b,
  idx,
  zh,
  T,
}: {
  b: Block;
  idx: number;
  zh: boolean;
  T: (l: L) => string;
}) {
  switch (b.t) {
    case "h2":
      return (
        <h2
          id={`s-${idx}`}
          className="title-cn mt-9 mb-3 scroll-mt-20 text-[18px] text-mist"
        >
          {T(b.c)}
        </h2>
      );
    case "h3":
      return (
        <h3
          id={`s-${idx}`}
          className="title-cn mt-6 mb-2 scroll-mt-20 text-[14.5px] text-mist"
        >
          {T(b.c)}
        </h3>
      );
    case "p":
      return (
        <p className="mb-3.5 text-[13px] leading-relaxed text-mist-dim">{T(b.c)}</p>
      );
    case "ul":
      return (
        <ul className="mb-4 space-y-2">
          {b.items.map((it, k) => (
            <li key={k} className="flex gap-2.5 text-[13px] leading-relaxed text-mist-dim">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400/70" />
              <span>{T(it)}</span>
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="mb-4 space-y-2">
          {b.items.map((it, k) => (
            <li key={k} className="flex gap-2.5 text-[13px] leading-relaxed text-mist-dim">
              <span className="mt-[1px] shrink-0 font-mono text-[11.5px] text-accent-300">
                {String(k + 1).padStart(2, "0")}
              </span>
              <span>{T(it)}</span>
            </li>
          ))}
        </ol>
      );
    case "code":
      return (
        <div className="mb-5">
          <div className="code-box">
            <pre className="font-mono text-[11.5px] leading-relaxed text-mist-2">
              {b.text}
            </pre>
          </div>
          {b.caption && (
            <div className="mt-1.5 text-[11px] text-mist-faint">{T(b.caption)}</div>
          )}
        </div>
      );
    case "callout": {
      const tone =
        b.tone === "warn"
          ? "border-warn/30 bg-warn/8"
          : b.tone === "mint"
            ? "border-mint-500/30 bg-mint-500/6"
            : "border-cyanx-500/25 bg-cyanx-500/6";
      const dot = b.tone === "warn" ? "text-warn" : b.tone === "mint" ? "text-win" : "text-cyanx-300";
      return (
        <div className={`mb-5 rounded-xl border px-4 py-3 ${tone}`}>
          {b.title && (
            <div className={`mb-1 text-[12px] font-semibold ${dot}`}>{T(b.title)}</div>
          )}
          <p className="text-[12.5px] leading-relaxed text-mist-dim">{T(b.c)}</p>
        </div>
      );
    }
    case "table":
      return (
        <div className="panel mb-5 overflow-x-auto !p-0">
          <table className="w-full min-w-[520px] border-collapse text-left">
            <thead>
              <tr className="border-b border-mist/10">
                {b.head.map((h, k) => (
                  <th
                    key={k}
                    className="px-4 py-2.5 text-[11px] tracking-widest text-mist-faint uppercase"
                  >
                    {T(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri} className="border-b border-mist/6 last:border-0">
                  {r.map((c, ci) => (
                    <td
                      key={ci}
                      className={`px-4 py-2.5 align-top text-[12.5px] leading-relaxed ${
                        ci === 0 ? "text-mist-2" : "text-mist-dim"
                      }`}
                    >
                      {T(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "links":
      return (
        <div className="mb-5 flex flex-wrap gap-2">
          {b.items.map((l) =>
            l.href.startsWith("/") ? (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-md border border-accent-500/35 px-3 py-1.5 text-[11.5px] text-accent-200 transition-colors hover:bg-accent-500/10"
              >
                {T(l.label)} →
              </Link>
            ) : (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-accent-500/35 px-3 py-1.5 text-[11.5px] text-accent-200 transition-colors hover:bg-accent-500/10"
              >
                {T(l.label)} ↗
              </a>
            ),
          )}
        </div>
      );
    case "cards":
      return (
        <div className="mb-5 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {b.items.map((c, k) => (
            <div key={k} className="rail-quiet p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="title-cn text-[13px] text-mist">{T(c.title)}</div>
                {c.badge && (
                  <Badge tone="cyan" className="shrink-0">
                    {T(c.badge)}
                  </Badge>
                )}
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-mist-dim">{T(c.desc)}</p>
            </div>
          ))}
        </div>
      );
    default:
      return null;
  }
}
