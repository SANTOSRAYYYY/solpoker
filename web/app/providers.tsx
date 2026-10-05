"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

// Design refs: docs/design/stage1-design.md §13, §16.
// Config verified against Privy v3.47.0 docs (2026-10-06):
// - embeddedWallets.solana.createOnLogin is per-chain (moved in v3);
// - solana.rpcs only needed for embedded-wallet UI flows; we supply devnet
//   endpoints because the project targets Solana devnet (see context block v6).
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_WS = "wss://api.devnet.solana.com";

/**
 * Whether a Privy app ID is configured. Pages and hooks use this to decide
 * whether wallet functionality is available; without an ID the scaffold still
 * builds and renders chrome.
 */
export const PRIVY_CONFIGURED = PRIVY_APP_ID.length > 0;

export function Providers({ children }: { children: React.ReactNode }) {
  // Scaffold path: without a real app ID, render the page chrome without the
  // Privy provider so builds and design review work. Production and any real
  // dev run must set NEXT_PUBLIC_PRIVY_APP_ID.
  if (!PRIVY_CONFIGURED) {
    return (
      <>
        <div className="config-banner">
          未配置 NEXT_PUBLIC_PRIVY_APP_ID — 钱包功能不可用（见 web/README.md）
        </div>
        {children}
      </>
    );
  }
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
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
      {children}
    </PrivyProvider>
  );
}
