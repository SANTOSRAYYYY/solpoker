"use client";

// TEE attestation + auth token flow (design stage1-design.md §13).
//
// - verifyTeeAttestation: same verification as the SDK's verifyTeeRpcIntegrity
//   (/quote endpoint, dcap-qvl collateral check, reportData == challenge), but
//   the 64-byte challenge comes from crypto.getRandomValues — the SDK uses
//   Math.random, which design §13 explicitly forbids.
// - getAuthToken: taken from the SDK directly; the challenge is server-issued
//   (no client RNG involved), so the Math.random concern does not apply.
//
// The token stays in memory only (React state); never persisted (Stage 0
// 遗留问题 4: tokens last ~30 days and gate access to private accounts).

import { getCollateral, verify, Quote } from "@phala/dcap-qvl";
import { getAuthToken as sdkGetAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PublicKey } from "@solana/web3.js";

// devnet-tee per context block v6; mainnet-tee when the time comes.
export const TEE_ENDPOINT = "https://devnet-tee.magicblock.app";

/**
 * Attestation gate: fetch a quote for a client-generated challenge and verify
 * the TDX collateral + that reportData echoes our challenge. Replicates
 * SDK verifyTeeRpcIntegrity with a CSPRNG challenge (§13).
 */
export async function verifyTeeAttestation(rpcUrl: string = TEE_ENDPOINT) {
  const challengeBytes = new Uint8Array(64);
  crypto.getRandomValues(challengeBytes);
  const challenge = bytesToBase64(challengeBytes);

  const response = await fetch(
    `${rpcUrl}/quote?challenge=${encodeURIComponent(challenge)}`
  );
  const body = await response.json();
  if (response.status !== 200 || !("quote" in body)) {
    throw new Error(body.error ?? "获取 TEE quote 失败");
  }

  const rawQuote = base64ToBytes(body.quote);
  const collateral = await getCollateral(
    "https://pccs.phala.network/tdx/certification/v4",
    rawQuote
  );
  const now = Math.floor(Date.now() / 1000);
  verify(rawQuote, collateral, now);
  const quote = Quote.parse(rawQuote);

  const td10 = quote.report.asTd10();
  const td15 = td10 ? null : quote.report.asTd15();
  const reportData = td10
    ? new Uint8Array(td10.reportData)
    : td15
      ? new Uint8Array(td15.base.reportData)
      : null;
  if (!reportData) throw new Error("不支持的 quote 报告格式");
  if (!bytesEqual(reportData, challengeBytes)) {
    throw new Error("quote reportData 与挑战不匹配");
  }
}

export interface TeeSession {
  token: string;
  expiresAt: number;
}

/**
 * Full §13 入场检查: attestation gate, then challenge-response auth with the
 * wallet's signMessage (raw bytes, Privy-verified API). Returns the TEE
 * session to keep in memory.
 */
export async function establishTeeSession(
  walletAddress: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  rpcUrl: string = TEE_ENDPOINT
): Promise<TeeSession> {
  await verifyTeeAttestation(rpcUrl);
  return sdkGetAuthToken(rpcUrl, new PublicKey(walletAddress), signMessage);
}

// --- base64 helpers that avoid Buffer (browser-safe) ---
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
