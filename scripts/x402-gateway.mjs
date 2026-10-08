// x402 网关（本地模拟，零依赖 node:http）：HTTP 402 报价 + 付款校验 + 调
// `credit_x402_deposit` 入账。这是配套文档一 §4.3「标准模式」的可跑参考实现。
//
// 流程（标准 x402 exact-SVM 快速路径）：
//   1. 客户端 GET /v1/tables/:id/seats?payer=<pubkey>  → 402 + 付款要求
//      （payTo = 这张桌的 vault_auth，所以 USDC 直达 TableVault，不经运营方钱包）
//   2. 客户端按报价付款：一笔只含「计算预算 + TransferChecked + Memo」的交易
//   3. 客户端 POST /v1/tables/:id/seats，头 `X-PAYMENT: <tx signature>`
//   4. 网关校验（下方 verify）：L1 查那笔交易，确认
//        · 成功、(payer → ATA(vault_auth, mint)) 的 tUSDC 增量 ≥ amount
//      （FACILITATOR_URL 设置时改为调用外部 facilitator 的 /verify；facilitator
//        最终选型仍是待定项 —— 见配套文档一 §4.5）
//   5. 网关（config.gateway 的密钥）调 `credit_x402_deposit` → DepositRecord
//      落链（同一笔付款不可重复入账）+ 事件 X402DepositCredited
//
// 用法:
//   node scripts/x402-gateway.mjs [--port 8790]
//   # 环境变量：GATEWAY_KEY=keys/gateway.json（默认 deployer，本地模拟用）
//   #           FACILITATOR_URL=http://…（可选：外部校验器）
//   node scripts/x402-gateway.mjs --selftest    # 无服务端逻辑自检（报价/解析/去重）
//
// 安全：网关只持有 config.gateway 的签名权 —— 它能「记入账」，但不能把任何
// 资金转给自己（payout 在入座时钉死为付款人/agent 主人）；每笔入账都有
// DepositRecord 与付款签名，事后可用 /history 的「L1 审计视图」逐笔核对。
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import { L1_RPC } from "./env.mjs";

const TUSDC_MINT = new PublicKey("9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH");
const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");

const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const permProgram = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");

const arg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg("--port", 8790));
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "";
const PRICE_TIERS = { minBuyInBb: 100, maxBuyInBb: 1000 };

const l1 = new Connection(L1_RPC, {
  commitment: "confirmed",
  fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(30000) }),
});
const keyPath = process.env.GATEWAY_KEY ?? "keys/deployer.json";
const gateway = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8"))));
const program = new anchor.Program(
  idl,
  new anchor.AnchorProvider(l1, new anchor.Wallet(gateway), { commitment: "confirmed" })
);

/** 一桌的网关视图：PDA + 报价 + 8 个“其余座位”账本地址。 */
function tableView(tableId, seatIdx) {
  const table = pda([Buffer.from("table"), u32le(tableId)]);
  const seat = (i) => pda([Buffer.from("seat"), table.toBuffer(), Buffer.from([i])]);
  const vaultAuth = pda([Buffer.from("vault_auth"), table.toBuffer()]);
  const others = Array.from({ length: 9 }, (_, i) => i).filter((i) => i !== seatIdx);
  return {
    table,
    seat: seat(seatIdx),
    seatIdx,
    vaultAuth,
    vault: getAssociatedTokenAddressSync(TUSDC_MINT, vaultAuth, true),
    otherPdas: others.map(seat),
  };
}

/** 402 报价（字段名对齐 @x402/core 2.28 的 exact-SVM 方案；extra.solpoker 为标准忽略字段）。 */
function quote(tableId, tv, payer, sb, bb, ante) {
  const min = BigInt(PRICE_TIERS.minBuyInBb) * BigInt(bb);
  return {
    x402Version: 2,
    error: "payment required",
    accepts: [
      {
        scheme: "exact",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        asset: TUSDC_MINT.toBase58(),
        payTo: tv.vaultAuth.toBase58(),
        maxAmountRequired: min.toString(),
        resource: `/v1/tables/${tableId}/seats/${tv.seatIdx}`,
        description: `SolPoker table #${tableId} seat ${tv.seatIdx} buy-in`,
        mimeType: "application/json",
        maxTimeoutSeconds: 120,
        extra: {
          solpoker: {
            programId: programId.toBase58(),
            table: tv.table.toBase58(),
            seat: tv.seatIdx,
            payer,
            minBuyIn: min.toString(),
            maxBuyIn: (BigInt(PRICE_TIERS.maxBuyInBb) * BigInt(bb)).toString(),
            blinds: { sb: sb.toString(), bb: bb.toString(), ante: ante.toString() },
            note: "付款交易只能含 ComputeBudget + TransferChecked(vault) + Memo；付完把签名放进 X-PAYMENT 头 POST 本资源入账。",
          },
        },
      },
    ],
  };
}

