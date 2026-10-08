// 水龙头私钥材料解析（服务端专用）。
//
// 部署形态：
// - serverless（Vercel）：SOLPOKER_DEPLOYER_KEYPAIR 环境变量装 key 材料（JSON 数组或 base58）；
// - 本机 / 有状态主机：仍可从文件读（默认 ../keys/deployer.json，可用 SOLPOKER_DEPLOYER_KEYPAIR_PATH 指到别处）。
//
// base58 解码为零依赖极简实现（与 scripts/lib/bs58.mjs 同源，已与 bs58 4.0.1 逐字节对照）。

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function decodeBase58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = MAP.get(c);
    if (v === undefined) throw new Error(`bad base58 char: ${c}`);
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let lead = 0;
  for (const c of s) {
    if (c === "1") lead++;
    else break;
  }
  return Uint8Array.from([...new Array(lead).fill(0), ...bytes]);
}

/** 把「JSON 数组」或「base58」两种 key 材料统一解析成 64 字节私钥。 */
export function parseKeypairMaterial(raw: string): Uint8Array {
  const t = raw.trim();
  if (!t) throw new Error("empty key material");
  if (t.startsWith("[")) {
    const arr = JSON.parse(t) as number[];
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error(`expected a 64-byte JSON array, got ${Array.isArray(arr) ? arr.length : "?"}`);
    }
    return Uint8Array.from(arr);
  }
  const bytes = decodeBase58(t);
  if (bytes.length !== 64) {
    throw new Error(`base58 key decoded to ${bytes.length} bytes (expected 64)`);
  }
  return bytes;
}
