import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";

/**
 * 官方站外壳（落地页 `/` 专用）：不挂应用导航与钱包区 ——
 * 连接钱包发生在「进入大厅」之后。主题与 I18n/Privy Provider 在根布局全局加载。
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="room min-h-screen overflow-x-clip font-body text-mist">
      <SiteNav />
      {children}
      <SiteFooter />
    </div>
  );
}
