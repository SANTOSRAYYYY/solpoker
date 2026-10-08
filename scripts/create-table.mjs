// 一键建桌：新桌全流程引导（"换新桌"一条命令）。
//   create_table → create_seats → create_hands → init_replay → delegate ×15
//   → ER init_permissions
// 幂等：已存在的步骤自动跳过；完成后打印需要写入 web/.env.local 的桌号。
// 单桌逻辑在 scripts/lib/deploy-table.mjs（批量部署 scripts/deploy-tables.mjs 共用）。
//
// 用法: node scripts/create-table.mjs <tableId> [sb=0.1] [bb=0.2] [ante=0.02] [kind=0]
// 例:   node scripts/create-table.mjs 10
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { L1_RPC, ER_BASE_URL } from "./env.mjs";
import { deployTable } from "./lib/deploy-table.mjs";

const TABLE_ID = Number(process.argv[2]);
if (!Number.isInteger(TABLE_ID)) {
  console.error("用法: node scripts/create-table.mjs <tableId> [sb] [bb] [ante] [kind]");
  console.error("      kind: 0=真人桌（默认）1=AI 桌 2=混合桌");
  process.exit(1);
}
const SB = Number(process.argv[3] ?? 0.1);
const BB = Number(process.argv[4] ?? 0.2);
const ANTE = Number(process.argv[5] ?? 0.02);
const KIND = Number(process.argv[6] ?? 0);

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);

const l1 = new Connection(L1_RPC, {
  commitment: "confirmed",
  fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(30000) }),
});
const prog = (conn) =>
  new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" }));

if (!(await l1.getAccountInfo(config))) {
  const [delegPayer] = PublicKey.findProgramAddressSync([Buffer.from("deleg_payer")], programId);
  const { TEE_VALIDATOR } = await import("./lib/deploy-table.mjs");
  const ix = await prog(l1).methods
    .initConfig(deployer.publicKey, TEE_VALIDATOR, deployer.publicKey)
    .accounts({ config, delegPayer, admin: deployer.publicKey })
    .instruction();
  const { sendAndConfirm } = await import("./lib/deploy-table.mjs");
  await sendAndConfirm(l1, [ix], [deployer], "init_config (L1)");
} else console.log("… config exists");

const nacl = (await import("tweetnacl")).default;
const er = new Connection(
  `${ER_BASE_URL}?token=${await getAuthToken(ER_BASE_URL, deployer.publicKey, async (msg) =>
    nacl.sign.detached(msg, deployer.secretKey)
  )}`,
  "confirmed"
);

const { created } = await deployTable({
  id: TABLE_ID, sb: SB, bb: BB, ante: ANTE, kind: KIND,
  conns: { l1, er },
  programs: { l1: prog(l1), er: prog(er) },
  programId, deployer, idl,
  log: (s) => console.log(s),
});

console.log(
  `\n✅ 桌 #${TABLE_ID} 就绪（盲注 ${SB}/${BB}，ante ${ANTE}，kind ${KIND}${created ? "" : "，补齐全流程"}）`
);
console.log(`提示：把 #${TABLE_ID} 加进 crank 与大厅白名单：`);
console.log(`  1) 重启 crank: node scripts/crank.mjs 5,6,7,8,9,${TABLE_ID}`);
console.log(`  2) web/.env.local: NEXT_PUBLIC_TABLE_IDS=5,6,7,8,9,${TABLE_ID}`);
console.log(`批量部署 15 桌: node scripts/deploy-tables.mjs --check`);
