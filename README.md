# SolPoker

**Verifiably private poker on Solana.** Hands run inside a MagicBlock **Private Ephemeral
Rollup** (Intel TDX, `devnet-tee`): hole cards are dealt and played encrypted inside a
hardware enclave, and **the operator cannot read them** — every private account's reader
list is on-chain policy, not a promise. Dealing is deterministic from commit–reveal salts
and VRF randomness, so every hand can be recomputed card-by-card after settlement.

> **Status: devnet / testnet.** Test tUSDC (`9WUwFXp…`) carries no real value, and the
> product is deliberately honest about its edges (see [Trust model](#trust-model)).
> Mainnet waits until the escape channel, governance and fee model are done — the
> [CHANGELOG](CHANGELOG.md) is the full build log.

**Live (devnet):** [web app](https://solpoker-coinsatoshi666-5257.vercel.app) ·
[docs](https://solpoker-coinsatoshi666-5257.vercel.app/docs) ·
[trust & verification](https://solpoker-coinsatoshi666-5257.vercel.app/trust)
*(get test tUSDC from the in-app faucet)*

## What's under the hood

| Piece | Role |
| --- | --- |
| [`programs/solpoker`](programs/solpoker) | Anchor program on Solana devnet + MagicBlock ER. Program ID `EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf`. Full game state, dealing protocol, settlement, PER permissioning. |
| [`crates/solpoker-core`](crates/solpoker-core) | Pure, unit-tested core: NLHE betting engine, deterministic deal driver, hand evaluator, settlement (side pots, rake), VRF state machine. The program is a thin shell over this — rules live in one place. |
| [`web`](web) | Next.js app: landing + lobby + table + `/docs` (GitBook-style, bilingual) + `/history` (L1 audit) + `/trust` (interactive lifecycle, claims) + faucet. Privy wallet login, session keys, all play signed client-side. |
| [`scripts`](scripts) | Operators' toolbox: `crank.mjs` (keeper that drives the phase machine), `testnet-health.mjs`, `verify-hand`, table deployment, per-table tools. |
| [`scripts/agent`](scripts/agent) | AI players: `agent.mjs` (`new/fund/sit/run/stand/status`), MCP server, strategy hooks. Table 22 runs a live AI demo. |
| [`docs`](docs) | [Dealing protocol (zh/en)](docs/dealing-protocol.zh.md), [testnet runbook](docs/runbook-testnet.md), design docs. |

## How a hand works

1. **Commit** — the table freezes a hand; each seat posts a salt commitment on the ER.
2. **Randomness** — MagicBlock VRF delivers a seed (the oracle's callback writes it into the
   private deck account; requests are permissionless).
3. **Reveal + deal** — salts are revealed, every check passes, and the deal is computed
   *inside* the program: `cards = f(VRF output, salt digest)`; hole cards land in per-seat
   private accounts (readable by that seat only).
4. **Play** — actions are signed by the player (or their session key) on the ER; the keeper
   (crank) only drives timers and street transitions — it cannot act for anyone.
5. **Settle** — showdown evaluation, side pots and rake are computed on-chain from the
   revealed hands; a proof entry + secrets go into ring buffers so **anyone can recompute
   all 52 cards** of the hand afterwards.
6. **Settle to L1** — the game state is committed back to the base layer on a schedule;
   money moves only between per-table escrow and the addresses pinned at sit-down.

## Trust model

- **Operator cannot see your cards.** Every hand/deck account has an on-chain member list
  (`permission:` accounts) that excludes the operator; the seat's own wallet is the only
  human reader. The program enforces this (`take_seat` adds only the occupant, `stand_up`
  resets to a keyless VRF sentinel, and the admin override path itself rejects the
  operator — `MemberNotAllowed`). You can check any table's lists on-chain.
- **Operator cannot move your money.** Cash-out is permissionless and can only pay the ATA
  pinned at your sit-down. The vault is per-table escrow on L1.
- **Everything is recomputable.** Deals are deterministic from public randomness + your
  revealed salts; the `/history` page and the `verify-hand` tool recompute hands from
  on-chain data.
- **Still trust (stated plainly):** the TEE platform (Intel TDX / MagicBlock), the program
  upgrade authority (governance is a mainnet item), and validator liveness.

## Running it

Pinned toolchain (Rust 1.89, Agave 3.1.10, Anchor 1.0.2, Node 24) — `scripts/check-pins.sh`
catches drift. Build + tests:

```bash
yarn install --frozen-lockfile
cargo test -p solpoker-core && anchor build
```

Run the testnet product (keeper + AI agents + web). Both MagicBlock endpoints are reached
directly; pass the L1 endpoint explicitly:

```bash
export L1_URL=https://rpc.magicblock.app/devnet

node scripts/crank.mjs 5,6,7,8,9,11,12,14,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,41
node scripts/agent/agent.mjs run bob        # one process per AI player
(cd web && npm run dev -- -p 3100)          # app on http://localhost:3100
```

One-command health check: `node scripts/testnet-health.mjs` (deep: `--deep 22`).
Full operator manual: [docs/runbook-testnet.md](docs/runbook-testnet.md).

**Bring your own AI:** register a profile and sit it down —

```bash
node scripts/agent/agent.mjs new alice
node scripts/agent/register-agent.mjs alice --owner keys/agents/alice-owner.json
node scripts/agent/agent.mjs fund alice 0.05 100
node scripts/agent/agent.mjs sit alice 22 5 100
node scripts/agent/agent.mjs run alice --strategy ./my-strategy.mjs
```

## 中文速览

SolPoker 是运行在 **MagicBlock 私有 Ephemeral Rollup（Intel TDX）** 上的隐私德州扑克：
底牌在硬件隔离区内加密运行，**运营方读不到任何人的底牌**（每张私有账户的可读名单是链上
策略、公开可查：入座只加入本座玩家、离座回到无密钥哨兵、连管理员的覆盖通道也拒绝运营方）；
发牌由 **VRF + 双方盐承诺** 确定性推导，**每一手都能在结算后逐张复算**；资金只存在每桌
独立的 L1 托管账户里，兑现无许可且只能打到你入座时钉死的地址。

当前为 **devnet 测试网**（测试币无价值）。产品站内置水龙头、GitBook 式双语文档、可交互
信任页与手牌验证器。运维手册见 [docs/runbook-testnet.md](docs/runbook-testnet.md)，发牌
协议见 [docs/dealing-protocol.zh.md](docs/dealing-protocol.zh.md)。

## License

[MIT](LICENSE)
