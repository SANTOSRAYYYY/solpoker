// 凭据脱敏（2026-10-10 审计 L4）：ER 的 TEE token 以查询串形式拼在 RPC URL 里
// （`?token=…`），任何把 RPC 异常原文渲染到屏幕/日志的路径都可能把它带出来。
// 展示前统一过一遍这个函数。
export function redactSecrets(s: string): string {
  return s
    .replace(/([?&]token=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/(api-key=)[^&\s"']+/gi, "$1<redacted>");
}
