// probe-helius-parse — 探测 Helius Enhanced Transactions（解析历史）对我们程序的
// 返回形状，用来决定「L1 审计视图」怎么建。只读，不写链。
//
// 用法: node scripts/probe-helius-parse.mjs [tableId=14]
// key 从 web/.env.local 的 HELIUS_RPC 提取（绝不硬编码）。
import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { envValue } from "./env.mjs";

const id = Number(process.argv[2] ?? 14);
const keyed = envValue("HELIUS_RPC", "");
if (!keyed.includes("api-key=")) {
  console.error("缺少 HELIUS_RPC（web/.env.local）");
  process.exit(1);
}
const base = new URL(keyed).origin;
const apiKey = new URL(keyed).searchParams.get("api-key");
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];

const table = pda([Buffer.from("table"), u32le(id)]);
const seats = Array.from({ length: 9 }, (_, i) => pda([Buffer.from("seat"), table.toBuffer(), Buffer.from([i])]));
console.log(`桌 #${id}  table=${table.toBase58()}`);
console.log(`程序 ${programId.toBase58()}   Helius ${base}\n`);

async function parsedHistory(address, limit = 8) {
  const url = `${base}/v0/addresses/${address}/transactions/?api-key=${apiKey}&limit=${limit}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) return { status: r.status, body: (await r.text()).slice(0, 300) };
  return { status: r.status, items: await r.json() };
}

for (const [label, addr] of [["Table PDA", table], ["座位0", seats[0]], ["座位1", seats[1]]]) {
  const res = await parsedHistory(addr.toBase58());
  console.log(`=== ${label} ${addr.toBase58().slice(0, 8)}… → HTTP ${res.status}，${res.items?.length ?? 0} 笔`);
  if (!res.items) { console.log("   ", JSON.stringify(res.body)); continue; }
  for (const t of res.items.slice(0, 4)) {
    console.log("   ", JSON.stringify(pick(t, ["signature", "slot", "timestamp", "type", "source", "description", "fee", "transactionError", "instructionTypes"])).slice(0, 300));
    if (t.events) console.log("      events:", JSON.stringify(t.events).slice(0, 200));
    if (t.instructions) console.log("      ixs:", JSON.stringify(t.instructions.map((x) => pick(x, ["programId", "programName", "type"])).slice(0, 4)));
  }
}

// Parse Transaction(s)：拿上面第一笔签名走一次 POST 解析，看 events/instructions 细节
const first = (await parsedHistory(table.toBase58(), 2)).items?.[0];
if (first?.signature) {
  const r = await fetch(`${base}/v0/transactions/?api-key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions: [first.signature] }),
    signal: AbortSignal.timeout(25000),
  });
  const j = await r.json();
  const t = Array.isArray(j) ? j[0] : j;
  console.log(`\n=== Parse Transaction(s) ${first.signature.slice(0, 12)}… → HTTP ${r.status}`);
  console.log("   ", JSON.stringify(pick(t, ["type", "source", "description", "instructionTypes"])).slice(0, 400));
  console.log("    accounts:", JSON.stringify((t.accountData ?? []).map((a) => a.account).slice(0, 12)));
  console.log("    events:", JSON.stringify(t.events ?? null).slice(0, 400));
  console.log("    ixs:", JSON.stringify((t.instructions ?? []).map((x) => pick(x, ["programId", "programName", "type", "innerInstructions"])).map((x) => ({ ...x, innerInstructions: undefined }))).slice(0, 500));
}
