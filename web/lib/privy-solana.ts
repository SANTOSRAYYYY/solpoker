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
 * TODO (待核实): web3.js v1 bytes round-trip on the latest React SDK.
 * The official SPL recipe still uses web3.js v1 but has a typo; verify with a
 * real transaction before relying on this for sit_down.
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
    });
    // Defence: sign-only wallets return a raw 64-byte signature instead of a
    // full transaction; callers must detect length == 64 and attach the sig
    // themselves before broadcasting.
    return signedTransaction;
  };
}
