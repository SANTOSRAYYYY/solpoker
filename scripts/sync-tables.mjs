// 全桌 ER→L1 快照同步：对 phase==Idle 的桌发一次 commit_game（幂等、可重复跑）。
// 用法: node tmp-sync-tables.mjs [ids 逗号分隔]
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import * as env from "./env.mjs";

const IDS = (process.argv[2] ?? "2,5,6,7,8,9,11,12,13,14,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,41")
  .split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");

const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8"))));
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];

const erRead = new Connection(env.ER_BASE_URL, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(20000) }) });
const { token } = await getAuthToken(env.ER_BASE_URL, deployer.publicKey, async (msg) => (await import("tweetnacl")).default.sign.detached(msg, deployer.secretKey));
const er = new Connection(`${env.ER_BASE_URL}?token=${token}`, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(25000) }) });
const program = new anchor.Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(deployer), { commitment: "confirmed" }));
const [magicFeeVault] = PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), TEE_VALIDATOR.toBuffer()], DLP);
const PHASE = ["Idle", "Commit", "AwaitSeed", "Preflop", "AwaitStreet", "Betting", "AwaitRunout", "Settle"];

let ok = 0, skip = 0, fail = 0;
for (const id of IDS) {
  const table = pda([Buffer.from("table"), u32(id)]);
  const game = pda([Buffer.from("game"), table.toBuffer()]);
  let gAcc;
  try { gAcc = await erRead.getAccountInfo(game); } catch (e) { console.log(`#${id}: 读取失败 ${String(e.message).slice(0, 60)}`); fail++; continue; }
  if (!gAcc) { console.log(`#${id}: game 不存在`); skip++; continue; }
  const phase = gAcc.data[1544];
  if (phase !== 0) { console.log(`#${id}: ${PHASE[phase]}（非 Idle，跳过——crank 会在手间提交）`); skip++; continue; }
  try {
    const ix = await program.methods.commitGame().accounts({
      table, game,
      handProof: pda([Buffer.from("proof"), table.toBuffer()]),
      handSecrets: pda([Buffer.from("secrets"), table.toBuffer()]),
      handReplay: pda([Buffer.from("replay"), table.toBuffer()]),
      commitPayer: pda([Buffer.from("commit_payer"), table.toBuffer()]),
      magicContext: MAGIC_CONTEXT, magicProgram: MAGIC_PROGRAM, magicFeeVault,
    }).instruction();
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
    tx.feePayer = deployer.publicKey;
    tx.recentBlockhash = (await er.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(deployer);
    const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const t0 = Date.now();
    let done = false;
    for (;;) {
      const st = await er.getSignatureStatuses([sig]);
      const s = st.value[0];
      if (s?.err) throw new Error(JSON.stringify(s.err));
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") { done = true; break; }
      if (Date.now() - t0 > 60000) throw new Error("确认超时");
      await new Promise((r) => setTimeout(r, 700));
    }
    if (done) { console.log(`#${id}: commit_game ✓ ${sig.slice(0, 12)}…`); ok++; }
  } catch (e) {
    console.log(`#${id}: ✗ ${String(e.message).slice(0, 100)}`); fail++;
  }
}
console.log(`\n同步完成：ok=${ok} skip=${skip} fail=${fail}`);
