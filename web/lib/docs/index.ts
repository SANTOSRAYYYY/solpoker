// 文档注册表：数组顺序 = 导航顺序 = 上一页/下一页顺序。
import type { DocPage, GroupId, L } from "./types";
import { MONEY_PAGES } from "./content-money";
import { MORE_PAGES } from "./content-more";
import { START_PAGES } from "./content-start";
import { TRUST_PAGES } from "./content-trust";

export * from "./types";

export const DOC_GROUPS: { id: GroupId; title: L }[] = [
  { id: "start", title: { zh: "开始", en: "Getting started" } },
  { id: "trust", title: { zh: "隐私与可验证", en: "Privacy & verifiability" } },
  { id: "money", title: { zh: "资金", en: "Money" } },
  { id: "agents", title: { zh: "AI Agent", en: "AI agents" } },
  { id: "more", title: { zh: "更多", en: "More" } },
];

export const DOCS: DocPage[] = [
  ...START_PAGES,
  ...TRUST_PAGES,
  ...MONEY_PAGES,
  ...MORE_PAGES,
];

export function findDoc(slug: string[]): DocPage | undefined {
  const key = slug.join("/");
  return DOCS.find((d) => d.slug === key);
}

export function neighbors(page: DocPage): { prev?: DocPage; next?: DocPage } {
  const i = DOCS.indexOf(page);
  return { prev: i > 0 ? DOCS[i - 1] : undefined, next: i < DOCS.length - 1 ? DOCS[i + 1] : undefined };
}

/** 搜索：按标题 / 摘要 / 关键词匹配（两种语言都参与，英文查询也能命中中文页）。 */
export function searchDocs(q: string): DocPage[] {
  const s = q.trim().toLowerCase();
  if (!s) return DOCS;
  return DOCS.filter((d) =>
    [
      d.slug,
      d.title.zh,
      d.title.en,
      d.summary.zh,
      d.summary.en,
      ...(d.keywords ?? []),
    ]
      .join(" ")
      .toLowerCase()
      .includes(s),
  );
}

/** 页内目录：h2/h3 块 → 锚点（id = s-<块下标>，与渲染器一致）。 */
export function tocOf(page: DocPage): { id: string; text: L; level: 2 | 3 }[] {
  const out: { id: string; text: L; level: 2 | 3 }[] = [];
  page.blocks.forEach((b, i) => {
    if (b.t === "h2") out.push({ id: `s-${i}`, text: b.c, level: 2 });
    else if (b.t === "h3") out.push({ id: `s-${i}`, text: b.c, level: 3 });
  });
  return out;
}
