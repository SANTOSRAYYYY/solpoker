/**
 * Stage 0 smoke test: delegate -> ER increments -> commit -> undelegate.
 *
 * Runs against either
 *   - the local mb-stack (default: base 8899, ER via QFS 6699, validator mAGic...), or
 *   - devnet + devnet-tee (EPHEMERAL_PROVIDER_ENDPOINT=https://devnet-tee.magicblock.app).
 *
 * Every step records its signature, latency and the payer's L1 balance delta into
 * .anchor/smoke-report-<tag>.json so the CHANGELOG can cite real numbers.
 * The counter is public on purpose; no secrets are logged.
 */
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  GetCommitmentSignature,
  delegationRecordPdaFromDelegatedAccount,
  getAuthToken,
  verifyTeeRpcIntegrity,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import type { Smoke } from "../target/types/smoke";

const COUNTER_SEED = Buffer.from("smoke-counter");
const LOCAL_ER_VALIDATOR = "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev";
const DEVNET_TEE_VALIDATOR = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";

const BASE_URL =
  process.env.PROVIDER_ENDPOINT ||
  process.env.ANCHOR_PROVIDER_URL ||
  "http://127.0.0.1:8899";
const ER_URL = process.env.EPHEMERAL_PROVIDER_ENDPOINT || "http://127.0.0.1:6699";
const IS_TEE = /tee/i.test(ER_URL);
// Both devnet-tee and the local query-filtering-service (6699) require ?token=.
// Attestation (verifyTeeRpcIntegrity) only makes sense against a real TDX endpoint.
const NEEDS_AUTH = IS_TEE || process.env.ER_AUTH === "1" || /:6699(\/|$)/.test(ER_URL);
const VALIDATOR = new PublicKey(
  process.env.VALIDATOR || (IS_TEE ? DEVNET_TEE_VALIDATOR : LOCAL_ER_VALIDATOR),
);
const TAG = process.env.SMOKE_TAG || (IS_TEE ? "devnet-tee" : "local");

