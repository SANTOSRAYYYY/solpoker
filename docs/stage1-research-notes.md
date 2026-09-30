# Stage 1 research notes (verified facts, 2026-09-30)

## Delegation program (DLP) fees — source: github.com/magicblock-labs/delegation-program, tag v3.1.0 == HEAD fb6668c for these lines
- `dlp-api/src/consts.rs`: COMMIT_FEE_LAMPORTS = 100_000; SESSION_FEE_LAMPORTS = 300_000; PROTOCOL_FEES_PERCENTAGE = 10; RENT_FEES_PERCENTAGE = 10; DEFAULT_UNDELEGATION_REQUEST_TIMEOUT_SLOTS = 9000.
- Fees are charged ONLY at undelegation, per delegated account: `src/processor/fast/undelegate.rs::process_delegation_cleanup`:
  commit_count = delegation_metadata.last_commit_id.saturating_sub(1); fee = 100_000 * commit_count + 300_000;
  fee_remaining = fee.min(delegation_record.lamports + delegation_metadata.lamports)  -> capped by the rent of the two PDAs;
  taken from those PDAs on close; 10% to protocol fees vault, 90% to validator fees vault; the rest refunded to delegation rent payer.
- commit_state / commit_finalize / finalize charge no fee; finalize only settles lamports (settle_lamports_balance) and sets last_commit_id = commit_record.nonce.
- Rollback path (`undelegate_with_rollback_after_timeout.rs`) closes request/record/metadata with plain `close_pda` -> NO fee, full rent back to rent payer; pending commit state/record closed to commit reimbursement account.
- DelegationRecord = disc 8 | authority 32 | owner 32 | delegation_slot 8 | lamports 8 | commit_frequency_ms 8 = 96 B.
  DelegationMetadata = disc 8 | last_commit_id u64 | undelegation_requester u8 | seeds Vec<Vec<u8>> (borsh) | rent_payer 32.
- Stage 0 measurement consistent: smoke counter record+metadata rent = 2,326,640 lamports; 2 commits -> fee 400,000; refund 1,926,640.
- devnet rent now: getMinimumBalanceForRentExemption(0) = 650,240 = 128 * 5,080 -> (bytes + 128) * 5,080 lamports. (64 B -> 975,360; 102 B -> 1,168,400; 165 B -> 1,488,440.)
- magic program api 0.10.1 (ER side): "If the payer account is delegated, a callback fee is deducted from it" (AddActionCallback). SDK MagicIntentBundleBuilder::magic_fee_vault(): "Required when the payer is delegated".

## Escape hatch — RequestUndelegation (disc 26) / UndelegateWithRollbackAfterTimeout (disc 27)
- Discriminator encoding: u8 enum value as u64 little-endian, 8 bytes.
- RequestUndelegation accounts: 0 [signer, writable] delegation rent payer (MUST equal metadata.rent_payer, else InvalidReimbursementAddressForDelegationRent); 1 [signer] delegated account (PDA, off-curve, owned by DLP); 2 [] owner program; 3 [writable] undelegation request PDA ["undelegation-request", delegated]; 4 [] delegation record; 5 [writable] delegation metadata; 6 [] system program. Creates UndelegationRequest {delegated_account, expires_at_slot = now + 9000}; sets metadata.undelegation_requester = OwnerProgram. Idempotent if request exists.
- Rollback accounts: 0 [signer, writable] delegated account; 1 [] owner program; 2 [w] undelegation request; 3 [w] delegation record; 4 [w] delegation metadata; 5 [w] delegation rent payer; 6 [w] commit state PDA; 7 [w] commit record PDA; 8 [w] commit reimbursement. Authorized by owner-program CPI signing for the delegated account; returns last base-chain state; "might cause data-loss"; wrapper must preserve account data before invoking DLP and restore it after.
- ER 0.14.10 config has `chainlink.undelegation_request_poll_interval: 300s` (seen in local ER startup log) -> validator polls for owner requests.
- PROBE (scripts/probe_dlp.py, simulateTransaction sigVerify=false):
  - devnet (solana-core 4.3.0): disc 26 and 27 -> "Failed to read and parse discriminator" / InvalidInstructionData (same as unknown 250); disc 3 -> NotEnoughAccountKeys. => NOT supported.
  - mainnet-beta: identical result => NOT supported.
  - DLP programData Ew1j4p6jU82qmLFLJe2SVp5ZKoNokMP6J1Bf5LaZ6GyE: mainnet last deploy slot 416,508,270 (2026-04-29T20:13:13Z); devnet slot 458,511,904 (2026-04-27T20:38:44Z).
  - Local stack DLP dump (`@magicblock-labs/ephemeral-validator@0.14.10/bin/local-dumps/DELeGG....so`) is byte-identical to devnet DLP (459,416 B, sha256 prefix e940763c05d5151ac3f6) => local also lacks 26/27.

