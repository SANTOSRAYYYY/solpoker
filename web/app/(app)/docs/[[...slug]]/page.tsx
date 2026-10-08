import type { Metadata } from "next";
import { DocsShell } from "@/components/docs-shell";
import { DOCS, findDoc } from "@/lib/docs";

type Params = { params: Promise<{ slug?: string[] }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const page = (slug?.length ?? 0) > 0 ? findDoc(slug ?? []) : DOCS[0];
  return {
    title: page ? `${page.title.zh} · SolPoker 文档` : "SolPoker · 产品文档",
    description: page?.summary.zh,
  };
}

/**
 * GitBook 式产品文档：/docs 与 /docs/<slug>（静态可预渲染）。
 * 主体是客户端组件（语言跟随全局 i18n 开关）。
 */
export default async function DocsRoute({ params }: Params) {
  const { slug } = await params;
  return <DocsShell slug={slug ?? []} />;
}