/** 校验付款：L1 上那笔交易里，payer → ATA(vaultAuth) 的 tUSDC 增量 ≥ amount。 */
async function verifyPayment(sig, payer, vault, vaultAuth, amount) {
  if (FACILITATOR_URL) {
    const r = await fetch(`${FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature: sig, payer, payTo: vaultAuth.toBase58(), asset: TUSDC_MINT.toBase58(), amount: amount.toString() }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && (j.valid ?? j.ok ?? false), detail: j };
  }
  const tx = await l1.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) return { ok: false, detail: "交易不存在或超出 RPC 保留期" };
  if (tx.meta?.err) return { ok: false, detail: `交易失败：${JSON.stringify(tx.meta.err)}` };
  const keys = [
    ...(tx.transaction.message.staticAccountKeys ?? []),
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  const vaultIdx = keys.findIndex((k) => k.equals(vault));
  if (vaultIdx < 0) return { ok: false, detail: "交易未触达 TableVault" };
  const pre = tx.meta?.preTokenBalances?.find((b) => b.accountIndex === vaultIdx && b.mint === TUSDC_MINT.toBase58());
  const post = tx.meta?.postTokenBalances?.find((b) => b.accountIndex === vaultIdx && b.mint === TUSDC_MINT.toBase58());
  const delta = BigInt(post?.uiTokenAmount?.amount ?? "0") - BigInt(pre?.uiTokenAmount?.amount ?? "0");
  if (delta < BigInt(amount)) return { ok: false, detail: `入金 ${delta} < 报价 ${amount}` };
  // 付款人必须出现在签名者里（付款交易由付款人签）
  const signers = keys.slice(0, tx.transaction.message.header.numRequiredSignatures);
  if (payer && !signers.some((k) => k.toBase58() === payer)) {
    return { ok: false, detail: "付款人不是该交易的签名者" };
  }
  return { ok: true, detail: { delta: delta.toString() } };
}

/** 入账：调 credit_x402_deposit（网关签名）。 */
async function credit({ tableId, tv, payer, amount, sig }) {
  const sigBytes = Buffer.from(bs58.decode(sig));
  const sigLo = Array.from(sigBytes.slice(0, 32));
  const sigHi = Array.from(sigBytes.slice(32, 64));
  const [depositRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from("x402"), Buffer.from(sigLo), Buffer.from(sigHi)],
    programId
  );
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const ix = await program.methods
    .creditX402Deposit(tv.seatIdx, new PublicKey(payer), new BN(amount), sigLo, sigHi)
    .accounts({
      config,
      table: tv.table,
      seat: tv.seat,
      depositRecord,
      other0: tv.otherPdas[0], other1: tv.otherPdas[1], other2: tv.otherPdas[2],
      other3: tv.otherPdas[3], other4: tv.otherPdas[4], other5: tv.otherPdas[5],
      other6: tv.otherPdas[6], other7: tv.otherPdas[7],
      gateway: gateway.publicKey,
      agentProfile: null,
    })
    .instruction();
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
  tx.feePayer = gateway.publicKey;
  tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(gateway);
  const txSig = await l1.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await l1.confirmTransaction(txSig, "confirmed");
  return { creditSig: txSig, depositRecord: depositRecord.toBase58() };
}

// bs58（只用于把 base58 签名转字节；避免额外依赖，内联实现）
const bs58 = (() => {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map = new Map([...ALPHABET].map((c, i) => [c, i]));
  return {
    decode(s) {
      let n = 0n;
      for (const c of s) {
        const v = map.get(c);
        if (v === undefined) throw new Error(`bad base58 char ${c}`);
        n = n * 58n + BigInt(v);
      }
      const bytes = [];
      while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
      let lead = 0;
      for (const c of s) { if (c === "1") lead++; else break; }
      return new Uint8Array([...Array(lead).fill(0), ...bytes]);
    },
  };
})();

// ---------------- 自检（--selftest，不需要网络） ----------------
if (process.argv.includes("--selftest")) {
  const sigB58 = Buffer.alloc(64, 7).toString("base64");
  // bs58 编解码往返
  const sig = "5".repeat(88);
  let ok = true;
  try {
    const b = bs58.decode("1111111111111111111111111111111111111111111111111111111111111111");
    ok = b.length === 32 && b.every((x) => x === 0);
  } catch { ok = false; }
  const tv = { seatIdx: 3, otherPdas: Array.from({ length: 8 }, (_, i) => new PublicKey(programId)) };
  const q = quote(20, { ...tv, table: programId, vaultAuth: programId, seat: programId }, "11111111111111111111111111111111", 100000n, 200000n, 20000n);
  const acc = q.accepts[0];
  console.log("bs58 往返:", ok ? "OK" : "FAIL");
  console.log("报价:", JSON.stringify({ scheme: acc.scheme, network: acc.network, payTo: acc.payTo.slice(0, 8) + "…", maxAmountRequired: acc.maxAmountRequired, seat: acc.extra.solpoker.seat }));
  console.log("SELFTEST", ok && acc.scheme === "exact" && acc.maxAmountRequired === "20000000" ? "OK" : "FAIL");
  process.exit(0);
}

// ---------------- HTTP 服务 ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const m = /^\/v1\/tables\/(\d+)\/seats(?:\/(\d+))?$/.exec(url.pathname);
  try {
    if (!m) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found", hint: "GET /v1/tables/:id/seats/:idx?payer=<pubkey>" }));
      return;
    }
    const tableId = Number(m[1]);
    const tv0 = tableView(tableId, Number(m[2] ?? 0));
    const tableInfo = await l1.getAccountInfo(tv0.table);
    if (!tableInfo) throw new Error(`table #${tableId} 不存在`);

    // 报价（无 X-PAYMENT）或入账（有 X-PAYMENT）
    const paymentSig = req.headers["x-payment"];
    const payer = url.searchParams.get("payer") ?? "";
    const amount = url.searchParams.get("amount") ?? "";
    const sb = tableInfo.data.readBigUInt64LE(79);
    const bb = tableInfo.data.readBigUInt64LE(87);
    const ante = tableInfo.data.readBigUInt64LE(95);
    const tv = tableView(tableId, Number(m[2] ?? 0));

    if (!paymentSig) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify(quote(tableId, tv, payer, sb, bb, ante), null, 1));
      console.log(`[402] 桌 #${tableId} 座 ${tv.seatIdx} 报价给 ${payer.slice(0, 8)}…（payTo=vault_auth）`);
      return;
    }
    if (!payer || !amount) throw new Error("入账需要 ?payer= 与 ?amount=（base units）");
    const v = await verifyPayment(String(paymentSig), payer, tv.vault, tv.vaultAuth, amount);
    if (!v.ok) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid payment", detail: v.detail, accepts: quote(tableId, tv, payer, sb, bb, ante).accepts }, null, 1));
      console.log(`[402] 校验失败：${JSON.stringify(v.detail).slice(0, 120)}`);
      return;
    }
    let c;
    try {
      c = await credit({ tableId, tv, payer, amount, sig: String(paymentSig) });
    } catch (e) {
      const msg = String(e?.message ?? e);
      // DepositRecord 的 init 语义：同一笔付款重复入账会在这里失败（account already in use）。
      const replay = /already in use|AccountAlreadyInUse|0x0/i.test(msg);
      res.writeHead(replay ? 409 : 400, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          {
            error: replay ? "payment already credited（同一笔付款不可重复入账）" : "credit failed",
            detail: msg.slice(0, 400),
          },
          null,
          1
        )
      );
      console.log(`[err] 入账失败（${replay ? "重复入账" : "其他"}）：${msg.slice(0, 120)}`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, credited: amount, seat: tv.seatIdx, ...c }, null, 1));
    console.log(`[入账] 桌 #${tableId} 座 ${tv.seatIdx} ← ${payer.slice(0, 8)}… ${amount} 单位  credit_tx=${c.creditSig.slice(0, 12)}… record=${c.depositRecord.slice(0, 8)}…`);
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message ?? e) }));
    console.log(`[err] ${String(e.message ?? e).slice(0, 160)}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`x402-gateway 监听 http://127.0.0.1:${PORT}`);
  console.log(`  网关身份 ${gateway.publicKey.toBase58()}（需 == config.gateway）`);
  console.log(`  L1       ${L1_RPC.split("?")[0]}`);
  console.log(`  facilitator ${FACILITATOR_URL ? FACILITATOR_URL : "（未设置 → 本地链上校验；最终选型待定）"}`);
  console.log(`  报价     GET  /v1/tables/<id>/seats/<idx>?payer=<pubkey>`);
  console.log(`  入账     POST /v1/tables/<id>/seats/<idx>?payer=<pubkey>&amount=<units>  头: X-PAYMENT: <付款签名>`);
});
