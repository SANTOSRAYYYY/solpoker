import type { Metadata } from "next";
import "./theme.css";
import "./globals.css";
import { Providers } from "./providers";
import { ErrorCatcher } from "@/components/error-catcher";

export const metadata: Metadata = {
  title: "SolPoker - 隐私扑克",
  description: "Solana 隐私扑克 | Solana privacy poker",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
        {/* ?debug=1 时的浮动诊断面板（放在根布局：段错误边界不会把它一起替换掉） */}
        <ErrorCatcher />
      </body>
    </html>
  );
}
