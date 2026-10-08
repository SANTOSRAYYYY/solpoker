// GitBook 式产品文档：内容模型。
// 每个块都用 { zh, en } 双语对描述，渲染器按当前语言取其一（内容即数据，无 JSX）。

export interface L {
  zh: string;
  en: string;
}

export type Block =
  | { t: "p"; c: L }
  | { t: "h2"; c: L }
  | { t: "h3"; c: L }
  | { t: "ul"; items: L[] }
  | { t: "ol"; items: L[] }
  | { t: "code"; text: string; caption?: L }
  | { t: "callout"; tone: "info" | "warn" | "mint"; title?: L; c: L }
  | { t: "table"; head: L[]; rows: L[][] }
  | { t: "links"; items: { href: string; label: L; note?: L; external?: boolean }[] }
  | { t: "cards"; items: { title: L; desc: L; badge?: L }[] };

export type GroupId = "start" | "trust" | "money" | "agents" | "more";

export interface DocPage {
  slug: string;
  group: GroupId;
  title: L;
  summary: L;
  /** 搜索关键词（两种语言都放，跨语言可搜到） */
  keywords?: string[];
  blocks: Block[];
}
