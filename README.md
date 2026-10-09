# SolPoker

**Private, verifiable No-Limit Hold'em cash tables on Solana.**
Two to nine players per table; hands run inside a MagicBlock **Private Ephemeral Rollup**
(Intel TDX, `devnet-tee`) where hole cards are dealt and played encrypted inside a hardware
enclave. **The operator cannot read your cards** — that is on-chain policy, not a promise:
every private account carries a reader list you can inspect, and the program itself refuses
to add the operator to it. Dealing is deterministic from commit–reveal salts and MagicBlock
VRF randomness, so **every hand can be recomputed card-by-card** from on-chain data after
settlement.

> **Status: devnet / testnet.** Test tUSDC carries no real value; the product is
> deliberately explicit about what is and isn't provable yet (see
> [Trust model](#trust-model) and [Status & roadmap](#status--roadmap)). The
> [CHANGELOG](CHANGELOG.md) is the complete build log.

**Live on devnet:** [Web app](https://solpoker-coinsatoshi666-5257.vercel.app) ·
[Documentation](https://solpoker-coinsatoshi666-5257.vercel.app/docs) ·
[Trust & verification](https://solpoker-coinsatoshi666-5257.vercel.app/trust) ·
[Hand verifier](https://solpoker-coinsatoshi666-5257.vercel.app/history)
— grab test tUSDC from the in-app faucet and sit down.

---

## Why it's different

**Privacy that is enforced, not promised.** Hole cards live in per-seat private accounts on
the TEE rollup; the deck (salts + VRF outputs) has no human readers at all. The reader lists
are on-chain `permission:` accounts — `take_seat` adds only the occupant, `stand_up` resets
to a keyless sentinel, and the admin override path itself rejects the operator
(`MemberNotAllowed`). Nobody — including us — can read your hand from the outside.

**Fairness you can recompute.** Each player commits a salt before seeing randomness; the
deal is `cards = f(VRF output, salt digest)`, computed inside the enclave. At settlement the
proof ring buffers publish commitments, deltas and the secrets needed to replay the hand:
the `/history` verifier and `scripts/verify-hand.mjs` re-draw all 52 cards and check the
action transcript against on-chain anchors.

**Custody without a custodian.** Money never enters the rollup. Each table has its own L1
vault; your buy-in is escrowed there, and `cash_out` is permissionless but can only ever pay
the payout address pinned at your sit-down.

**Real cash-game poker.** 9-max ring tables (2–9 players in any hand): blinds/ante and
min/max buy-in per table, side pots and all-in runouts, rake with no-flop-no-drop and a cap,
the standard heads-up position exception, action timers → auto check/fold → strikes →
auto stand-up when idle, late seating, leave-and-cash-out anytime.

**Speed that feels local.** Actions are signed on the ER (seconds, not slots), session keys
mean one signature per sitting and zero popups afterwards, and the keeper (crank) drives
timers and street transitions so clients only ever sign their own moves.

**AI players welcome.** A first-class agent runner (`scripts/agent`) with strategies and an
MCP server; agent profiles are registered on-chain with distinct owners (same-owner seats
are refused on the same table). The demo table runs five AI players live.

---

## Architecture

```
            ┌──────────────────────────── L1 (devnet) ───────────────────────────┐
            │  Table config · per-table vault (escrow) · SeatLedger · agent       │
            │  profiles · commits of game state (base-layer evidence, audit)      │
            └───────────────▲─────────────────────────────────────▲──────────────┘
                            │ commits / cash_out                  │ open/close
                            │                                     │
   players (browser, Privy  │        ┌──────── Private ER (TEE) ───┴────────────┐
   + session keys) ─────────┼──────► │ program: game state, dealing protocol,   │
                            │        │ settlement · PER: per-account readers    │
   keepers (crank) ─────────┼──────► │ private deck + 9 player-hand accounts    │
                            │        └──────────────▲───────────────────────────┘
   MagicBlock VRF oracle ───┴──── callback (randomness → private deck) ─────────┘
```

| Component | What it is |
| --- | --- |
| [`programs/solpoker`](programs/solpoker) | The Anchor program (`EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf`): game state, dealing protocol, settlement, vaults, PER permissioning, VRF lifecycle. |
| [`crates/solpoker-core`](crates/solpoker-core) | Pure, heavily unit-tested rules core: NLHE betting engine (2–9 players, side pots, runouts), deterministic deal driver, hand evaluator, rake, VRF state machine. The program is a thin shell — the rules live in one place. |
| [`web`](web) | Next.js app: landing, lobby, table, `/docs` (GitBook-style, zh/en), `/history` (L1 audit + recompute), `/trust` (interactive hand lifecycle & claims), `/faucet`. Privy login, session keys, client-signed play. |
| [`scripts/crank.mjs`](scripts/crank.mjs) | The keeper: drives the phase machine on the ER (freeze → commit → VRF → deal → streets → settle → commit to L1), sweeps settled seats, and never acts for players. Permissionless by design — anyone can run one. |
| [`scripts/agent`](scripts/agent) | AI players: `agent.mjs` (`new` / `fund` / `sit` / `run` / `stand` / `status`), `register-agent.mjs`, strategy hooks, MCP server. |
| [`scripts`](scripts) | Operator toolbox: table deployment (`create-table.mjs`), health (`testnet-health.mjs`), verification (`verify-hand.mjs`, `verify-actions.mjs`), L1 audit, delegated-fee top-ups. |
| [`docs`](docs) | [Dealing protocol spec (zh/en)](docs/dealing-protocol.zh.md) — the byte-level contract for commit–reveal–VRF–deal; [testnet runbook](docs/runbook-testnet.md); design documents. |

## A hand, end to end

1. **Freeze & commit** — the table freezes a new hand; every seated player posts a salt
   *commitment* on the ER (pre-committed a hand early for pace).
2. **Randomness** — a permissionless request goes to the MagicBlock VRF; the oracle's
   callback writes the seed into the private deck account. Nobody can predict or bias it.
3. **Reveal & deal** — salts are revealed (also pre-revealed for pace); the deal is computed
   in-program: hole cards land in each seat's private account, readable by that seat's wallet
   only.
4. **Betting** — players sign actions (or their session key does); the engine validates turn,
   amounts and legality on-chain; the crank only advances timers/streets and can never act
   for anyone.
5. **Settle** — showdown evaluation, side pots and rake are computed on-chain from revealed
   hands and the board; the hand's proof entry, secrets and replay digests are written to
   ring buffers.
6. **Back to L1** — the game state is committed to the base layer on a schedule (and at hand
   boundaries), so L1 always holds the auditable story and the vault stays solvent.

## Verify it yourself

- **Reader lists** — every table's `permission:` accounts list exactly who can read the deck
  and hand accounts: the occupant, plus a keyless VRF sentinel. The operator is not on any
  list, and the member-update path rejects it (error `MemberNotAllowed`).
- **Hands** — `node scripts/verify-hand.mjs <tableId> <handId>` recomputes a settled hand
  from on-chain `HandProof` + `HandSecrets` + `HandReplay`; `node scripts/verify-actions.mjs`
  cross-checks the action event stream. The web `/history` page does the L1-side audit
  (deposits, payouts, commits) with links to Solscan.
- **Money** — `cash_out` pays only `ATA(payout, mint)` where `payout` was pinned at your
  sit-down; the program hard-codes that constraint. Table vaults are public token accounts.
- **Health** — `node scripts/testnet-health.mjs --deep 22` checks program, tables, vaults,
  snapshots and liveness in one shot.

## Trust model

- **Operator cannot see your cards** (on-chain member lists, enforced by program policy).
- **Operator cannot move your money** (per-table escrow; payout pinned at sit-down;
  permissionless cash-out).
- **Nothing can be changed after the fact** (deterministic deals; proofs; recomputable hands).
- **Still trust, stated plainly:** the TEE platform (Intel TDX / MagicBlock PER), the program
  upgrade authority (governance is a mainnet item), and the validator staying alive while a
  hand is in flight.

## Running it

Pinned toolchain — Rust 1.89, Solana CLI (Agave) 3.1.10, Anchor 1.0.2, Node 24
(`scripts/check-pins.sh` catches drift). Build and test:

```bash
yarn install --frozen-lockfile
cargo test -p solpoker-core          # rules engine: 90+ tests
cargo test -p solpoker --lib         # program logic: dealing, settlement, permissions
anchor build
```

Run the testnet stack. Both MagicBlock endpoints are reached directly; pass the L1 endpoint
explicitly (the ER URL defaults to `devnet-tee`):

```bash
export L1_URL=https://rpc.magicblock.app/devnet

# keeper (drives every table)
node scripts/crank.mjs 5,6,7,8,9,11,12,14,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,41

# AI players (one process each)
node scripts/agent/agent.mjs run bob
node scripts/agent/agent.mjs run carol

# web app
cd web && npm run dev -- -p 3100     # http://localhost:3100

# one-command health check
node scripts/testnet-health.mjs
```

Full operator manual (deploying tables, funding fee accounts, troubleshooting):
[docs/runbook-testnet.md](docs/runbook-testnet.md).

### Configuration

| Variable | Where | Meaning |
| --- | --- | --- |
| `L1_URL` | scripts, keeper, agents | Base-layer RPC (direct). Defaults to Helius if set, else MagicBlock's public devnet route. |
| `ER_BASE` | scripts, keeper, agents | Ephemeral Rollup endpoint. Default `https://devnet-tee.magicblock.app`. |
| `NEXT_PUBLIC_TABLE_IDS` | web | Tables shown in the lobby. |
| `NEXT_PUBLIC_L1_RPC` | web | Keyless public RPC for the browser bundle. |
| `HELIUS_RPC`, `SOLPOKER_DEPLOYER_KEYPAIR` | Vercel / server | Server-only secrets (audit history, faucet). **Never** in the client bundle or the repo — see `web/.env.example`. |

### Deploy a table

```bash
node scripts/create-table.mjs 42 0.1 0.2 0.02 0   # id, sb, bb, ante, kind(0 human/1 AI/2 mixed)
```

Idempotent: creates the table, seats, hand/deck accounts, replay ring, delegates everything
to the TEE validator, and initializes the permission layer.

## AI agents

```bash
node scripts/agent/agent.mjs new alice
node scripts/agent/register-agent.mjs alice --owner keys/agents/alice-owner.json   # on-chain AgentProfile
node scripts/agent/agent.mjs fund alice 0.05 100        # SOL + tUSDC
node scripts/agent/agent.mjs sit alice 22 5 100         # table 22, seat 5, buy-in 100
node scripts/agent/agent.mjs run alice --strategy ./my-strategy.mjs
```

Agents get their own wallets, an on-chain profile with a distinct owner (the same owner
cannot hold two seats at one table), and play through the same protocol as humans — one
signature per sit-down, then session-key actions. An MCP server
([`scripts/agent/mcp-server.mjs`](scripts/agent/mcp-server.mjs)) exposes the same surface to
tool-using models.

## Status & roadmap

Now: **devnet testnet** with 25 live tables, a 5-AI demo table, faucet, docs and verification
tooling. Mainnet is gated on: governance for the program upgrade authority, the escape
channel, the fee model, and hardening the operator-trust story (membership policy is already
program-enforced; see the CHANGELOG for the experiments behind it).

## Security

The repository contains **no keys and no secrets** — key material lives in gitignored files
(`keys/`, `web/.env.local`) or environment variables, and was absent from every commit when
the repo went public (full-history scan). Found something? Please open an issue or contact
the maintainers before disclosing publicly.

## 中文速览

SolPoker 是 Solana 上的**隐私德州扑克现金桌**（每桌 2–9 人，现运行 25 张桌）：底牌与
牌局在 MagicBlock 私有 Ephemeral Rollup（Intel TDX 硬件隔离区）内加密演进，**运营方读不到
任何人的底牌**——每张私有账户的可读名单都是链上策略、公开可查（入座只加入本座玩家、离座
回到无密钥哨兵、连管理员的覆盖通道也被程序拒绝）。发牌由 **VRF + 双方盐承诺**确定性推导，
**每一手都能在结算后逐张复算**（网页验证器 / `scripts/verify-hand.mjs`）；资金只存在每桌
独立的 L1 托管账户，兑现无许可、只能打到你入座时钉死的地址。支持现金桌全套规则（侧池、
全下 runout、抽水上限、超时判罚、随时离桌兑现）、会话密钥零弹窗、以及链上注册的 AI agent
（演示桌有五个 AI 在打）。

当前为 **devnet 测试网**（测试币无价值）。产品站含水龙头、GitBook 式双语文档、可交互信任页
与手牌验证器；运维手册见 [docs/runbook-testnet.md](docs/runbook-testnet.md)，发牌协议见
[docs/dealing-protocol.zh.md](docs/dealing-protocol.zh.md)。

## License

[MIT](LICENSE)
