"use client";

// Thin helper layer over Privy's Solana wallet surface.
// Design refs: docs/design/stage1-design.md §13, §16.
//
// API verified against Privy v3.47.0 docs (2026-10-06):
// - hooks live in '@privy-io/react-auth/solana' (not the top-level package);
// - useWallets() lists embedded + external wallets, type ConnectedStandardSolanaWallet;
// - embedded wallet is identified by standardWallet.name === 'Privy';
// - useSignMessage().signMessage({ message: Uint8Array, wallet }) accepts raw
//   bytes (no UTF-8 requirement) and returns { signature: Uint8Array };
// - useSignTransaction().signTransaction({ transaction: Uint8Array, wallet })
//   accepts the encoded transaction and returns { signedTransaction: Uint8Array }.
//
// Remaining caveats tracked in README "待核实":
// - web3.js v1 serialized bytes round-trip with the latest SDK (recipe has a typo);
// - partial/multi-signer transactions are undocumented;
// - showWalletUIs: false may require an authorization policy (docs unclear).

import {
  useWallets,
  useSignMessage,
  useSignTransaction,
} from "@privy-io/react-auth/solana";
import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";

/**
 * The active Solana wallet from Privy, or null if none is connected.
 * Prefers the embedded wallet; falls back to the first connected external one.
 */
export function useSolanaWallet(): ConnectedStandardSolanaWallet | null {
  const { wallets } = useWallets();
  if (!wallets || wallets.length === 0) return null;
  return (
    wallets.find((w) => w.standardWallet.name === "Privy") ?? wallets[0] ?? null
  );
}

// ---------------------------------------------------------------------------
// 钱包选择器（2026-10-07 用户反馈）：Privy 会给 EVM 外部钱包派生一个 SVM 钱包
// ——那不是用户自己的 Solana 钱包。把全部连接的钱包列出来让用户选，默认优先
// 真 Solana 钱包（Phantom/Solflare/Backpack…），其次内嵌，最后 EVM 派生。
// ---------------------------------------------------------------------------

export type WalletKind = "embedded" | "solana" | "derived";

export interface WalletOption {
  address: string;
  name: string;
  kind: WalletKind;
  kindLabel: string;
  wallet: ConnectedStandardSolanaWallet;
}

const SOLANA_WALLET_NAMES = new Set([
  "Phantom",
  "Solflare",
  "Backpack",
  "Glow",
  "Slope",
  "Torus",
]);

export function classifyWallet(w: ConnectedStandardSolanaWallet): WalletKind {
  const name = w.standardWallet.name;
  if (name === "Privy") return "embedded";
  if (SOLANA_WALLET_NAMES.has(name)) return "solana";
  return "derived";
}

const KIND_LABEL: Record<WalletKind, string> = {
  embedded: "Privy 内嵌钱包",
  solana: "外部 Solana 钱包",
  derived: "EVM 派生 SVM（非你的 Solana 钱包）",
};

export function useWalletOptions(): WalletOption[] {
  const { wallets } = useWallets();
  return (wallets ?? []).map((w) => {
    const kind = classifyWallet(w);
    return {
      address: w.address,
      name: w.standardWallet.name,
      kind,
      kindLabel: KIND_LABEL[kind],
      wallet: w,
    };
  });
}

/** 默认选择：真 Solana 钱包 > 内嵌 > EVM 派生。 */
export function defaultWalletAddress(options: WalletOption[]): string | null {
  const rank: Record<WalletKind, number> = { solana: 0, embedded: 1, derived: 2 };
  const sorted = [...options].sort((a, b) => rank[a.kind] - rank[b.kind]);
  return sorted[0]?.address ?? null;
}

/**
 * Signs the L1 auth challenge (stage1-design.md §13) with the wallet.
 * The challenge is arbitrary 32-byte data from crypto.getRandomValues;
 * Privy accepts raw bytes. Returns the raw signature bytes.
 */
export function useSignChallenge() {
  const { signMessage } = useSignMessage();
  return async (
    wallet: ConnectedStandardSolanaWallet,
    bytes: Uint8Array
  ): Promise<Uint8Array> => {
    const { signature } = await signMessage({ message: bytes, wallet });
    return signature;
  };
}

/**
 * Signs an L1 (base-layer Solana) transaction through the Privy wallet —
 * e.g. sit_down / top_up. The caller builds the transaction with web3.js v1
 * (Anchor) and serializes it before passing it in. Returns the signed
 * serialized transaction bytes.
 *
 * 2026-10-07 实锤修复（读 SDK 源码确认）：solana 子包的 useSignTransaction
 * 默认 `chain: "solana:mainnet"`——Privy 会在错误的链上处理/预演我们的
 * devnet 交易，签名流程直接崩（用户点「坐下」即 Application error 的根因）。
 * 必须显式传 devnet。
 *
 * TODO (待核实): web3.js v1 bytes round-trip on the latest React SDK.
 */
export function useSignL1Transaction() {
  const { signTransaction } = useSignTransaction();
  return async (
    wallet: ConnectedStandardSolanaWallet,
    txBytes: Uint8Array
  ): Promise<Uint8Array> => {
    const { signedTransaction } = await signTransaction({
      transaction: txBytes,
      wallet,
      chain: "solana:devnet",
    } as Parameters<typeof signTransaction>[0]);
    // Defence: sign-only wallets return a raw 64-byte signature instead of a
    // full transaction; callers must detect length == 64 and attach the sig
    // themselves before broadcasting.
    return signedTransaction;
  };
}
