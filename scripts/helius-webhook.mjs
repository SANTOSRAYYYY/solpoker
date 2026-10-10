// Helius Webhook 接收器 + SSE 中继（本地开发用，零依赖）。
//
// 链路：Helius webhook ──(公网隧道)──▶ 本服务 POST / ──SSE──▶ 浏览器（大厅/对局页）
//       浏览器 EventSource 收到事件 → 立即重新拉一次状态（平时靠轮询兜底）
//
// 为什么只对 L1 有用：**Helius 是 L1 索引器，看不到 ER（devnet-tee）上的交易**
// （2026-10-08 实测：helius 与 ER 的签名零交集）。所以：
//   - 本服务推的是 **L1 活动**：sit_down / cash_out / top_up / commit（状态回写）/
//     delegate / create_table / register_agent 等；
//   - 牌局内的实时状态（Game on ER）仍然由页面轮询 ER，不受本服务影响。
//
// 用法:
//   node scripts/helius-webhook.mjs                 # 监听 8787
//   node scripts/helius-webhook.mjs --port 9000
//   本地端到端验证（无需隧道）:
//     curl -X POST http://127.0.0.1:8787/simulate -d '{"signature":"TESTSIG","description":"simulated sit_down"}'
//
// Helius 控制台建 webhook（主网/Devnet → Webhooks → Add Webhook）:
//   Webhook URL: https://<你的隧道域名>/           （ngrok http 8787 / cloudflared tunnel --url ...）
//   Transaction Types: Any（或只勾 Transfer/等；程序自定义指令会以 UNKNOWN 形式到达）
//   Account Addresses: 程序 ID 或你想盯的桌子/账户地址
//   Webhook Type: enhanced（推荐，字段更好读）或 raw
// 保存后会发一条测试 POST，本服务会打印出来。

import http from "node:http";

const portArgIdx = process.argv.indexOf("--port");
const PORT = portArgIdx >= 0 ? Number(process.argv[portArgIdx + 1]) : 8787;

/** @type {Set<import("node:http").ServerResponse>} */
const clients = new Set();
let received = 0;

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
  return clients.size;
}

/** 从 Helius（enhanced 或 raw）payload 里榨出"够用"的摘要。 */
function summarize(body) {
  const txs = Array.isArray(body) ? body : body?.transactions ?? [body];
  const out = [];
  for (const tx of txs) {
    if (!tx || typeof tx !== "object") continue;
    const signature = tx.signature ?? tx.transaction?.signatures?.[0] ?? null;
    const description = tx.description ?? tx.type ?? "L1 活动";
    // 相关账户：enhanced 给 accountData/instructions，raw 给 message.accountKeys
    const accounts = new Set();
    for (const ad of tx.accountData ?? []) if (ad?.account) accounts.add(ad.account);
    for (const ix of tx.instructions ?? []) {
      if (Array.isArray(ix?.accounts)) for (const a of ix.accounts) if (typeof a === "string") accounts.add(a);
      if (ix?.programId) accounts.add(ix.programId);
    }
    for (const k of tx.transaction?.message?.accountKeys ?? []) {
      accounts.add(typeof k === "string" ? k : k?.pubkey);
    }
    out.push({
      signature,
      description,
      slot: tx.slot ?? null,
      accounts: [...accounts].filter(Boolean).slice(0, 24),
    });
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  // CORS：浏览器从 3100 连过来
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // SSE 流：浏览器订阅
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`retry: 3000\n\n`);
    res.write(`data: ${JSON.stringify({ type: "hello", ts: Date.now() })}\n\n`);
    clients.add(res);
    console.log(`[sse] 客户端接入（当前 ${clients.size}）`);
    const ka = setInterval(() => {
      try {
        res.write(`: keep-alive\n\n`);
      } catch {
        clearInterval(ka);
      }
    }, 20000);
    req.on("close", () => {
      clearInterval(ka);
      clients.delete(res);
      console.log(`[sse] 客户端断开（当前 ${clients.size}）`);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, clients: clients.size, received }));
    return;
  }

  // Helius webhook / 本地模拟：同一个处理路径
  if (req.method === "POST" && (url.pathname === "/" || url.pathname === "/simulate")) {
    // 2026-10-10（审计 L3）：正式 webhook 需要共享密钥（WEBHOOK_SECRET，
    // 通过 x-webhook-secret 头携带）；未配置时只接受本地模拟端点。
    const secret = process.env.WEBHOOK_SECRET;
    if (secret) {
      if ((req.headers["x-webhook-secret"] ?? "") !== secret) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
    } else if (url.pathname !== "/simulate") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "WEBHOOK_SECRET 未设置，拒绝外部 webhook" }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received++;
      let body = null;
      try {
        body = JSON.parse(raw || "null");
      } catch {
        body = { signature: null, description: raw.slice(0, 120) };
      }
      const txs = summarize(body);
      const n = broadcast({ type: "l1-activity", source: url.pathname === "/simulate" ? "simulate" : "helius", txs });
      console.log(
        `[in] ${url.pathname === "/simulate" ? "simulate" : "helius"} → ${txs.length} 笔` +
          ` (${txs.map((t) => (t.signature ?? "?").slice(0, 10)).join(",")}) → 广播给 ${n} 个客户端`
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, txs: txs.length, clients: n }));
    });
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`helius-webhook 监听 http://127.0.0.1:${PORT}`);
  console.log(`  SSE:      GET  http://127.0.0.1:${PORT}/events`);
  console.log(`  健康检查: GET  http://127.0.0.1:${PORT}/health`);
  console.log(`  本地模拟: POST http://127.0.0.1:${PORT}/simulate`);
  console.log(`在 Helius 控制台把 Webhook URL 指向 <隧道>${"/"}（ngrok http ${PORT}）即可接真实事件。`);
});
