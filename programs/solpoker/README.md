# solpoker — Stage 2 slice: VRF in the TEE Ephemeral Rollup

Anchor 1.0.2 program slice implementing design `solpoker-stage1-design.md`
§9 (VRF 集成), §6.2 (由谁推进 / V1 拆分), §14.2 (ER 指令清单), §15 (日志纪律).
Only the VRF path is implemented; dealing, betting and settlement land in
Stage 4/5 on top of `solpoker-core`.

## Build

```bash
anchor build --ignore-keys
```

- `--ignore-keys` replaces the placeholder `declare_id!` with a generated
  keypair. Re-deploys must keep the program id stable, or every PDA
  (`["game", table]`, `["deck", table, epoch]`, the scoped VRF identity) changes.
- `Cargo.toml` pins `anchor-lang = "=1.0.2"`, `ephemeral-rollups-sdk = "=0.17.3"`
  (features `anchor`, `access-control`, `vrf`), `rust-version = "1.89"`.
  Do not relax the SDK pin without re-verifying signatures against the
  published crate sources (see below).

## VRF queues

| Network        | Queue address |
|----------------|---------------|
| devnet / mainnet ER | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` |
| local stack    | `Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT` |

Both are constants in the SDK
(`ephemeral-rollups-sdk-0.17.3/src/consts.rs` re-exported from
`ephemeral-vrf-sdk-0.17.3/src/consts.rs`:
`DEFAULT_EPHEMERAL_QUEUE`, `DEFAULT_EPHEMERAL_TEST_QUEUE`). The ER queue is
free per design §9; requests expire after 120 s TTL.

## SDK 出处 (signatures were verified against these files, not memory)

Downloaded from `https://static.crates.io/` and extracted locally:

- `ephemeral-rollups-sdk-0.17.3/src/vrf.rs` — `pub mod vrf` re-exports
  `ephemeral_vrf_sdk::*` behind feature `vrf`.
- `ephemeral-rollups-sdk-0.17.3/src/lib.rs` — `pub fn id()` (delegation
  program id, used for the `owner` constraint of delegated accounts).
- `ephemeral-vrf-sdk-0.17.3/src/instructions.rs` —
  `create_request_randomness_ix(params: RequestRandomnessParams) -> compat::Instruction`,
  `RequestRandomnessParams { payer, oracle_queue, callback_program_id,
  callback_discriminator, accounts_metas, caller_seed, callback_args }`.
- `ephemeral-vrf-sdk-0.17.3/src/consts.rs` — `VRF_PROGRAM_ID
  (Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz)`,
  `scoped_vrf_identity(callback_program_id) -> Pubkey` (PDA `["identity",
  callback_program_id]`), queue constants.
- `ephemeral-vrf-sdk-0.17.3/src/types.rs` — `SerializableAccountMeta`
  (`pubkey`, `is_signer`, `is_writable`); fulfillment ix data is
  `discriminator ‖ randomness ‖ callback_args`.
- `ephemeral-vrf-sdk-vrf-macro-0.17.3/src/lib.rs` — `#[vrf]` (requires an
  `oracle_queue` field; generates `invoke_signed_vrf(&self, payer: &AccountInfo,
  ix: &Instruction)`; maps the request discriminator to the scoped variant 10)
  and `#[vrf_callback]` (place ABOVE `#[derive(Accounts)]`; injects
  `vrf_program_identity: Signer` constrained to `scoped_vrf_identity(&crate::ID)`).
- `MagicIntentBundleBuilder` (needed in Stage 3 for commits, not used here)
  lives in `ephemeral-rollups-sdk-0.17.3/src/ephem/mod.rs`.

Note: there are **no** separate `ephemeral-rollups-sdk-vrf` /
`-attribute-vrf` crates on crates.io at 0.17.3 — VRF support is the `vrf`
feature of the main crate plus `ephemeral-vrf-sdk-vrf-macro`.

## Architecture notes

- **V1 拆分 (§6.2)**: `advance` only arms the slot (Ready) via
  `solpoker_core::vrf::VrfSlot::arm`; the permissionless `request_vrf` sends
  the queue CPI and atomically sets Pending. A failed CPI reverts only
  `request_vrf` — the poker action from the earlier tx stays committed and the
  slot stays armed.
- **Delegation**: all rules (arm idempotence, request-requires-Ready,
  stale-callback ignore, retry/void) live in `solpoker-core`
  (`crates/solpoker-core/src/vrf.rs`). The on-chain `Game.vrf` is a
  serializable mirror *without* randomness (secrets only in the private Deck);
  handlers replay it into a core slot, run the transition, and sync back.
- **Secrets (§15)**: `vrf_callback` writes randomness only into `Deck`
  (private, members = []); nothing secret is ever logged or put in public
  accounts. One `#[error_code]`, category-only messages.
- Attempt numbering is **1-based** and target encoding is Preflop=0..Runout=4,
  matching the pinned CI vector in solpoker-core.

## Unit tests (run without a validator)

```bash
cargo test            # in programs/solpoker: caller_seed pinned-vector parity
                      # with solpoker-core, callback_args roundtrip/rejection
cargo test            # in crates/solpoker-core: full VrfSlot state machine
```

## What MUST run on the local stack (MagicBlock ER + VRF queue Sc9M…)

1. **arm → request → callback happy path** through the real queue, including
   the scoped-identity signature check (`#[vrf_callback]` rejects a wrong
   signer PDA).
2. **Queue failure path**: force a failure (e.g. paused queue) and confirm
   `request_vrf` reverts while the slot armed by a previous `advance` stays
   Ready (V1 拆分).
3. **Stale-callback ignore**: deliver a callback for an old attempt after a
   retry; the tx must succeed and change nothing.

## Stage 2 必测的三件事 (acceptance measurements)

1. **延迟 p50/p95**: request_vrf tx confirmed → vrf_callback tx confirmed, on
   devnet-tee (queue `5hBR…`). Feeds the Table timeout defaults (E1).
2. **超时重试**: after `vrf_timeout_s` (10 s) without callback, `retry_vrf`
   succeeds, attempt increments, caller_seed changes, a new request lands;
   late old-attempt callbacks are ignored. Repeat to `vrf_max_attempts` (3) and
   verify the slot ends in Void and `retry_vrf` then returns Ok without CPI.
3. **旧回调忽略**: a fulfillment for a superseded attempt/hand returns Ok and
   leaves Deck and slot untouched (state stays Pending for the new attempt).

## Open questions for the local-stack run

- `owner = ephemeral_rollups_sdk::id()` on Game/Deck assumes the delegated
  owner in the ER is the delegation program and that Anchor 1.0 accepts a
  const-fn path in the `owner` constraint. If the undelegated (L1) path needs
  the same code, the constraint must be relaxed or made conditional.
- The fulfillment's callback account ordering assumption: identity signer
  first, then `accounts_metas` in the order given (`[deck, game]`). Confirm on
  the local stack that the VRF program passes them in exactly this order.
- Whether the VRF program charges/debits the request `payer` in the ER queue
  (design §9 says the ER queue is free — verify no rent/lamport requirement
  surfaces for a 0-balance or non-existent payer account).
- Whether `#[vrf]`'s generated `program_identity` seeds `[b"identity"]` (PDA
  under this program) matches what `create_request_randomness_ix` puts in the
  ix (`find_program_address(&[IDENTITY], callback_program_id)`) at runtime —
  should hold by construction, but the first end-to-end request proves it.
- The `Table`/`Game`/`Deck` accounts for these tests must be created and
  delegated by the Stage 3 deploy script; this slice intentionally contains no
  `create_table`/init instructions.
