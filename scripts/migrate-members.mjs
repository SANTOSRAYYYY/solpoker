// 存量桌 PER 成员迁移（2026-10-09 成员策略）：运营方退出全部私有账户名单。
// 对每张桌：deck → [VRF 身份]；hand_i → [占用者]（有占用者）或 [VRF 身份]（空座）。
// 用法: node tmp-migrate-members.mjs [开始ID] [结束ID]   （默认 1..40）
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import * as env from "./env.mjs";

const FROM = Number(process.argv[2] ?? 1);
const TO = Number(process.argv[3] ?? 40);
// 2026-10-10（审计 M5）：默认**干跑**（打印计划，不发交易）；真正执行必须显式
// 加 --apply。历史上这个脚本默认全量 1..40 直发，误跑即对全部在线桌动成员名单。
const APPLY = process.argv.includes("--apply");
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");

const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8"))));
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (seeds, pid = programId) => PublicKey.findProgramAddressSync(seeds, pid)[0];
const vrfIdentity = pda([Buffer.from("identity"), programId.toBuffer()], VRF_PROGRAM);

const er = new Connection(env.ER_BASE_URL, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(20000) }) });
const { token } = await getAuthToken(env.ER_BASE_URL, deployer.publicKey, async (msg) => (await import("tweetnacl")).default.sign.detached(msg, deployer.secretKey));
const erTx = new Connection(`${env.ER_BASE_URL}?token=${token}`, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(20000) }) });
const program = new anchor.Program(idl, new anchor.AnchorProvider(erTx, new anchor.Wallet(deployer), { commitment: "confirmed" }));

async function send(ixs, label) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  tx.add(...ixs);
  tx.feePayer = deployer.publicKey;
  tx.recentBlockhash = (await erTx.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(deployer);
  const sig = await erTx.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const t0 = Date.now();
  for (;;) {
    const st = await erTx.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) throw new Error(`${label}: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return sig;
    if (Date.now() - t0 > 45000) throw new Error(`${label}: timeout`);
    await new Promise((r) => setTimeout(r, 600));
  }
}

let ok = 0, fail = 0, skipped = 0;
for (let id = FROM; id <= TO; id++) {
  const table = pda([Buffer.from("table"), u32(id)]);
  const game = pda([Buffer.from("game"), table.toBuffer()]);
  const deck = pda([Buffer.from("deck"), table.toBuffer(), Buffer.from([0, 0])]);
  const gAcc = await er.getAccountInfo(game);
  if (!gAcc) { continue; } // 该桌不存在
  const g = gAcc.data;
  const occupied = g.readUInt16LE(1524);
  const targets = [[0, [vrfIdentity]]];
  for (let i = 0; i < 9; i++) {
    const occ = new PublicKey(g.subarray(152 + i * 152, 152 + i * 152 + 32));
    const occEmpty = occ.equals(PublicKey.default);
    targets.push([i + 1, [occEmpty ? vrfIdentity : occ]]);
  }
  const results = [];
  for (const [targetIndex, members] of targets) {
    const tgt = targetIndex === 0 ? deck : pda([Buffer.from("hand"), table.toBuffer(), Buffer.from([0, 0]), Buffer.from([targetIndex - 1])]);
    // 不要用 getAccountInfo 做存在性预检查：收紧成员后非成员读 = null，
    // 与"账户不存在"不可区分（2026-10-09 实测）。直接尝试，程序端校验 PDA。
    const permission = pda([Buffer.from("permission:"), tgt.toBuffer()], PERMISSION_PROGRAM);
    if (!APPLY) {
      console.log(`[dry-run] #${id} target#${targetIndex} members=[${members.map((m) => m.toBase58().slice(0, 6)).join(", ")}]（加 --apply 执行）`);
      continue;
    }
    try {
      const ix = await program.methods
        .adminSetMembers(targetIndex, members)
        .accounts({
          table, game, target: tgt, permission,
          commitPayer: pda([Buffer.from("commit_payer"), table.toBuffer()]),
          vault: new PublicKey("MagicVau1t999999999999999999999999999999999"),
          magicProgram: new PublicKey("Magic11111111111111111111111111111111111111"),
          permissionProgram: PERMISSION_PROGRAM,
          admin: deployer.publicKey,
        }).instruction();
      await send([ix], `#${id} target#${targetIndex}`);
      ok++;
    } catch (e) {
      fail++;
      const msg = String(e.message ?? e);
      // 幂等/无权限/未委托等重复失败只提示一次
      results.push(`  ✗ #${id} t#${targetIndex}: ${msg.slice(0, 100)}`);
    }
  }
  console.log(`桌#${id}: occupied=${occupied.toString(2)} → ${targets.length} 个目标，累计 ok=${ok} fail=${fail} skip=${skipped}`);
  for (const r of results.slice(0, 3)) console.log(r);
}
console.log(`\n迁移完成：ok=${ok} fail=${fail} skip=${skipped}`);
