# solpoker

Private heads-up No-Limit Hold'em on Solana. Hands run inside a MagicBlock **Private Ephemeral Rollup** (Intel TDX, `devnet-tee`); USDC never enters the rollup and is escrowed per table on L1. v1 ships cash tables only (0.1/0.2, 0.5/1, 1/2 USDC).

Solana 上的隐私德州扑克（v1 为单挑现金桌）。对局运行在 MagicBlock 私有 Ephemeral Rollup（Intel TDX）里，USDC 只留在 L1 的每桌托管账户中。

> Status: **Stage 1** (design documents, awaiting sign-off). Stage 0 delivered the pinned toolchain, repo skeleton and delegation smoke test on the local stack and devnet-tee. See [CHANGELOG.md](CHANGELOG.md).
>
> Design: [Stage 1 design](docs/design/stage1-design.md) · [AI tables and x402](docs/design/stage1-agents-x402.md) · [commit fees and escape hatch](docs/design/stage1-fees-escape.md) · [decisions](docs/design/decisions.md) · [pre-dev review](docs/design/pre-dev-review.md)

## Pinned toolchain

| Tool | Version | Notes |
| --- | --- | --- |
| Rust | 1.89.0 | `rust-toolchain.toml` |
| Solana CLI (Agave) | 3.1.10 | `sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.10/install)"` |
| Anchor CLI | 1.0.2 | prebuilt binary, sha256 in `.github/workflows/ci.yml` |
| Node | 24.x | `package.json` `engines` |
| Local MagicBlock stack | `@magicblock-labs/ephemeral-validator@0.14.10` | `npm i -g`, started by `scripts/mb-stack.sh` |
| anchor-lang / ephemeral-rollups-sdk | `=1.0.2` / `=0.17.3` | exact pins in each program's `Cargo.toml` |
| @anchor-lang/core / ER SDK / web3.js | 1.0.2 / 0.17.3 / 1.98.4 | exact pins + yarn `resolutions` |

`scripts/check-pins.sh` fails if anything drifted.

## Layout

| Path | What |
| --- | --- |
| `programs/solpoker` | main program (skeleton in Stage 0), ID `EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf` |
| `programs/smoke` | throwaway Stage 0 spike: delegate / commit / undelegate a counter, ID `BU1Ad3zgoJWrP11kZTzomMTJtebVGYdVweMjkQHtfQW4` |
| `tests/smoke.ts` | smoke test; same file runs against the local stack or devnet-tee |
| `scripts/mb-stack.sh`, `scripts/mb-health.sh` | start / health-check the local MagicBlock stack |
| `scripts/tee-latency.ts` | latency breakdown against devnet-tee |
| `scripts/check-pins.sh` | version pin checks |
| `scripts/probe_dlp.py` | does a cluster's delegation program support the escape hatch (simulation only) |
| `scripts/probe-er-feepayer.ts` | which fee payers (funded / zero / rent-exempt minimum) the ER accepts |
| `docs/design/` | Stage 1 design (main, AI tables and x402, fees and escape hatch), decisions, pre-dev review, context block |
| `docs/stage*-notes.md` | verified external facts with sources |

## Local test

```bash
yarn install --frozen-lockfile
anchor build
scripts/mb-stack.sh --reset          # terminal 1: base 8899, ER 7799, QFS 6699
scripts/mb-health.sh                 # terminal 2
anchor test --skip-local-validator
```

The local query-filtering-service (6699) enforces `?token=` auth just like devnet-tee, so the tests authenticate with `getAuthToken` locally too.

## devnet-tee smoke test

```bash
PROVIDER_ENDPOINT=https://api.devnet.solana.com \
EPHEMERAL_PROVIDER_ENDPOINT=https://devnet-tee.magicblock.app \
ANCHOR_WALLET=keys/deployer.json \
yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/smoke.ts
```

Delegation always names the validator explicitly (`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` on devnet-tee, `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev` locally); `validator: None` is never used.

## Keys

Devnet keys go in `keys/` (gitignored, together with `solpoker-key-*.json` and `*-keypair.json`). Copy `keys/solpoker-program.json` to `target/deploy/solpoker-keypair.json` and `keys/smoke-program.json` to `target/deploy/smoke-keypair.json` before `anchor deploy`. CI generates a throwaway wallet and preloads the programs at their declared IDs, so no real key ever enters CI. Mainnet keys are managed separately, and the upgrade authority moves to a multisig before mainnet.
