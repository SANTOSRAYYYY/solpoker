import type { Metadata } from "next";
import { AppNav } from "@/components/app-nav";
import { ErrorCatcher } from "@/components/error-catcher";
import { WalletProvider } from "@/components/wallet-context";

export const metadata: Metadata = {
  title: "SolPoker · 隐私德扑",
  description:
    "Solana 隐私德州扑克：底牌在 TEE 内解密，VRF + 双方盐发牌，链上可复算",
};

/**
 * 真实页面（大厅 / 对局 / Agent / 手牌验证 / 信任）的公共外壳。
 * 主题（Tailwind + 设计系统）在根布局的 app/theme.css 里全局加载。
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <div className="room min-h-screen overflow-x-clip font-body text-mist">
        <AppNav />
        {children}
        <ErrorCatcher />
      </div>
    </WalletProvider>
  );
}