type Step = {
  step: string;
  layer: "L1" | "ER";
  signature?: string;
  l1Signature?: string;
  ms: number;
  payerL1DeltaLamports?: number;
  note?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toWs(url: string): string {
  const u = new URL(url);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (u.port) u.port = String(Number(u.port) + 1);
  return u.toString();
}

describe(`smoke (${TAG})`, function () {
  this.timeout(10 * 60 * 1000);

  const payer: Keypair = (anchor.Wallet.local() as anchor.Wallet).payer;
  const wallet = new anchor.Wallet(payer);
  const base = new Connection(BASE_URL, { commitment: "confirmed", wsEndpoint: toWs(BASE_URL) });
  const baseProvider = new anchor.AnchorProvider(base, wallet, { commitment: "confirmed" });
  // Node 24 strips TS types natively and may load this file as ESM (no require/__dirname),
  // so read the IDL from the repo root (anchor test runs from there).
  const idl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target/idl/smoke.json"), "utf8"));
  const program = new Program<Smoke>(idl, baseProvider);

  const [counterPda] = PublicKey.findProgramAddressSync(
    [COUNTER_SEED, payer.publicKey.toBuffer()],
    program.programId,
  );

  let er: Connection;
  let erProgram: Program<Smoke>;
  let startCount = 0;
  const steps: Step[] = [];
  const report: Record<string, unknown> = {
    tag: TAG,
    baseUrl: BASE_URL,
    erUrl: ER_URL,
    validator: VALIDATOR.toBase58(),
    programId: program.programId.toBase58(),
    payer: payer.publicKey.toBase58(),
    counter: counterPda.toBase58(),
    startedAt: new Date().toISOString(),
    steps,
  };

  const l1Balance = () => base.getBalance(payer.publicKey, "confirmed");

  async function timedL1(step: string, fn: () => Promise<string>, note?: string) {
    const before = await l1Balance();
    const t0 = Date.now();
    const signature = await fn();
    const ms = Date.now() - t0;
    const after = await l1Balance();
    steps.push({ step, layer: "L1", signature, ms, payerL1DeltaLamports: after - before, note });
    return signature;
  }

  async function timedEr(step: string, fn: () => Promise<string>, note?: string) {
    const before = await l1Balance();
    const t0 = Date.now();
    const signature = await fn();
    const ms = Date.now() - t0;
    const after = await l1Balance();
    const entry: Step = { step, layer: "ER", signature, ms, payerL1DeltaLamports: after - before, note };
    steps.push(entry);
    return entry;
  }

  async function readCounter(conn: Connection) {
    const info = await conn.getAccountInfo(counterPda, "confirmed");
    if (!info) return null;
    const decoded = program.coder.accounts.decode("counter", info.data) as {
      authority: PublicKey;
      count: anchor.BN;
    };
    return { owner: info.owner, count: decoded.count.toNumber() };
  }

  async function waitFor<T>(label: string, fn: () => Promise<T | null>, ok: (v: T) => boolean, timeoutMs = 90_000) {
    const t0 = Date.now();
    let last: T | null = null;
    while (Date.now() - t0 < timeoutMs) {
      last = await fn();
      if (last !== null && ok(last)) return { value: last, ms: Date.now() - t0 };
      await sleep(1000);
    }
    throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
  }

  async function describeL1Tx(sig: string) {
    const tx = await base.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) return null;
    const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
    const i = keys.indexOf(payer.publicKey.toBase58());
    return {
      feePayer: keys[0],
      feeLamports: tx.meta?.fee,
      payerIsFeePayer: keys[0] === payer.publicKey.toBase58(),
      payerDeltaLamports: i >= 0 && tx.meta ? tx.meta.postBalances[i] - tx.meta.preBalances[i] : 0,
      slot: tx.slot,
    };
  }

  before(async () => {
    report.payerStartLamports = await l1Balance();
    let erUrl = ER_URL;
    if (IS_TEE) {
      const t0 = Date.now();
      await verifyTeeRpcIntegrity(ER_URL);
      report.attestation = { verifyTeeRpcIntegrity: "ok", ms: Date.now() - t0 };
    }
    if (NEEDS_AUTH) {
      const t0 = Date.now();
      const auth = await getAuthToken(ER_URL, payer.publicKey, async (m: Uint8Array) =>
        nacl.sign.detached(m, payer.secretKey),
      );
      report.auth = { expiresAt: auth.expiresAt, ms: Date.now() - t0 };
      const u = new URL(ER_URL);
      u.searchParams.set("token", auth.token);
      erUrl = u.toString();
    }
    const wsUrl = new URL(erUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    if (wsUrl.port) wsUrl.port = String(Number(wsUrl.port) + 1);
    er = new Connection(erUrl, { commitment: "confirmed", wsEndpoint: wsUrl.toString() });
    erProgram = new Program<Smoke>(idl, new anchor.AnchorProvider(er, wallet, { commitment: "confirmed" }));
  });

  after(() => {
    report.finishedAt = new Date().toISOString();
    const dir = path.join(process.cwd(), ".anchor");
    fs.mkdirSync(dir, { recursive: true });
    // The auth token is never written to the report.
    fs.writeFileSync(path.join(dir, `smoke-report-${TAG}.json`), JSON.stringify(report, null, 2));
  });

  it("initializes the counter on L1 (or reuses an undelegated one)", async () => {
    let existing = await readCounter(base);
    if (existing && existing.owner.equals(DELEGATION_PROGRAM_ID)) {
      // Left delegated by an interrupted run: recover through the ER first.
      const entry = await timedEr("recover_undelegate", () =>
        erProgram.methods.undelegate().accountsPartial({ payer: payer.publicKey, counter: counterPda }).rpc(),
        "counter was still delegated from a previous run",
      );
      entry.l1Signature = await GetCommitmentSignature(entry.signature!, er);
      await waitFor("recovered owner", () => readCounter(base), (c) => c.owner.equals(program.programId));
      existing = await readCounter(base);
    }
    if (!existing) {
      await timedL1("initialize", () =>
        program.methods.initialize().accountsPartial({ authority: payer.publicKey, counter: counterPda }).rpc(),
      );
    }
    const c = await readCounter(base);
    expect(c).to.not.equal(null);
    expect(c!.owner.toBase58()).to.equal(program.programId.toBase58());
    startCount = c!.count;
    report.startCount = startCount;
  });

  it("delegates to the explicitly named validator", async () => {
    await timedL1("delegate", () =>
      program.methods.delegate(VALIDATOR).accountsPartial({ payer: payer.publicKey, pda: counterPda }).rpc(),
    );
    const info = await base.getAccountInfo(counterPda, "confirmed");
    expect(info!.owner.toBase58()).to.equal(DELEGATION_PROGRAM_ID.toBase58());
    const record = await base.getAccountInfo(delegationRecordPdaFromDelegatedAccount(counterPda), "confirmed");
    expect(record, "delegation record exists").to.not.equal(null);
    // DelegationRecord: disc(8) | authority(32) | owner(32) | delegation_slot | lamports | commit_frequency_ms
    const authority = new PublicKey(record!.data.subarray(8, 40));
    const owner = new PublicKey(record!.data.subarray(40, 72));
    const commitFrequencyMs = record!.data.readBigUInt64LE(88);
    report.delegationRecord = {
      address: delegationRecordPdaFromDelegatedAccount(counterPda).toBase58(),
      authority: authority.toBase58(),
      owner: owner.toBase58(),
      commitFrequencyMs: commitFrequencyMs.toString(),
      rentLamports: record!.lamports,
    };
    expect(authority.toBase58()).to.equal(VALIDATOR.toBase58());
    expect(owner.toBase58()).to.equal(program.programId.toBase58());
  });

  it("increments three times inside the ER", async () => {
    for (let i = 1; i <= 3; i++) {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await timedEr(`er_increment_${i}`, () =>
            erProgram.methods.increment().accountsPartial({ authority: payer.publicKey, counter: counterPda }).rpc(),
            attempt ? `retry ${attempt}` : undefined,
          );
          lastErr = undefined;
          break;
        } catch (e) {
          lastErr = e; // the ER may need a moment to clone the freshly delegated account
          await sleep(2000);
        }
      }
      if (lastErr) throw lastErr;
    }
    const inEr = await readCounter(er);
    expect(inEr!.count).to.equal(startCount + 3);
    const onL1 = await readCounter(base);
    expect(onL1!.count, "L1 must not change before commit").to.equal(startCount);
  });

  it("commits to L1 and L1 matches the ER value", async () => {
    const entry = await timedEr("er_commit", () =>
      erProgram.methods.commit().accountsPartial({ payer: payer.publicKey, counter: counterPda }).rpc(),
    );
    const t0 = Date.now();
    entry.l1Signature = await GetCommitmentSignature(entry.signature!, er);
    report.commitL1 = { ...(await describeL1Tx(entry.l1Signature)), msUntilL1Signature: Date.now() - t0 };
    const { ms } = await waitFor("L1 count after commit", () => readCounter(base), (c) => c.count === startCount + 3);
    (report.commitL1 as Record<string, unknown>).msUntilL1StateVisible = ms;
    const onL1 = await readCounter(base);
    expect(onL1!.owner.toBase58(), "still delegated after plain commit").to.equal(DELEGATION_PROGRAM_ID.toBase58());
  });

  it("increments once more, then commit_and_undelegate returns ownership", async () => {
    await timedEr("er_increment_4", () =>
      erProgram.methods.increment().accountsPartial({ authority: payer.publicKey, counter: counterPda }).rpc(),
    );
    const entry = await timedEr("er_undelegate", () =>
      erProgram.methods.undelegate().accountsPartial({ payer: payer.publicKey, counter: counterPda }).rpc(),
    );
    const t0 = Date.now();
    entry.l1Signature = await GetCommitmentSignature(entry.signature!, er);
    report.undelegateL1 = { ...(await describeL1Tx(entry.l1Signature)), msUntilL1Signature: Date.now() - t0 };
    const { value, ms } = await waitFor(
      "L1 owner back to program",
      () => readCounter(base),
      (c) => c.owner.equals(program.programId) && c.count === startCount + 4,
    );
    (report.undelegateL1 as Record<string, unknown>).msUntilOwnerRestored = ms;
    expect(value.count).to.equal(startCount + 4);
  });

  it("the undelegated counter is writable on L1 again", async () => {
    await timedL1("l1_increment_after_undelegate", () =>
      program.methods.increment().accountsPartial({ authority: payer.publicKey, counter: counterPda }).rpc(),
    );
    const c = await readCounter(base);
    expect(c!.count).to.equal(startCount + 5);
    report.payerEndLamports = await l1Balance();
    report.payerTotalDeltaLamports = (report.payerEndLamports as number) - (report.payerStartLamports as number);
  });
});
