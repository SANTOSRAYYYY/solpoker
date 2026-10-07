// SolPoker chain client: PDA helpers, instruction builders, tx senders.
//
// Key rules learned in Stage 6 (CHANGELOG):
// - every ER game-loop tx MUST carry ComputeBudget setComputeUnitLimit(ER_CU)
//   — advance's deal path alone measured 421k CUs against the 200k default;
// - ER txs MUST skipPreflight — the TEE's simulateTransaction rejects
//   writable loads of PER-private accounts for non-member signers while
//   execution accepts them;
// - the TEE never returns tx logs; surface errors via getSignatureStatuses.

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
import {
  PROGRAM_ID,
  IDL,
  TABLE_ID,
  TUSDC_MINT,
  ER_VRF_QUEUE,
  PERMISSION_PROGRAM,
  ER_CU,
} from "./config";

// ---------- PDAs ----------
const u32le = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const pda = (seeds: Uint8Array[], program: PublicKey = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

export const pdas = (() => {
  const table = pda([u8s("table"), u32le(TABLE_ID)]);
  return {
    table,
    vaultAuth: pda([u8s("vault_auth"), table.toBytes()]),
    game: pda([u8s("game"), table.toBytes()]),
    handProof: pda([u8s("proof"), table.toBytes()]),
    handSecrets: pda([u8s("secrets"), table.toBytes()]),
    deck: pda([u8s("deck"), table.toBytes(), new Uint8Array([0, 0])]),
    commitPayer: pda([u8s("commit_payer"), table.toBytes()]),
    seat: (i: number) => pda([u8s("seat"), table.toBytes(), new Uint8Array([i])]),
    hand: (i: number) =>
      pda([u8s("hand"), table.toBytes(), new Uint8Array([0, 0]), new Uint8Array([i])]),
    permission: (acc: PublicKey) =>
      pda([u8s("permission:"), acc.toBytes()], PERMISSION_PROGRAM),
  };
})();

function u8s(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------- anchor program (read/instruction building only) ----------
export function makeProgram(conn: Connection): anchor.Program {
  const wallet = {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async <T,>(t: T) => t,
    signAllTransactions: async <T,>(t: T[]) => t,
  } as anchor.Wallet;
  return new anchor.Program(
    IDL as anchor.Idl,
    new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" })
  );
}

// ---------- tx send ----------
export class TxError extends Error {
  constructor(
    message: string,
    public readonly errJson?: string
  ) {
    super(message);
  }
}

/**
 * Send + confirm. ER sends must pass cu (adds the budget ix) and always use
 * skipPreflight (TEE simulate/execute asymmetry). Throws TxError with the
 * on-chain error JSON on failure.
 */
export async function sendAndConfirm(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  label: string,
  cu: number | null = null
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const tx = new Transaction();
    if (cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
    tx.add(...ixs);
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(...signers);
    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
    const t0 = Date.now();
    for (;;) {
      const st = await conn.getSignatureStatuses([sig]);
      const s = st.value[0];
      if (s?.err) {
        const errStr = JSON.stringify(s.err);
        // devnet-tee backends are inconsistent about PER writable-load checks;
        // a bare InvalidWritableAccount is transient — retry a few times.
        if (errStr.includes("InvalidWritableAccount") && attempt < 4) {
          await sleep(1200);
          break;
        }
        throw new TxError(`${label} failed: ${errStr}`, errStr);
      }
      if (
        s?.confirmationStatus === "confirmed" ||
        s?.confirmationStatus === "finalized"
      ) {
        return sig;
      }
      if (Date.now() - t0 > 90000) {
        throw new TxError(`${label} confirmation timeout`);
      }
      await sleep(700);
    }
  }
}

/**
 * L1 send where the WALLET (Privy) signs instead of a local keypair. The
 * caller serializes the unsigned tx, the wallet signs it, we broadcast.
 */
export async function sendWalletSigned(
  conn: Connection,
  signedBytes: Uint8Array,
  label: string
): Promise<string> {
  const sig = await conn.sendRawTransaction(signedBytes, {
    skipPreflight: false,
  });
  const t0 = Date.now();
  for (;;) {
    const st = await conn.getSignatureStatuses([sig]);
    const s = st.value[0];
    if (s?.err) throw new TxError(`${label} failed: ${JSON.stringify(s.err)}`);
    if (
      s?.confirmationStatus === "confirmed" ||
      s?.confirmationStatus === "finalized"
    ) {
      return sig;
    }
    if (Date.now() - t0 > 90000) throw new TxError(`${label} confirmation timeout`);
    await sleep(700);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- instruction builders ----------
export async function ixCommitSalt(
  program: anchor.Program,
  idx: number,
  handId: bigint,
  commitment: Uint8Array,
  signer: PublicKey
) {
  return program.methods
    .commitSalt(idx, new BN(handId.toString()), Array.from(commitment))
    .accounts({
      table: pdas.table,
      game: pdas.game,
      seatLedger: pdas.seat(idx),
      signer,
    })
    .instruction();
}

export async function ixRevealSalt(
  program: anchor.Program,
  idx: number,
  handId: bigint,
  salt: Uint8Array,
  signer: PublicKey
) {
  return program.methods
    .revealSalt(idx, new BN(handId.toString()), Array.from(salt))
    .accounts({
      table: pdas.table,
      seatLedger: pdas.seat(idx),
      playerHand: pdas.hand(idx),
      signer,
    })
    .instruction();
}

export type ActKind = "fold" | "check" | "call" | "bet" | "raiseTo" | "allIn";

export async function ixAct(
  program: anchor.Program,
  idx: number,
  handId: bigint,
  actionSeq: number,
  action: ActKind,
  amount: bigint | null,
  signer: PublicKey
) {
  const normalized = normalizeActionArg(action, amount);
  return program.methods
    .act(idx, new BN(handId.toString()), actionSeq, normalized)
    .accounts({
      table: pdas.table,
      game: pdas.game,
      seatLedger: pdas.seat(idx),
      signer,
    })
    .instruction();
}

function normalizeActionArg(action: ActKind, amount: bigint | null) {
  const bn = new BN((amount ?? 0n).toString());
  switch (action) {
    case "fold":
      return { fold: {} };
    case "check":
      return { check: {} };
    case "call":
      return { call: {} };
    case "allIn":
      return { allIn: {} };
    // anchor-ts: tuple variants are arrays (Bet(u64) → { bet: [bn] })
    case "bet":
      return { bet: [bn] };
    case "raiseTo":
      return { raiseTo: [bn] };
  }
}

export async function ixStandUp(
  program: anchor.Program,
  idx: number,
  signer: PublicKey,
  extra: { permission: PublicKey; commitPayer: PublicKey; vault: PublicKey }
) {
  return program.methods
    .standUp(idx)
    .accounts({
      table: pdas.table,
      game: pdas.game,
      seatLedger: pdas.seat(idx),
      playerHand: pdas.hand(idx),
      permission: extra.permission,
      commitPayer: extra.commitPayer,
      vault: extra.vault,
      signer,
    })
    .instruction();
}

export { SystemProgram, TUSDC_MINT, ER_VRF_QUEUE };