## MagicBlock endpoints (docs.magicblock.gg/pages/get-started/how-integrate-your-program/local-setup)
- Mainnet: as.magicblock.app MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57; eu.magicblock.app MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e; us.magicblock.app MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd; TEE mainnet-tee.magicblock.app MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo.
- Devnet: devnet-as / devnet-eu / devnet-us (same identities), TEE devnet-tee.magicblock.app MTEW...; local ER mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev.

## x402 exact SVM spec (github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md, fetched 2026-09-30)
- Outcome-based: tx MUST produce exactly one TransferChecked (spl-token or token-2022, top-level OR inner CPI) of >= amount of `asset` to ATA(payTo, asset). Overpayment tolerated; zero or >1 matching transfers -> reject. Extra instructions allowed subject to Sponsor Acceptance Policy.
- PaymentRequirements.extra: feePayer (required), memo (optional, <=256 B; client MUST use it as Memo data; facilitator MUST verify exactly one Memo matching), recentBlockhash, lastValidBlockHeight (hints).
- Sponsor MUSTs: feePayer not in any instruction's accounts nor program; not authority/source/delegate; resolve ALTs; no debit beyond network fee; no extra required signers beyond client + feePayer.
- Sponsor SHOULDs: CU limit <= 400,000, priority <= 50,000 microlamports (fast path <= 5 lamports/CU); only SetComputeUnitLimit(2)/SetComputeUnitPrice(3); program allowlist for simulation path (Squads v4, Squads Smart Account, Swig, Swig v2, SPL Governance, Metaplex Core, Lighthouse); ComputeBudget + Memo exempt; "Operators MAY override the allowlist"; simulate before signing.
- Reference facilitator @x402/svm ExactSvmScheme(signer, undefined, {enableSmartWalletVerification, smartWalletMaxComputeUnits, smartWalletMaxPriorityFeeMicroLamports, smartWalletAllowedPrograms}).
  Path 1 fast path: 3–7 ixs in order: SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked, up to 3 Lighthouse/Memo, Memo. Memo (extra.memo or >=16-byte random hex nonce) required for uniqueness.
  Path 2 (smart wallet, opt-in): fee payer isolation, CU caps, allowlisted wrapping program, memo enforcement, simulate with innerInstructions, exactly one matching inner TransferChecked, sponsor not authority; post-settlement MUST confirm on-chain (inner instructions, fallback ATA balance delta).
- SettlementResponse {success, transaction (sig), network, payer}. Payment flow `upfront` recommended for long-running handlers (blockhash ~60–90 s).
- Duplicate settlement: in-memory cache keyed by payload, evict after 120 s, reject "duplicate_settlement".
- npm @x402/core, svm, express, fetch, mcp all 2.28.0 (published 2026-09-29) — still latest on 2026-09-30.

## Rent (mainnet = devnet)
- getMinimumBalanceForRentExemption(0) = 650,240 on both mainnet-beta and devnet (2026-09-30) -> (bytes+128)*5,080.

## VRF queues on mainnet (2026-09-30)
- Same SDK constants on mainnet: DEFAULT_QUEUE Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh exists on mainnet (owner Vrf1RNUj...); DEFAULT_EPHEMERAL_QUEUE 5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc exists (owner DELeGG..., i.e. delegated).
- Delegation record of 5hBR57... (PDA F72HqCR8nwYsVyeVd38pgKkjXmXFzVAM8rjZZsXWbdE): validator = 11111111111111111111111111111111 (any validator) on both mainnet (delegation slot 384,817,225) and devnet (slot 426,250,209); owner program = VRF program. => ephemeral queue is addressable from any ER, including TEE.

## SDK 0.17.3 delegate CPI and PDA payers
- `sdk/src/cpi.rs::delegate_account_inner`: creates the buffer with `accounts.payer`, then `invoke_signed(..., pda_signer_seeds)` with ONLY the delegated PDA's seeds. A program-PDA payer (system-owned PDA) therefore needs a custom CPI that also passes the payer's seeds (build with magicblock-delegation-program-api 3.1.0 builders). Stage 3 spike.

## ER fee payer probe (2026-09-30, scripts/probe-er-feepayer.ts)
Smoke `increment` (authority = deployer co-signs) sent with different fee payers, the way a session key would pay:

| case | devnet-tee (ER 0.16.0) | local stack (ER 0.14.10 via QFS 6699) |
|---|---|---|
| A deployer (funded) | ok, fee 0 | ok, fee 0 |
| B fresh keypair, 0 lamports | **ok**, fee 0, `getTransaction` shows it as fee payer | **ok**, fee 0 |
| C fresh keypair with only the rent-exempt minimum (devnet 650,240 / local 890,880) | ok twice, balance unchanged | ok twice, balance unchanged |

