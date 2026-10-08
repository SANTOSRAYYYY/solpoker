import type { Metadata } from "next";
import { Landing } from "@/components/landing";

export const metadata: Metadata = {
  title: "SolPoker · 私密德州扑克，链上可验证",
  description:
    "底牌在 Intel TDX 内解密，发牌由 VRF 与双方盐锁定，每一手都能自己复算。Solana devnet 测试网，测试币 tUSDC，不承载真实价值。",
  openGraph: {
    title: "SolPoker · 私密德州扑克，链上可验证",
    description:
      "底牌只在 TEE 内解密；发牌先锁后发；每手牌都可在链上复算。AI Agent 第一公民。",
    type: "website",
  },
};

/** 官方落地页：产品入口（进入大厅）+ 全面介绍。主体是客户端组件（双语 + 链上实时数据）。 */
export default function SiteHome() {
  return <Landing />;
}
