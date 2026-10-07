// MCP 冒烟客户端：以标准 MCP 客户端的方式驱动 mcp-server.mjs 打 2 手牌。
// 手写 JSON-RPC over stdio（顺便验证线级协议）；决策是「能过牌就过牌，否则跟注」
// 的最小脚本脑——本测试验证的是通道，不是策略。
// 用法: node scripts/agent/mcp-smoke.mjs <agentName> [table] [hands]
import { spawn } from "node:child_process";

const AGENT = process.argv[2] ?? "bob";
const TABLE = Number(process.argv[3] ?? 11);
const HANDS = Number(process.argv[4] ?? 2);

const child = spawn(process.execPath, ["scripts/agent/mcp-server.mjs"], {
  env: { ...process.env, SOLPOKER_AGENT: AGENT },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let nextId = 1;
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  for (;;) {
    const i = buf.indexOf("\n");
    if (i < 0) break;
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    } catch {}
  }
});

function call(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
const tool = async (name, args) => {
  const r = await call("tools/call", { name, arguments: args ?? {} });
  const text = r.content?.[0]?.text ?? "{}";
  if (r.isError) throw new Error(`${name} 工具错误: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
};

// ---- 1. 握手 ----
const init = await call("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "mcp-smoke", version: "0.1" },
});
console.log("initialize:", init.serverInfo.name, init.serverInfo.version);
notify("notifications/initialized");
const tools = await call("tools/list", {});
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

// ---- 2. 钱包与选桌 ----
console.log("wallet:", JSON.stringify(await tool("wallet_status")));
const tables = await tool("list_tables");
console.log("tables:", tables.map((t) => `#${t.table_id} ${t.kind} ${t.humans}h/${t.agents}a free=${t.free}`).join(" | "));

// ---- 3. 入座 ----
console.log("sit_down:", JSON.stringify(await tool("sit_down", { table: TABLE, buy_in: "20" })));
console.log("（等 crank take_seat…）");
await new Promise((r) => setTimeout(r, 6000));

// ---- 4. 打牌循环 ----
let hands = 0;
for (let step = 0; step < 400 && hands < HANDS; step++) {
  const t = await tool("wait_for_turn", { table: TABLE, timeout_ms: 20000 });
  if (t.status === "not_attached") { console.log("…not_attached:", t.reason); await new Promise((r) => setTimeout(r, 3000)); continue; }
  if (t.status === "waiting") { console.log("…waiting", t.phase, "hand", t.hand_id); continue; }
  if (t.status === "hand_ended") {
    hands++;
    console.log(`✔ 第 ${hands} 手结束 → 我的筹码 ${t.my_stack}`);
    continue;
  }
  if (t.status === "your_turn") {
    const action = BigInt(t.to_call) === 0n ? "check" : "call";
    const r = await tool("act", { table: TABLE, hand_id: t.hand_id, action_seq: t.action_seq, action });
    console.log(`act ${action} (hand#${t.hand_id} seq=${t.action_seq} pot=${t.pot} 剩 ${t.deadline_s}s) → ${r.ok ? "ok" : JSON.stringify(r)}`);
  }
}

// ---- 5. 离桌 ----
console.log("leave:", JSON.stringify(await tool("leave", { table: TABLE })));
child.kill();
console.log(`MCP_SMOKE_OK（${hands} 手）`);
process.exit(hands >= HANDS ? 0 : 1);
