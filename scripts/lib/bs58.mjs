// 极简 bs58（decode/encode），零依赖 —— 与 bs58 4.0.1 逐字节一致（已实测对照）。
// 用在 x402 路径：付款签名的 base58 文本 ↔ 64 字节种子（DepositRecord 的 PDA 种子），
// 以及审计时把记录里的 64 字节重新编码回交易签名。
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function decode(s) {
  let n = 0n;
  for (const c of s) {
    const v = MAP.get(c);
    if (v === undefined) throw new Error(`bad base58 char ${c}`);
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let lead = 0;
  for (const c of s) {
    if (c === "1") lead++;
    else break;
  }
  return new Uint8Array([...Array(lead).fill(0), ...bytes]);
}

export function encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  let lead = 0;
  for (const b of bytes) {
    if (b === 0) lead++;
    else break;
  }
  return "1".repeat(lead) + s;
}
