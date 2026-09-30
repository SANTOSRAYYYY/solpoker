/**
 * Stage 0: break down ER transaction latency on devnet-tee.
 *
 *   node scripts/tee-latency.ts            (Node 24 strips TS types natively)
 *
 * Measures, for the smoke counter delegated to the TEE validator:
 *   - plain RPC round trip (getSlot, getLatestBlockhash)
 *   - sendRawTransaction latency (skipPreflight)
 *   - time until getSignatureStatuses reports processed / confirmed (50 ms polling)
 *   - whether a websocket signature notification arrives (token in the ws URL)
 * Writes .anchor/tee-latency-report.json. The auth token is never written or logged.
 */
import * as anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  GetCommitmentSignature,
  getAuthToken,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();
const BASE_URL = process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com";
const TEE_URL = process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-tee.magicblock.app";
const VALIDATOR = new PublicKey(process.env.VALIDATOR || "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const N = Number(process.env.N || 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const stats = (a: number[]) => ({ n: a.length, min: Math.min(...a), median: median(a), max: Math.max(...a) });

async function timeIt<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, Math.round(performance.now() - t0)];
}

async function main() {
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(ROOT, "keys/deployer.json"), "utf8"))),
  );
  const wallet = new anchor.Wallet(payer);
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/smoke.json"), "utf8"));
  const base = new Connection(BASE_URL, "confirmed");
  const program = new anchor.Program(idl, new anchor.AnchorProvider(base, wallet, { commitment: "confirmed" }));
  const [counter] = PublicKey.findProgramAddressSync(
    [Buffer.from("smoke-counter"), payer.publicKey.toBuffer()],
    program.programId,
  );

  const [auth, authMs] = await timeIt(() =>
    getAuthToken(TEE_URL, payer.publicKey, async (m: Uint8Array) => nacl.sign.detached(m, payer.secretKey)),
  );
  const u = new URL(TEE_URL);
  u.searchParams.set("token", auth.token);
  const ws = new URL(u.toString());
  ws.protocol = "wss:";
  const er = new Connection(u.toString(), { commitment: "confirmed", wsEndpoint: ws.toString() });
  const erProgram = new anchor.Program(idl, new anchor.AnchorProvider(er, wallet, { commitment: "confirmed" }));

  const report: Record<string, unknown> = { teeUrl: TEE_URL, baseUrl: BASE_URL, n: N, authMs, at: new Date().toISOString() };

  // 1) plain RPC round trips
  const slotRtt: number[] = [];
  const bhRtt: number[] = [];
  const baseRtt: number[] = [];
  for (let i = 0; i < 5; i++) {
    slotRtt.push((await timeIt(() => er.getSlot()))[1]);
    bhRtt.push((await timeIt(() => er.getLatestBlockhash()))[1]);
    baseRtt.push((await timeIt(() => base.getSlot()))[1]);
  }
  report.rpcRoundTrip = { teeGetSlot: stats(slotRtt), teeGetLatestBlockhash: stats(bhRtt), devnetGetSlot: stats(baseRtt) };

  // 2) make sure the counter is delegated to the TEE
  const info = await base.getAccountInfo(counter, "confirmed");
  if (!info) throw new Error("counter missing on L1; run tests/smoke.ts first");
  if (!info.owner.equals(DELEGATION_PROGRAM_ID)) {
    const sig = await program.methods.delegate(VALIDATOR).accountsPartial({ payer: payer.publicKey, pda: counter }).rpc();
    report.delegateSignature = sig;
    await sleep(3000);
  }

  // 3) raw send + status polling
  const sendMs: number[] = [];
  const processedMs: number[] = [];
  const confirmedMs: number[] = [];
  const wsMs: (number | null)[] = [];
  const sigs: string[] = [];
  for (let i = 0; i < N; i++) {
    const tx: Transaction = await erProgram.methods
      .increment()
      .accountsPartial({ authority: payer.publicKey, counter })
      .transaction();
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    tx.sign(payer);
    const raw = tx.serialize();

    let wsAt: number | null = null;
    const t0 = performance.now();
    const [sig, sMs] = await timeIt(() => er.sendRawTransaction(raw, { skipPreflight: true }));
    let subId: number | null = null;
    try {
      subId = er.onSignature(sig, () => { wsAt = Math.round(performance.now() - t0); }, "confirmed");
    } catch { subId = null; }
    let pAt: number | null = null;
    let cAt: number | null = null;
    while (performance.now() - t0 < 30_000 && cAt === null) {
      const st = (await er.getSignatureStatuses([sig])).value[0];
      const now = Math.round(performance.now() - t0);
      if (st?.err) throw new Error(`tx ${i} failed: ${JSON.stringify(st.err)}`);
      if (st && pAt === null) pAt = now;
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) cAt = now;
      if (cAt === null) await sleep(50);
    }
    await sleep(1500); // give the websocket a chance to deliver
    if (subId !== null) { try { await er.removeSignatureListener(subId); } catch { /* ignore */ } }
    sigs.push(sig);
    sendMs.push(sMs);
    if (pAt !== null) processedMs.push(pAt);
    if (cAt !== null) confirmedMs.push(cAt);
    wsMs.push(wsAt);
  }
  report.erTx = {
    sendRawTransaction: stats(sendMs),
    untilProcessedByPolling: stats(processedMs),
    untilConfirmedByPolling: stats(confirmedMs),
    websocketNotification: { delivered: wsMs.filter((x) => x !== null).length, of: N, ms: wsMs },
    signatures: sigs,
  };

  // 4) the same increment through Anchor .rpc() for comparison
  const rpcMs: number[] = [];
  for (let i = 0; i < 3; i++) {
    rpcMs.push((await timeIt(() =>
      erProgram.methods.increment().accountsPartial({ authority: payer.publicKey, counter }).rpc()))[1]);
  }
  report.anchorRpcConfirm = stats(rpcMs);

  // 5) give the counter back to L1
  const undo = await erProgram.methods.undelegate().accountsPartial({ payer: payer.publicKey, counter }).rpc();
  const l1 = await GetCommitmentSignature(undo, er);
  for (let i = 0; i < 90; i++) {
    const a = await base.getAccountInfo(counter, "confirmed");
    if (a && a.owner.equals(program.programId)) break;
    await sleep(1000);
  }
  report.undelegate = { erSignature: undo, l1Signature: l1 };

  fs.mkdirSync(path.join(ROOT, ".anchor"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, ".anchor/tee-latency-report.json"), JSON.stringify(report, null, 2));
  const { erTx, ...summary } = report as { erTx: Record<string, unknown> };
  const { signatures, ...erTxSummary } = erTx;
  console.log(JSON.stringify({ ...summary, erTx: erTxSummary }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
