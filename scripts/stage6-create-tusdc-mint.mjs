// One-off: create the tUSDC mint on devnet (classic SPL, 6 decimals,
// mint authority = deployer). The keypair determines the mint address.
import fs from "node:fs";
import { Connection, Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, MINT_SIZE, createInitializeMint2Instruction } from "@solana/spl-token";

const l1 = new Connection("http://127.0.0.1:8898/devnet", "confirmed");
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/deployer.json", "utf8")))
);
const mintKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("keys/tusdc-mint.json", "utf8")))
);
console.log("mint:", mintKp.publicKey.toBase58());

if (await l1.getAccountInfo(mintKp.publicKey)) {
  console.log("… mint already exists");
  process.exit(0);
}
const rent = await l1.getMinimumBalanceForRentExemption(MINT_SIZE);
const tx = new Transaction().add(
  SystemProgram.createAccount({
    fromPubkey: deployer.publicKey,
    newAccountPubkey: mintKp.publicKey,
    lamports: rent,
    space: MINT_SIZE,
    programId: TOKEN_PROGRAM_ID,
  }),
  createInitializeMint2Instruction(mintKp.publicKey, 6, deployer.publicKey, null)
);
tx.feePayer = deployer.publicKey;
tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
tx.sign(deployer, mintKp);
const sig = await l1.sendRawTransaction(tx.serialize());
await l1.confirmTransaction(sig, "confirmed");
console.log("✓ tUSDC mint created:", sig);
