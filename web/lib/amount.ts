// 金额输入解析：返回 null 表示非法输入（绝不让 BigInt(NaN) 进事件处理器）。
export function parseUsdcInput(text: string): bigint | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * 1e6));
}
