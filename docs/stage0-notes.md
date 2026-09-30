# Stage 0 notes (verified facts, 2026-09-30)

## Toolchain (installed + verified)
- rustc 1.89.0 (rustup, profile minimal + rustfmt/clippy); repo `rust-toolchain.toml` = 1.89.0. No MSRV errors in the first build.
- solana-cli 3.1.10 (Agave), installed via `https://release.anza.xyz/v3.1.10/install`. platform-tools v1.52 downloaded on first build.
- anchor-cli 1.0.2: prebuilt binary `https://github.com/solana-foundation/anchor/releases/download/v1.0.2/anchor-1.0.2-x86_64-unknown-linux-gnu` (published 2026-05-02), sha256 `51c158a7b66db6d9802afe59cd73e6d78928791114b55567de5c0732e88770eb`. No checksum asset is published upstream.
- node v24.21.0 (LTS Krypton), tarball sha256 verified against `https://nodejs.org/dist/v24.21.0/SHASUMS256.txt`. npm 11.19.0.
- Env script: `~/.solpoker-env` (PATH for node24, anchor, solana, cargo); sourced from `~/.bashrc`.
- Local stack: `npm i -g @magicblock-labs/ephemeral-validator@0.14.10` -> bins mb-stack, mb-test-validator, ephemeral-validator (magicblock-config 0.14.10), vrf-oracle 0.4.1, rpc-router, query-filtering-service.
  - mb-stack ports: base 8899/8900, ER 7799/7800, QFS (public entry) 6699/6700. Env overrides MB_STACK_{PUBLIC,ER,BASE}_PORT, MB_STACK_ER_REMOTES. Extra CLI args are forwarded to solana-test-validator (so `--help` starts the stack).
  - mb-test-validator preloads programs: DELeGG (delegation), noopb9bk, Vrf1RNUj (VRF), ACLseo (permission), SPLxh1LV, Enhkomtz, DmnRGfyy, KeyspM2s; accounts incl. mAGic… (local ER identity), VRF queues Cuj97…, 5hBR5…, GKE6d…, Sc9MJ…
  - Official local test script: public ER examples use ER 7799 directly; TEE examples go through QFS 6699.

## Versions resolved in the repo
- Cargo: anchor-lang =1.0.2 (single version in tree), ephemeral-rollups-sdk =0.17.3, ephemeral-vrf-sdk 0.17.3, magicblock-delegation-program-api 3.1.0, magicblock-magic-program-api 0.10.1. solana-program: v3.0.0 (x4) and v2.3.0 (x1, pulled by an SDK dep — to be identified).
- npm: @anchor-lang/core 1.0.2 (1.0.3 exists; `^1.0.2` resolved to 1.2.0 so we pin exact), @anchor-lang/borsh 1.0.2 and @anchor-lang/errors 1.0.2 via `resolutions`, @magicblock-labs/ephemeral-rollups-sdk 0.17.3, @solana/web3.js 1.98.4, tweetnacl 1.0.3.
- `anchor init --test-template mocha` default package manager: yarn. Template `rust-toolchain.toml` pinned 1.89.0.

## Keys / IDs
- deployer 541kpQWNTnAGG2Lie54D3qqhLvNJ5UKKpJPFyoi1P33H — devnet balance 100 SOL (tx 5hQKBwo7z4Mpysw9cn4yWU9fZLdxSBYpMm1FZEWXf7vna5XArPNbTGyWcLnCmWbpawDq4wpdwYscBaV5tNq8oB23, slot 505804744, from 9k16F6fmbFBUiQ3xCthTofCVaj72bBETYRxYE5nonNBZ).
- solpoker program EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf; smoke program (throwaway) BU1Ad3zgoJWrP11kZTzomMTJtebVGYdVweMjkQHtfQW4; tUSDC mint 9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH.
- GitHub: SANTOSRAYYYY/solpoker exists, PRIVATE, empty (created 2026-09-30T05:26:02Z).

## SDK 0.17.3 API facts (from source / d.ts)
- Rust: `ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, action, ephemeral_accounts, vrf, vrf_callback}`; `cpi::DelegateConfig { commit_frequency_ms: u32, validator: Option<Pubkey> }` (default from DelegateAccountArgs); `ephem::MagicIntentBundleBuilder::new(payer, magic_context, magic_program)` -> `.commit(&[..])` / `.commit_and_undelegate(&[..])` -> `.build_and_invoke()`; optional `.magic_fee_vault(acc)` "required when the payer is delegated".
- `#[delegate]` on a field `x` with `del` generates `delegate_x(&self, payer, seeds, config)` and adds buffer / delegation_record / delegation_metadata / owner_program / delegation_program / system_program accounts.
- `#[commit]` adds `magic_program: Program<MagicProgram>` and `magic_context` (mut, address = MAGIC_CONTEXT_ID).
- `#[ephemeral]` adds `process_undelegation(ctx, account_seeds: Vec<Vec<u8>>)` (undelegate-buffer PDA).
- TS: `GetCommitmentSignature(sig, erConnection): Promise<string>`; `getAuthToken(rpcUrl, publicKey, signMessage, template?) -> {token, expiresAt}`; `verifyTeeRpcIntegrity(rpcUrl)`, `verifyTeeIntegrity(rpcUrl)`, `waitUntilPermissionActive(rpcUrl, pubkey, timeout?)`, `createDelegatePermissionInstruction`, `delegationRecordPdaFromDelegatedAccount(pda)`; consts DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID, PERMISSION_PROGRAM_ID. SDK deps include @phala/dcap-qvl ^0.3.9 (attestation).
- Delegation program api 3.1.0: DelegationRecord = disc(8) | authority(32, = validator) | owner(32) | delegation_slot u64 | lamports u64 | commit_frequency_ms u64. PDA tags: "delegation", "delegation-metadata", "state-diff", "commit-state-record", "buffer", "undelegate-buffer", "undelegation-request", "v-fees-vault", "p-conf", "magic-fee-vault".

## x402 (researched for Stage 8)
- Spec: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md — payment = exactly one TransferChecked to ATA(payTo, asset); fast path allows only ComputeBudget(limit, price) + TransferChecked + up to 3 Lighthouse/Memo + Memo (3–7 ixs); extra.memo ≤256 bytes must match; fee payer must not appear in any ix accounts; facilitator should keep a 120 s duplicate-settlement cache.
- Solana guide: https://solana.com/docs/payments/agentic-payments/x402 — V2 headers PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE; devnet CAIP-2 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`; devnet USDC 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU.
- npm @x402/core, @x402/svm, @x402/express, @x402/fetch, @x402/mcp, @x402/hono = 2.28.0 (2026-09-29). @x402/svm peer @solana/kit >=5.1.0. @x402/mcp: `createPaymentWrapper` (server), `createx402MCPClient` (client).
- CDP hosted facilitator rejected valid exact-SVM payments 2026-08-23..26: https://github.com/x402-foundation/x402/issues/3268
