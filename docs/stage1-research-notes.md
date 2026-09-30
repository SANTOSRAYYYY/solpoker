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
