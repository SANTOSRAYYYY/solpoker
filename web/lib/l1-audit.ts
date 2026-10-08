// L1 审计视图的客户端侧：调 /api/l1-audit（服务端拿 Helius key），并给出渲染辅助。
//
// 为什么不是浏览器直连 Helius：解析历史 API 需要 API key，而 key 绝不能进前端
// bundle（NEXT_PUBLIC_* 会被打包发布）。所以浏览器只跟自家路由说话。
import { useCallback, useEffect, useState } from "react";

export interface AuditItem {
  signature: string;
  slot: number;
  blockTime: number | null;
  accounts: string[];
  ix: string | null;
  label: string;
  kind: "game" | "per" | "other";
  amount: string | null;
  payer: string | null;
  fee: number | null;
  err: string | null;
}

export interface AuditView {
  source: "helius-parsed" | "raw-rpc";
  tableId: number;
  table: string;
  fetchedAt: number;
  items: AuditItem[];
}

export function useL1Audit(tableId: number | null, tick = 0) {
  const [view, setView] = useState<AuditView | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (tableId == null) return;
    let stop = false;
    setState("loading");
    fetch(`/api/l1-audit?table=${tableId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: AuditView) => {
        if (!stop) {
          setView(j);
          setState("done");
        }
      })
      .catch(() => {
        if (!stop) setState("error");
      });
    return () => {
      stop = true;
    };
  }, [tableId, tick, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { view, state, refresh };
}

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;

export const auditTone = (k: AuditItem["kind"]) =>
  k === "game" ? "mint" : k === "per" ? "plain" : "cyan";

/** tUSDC base units（6 位小数）→ 人类可读。 */
export const fmtAuditAmount = (raw: string | null): string | null => {
  if (!raw) return null;
  const n = BigInt(raw);
  if (n === 0n) return null;
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""}`;
};
