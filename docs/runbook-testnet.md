# 测试网运维手册（SolPoker · devnet + devnet-tee）

> 目标：任何人在一台干净机器上，按本文就能把整套产品跑起来、加桌、验证、排障。
> 部署对象是 **Solana devnet + MagicBlock devnet-tee（TEE）**，资产为测试网 tUSDC，不承载真实价值。
>
> 一条命令看现在是否健康：`node scripts/testnet-health.mjs`（深验再加 `--deep <tableId>`）。

---

## 0. 前置

| 依赖 | 说明 |
|---|---|
| Node.js | ≥ 22（开发用 24.x 验证过） |
| Rust + Solana CLI (Agave) + Anchor | 只在改程序/部署时需要；日常运维不用 |
| `keys/`（gitignored） | `deployer.json`（管理员/网关/付租金）、`test-players.json`（测试玩家）、`agents/*.json`（agent 密钥） |
| `web/.env.local`（gitignored） | 见下 |

`web/.env.local` 关键项：

```ini
NEXT_PUBLIC_PRIVY_APP_ID=<Privy app id>              # 钱包登录
NEXT_PUBLIC_TABLE_IDS=5,6,7,8,9,11,12,14,20,...,34  # 大厅白名单（也是自检脚本的桌列表）
NEXT_PUBLIC_L1_RPC=https://emylee-jgugz7-fast-devnet.helius-rpc.com   # 浏览器读 L1（Secure，无 key）
HELIUS_RPC=https://devnet.helius-rpc.com/?api-key=<key>               # 服务端/脚本用（含 key，绝不进前端）
NEXT_PUBLIC_SSE_URL=http://127.0.0.1:8787/events      # 可选：实时推送；不设则回落轮询
ER_BASE=https://devnet-tee.magicblock.app             # 可选：覆盖 ER 端点（默认即此）
```

端点优先级统一在 `scripts/env.mjs`：`L1_URL > HELIUS_RPC > NEXT_PUBLIC_L1_RPC > MagicBlock 路由`；
本地栈用 `L1_URL` / `ER_BASE` 覆盖即可。

## 1. 启动（四个进程）

```bash
# ① 前端（浏览器入口，端口 3100）
cd web && npm install && npm run dev -- -p 3100

# ② crank：驱动所有桌的状态机（take_seat / advance / request_vrf / claim_timeout / commit_game / sweep）
node scripts/crank.mjs 5,6,7,8,9,11,12,14,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34

# ③ SSE 中继（可选，实时推送 L1 事件；Helius webhook → 本进程 → 浏览器）
node scripts/helius-webhook.mjs            # 默认 127.0.0.1:8787

# ④ x402 网关（可选，仅 x402 入座/退款路径需要）
node scripts/x402-gateway.mjs --port 8790
```

自检：

```bash
node scripts/testnet-health.mjs            # 端点/程序/23 桌（委托 15/15 + 权限 10/10）/四个服务
node scripts/testnet-health.mjs --deep 20  # 额外：对某桌最近一手跑整手复算 + 行动流验证
```

## 2. 加一张新桌（幂等，可断点续跑）

```bash
node scripts/create-table.mjs 35 0.1 0.2 0.02 0   # 桌号 盲注SB 盲注BB 前注 kind(0真人/1AI/2混合)
# 或批量：node scripts/deploy-tables.mjs --ids 35-39
node scripts/deploy-tables.mjs --check            # 只预检：桌号占用 / DelegPayer 余额估算
```

- `DelegPayer` 付委托租金（实测 ≈3.2M lamports/次委托，每桌 15 个账户 ≈0.05 SOL）；
  不足时脚本会给出 `--topup` 命令。
- 全流程：`create_table → create_seats → create_hands → init_replay → delegate×15 → init_permissions(ER)`。
- 完成后把桌号加进 `NEXT_PUBLIC_TABLE_IDS` 与 crank 参数并重启两处。
- **权限账户派生在 ACL 权限程序（`ACLseoPoy…`）下**，不是本程序 —— 改 PDA 代码务必复验：
  `node scripts/er-perm-probe.mjs <tableId>`（先 L1 模拟拿日志，成功再发 ER）。

## 3. 验证一手牌（任何人可跑，只读）

| 命令 | 验什么 |
|---|---|
| `node scripts/verify-hand.mjs <tableId> [handId]` | **整手复算**：从 VRF + 盐 + 每条街首摘要重抽每一张牌，与链上 proof 逐张比对（v2 条目不存 occupants，salt_digest 会如实标注「无法独立复算」） |
| `node scripts/verify-actions.mjs <tableId>` | **行动流**：扫 ER 交易日志重建行动序列，与每条街的 `street_end` 锚点、`transcript_final` 比对 |
| `node scripts/replay-status.mjs <tableId>` | HandReplay 环（anchor / attempts / 僵尸座位） |
| `node scripts/program-smoke.mjs <tableId>` | 部署后派发烟测（老指令/新指令/退款 + `audit_table` 守恒） |
| `node scripts/l1-audit.mjs <tableId>` | **L1 审计视图**：入座/兑现/commit/委托/x402 入账与退款的时间线（Helius 解析历史 + 我们自己的指令解码） |
| 浏览器 `/history` | 同一套引擎的 UI：守恒、整手复算、行动流三个按钮 + L1 审计视图 |

