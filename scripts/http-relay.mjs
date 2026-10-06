// Local HTTP->HTTPS relay with Host-header rewriting (dev tooling).
//
// Why this exists: the current dev machine reaches external hosts ONLY via the
// system HTTP proxy (direct TCP is reset; Solana's public RPC additionally
// rate-limits the proxy's shared exit IP with 429s). Tools that cannot speak
// HTTP-CONNECT (solana CLI, reqwest-based clients) point at this relay
// instead. The relay tunnels through the proxy, upgrades to TLS, and rewrites
// the Host header (public RPCs 403 on a mismatched Host). Handles HTTP/1.1
// keep-alive with Content-Length bodies (JSON-RPC use case).
//
// Proven endpoints (2026-10-06):
//   node scripts/http-relay.mjs 8898 rpc.magicblock.app         # L1 → http://127.0.0.1:8898/devnet
//   node scripts/http-relay.mjs 7799 devnet-tee.magicblock.app  # ER → http://127.0.0.1:7799?token=…
// rpc.magicblock.app/devnet has NO rate limiting (unlike api.devnet.solana.com
// through a shared proxy exit — that path was unusable for program deploys).
//
// Usage: node scripts/http-relay.mjs <listenPort> <targetHost> [proxyPort]
import net from "node:net";
import tls from "node:tls";

const listenPort = Number(process.argv[2]);
const targetHost = process.argv[3];
const proxyPort = Number(process.argv[4] ?? 10809);
if (!listenPort || !targetHost) {
  console.error("usage: node http-relay.mjs <listenPort> <targetHost> [proxyPort]");
  process.exit(1);
}

// Split a stream of HTTP/1.1 requests into messages {head, body} and call
// onMessage(head, body). Only supports Content-Length bodies (sufficient for
// JSON-RPC; no chunked-encoding client requests from solana CLI).
function makeRequestParser(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headEnd = buf.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      const head = buf.slice(0, headEnd + 4).toString("latin1");
      const m = /content-length:\s*(\d+)/i.exec(head);
      const bodyLen = m ? Number(m[1]) : 0;
      if (buf.length < headEnd + 4 + bodyLen) return;
      const body = buf.slice(headEnd + 4, headEnd + 4 + bodyLen);
      buf = buf.slice(headEnd + 4 + bodyLen);
      onMessage(head, body);
    }
  };
}

const server = net.createServer((client) => {
  const proxy = net.connect(proxyPort, "127.0.0.1", () => {
    proxy.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n\r\n`);
  });

  let secure = null;
  let connectBuf = Buffer.alloc(0);
  let ready = false;
  const pending = [];

  const forward = (head, body) => {
    const fixed = head
      .replace(/host:\s*[^\r\n]*/i, `Host: ${targetHost}`)
      .replace(/connection:\s*[^\r\n]*/i, "Connection: keep-alive");
    secure.write(fixed, "latin1");
    if (body.length) secure.write(body);
  };

  const parser = makeRequestParser((head, body) => {
    if (ready) forward(head, body);
    else pending.push([head, body]);
  });

  client.on("data", parser);

  proxy.on("data", (chunk) => {
    if (secure) return; // piping handles the rest
    connectBuf = Buffer.concat([connectBuf, chunk]);
    const idx = connectBuf.indexOf("\r\n\r\n");
    if (idx === -1) return;
    const head = connectBuf.slice(0, idx).toString();
    if (!/^HTTP\/1\.[01] 200/.test(head)) {
      client.destroy();
      proxy.destroy();
      return;
    }
    secure = tls.connect({ socket: proxy, servername: targetHost });
    secure.on("secureConnect", () => {
      secure.pipe(client);
      ready = true;
      for (const [h, b] of pending) forward(h, b);
      pending.length = 0;
    });
    secure.on("error", () => client.destroy());
  });

  proxy.on("error", () => client.destroy());
  client.on("error", () => {
    proxy.destroy();
    if (secure) secure.destroy();
  });
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`relay http://127.0.0.1:${listenPort} -> https://${targetHost} (Host rewritten) via proxy ${proxyPort}`);
});
