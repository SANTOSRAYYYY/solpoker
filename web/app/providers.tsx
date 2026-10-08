"use client";

// Privy 接入——严格照抄官方 Solana recipe
// (docs.privy.io/recipes/solana/getting-started-with-privy-and-solana)：
// - loginMethods: ['wallet', 'email']
// - appearance.showWalletLoginFirst + walletChainType: 'solana-only'
// - externalWallets.solana.connectors = toSolanaWalletConnectors()
// - embeddedWallets.solana.createOnLogin（3.47.0 类型确认 per-chain 合法）
// - solana.rpcs（官方说明：仅嵌入式钱包 UI 流程需要；devnet 替换 mainnet
//   是本项目要求，其余字段与 recipe 逐字一致）

import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { I18nProvider } from "@/lib/i18n";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_WS = "wss://api.devnet.solana.com";

/** 未配置 app ID 时页面框架仍可构建渲染（钱包功能不可用）。 */
export const PRIVY_CONFIGURED = PRIVY_APP_ID.length > 0;

export function Providers({ children }: { children: React.ReactNode }) {
  if (!PRIVY_CONFIGURED) {
    return (
      <I18nProvider>
        <div className="config-banner">
          未配置 NEXT_PUBLIC_PRIVY_APP_ID — 钱包功能不可用（见 web/README.md）
        </div>
        {children}
      </I18nProvider>
    );
  }
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["wallet", "email"],
        appearance: {
          theme: "dark",
          accentColor: "#9945FF",
          showWalletLoginFirst: true,
          // 与后台配置一致（2026-10-07 用户开启后）：服务端 solana_wallet_auth
          // = true、wallet_auth（EVM）= false → 弹窗只列 Solana 钱包。官方
          // recipe 同样是 solana-only。
          walletChainType: "solana-only",
        },
        externalWallets: {
          solana: {
            connectors: toSolanaWalletConnectors(),
          },
        },
        embeddedWallets: {
          solana: {
            createOnLogin: "users-without-wallets",
          },
        },
        solana: {
          rpcs: {
            "solana:devnet": {
              rpc: createSolanaRpc(DEVNET_RPC),
              rpcSubscriptions: createSolanaRpcSubscriptions(DEVNET_WS),
            },
          },
        },
      }}
    >
      <I18nProvider>{children}</I18nProvider>
    </PrivyProvider>
  );
}
