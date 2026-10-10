// Stage 2 on-chain acceptance: end-to-end VRF path on devnet-tee.
//
// Flow (design §9 / §17 S2):
//   1. create_table (L1)        — test-harness instruction
//   2. delegate_game (L1)       — Game + Deck → TEE validator MTEW…
//   3. getAuthToken (TEE)       — deployer signs the challenge
//   4. debug_arm_vrf (ER)       — arm slot for Flop (test harness)
//   5. request_vrf (ER)         — queue 5hBR… CPI
//   6. poll Game on ER          — Fulfilled, then Deck.vrf_out filled
//
// All sends are sendRawTransaction + signature-status polling (§13.3).
// Network: L1 via relay 127.0.0.1:8899, ER via relay 127.0.0.1:7799 (this
// machine only reaches external hosts through the system proxy; the relays
// tunnel + rewrite Host).
//
// Usage: node scripts/stage2-vrf-e2e.mjs [tableId]
// Run from the repo root (uses root node_modules).

import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmRawTransaction } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

const L1_URL = process.env.L1_URL ?? "http://127.0.0.1:8898/devnet";
const ER_BASE = process.env.ER_BASE ?? "http://127.0.0.1:7799";
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const ER_VRF_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const TABLE_ID = Number(process.argv[2] ?? 42);

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);

const l1 = new Connection(L1_URL, "confirmed");
const provider = new anchor.AnchorProvider(l1, new anchor.Wallet(deployer), {
  commitment: "confirmed",
});
const program = new anchor.Program(idl, provider);

const tableIdBuf = Buffer.alloc(4);
tableIdBuf.writeUInt32LE(TABLE_ID);
const [table] = PublicKey.findProgramAddressSync([Buffer.from("table"), tableIdBuf], programId);
const [game] = PublicKey.findProgramAddressSync([Buffer.from("game"), table.toBuffer()], programId);
const [deck] = PublicKey.findProgramAddressSync(
  [Buffer.from("deck"), table.toBuffer(), Buffer.from([0, 0])],
  programId
);

async function sendAndConfirm(connection, ixs, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = deployer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(deployer);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const t0 = Date.now();
  for (;;) {
    const st = await connection.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
      console.log(`✓ ${label}: ${sig} (${Date.now() - t0}ms)`);
      return sig;
    }
    if (Date.now() - t0 > 120000) throw new Error(`${label} confirmation timeout`);
    await new Promise((r) => setTimeout(r, 800));
  }
}

const GAME_DISC = 8;
function decodeGameState(data) {
  // Game layout: disc(8) table(32) hand_id(8) board(5) board_len(1)
  //              vrf{state(1) target(1) attempt(1) requested_at(8)} seats(216)
  const o = GAME_DISC + 32 + 8 + 5 + 1;
  const states = ["Idle", "Ready", "Pending", "Fulfilled", "Void"];
  return {
    handId: data.readBigUInt64LE(GAME_DISC + 32),
    state: states[data.readUInt8(o)] ?? `?${data.readUInt8(o)}`,
    target: data.readUInt8(o + 1),
    attempt: data.readUInt8(o + 2),
  };
}
function decodeDeckVrfOut(data, idx) {
  // Deck layout: disc(8) hand_id(8) vrf_out(5×32) vrf_attempt_used(5)
  const off = GAME_DISC + 8 + idx * 32;
  return data.subarray(off, off + 32);
}

console.log(`table_id=${TABLE_ID}`);
console.log(`table=${table.toBase58()}`);
console.log(`game =${game.toBase58()}`);
console.log(`deck =${deck.toBase58()}`);

// ---- 1. create_table (skip if already created) ----
const existing = await l1.getAccountInfo(table);
if (existing) {
  console.log("… table already exists, skipping create_table");
} else {
  const ix = await program.methods
    .createTable(TABLE_ID)
    .accounts({ table, game, deck, admin: deployer.publicKey })
    .instruction();
  await sendAndConfirm(l1, [ix], "create_table (L1)");
}

// ---- 2. delegate_game (skip if game already delegated) ----
const gameInfo = await l1.getAccountInfo(game);
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
if (gameInfo && gameInfo.owner.equals(DLP)) {
  console.log("… game already delegated, skipping delegate_game");
} else {
  const ix = await program.methods
    .delegateGame(TEE_VALIDATOR)
    .accounts({ table, game, deck, admin: deployer.publicKey })
    .instruction();
  await sendAndConfirm(l1, [ix], "delegate_game (L1 → MTEW…)");
}

// ---- 3. TEE auth token ----
const { token, expiresAt } = await getAuthToken(
  ER_BASE,
  deployer.publicKey,
  async (msg) => {
    // deployer signs the challenge bytes directly
    const sig = (await import("tweetnacl")).default.sign.detached(msg, deployer.secretKey);
    return sig;
  }
);
console.log(`✓ TEE token (expires ${new Date(expiresAt * 1000).toISOString()})`);
const er = new Connection(`${ER_BASE}?token=${token}`, "confirmed");

// ---- 4. arm ----
// 2026-10-10（审计 P1-9）：debug_arm_vrf 已从生产程序删除（可被 admin 用来
// 把手牌卡死在 AwaitSeed）。本脚本是 stage-2 遗留 harness，需改用 advance 的
// 正常 phase 流程 arm——在此之前无法继续。
throw new Error("debug_arm_vrf 已于 2026-10-10 移除（审计 P1-9）：stage2 harness 需改写为 advance 流程");

// ---- 5. request_vrf ----
const tRequest = Date.now();
{
  const ix = await program.methods
    .requestVrf()
    .accounts({ table, game, payer: deployer.publicKey, vrf: { oracleQueue: ER_VRF_QUEUE } })
    .instruction();
  await sendAndConfirm(er, [ix], "request_vrf (ER, queue 5hBR…)");
}

// ---- 6. poll for fulfillment ----
let fulfilled = false;
for (let i = 0; i < 60; i++) {
  const acc = await er.getAccountInfo(game);
  if (!acc) throw new Error("game account vanished on ER");
  const g = decodeGameState(acc.data);
  if (g.state === "Fulfilled") {
    fulfilled = true;
    const latency = Date.now() - tRequest;
    console.log(`✓ VRF fulfilled in ${latency}ms (state=${g.state}, attempt=${g.attempt})`);
    const deckAcc = await er.getAccountInfo(deck);
    const rnd = decodeDeckVrfOut(deckAcc.data, 1);
    const isZero = rnd.every((b) => b === 0);
    console.log(`✓ Deck.vrf_out[Flop] filled: ${!isZero} (first 8 bytes: ${Buffer.from(rnd.slice(0, 8)).toString("hex")})`);
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!fulfilled) {
  console.error("✗ VRF fulfillment timeout (60s)");
  process.exit(1);
}
console.log("STAGE2_VRF_E2E_OK");
