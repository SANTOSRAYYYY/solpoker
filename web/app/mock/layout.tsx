import type { Metadata } from "next";
import { MockNav } from "./nav";

export const metadata: Metadata = {
  title: "SolPoker · 视觉稿",
  description: "Solana 品牌配色的 UI 视觉稿（不影响现网页面）",
};

export default function MockLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 主题（Tailwind + 设计系统）由根布局的 app/theme.css 统一提供。
  // overflow-x-clip：裁掉横向溢出但**不**建立滚动容器
  // （overflow-x-hidden 会把容器变成滚动容器，破坏子元素的 position:sticky）
  return (
    <div className="room min-h-screen overflow-x-clip font-body text-mist">
      <MockNav />
      {children}
    </div>
  );
}
