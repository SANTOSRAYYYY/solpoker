# SolPoker Web (Stage 7)

Next.js App Router + React 19 前端。深色主题，Solana Purple `#9945FF` 主色，`#14F195` 用于正向操作，暗红用于危险操作（弃牌）。钱包层使用 **Privy**（`@privy-io/react-auth` v3）。

Bilingual 中文/English，中文默认（后续阶段接入 i18n；当前文案以中文硬编码占位）。

## 快速开始（devnet 演示，桌 #9）

```bash
# 1. 本地中继（本机网络限制；浏览器不需要中继，crank/e2e 需要）
node scripts/http-relay.mjs 8898 rpc.magicblock.app         # L1 → http://127.0.0.1:8898/devnet
node scripts/http-relay.mjs 7799 devnet-tee.magicblock.app  # ER → http://127.0.0.1:7799?token=…

# 2. crank（阶段机驱动：take_seat/advance/request_vrf/claim_timeout/commit_game）
node scripts/crank.mjs 9

# 3. 前端
cd web
npm install
npm run build && npx next start -p 3100   # 或 npm run dev
```

浏览器打开 `http://127.0.0.1:3100` → 连接钱包（Privy）→ 连接 TEE（attestation + 一次 challenge 签名）→ 入座 → 对局。

新钱包需要 SOL（手续费）和 tUSDC（买入）。devnet 演示用 crank 的 fund 子命令从 deployer 发放：

```bash
node scripts/crank.mjs fund <钱包地址> [SOL=0.05] [tUSDC=25]
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy 应用 ID（必填）。未配置时页面框架仍渲染，钱包功能不可用。 |
| `NEXT_PUBLIC_TABLE_ID` | 牌桌 ID（默认 `9`——已在链上创建/委托/权限就绪的演示桌）。 |
| `NEXT_PUBLIC_L1_RPC` | L1 RPC（默认 `https://rpc.magicblock.app/devnet`）。 |
| `NEXT_PUBLIC_ER_RPC` | ER/TEE RPC（默认 `https://devnet-tee.magicblock.app`）。 |

创建 `.env.local`：

```
NEXT_PUBLIC_PRIVY_APP_ID=your-privy-app-id
```

## 架构（设计 §12/§13，Stage 6 教训见根目录 CHANGELOG）

- **职责划分**：浏览器只签「玩家动作」（sit_down/commit_salt/reveal_salt/act/stand_up/cash_out）；crank（deployer 密钥）驱动阶段机（take_seat/advance/request_vrf/claim_timeout/commit_game）。
- **Session key（D2/X10）**：入座交易里一次钱包签名，授权本地生成的 session key 并预充 0.001 SOL；此后 commit/reveal/act/stand_up 全部由 session key 签名，不再弹窗。存放在 localStorage（devnet 演示）。
- **盐流程**：客户端按 (table, hand_id) 生成盐（sessionStorage 持久化，刷新不丢）；phase=Commit 自动 commit、AwaitSeed 且 VRF 已履行自动 reveal。
- **ER 交易纪律**：一律带 `ComputeBudgetProgram.setComputeUnitLimit(1.4M)`（advance 发牌实测 421k CU）；一律 `skipPreflight`（TEE 的 simulate 与执行对 PER 私有账户判定不一致）。
- **状态读取**：Game 用原始字节解码（anchor-ts 对 zero-copy 内嵌枚举解码有 bug）；自己的 PlayerHand 凭 PER 成员资格 + auth token 读取。
- **轮询代替订阅**：本机网络只能走 HTTP 中继（无 WebSocket），设计 §13「先订阅再发送」在本环境降级为 1.5s 轮询，已记录为偏差。

## 依赖版本（2026-10-06 核实）

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `@privy-io/react-auth` | `3.47.0` | 精确锁定；Solana hooks 全部从 `@privy-io/react-auth/solana` 子路径导入 |
| `@solana/kit` | `^3.0.3` | Privy v3 的 peer 依赖（3.47.0 起同时兼容 kit v8 的 legacy/v1 交易） |
| `@solana-program/system` / `memo` / `token` | `0.8.0` / `0.8.0` / `0.6.0` | Privy peer 依赖的精确兼容版本 |
| `@anchor-lang/core` | `1.0.2` | 与链上程序同一 Anchor 版本 |
| `next` | `15.5.9` | 15.x 最新（15.1.6 有 CVE-2025-66478） |
| `react` / `react-dom` | `19.0.0` | Privy peerDep 支持 `^18 \|\| ^19` |
| `typescript` | `5.7.3` | |

## 目录

- `app/page.tsx` — 牌桌页：钱包/TEE 门控、入座、桌面（公共牌/座位/底池）、手牌（仅本人可见）、行动区、兑现
- `app/trust/page.tsx` — 信任页（逐项证据链接，设计 §16）
- `app/providers.tsx` — PrivyProvider（Solana 嵌入式钱包，登录时自动创建）
- `lib/config.ts` — 链/程序常量（与 scripts/stage6-full-hand-e2e.mjs 同步）
- `lib/game-state.ts` — Game/PlayerHand 原始字节解码、牌面与金额格式化
- `lib/solpoker-client.ts` — PDA、指令构建、发送（CU ix / skipPreflight / 钱包签名发送）
- `lib/use-game.ts` — 游戏驱动 hook：轮询、座位推导、自动盐流程、act/standUp
- `lib/session-key.ts` — session key 与盐的生成分配
- `lib/privy-solana.ts` — Privy Solana 钱包辅助函数
- `lib/tee-auth.ts` — TEE attestation + auth token（§13）

## 已核实的 Privy API（2026-10-06，对照官方文档）

- `useSignMessage()` → `signMessage({ message: Uint8Array, wallet })`：接受**任意原始字节**（不限 UTF-8），满足设计 §13 的 32 字节挑战签名；返回 `{ signature: Uint8Array }`。
- `useSignTransaction()` → `signTransaction({ transaction: Uint8Array, wallet })`：接受序列化交易 bytes，返回 `{ signedTransaction: Uint8Array }`。
- `useWallets()`（`/solana` 子路径）：同时列出嵌入式 + 外部钱包，类型 `ConnectedStandardSolanaWallet`；嵌入式钱包用 `w.standardWallet.name === 'Privy'` 识别。

## 待核实（需真机/真链联调）

1. **web3.js v1 序列化往返**：Anchor 构建的 `Transaction` 序列化传给 `signTransaction` 的兼容性——官方 SPL recipe 仍在用 v1 但示例代码有笔误，需用真实 `sit_down` 交易实测（Stage 7 真机 playtest 首验项）。
2. **`showWalletUIs: false` 静默签名**：是否需要额外授权策略配置，文档未展开。
3. **sign-only 外部钱包兜底**：个别钱包返回裸 64 字节签名而非完整交易，`useSignL1Transaction` 的返回长度需判别。

## 后续阶段

- i18n 正式接入（中/英切换）
- 多桌大厅（当前固定演示桌 #9）
- 混合桌与 x402 agent（Stage 8）