- Conclusion today: both ER versions accept a zero-balance fee payer and charge 0 for ER transactions. The user reports that the ER does not accept zero-balance fee payers; we design conservatively (fund session keys, amount is a parameter) until MagicBlock confirms mainnet behaviour.
- devnet signatures: A `4HsmzeUQrdvAgQUwzag995AtCrdByFJQdjL2aYYff8YAke43JuobyLzVRJfcRDPDRQDPfX25BTNFTmBWUHVJw7pJ`, B `3wDQZk9jFnuWvkQsMxE9A7w6eG2YWpSQzceWZLeyUt8Kz6fprBU4ch1n7TzphAnFgXYxHzfBt1DfSnARrKt9eEcY`, C `621m5FG9KVvbzn2hbk63TH9by5J5YXjMmW4qVedPR7Ns8MCfAepzjFRmtunyyLS9b9si4r1Z4M18vJ14kBu9Xhb3`.
- Agave rule found on the way: the fee payer must stay rent-exempt after the fee is deducted (or end at exactly 0 through a transfer paid by someone else). An account funded with only the rent-exempt minimum cannot pay its own L1 fee; 0.001 SOL (1,000,000 lamports) leaves room for self-sweeping on both rent levels.
- Rent-exempt minimum for a 0-byte account: devnet/mainnet 650,240 lamports; local test validator (Agave 3.1.10) 890,880.
- The first devnet run lost 650,240 lamports (the throwaway key was not persisted and the sweep was wrong); fixed in the script, local re-run swept to 0.

## TEE endpoints (verified 2026-09-30 17:58 +08, JSON-RPC getIdentity / getVersion)
- https://mainnet-tee.magicblock.app -> identity MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo; magicblock-core 0.16.0, git e66d914, solana-core 4.0.0
- https://devnet-tee.magicblock.app  -> identity MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo; magicblock-core 0.16.0, git e66d914, solana-core 4.0.0
- Same validator identity and build on both clusters, so ProgramConfig.tee_validator is the same value on devnet and mainnet.

## VRF (verified 2026-09-30 from source; live behaviour is Stage 2)
Sources: ephemeral-rollups-sdk v0.17.3 `rust/vrf-sdk`, `rust/vrf-macro`; magicblock-labs/ephemeral-vrf HEAD 52b103c (2026-09-18) `program/src/*`, `api/src/consts.rs`.
- Request builders (vrf-sdk/src/instructions.rs): `create_request_randomness_ix` = scoped identity, regular priority (data[0] = 10); `create_request_high_priority_scoped_randomness_ix` = scoped, high priority (11); legacy global-identity variants 3 / 8 are deprecated.
- Request accounts: payer (signer, writable), `PDA(["identity"], callback_program)` (signer via invoke_signed), oracle_queue (writable), system program, slot_hashes sysvar.
- `RequestRandomnessParams { payer, oracle_queue, callback_program_id, callback_discriminator (<= 8 bytes), accounts_metas, caller_seed: [u8;32], callback_args: Option<Vec<u8>> }`.
- Request id = hashv(caller_seed, slot, slothash, callback_discriminator, callback_program_id, unix_timestamp, queue_idx); the oracle cannot choose the VRF input.
- Fulfillment (provide_randomness.rs): must land in a later slot than the request; proof verified on-chain (RFC 9381); the queue item is removed, then the callback is invoked with **data = callback_discriminator || randomness || callback_args**, where randomness = hash(vrf_output) (32 bytes). First callback account = scoped identity PDA `PDA(["identity", callback_program_id], Vrf1…)`, signed by the VRF program. => a request tag passed in `callback_args` comes back verbatim, so the callback can match it against the pending request.
- If the callback returns an error, the whole fulfillment tx fails and the queue item is NOT removed (it stays until TTL). => our callback must return Ok for stale / mismatched-but-authentic callbacks and simply ignore them; only a wrong identity signer should fail.
- `#[vrf]` injects `program_identity` (seeds ["identity"]) and `slot_hashes`, requires an `oracle_queue` field, and generates `invoke_signed_vrf(payer, &ix)`. `#[vrf_callback]` injects `vrf_program_identity: Signer` with `address = scoped_vrf_identity(&crate::ID)`.
- Queue TTL: `QUEUE_TTL_SECONDS = 120` (wall clock); `purge_expired_requests` removes older items. Paused queues reject new requests with `QueuePaused`.
- Fees: `VRF_LAMPORTS_COST = 500_000`, `VRF_HIGH_PRIORITY_LAMPORTS_COST = 800_000` lamports per request on L1 queues; **`DEFAULT_EPHEMERAL_QUEUE` (5hBR…) is always fee-exempt** (fees.rs `is_fee_exempt_ephemeral_queue`); the local test queue Sc9M… only with the `ephemeral-test-queue` feature.
- Local stack: `@magicblock-labs/ephemeral-validator@0.14.10` ships `vrf-oracle` 0.4.1 (`@magicblock-labs/vrf-oracle-linux-x64`, on PATH) but `mb-stack` does not start it. `mb-test-validator` preloads `Vrf1….so` and the queues Cuj97…, 5hBR…, GKE6…, Sc9M… from `bin/local-dumps`. The official test script starts two oracles: `RPC_URL=http://localhost:8899 WEBSOCKET_URL=ws://localhost:8900` and `RPC_URL=http://localhost:7799 WEBSOCKET_URL=ws://localhost:7800`, both with `VRF_ORACLE_SKIP_PREFLIGHT=true`.
