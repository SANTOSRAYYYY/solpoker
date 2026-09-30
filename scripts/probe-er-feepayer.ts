/**
 * Stage 1 follow-up: which fee payers does the TEE ER accept?
 *
 *   node scripts/probe-er-feepayer.ts        (Node 24 strips TS types natively)
 *
 * Sends the smoke `increment` (authority = deployer, co-signer) to devnet-tee with
 * different fee payers, the way a session key would pay for game actions:
 *   A. deployer (funded on L1)                       -> control
 *   B. fresh keypair, never funded (0 lamports)      -> expected: rejected
 *   C. fresh keypair funded with exactly the rent-exempt minimum for a 0-byte account
 * For each case records preflight / send / status results and the fee payer's balance
 * on L1 and in the ER before and after (does the ER charge fees?).
 * Afterwards sweeps the lamports of C back to the deployer and undelegates the counter.
 * Writes .anchor/er-feepayer-report.json. The auth token is never written or logged.
 */
import * as anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();
const BASE_URL = process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com";
const TEE_URL = process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-tee.magicblock.app";
const VALIDATOR = new PublicKey(process.env.VALIDATOR || "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => {
  const s = e instanceof Error ? e.message : String(e);
  return s.replace(/token=[^&\s"]+/g, "token=<redacted>").slice(0, 600);
};

async function main() {
  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(ROOT, "keys/deployer.json"), "utf8"))),
  );
  const wallet = new anchor.Wallet(deployer);
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/smoke.json"), "utf8"));
  const base = new Connection(BASE_URL, "confirmed");
  const program = new anchor.Program(idl, new anchor.AnchorProvider(base, wallet, { commitment: "confirmed" }));
  const [counter] = PublicKey.findProgramAddressSync(
    [Buffer.from("smoke-counter"), deployer.publicKey.toBuffer()],
    program.programId,
  );
  const auth = await getAuthToken(TEE_URL, deployer.publicKey, async (m: Uint8Array) =>
    nacl.sign.detached(m, deployer.secretKey),
  );
  const u = new URL(TEE_URL);
  u.searchParams.set("token", auth.token);
  const er = new Connection(u.toString(), { commitment: "confirmed" });
  const erProgram = new anchor.Program(idl, new anchor.AnchorProvider(er, wallet, { commitment: "confirmed" }));
  const report: Record<string, unknown> = { teeUrl: TEE_URL, baseUrl: BASE_URL, at: new Date().toISOString() };

  // make sure the counter is delegated to the TEE validator
  const info = await base.getAccountInfo(counter, "confirmed");
  if (!info) throw new Error("counter missing on L1; run tests/smoke.ts first");
  if (!info.owner.equals(DELEGATION_PROGRAM_ID)) {
    report.delegateSignature = await program.methods
      .delegate(VALIDATOR)
      .accountsPartial({ payer: deployer.publicKey, pda: counter })
      .rpc();
    await sleep(5000);
  }

  const rentMin = await base.getMinimumBalanceForRentExemption(0);
  report.rentExemptMin0 = rentMin;

  const bal = async (c: Connection, k: PublicKey) => {
    try { return await c.getBalance(k, "confirmed"); } catch (e) { return `error: ${errText(e)}`; }
  };

  async function tryIncrement(label: string, feePayer: Keypair) {
    const r: Record<string, unknown> = { feePayer: feePayer.publicKey.toBase58() };
    r.l1Before = await bal(base, feePayer.publicKey);
    r.erBefore = await bal(er, feePayer.publicKey);
    const tx: Transaction = await erProgram.methods
      .increment()
      .accountsPartial({ authority: deployer.publicKey, counter })
      .transaction();
    tx.feePayer = feePayer.publicKey;
    tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    const signers = feePayer.publicKey.equals(deployer.publicKey) ? [deployer] : [feePayer, deployer];
    tx.sign(...signers);
    const raw = tx.serialize();
    // 1) preflight (simulation inside the ER)
    try {
      const sim = await er.simulateTransaction(tx);
      r.simulateErr = sim.value.err ?? null;
      r.simulateLogsTail = (sim.value.logs || []).slice(-3);
    } catch (e) { r.simulateThrew = errText(e); }
    // 2) send without preflight, then poll the status
    try {
      const sig = await er.sendRawTransaction(raw, { skipPreflight: true });
      r.signature = sig;
      let st = null;
      for (let i = 0; i < 60 && !st; i++) {
        st = (await er.getSignatureStatuses([sig])).value[0];
        if (!st) await sleep(250);
      }
      r.status = st ? { err: st.err ?? null, confirmationStatus: st.confirmationStatus } : "no status after 15 s";
    } catch (e) { r.sendThrew = errText(e); }
    await sleep(1500);
    r.l1After = await bal(base, feePayer.publicKey);
    r.erAfter = await bal(er, feePayer.publicKey);
    report[label] = r;
    console.log(label, JSON.stringify(r));
  }

  // A. control
  await tryIncrement("A_deployer", deployer);
  // B. never-funded keypair
  const fresh = Keypair.generate();
  await tryIncrement("B_zero_balance", fresh);
  // C. keypair funded with exactly the rent-exempt minimum
  const minimal = Keypair.generate();
  const fundSig = await base.sendTransaction(
    new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: minimal.publicKey, lamports: rentMin })),
    [deployer],
  );
  await base.confirmTransaction(fundSig, "confirmed");
  report.fundMinimalSignature = fundSig;
  await sleep(2000);
  await tryIncrement("C_rent_exempt_min", minimal);
  // C2. second action from the same minimal payer (does the balance hold up?)
  await tryIncrement("C2_rent_exempt_min_again", minimal);

  // sweep C back to the deployer. An account holding only the rent-exempt minimum cannot pay
  // its own L1 fee (Agave requires the fee payer to stay rent-exempt after the fee is taken),
  // so the deployer pays the fee and `minimal` transfers everything, ending at 0 lamports.
  try {
    const left = await base.getBalance(minimal.publicKey, "confirmed");
    if (left > 0) {
      const sweep = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: minimal.publicKey, toPubkey: deployer.publicKey, lamports: left }),
      );
      sweep.feePayer = deployer.publicKey;
      const sweepSig = await base.sendTransaction(sweep, [deployer, minimal]);
      await base.confirmTransaction(sweepSig, "confirmed");
      report.sweepSignature = sweepSig;
      report.sweepLeft = await base.getBalance(minimal.publicKey, "confirmed");
    }
  } catch (e) { report.sweepThrew = errText(e); }

  // undelegate the counter again (leave devnet as we found it)
  try {
    report.undelegateSignature = await erProgram.methods
      .undelegate()
      .accountsPartial({ payer: deployer.publicKey, counter })
      .rpc({ skipPreflight: true });
  } catch (e) { report.undelegateThrew = errText(e); }

  fs.mkdirSync(path.join(ROOT, ".anchor"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, ".anchor/er-feepayer-report.json"), JSON.stringify(report, null, 2));
  console.log("report written to .anchor/er-feepayer-report.json");
}

main().then(() => process.exit(0)).catch((e) => { console.error(errText(e)); process.exit(1); });
