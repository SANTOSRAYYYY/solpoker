// §7 事件流存证：从 ER 交易日志重建一手的「规范行动事件流」。
//
// 程序在每次 act / claim_timeout 时 emit 一个 HandEventLog（disc：sha256("event:HandEventLog")[0..8]），
// Anchor 把它打成 "Program data: <base64>" 日志行。日志留在 ER 的交易历史里，
// 且这些事件的哈希已经被链进 street_end / transcript_final —— 所以日志被篡改是能被发现的。
//
// 用法（浏览器或 Node 均可，crypto 注入）：
//   const events = await fetchHandEvents(crypto, er, gamePda, handId, { limit: 400 });
//   // → [{ tag: 0|1, seat, kind, amount }]（按发生顺序）
//
// borsh 字段：hand_id(u64) seq(u32) event_tag(u8) seat(u8) kind(u8) amount(u64) = 23B

const DISCRIMINATOR_LEN = 8;
const BODY_LEN = 8 + 4 + 1 + 1 + 1 + 8;

/** "event:HandEventLog" 的 8 字节 discriminator（用注入的 crypto 现算，避免硬编码漂移）。 */
export async function handEventDiscriminator(crypto) {
  const d = await crypto.sha256(new TextEncoder().encode("event:HandEventLog"));
  return d.slice(0, DISCRIMINATOR_LEN);
}

const bytesEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function base64ToBytes(b64) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 抓取一张桌的 ER 交易历史，解出一手牌的规范行动事件流。
 * @param {object} crypto 注入的 crypto（webCrypto / nodeCrypto）
 * @param {Connection} er ER 连接（devnet-tee，公开账户免 token）
 * @param {PublicKey} gamePda 该桌的 Game PDA（act 交易都会触及它）
 * @param {number|bigint} handId 目标手号
 * @param {{limit?: number}} [opts]
 */
export async function fetchHandEvents(crypto, er, gamePda, handId, opts = {}) {
  const target = BigInt(handId);
  const disc = await handEventDiscriminator(crypto);
  const sigs = await er.getSignaturesForAddress(gamePda, { limit: opts.limit ?? 400 });
  const ordered = [...sigs].reverse(); // 旧 → 新

  const events = [];
  let scanned = 0;
  for (const info of ordered) {
    if (info.err) continue;
    let tx;
    try {
      tx = await er.getTransaction(info.signature, { maxSupportedTransactionVersion: 0 });
    } catch {
      continue;
    }
    scanned++;
    const logs = tx?.meta?.logMessages ?? [];
    for (const line of logs) {
      const idx = line.indexOf("Program data: ");
      if (idx < 0) continue;
      let raw;
      try {
        raw = base64ToBytes(line.slice(idx + "Program data: ".length).trim());
      } catch {
        continue;
      }
      if (raw.length !== DISCRIMINATOR_LEN + BODY_LEN) continue;
      if (!bytesEq(raw.slice(0, DISCRIMINATOR_LEN), disc)) continue;
      const b = raw.subarray(DISCRIMINATOR_LEN);
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const hid = dv.getBigUint64(0, true);
      if (hid !== target) {
        // 新→旧扫描时，出现更小的 hand_id 说明目标手的事件已经翻过去了
        if (hid < target) return { events, scanned, stoppedEarly: true };
        continue;
      }
      events.push({
        seq: dv.getUint32(8, true),
        tag: b[12],
        seat: b[13],
        kind: b[14],
        amount: dv.getBigUint64(15, true),
      });
    }
    // 一个 tx 内多条日志已按顺序加入；跨 tx 的顺序由 ordered 保证
  }
  return { events, scanned, stoppedEarly: false };
}
