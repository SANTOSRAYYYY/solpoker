// Per-seat session keys (design §12 / D2 / X10): generated in the browser,
// authorized once by the wallet in sit_down, then used to sign ER action
// transactions (commit_salt / reveal_salt / act / stand_up) without a wallet
// popup per move. Persisted in localStorage (devnet demo convenience).

import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

const keyOf = (tableId: number, seat: number, wallet: string) =>
  `solpoker:session:${tableId}:${seat}:${wallet}`;

export function loadOrCreateSessionKey(
  tableId: number,
  seat: number,
  wallet: string
): Keypair {
  try {
    // 2026-10-10（审计 M1）：会话私钥改存 sessionStorage（关浏览器即清），
    // 并顺手清掉历史遗留的 localStorage 副本（明文私钥不进持久存储）。
    localStorage.removeItem(keyOf(tableId, seat, wallet));
    const raw = sessionStorage.getItem(keyOf(tableId, seat, wallet));
    if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    // fall through: regenerate
  }
  const kp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
  try {
    sessionStorage.setItem(
      keyOf(tableId, seat, wallet),
      JSON.stringify(Array.from(kp.secretKey))
    );
  } catch {
    // storage full/denied: session key lives in memory only this run
  }
  return kp;
}

/** 离座/兑现后清掉该座位的会话私钥与全部盐（审计 M1：收缩被发现后的可用窗口）。 */
export function clearSeatSecrets(tableId: number, seat: number, wallet: string) {
  const key = keyOf(tableId, seat, wallet);
  try {
    localStorage.removeItem(key); // 历史遗留（旧版本写进 localStorage）
    sessionStorage.removeItem(key);
    const prefix = `solpoker:salt:${tableId}:`;
    const suffix = `:${seat}:${wallet}`;
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(prefix) && k.endsWith(suffix)) sessionStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

// Salt per (table, hand, seat) — sessionStorage so a refresh mid-hand keeps
// the reveal possible (same rule as the e2e's keys/test-salts-*.json).
const saltKey = (tableId: number, handId: string, seat: number, wallet: string) =>
  `solpoker:salt:${tableId}:${handId}:${seat}:${wallet}`;

export function loadOrCreateSalt(
  tableId: number,
  handId: bigint,
  seat: number,
  wallet: string
): Uint8Array {
  const k = saltKey(tableId, handId.toString(), seat, wallet);
  try {
    const raw = sessionStorage.getItem(k);
    if (raw) return Uint8Array.from(JSON.parse(raw));
  } catch {
    // regenerate below
  }
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  try {
    sessionStorage.setItem(k, JSON.stringify(Array.from(salt)));
  } catch {
    // memory-only fallback
  }
  return salt;
}

export async function saltCommitment(
  table: Uint8Array,
  handId: bigint,
  player: Uint8Array,
  salt: Uint8Array
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const handIdBe = new Uint8Array(8);
  new DataView(handIdBe.buffer).setBigUint64(0, handId, false);
  const parts = [enc.encode("solpoker/salt/v1"), table, handIdBe, player, salt];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(digest);
}
