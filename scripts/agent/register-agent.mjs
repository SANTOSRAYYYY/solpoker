// register-agent — 上链注册 AgentProfile（agent + 主人双签）。
//
// 为什么不用 `agent.mjs register`：公共 L1（rpc.magicblock.app）下它的固定流程
// 常被丢交易（confirmation timeout），且无优先费。本脚本：优先费 + 每次重试用
// 新 blockhash + 以「profile 是否已存在」为准判定成功（幂等）。
//
// 用法: L1_URL=<url> node scripts/agent/register-agent.mjs <name> [--owner keys/agents/<name>-owner.json]
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import * as env from "../env.mjs";

const name = process.argv[2];
if (!name) { console.error("用法: node scripts/agent/register-agent.mjs <name> [--owner <path>]"); process.exit(1); }
const ownerIdx = process.argv.indexOf("--owner");
const ownerPath = ownerIdx > 0 ? process.argv[ownerIdx + 1] : "keys/deployer.json";
const displayName = (process.argv.find((a) => a.startsWith("--name=")) ?? `--name=${name}`).slice(7);

const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);
const agentKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`keys/agents/${name}.json`, "utf8")).secretKey));
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(ownerPath, "utf8"))));
const l1 = new Connection(env.L1_RPC, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(25000) }) });
const program = new anchor.Program(idl, new anchor.AnchorProvider(l1, new anchor.Wallet(owner), { commitment: "confirmed" }));
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
const [profile] = PublicKey.findProgramAddressSync([Buffer.from("agent"), agentKp.publicKey.toBuffer()], PROGRAM_ID);

const nameBytes = Buffer.alloc(32); nameBytes.write(displayName.slice(0, 32), "utf8");
const metaBytes = Buffer.alloc(96);
const ix = await program.methods
  .registerAgent(Array.from(nameBytes), Array.from(metaBytes), false)
  .accounts({ config, profile, agent: agentKp.publicKey, owner: owner.publicKey, allowlist: null, systemProgram: anchor.web3.SystemProgram.programId })
  .instruction();

for (let attempt = 1; attempt <= 8; attempt++) {
  if (await l1.getAccountInfo(profile)) { console.log(`✓ ${name} 已注册（attempt ${attempt} 前确认）profile=${profile.toBase58()}`); process.exit(0); }
  try {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }))
      .add(ix);
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(owner, agentKp);
    const sig = await l1.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const t0 = Date.now();
    for (;;) {
      const st = await l1.getSignatureStatuses([sig]);
      const s = st.value[0];
      if (s?.err) { console.log(`attempt ${attempt}: 上链失败 ${JSON.stringify(s.err)}`); break; }
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
        console.log(`✓ ${name} 已注册: ${sig.slice(0, 20)}… profile=${profile.toBase58()}（agent=${agentKp.publicKey.toBase58()} owner=${owner.publicKey.toBase58()}）`);
        process.exit(0);
      }
      if (Date.now() - t0 > 25_000) { console.log(`attempt ${attempt}: 确认超时，重试`); break; }
      await new Promise((r) => setTimeout(r, 900));
    }
  } catch (e) {
    console.log(`attempt ${attempt}: ${String(e.message ?? e).slice(0, 90)}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
console.error(`${name} 注册失败（8 次尝试）`);
process.exit(1);
