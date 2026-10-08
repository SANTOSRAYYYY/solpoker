// 补齐指定桌的 ER 权限账户（init_permissions）。绕过建桌脚本的 token 流程，
// 取新鲜 token 后立即调用。幂等（已存在的权限会被程序跳过）。
// 用法: node tmp-init-permissions-41.mjs <tableId>
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import * as env from "./env.mjs";

const TABLE_ID = Number(process.argv[2] ?? 41);
const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");
const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");

const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8"))));
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (seeds, pid = programId) => PublicKey.findProgramAddressSync(seeds, pid)[0];
const table = pda([Buffer.from("table"), u32(TABLE_ID)]);
const deck = pda([Buffer.from("deck"), table.toBuffer(), Buffer.from([0, 0])]);
const hand = (i) => pda([Buffer.from("hand"), table.toBuffer(), Buffer.from([0, 0]), Buffer.from([i])]);
const permission = (acc) => pda([Buffer.from("permission:"), acc.toBuffer()], PERMISSION_PROGRAM);
const commitPayer = pda([Buffer.from("commit_payer"), table.toBuffer()]);

const { token } = await getAuthToken(env.ER_BASE_URL, deployer.publicKey, async (msg) => (await import("tweetnacl")).default.sign.detached(msg, deployer.secretKey));
const er = new Connection(`${env.ER_BASE_URL}?token=${token}`, { commitment: "confirmed", fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(25000) }) });
const program = new anchor.Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(deployer), { commitment: "confirmed" }));

const ix = await program.methods.initPermissions().accounts({
  table, deck,
  hand0: hand(0), hand1: hand(1), hand2: hand(2), hand3: hand(3), hand4: hand(4),
  hand5: hand(5), hand6: hand(6), hand7: hand(7), hand8: hand(8),
  permissionDeck: permission(deck),
  permissionHand0: permission(hand(0)), permissionHand1: permission(hand(1)),
  permissionHand2: permission(hand(2)), permissionHand3: permission(hand(3)),
  permissionHand4: permission(hand(4)), permissionHand5: permission(hand(5)),
  permissionHand6: permission(hand(6)), permissionHand7: permission(hand(7)),
  permissionHand8: permission(hand(8)),
  vault: EPHEMERAL_VAULT, commitPayer, admin: deployer.publicKey,
}).instruction();

const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
tx.feePayer = deployer.publicKey;
tx.recentBlockhash = (await er.getLatestBlockhash("confirmed")).blockhash;
tx.sign(deployer);
const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
const t0 = Date.now();
for (;;) {
  const st = await er.getSignatureStatuses([sig]);
  const s = st.value[0];
  if (s?.err) { console.log(`✗ init_permissions t#${TABLE_ID}: ${JSON.stringify(s.err)}`); process.exit(1); }
  if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") break;
  if (Date.now() - t0 > 60000) { console.log("确认超时"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 700));
}
console.log(`✓ 桌 #${TABLE_ID} init_permissions: ${sig.slice(0, 16)}…`);
