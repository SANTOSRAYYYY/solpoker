"use client";

// GitBook 式文档外壳：左侧目录（含搜索）+ 正文（含页内目录与上一页/下一页）。
// 内容语言跟随全局 i18n 开关（应用导航右上角）。

import Link from "next/link";
import { useMemo, useState } from "react";
import { DocBlocks } from "@/components/doc-blocks";
import {
  DOC_GROUPS,
  DOCS,
  findDoc,
  neighbors,
  searchDocs,
  tocOf,
  type L,
} from "@/lib/docs";
import { useI18n } from "@/lib/i18n";

export function DocsShell({ slug }: { slug: string[] }) {
  const { lang } = useI18n();
  const zh = lang === "zh";
  const T = (l: L) => (zh ? l.zh : l.en);

  // /docs 根路径 = 文档首页（第一页，Introduction）
  const page = slug.length > 0 ? findDoc(slug) : DOCS[0];
  const [q, setQ] = useState("");
  const [drawer, setDrawer] = useState(false);
  const hits = useMemo(() => searchDocs(q), [q]);

  if (!page) {
    return (
      <main className="mx-auto max-w-[900px] px-4 py-16 text-center">
        <div className="title-cn text-[20px] text-mist">
          {zh ? "找不到这一页" : "Page not found"}
        </div>
        <p className="mt-2 text-[13px] text-mist-dim">
          {zh
            ? "文档目录里没有这个地址 —— 也许它改名了。"
            : "No such page in these docs — it may have moved."}
        </p>
        <Link
          href="/docs"
          className="btn-casino btn-brand mt-6 inline-flex px-5 py-2 text-[13px]"
        >
          {zh ? "回到文档首页" : "Back to docs"}
        </Link>
      </main>
    );
  }

  const toc = tocOf(page);
  const { prev, next } = neighbors(page);
  const group = DOC_GROUPS.find((g) => g.id === page.group);

  return (
    <div className="mx-auto flex max-w-[1280px] gap-9 px-4 py-6 sm:px-5">
      {/* 移动端：目录抽屉 */}
      <button
        onClick={() => setDrawer(true)}
        className="btn-casino btn-glass fixed right-5 bottom-5 z-40 px-4 py-2 text-[12px] lg:hidden"
      >
        ☰ {zh ? "目录" : "Contents"}
      </button>
      {drawer && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setDrawer(false)}
        />
      )}

      {/* 左侧目录 */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-[290px] shrink-0 overflow-y-auto border-r border-mist/10 bg-[#08080f] p-4 transition-transform duration-300 lg:sticky lg:top-[4.2rem] lg:z-0 lg:h-[calc(100vh-5.5rem)] lg:translate-x-0 lg:border-r-0 lg:bg-transparent lg:p-0 ${
          drawer ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="title-cn text-[14px] text-mist">{zh ? "产品文档" : "Documentation"}</span>
          <span className="badge badge-plain font-mono !text-[10px]">v devnet</span>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={zh ? "搜索文档…" : "Search docs…"}
          className="mb-4 w-full rounded-lg border border-mist/12 bg-black/30 px-3 py-2 text-[12.5px] text-mist transition-colors placeholder:text-mist-faint focus:border-accent-500/50 focus:outline-none"
        />

        {DOC_GROUPS.map((g) => {
          const items = hits.filter((d) => d.group === g.id);
          if (items.length === 0) return null;
          return (
            <div key={g.id} className="mb-4">
              <div className="mb-1.5 text-[10px] tracking-[0.24em] text-mist-faint uppercase">
                {T(g.title)}
              </div>
              <ul className="space-y-0.5">
                {items.map((d) => {
                  const active = d.slug === page.slug;
                  return (
                    <li key={d.slug}>
                      <Link
                        href={`/docs/${d.slug}`}
                        onClick={() => setDrawer(false)}
                        aria-current={active}
                        className={`block rounded-md px-2.5 py-1.5 text-[12.5px] transition-colors ${
                          active
                            ? "bg-accent-500/12 text-accent-200"
                            : "text-mist-dim hover:bg-mist/6 hover:text-mist"
                        }`}
                      >
                        {T(d.title)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        {hits.length === 0 && (
          <div className="text-[12px] text-mist-faint">
            {zh ? "没有匹配的页面" : "No matching pages"}
          </div>
        )}

        <Link
          href="/lobby"
          className="btn-casino btn-brand mt-1 flex w-full items-center justify-center px-4 py-2 text-[12.5px]"
        >
          {zh ? "进入大厅" : "Enter the lobby"}
        </Link>
      </aside>

      {/* 正文 */}
      <main className="min-w-0 flex-1">
        <nav className="mb-3 flex items-center gap-1.5 text-[11.5px] text-mist-faint">
          <Link href="/docs" className="transition-colors hover:text-mist-dim">
            {zh ? "文档" : "Docs"}
          </Link>
          <span>/</span>
          <span>{group ? T(group.title) : ""}</span>
        </nav>

        <h1 className="title-cn text-[24px] text-mist">{T(page.title)}</h1>
        <p className="mt-2 mb-7 max-w-[740px] text-[13px] leading-relaxed text-mist-dim">
          {T(page.summary)}
        </p>

        <article className="max-w-[800px]">
          <DocBlocks page={page} />
        </article>

        {/* 上一页 / 下一页 */}
        <div className="mt-12 flex flex-wrap gap-3 border-t border-mist/10 pt-5">
          {prev ? (
            <Link
              href={`/docs/${prev.slug}`}
              className="panel flex-1 p-3.5 transition-colors hover:border-accent-500/40"
            >
              <div className="text-[10.5px] text-mist-faint">← {zh ? "上一页" : "Previous"}</div>
              <div className="title-cn mt-0.5 text-[13px] text-mist-2">{T(prev.title)}</div>
            </Link>
          ) : (
            <span className="flex-1" />
          )}
          {next && (
            <Link
              href={`/docs/${next.slug}`}
              className="panel flex-1 p-3.5 text-right transition-colors hover:border-accent-500/40"
            >
              <div className="text-[10.5px] text-mist-faint">{zh ? "下一页" : "Next"} →</div>
              <div className="title-cn mt-0.5 text-[13px] text-mist-2">{T(next.title)}</div>
            </Link>
          )}
        </div>
      </main>

      {/* 页内目录（宽屏） */}
      {toc.length > 1 && (
        <nav className="hidden w-[190px] shrink-0 xl:block">
          <div className="sticky top-[4.2rem]">
            <div className="mb-2 text-[10px] tracking-[0.24em] text-mist-faint uppercase">
              {zh ? "本页目录" : "On this page"}
            </div>
            <ul className="space-y-1">
              {toc.map((t) => (
                <li key={t.id} className={t.level === 3 ? "pl-3" : ""}>
                  <a
                    href={`#${t.id}`}
                    className="block text-[11.5px] leading-snug text-mist-dim transition-colors hover:text-mist"
                  >
                    {T(t.text)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      )}
    </div>
  );
}