负面测试（验证器不会说谎）：对未结算的手或 emit 之前的老手跑上面命令，应如实报失败/无数据。

## 4. 日常与排障

| 症状 | 处理 |
|---|---|
| 某座位资产卡住 | crank 的 sweep 会自动 `cash_out`（无许可）；也可手动 `node scripts/stand-up-player.mjs <tableId> <seat> <playerIdx>` 后等 commit 再 `cash_out`。先 `node scripts/replay-status.mjs <tableId>` 看僵尸座位 |
| 快照陈旧（`cash_out` 报 6019 BadSnapshot） | 正常：等 crank `commit_game`（手牌边界或 `hands_since_commit` 到阈值）；crank 会自动重试 |
| 手牌卡在 Commit（无人揭示盐） | 程序按 `commit_timeout_s` 逐次 strike（上限 `max_strikes`，默认 3）后自动释放座位；crank 只在超时后推进（避免空转烧手续费） |
| ER 报 401 InvalidToken | `getAuthToken` 的 token 会过期；用 `mkEr()` 重新认证（`scripts/deploy-tables.mjs` 已内置重试） |
| 交易"成功"但什么都没发生 | 先用 `getSignatureStatuses` 查 `err`（本环境 `confirmTransaction` 不抛错）；再 `getTransaction` 看日志 |
| 程序"部署成功"但新指令报 `Custom:101` | **老坑**：`anchor build` 会因 ID 校验中止而留下旧 `.so`。用 `anchor build --ignore-keys -p solpoker`，并跑 `node scripts/program-smoke.mjs` 复验派发 |
| 指令失败但 ER 不给日志 | **在 L1 上模拟**：原始 JSON-RPC `simulateTransaction`（`sigVerify:false, replaceRecentBlockhash:true`，注意 web3.js 封装会拒绝这个组合）→ 日志会给出 `AnchorError` 的 file:line 与 Left/Right 值 |
| 某桌无人也热闹（crank 反复发交易） | 检查是否 Commit 阶段空转（已按 `phase_deadline` 门控）或 `advance` 的静默 no-op 条件；正常空闲桌不应有交易 |

## 5. x402（标准模式）

```bash
# 报价（402）
curl -s "http://127.0.0.1:8790/v1/tables/20/seats/0?payer=<pubkey>" | head -40
# 客户端模拟（付款 + 入账，自动校验记录签名回编）
node scripts/x402-pay.mjs 20 1            # 桌 20 座 1，按最小买入付款
# 退款（付了款但未入账时：网关签名，只能动盈余）
node scripts/x402-refund.mjs 20 <payerPubkey> 10 <paymentSig>
# 或经网关：POST /v1/tables/:id/refunds?payer=&amount=  头 X-PAYMENT: <付款签名>
```

- 信任边界（写进设计文档 §4.3）：程序读不到别人的交易，「谁付的钱」由网关认定；`DepositRecord`/`RefundRecord` 记下付款签名，任何人事后可用 §3 的审计视图逐笔核对。
- facilitator 仍是待定项（`FACILITATOR_URL` 未设时用本地链上校验）。

## 6. 已知边界（如实）

- **devnet 特性**：ER/VRF 偶发抖动（主网会稳定得多）；RPC 历史保留期约一周 —— 牌面与结果的链上锚点永久，但「行动流重放」依赖交易日志，过期后只能验锚点。
- **v2 手牌**不再在链上存 occupants，所以 `salt_digest` 只能作为输入、无法独立复算（卡片复算不受影响）。
- **托管式 MCP** 仅 devnet 演示；正式使用自托管。
- **逃生通道**未上线（依赖 MagicBlock 给委托程序加 `RequestUndelegation`）。
- 反例留档：2026-10-08 修复前创建的 4 条 `RefundRecord`（桌 20/21/22/23）签名尾部损坏 —— 资金无误，审计请以 L1 审计视图 + 金库流水为准。

## 7. 改程序后（发布清单）

```bash
cargo test --workspace                                   # 32+90+7+1+1 全绿
cargo clippy --workspace --all-targets                   # 我们三个 crate 应 0 警告
anchor build --ignore-keys -p solpoker                   # 注意 --ignore-keys（否则会静默留旧 .so）
anchor idl build -p solpoker > idl-build.log && node scripts/install-idl.mjs   # 同步 IDL（web 与脚本共用）
node scripts/program-parity.mjs                          # 链上数据 vs 本地 .so 逐字节比对（防「部署了旧 .so」）
solana program deploy target/deploy/solpoker.so \
  --program-id EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf \
  --upgrade-authority keys/deployer.json --url "$HELIUS_RPC" --with-compute-unit-price 50000
node scripts/program-smoke.mjs 20                        # 派发复验（101 事故的教训）
node scripts/testnet-health.mjs --deep 20                # 全链路复验
cd web && npx tsc --noEmit && npm run build              # 前端类型 + 构建（构建前先停 dev，避免 .next 冲突）
```

**栈纪律（SBF 4KB）**：大结构体（如 `SeatLedger`）不要按份声明局部变量 —— 用
`fund::read_seat_counters` 逐座零拷贝读、迭代版 I-X；重活拆 `#[inline(never)]` 函数；
要长期保存的入参（签名等）在 handler 最前面就写进账户。详见 CHANGELOG 2026-10-08 两条。
