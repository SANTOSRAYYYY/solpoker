# SolPoker Agent Runner

把「机器人上桌打牌」做成一条命令。一个 agent = 一个密钥对 + 本 runner；
发牌/结算由 crank 驱动，agent 只在自己的回合做决策（设计 §5.3 的
**scripted 决策模式**；LLM/MCP 决策模式是 Stage 8 的事）。

## 快速开始

```bash
# 1. 创建并资助（默认 0.05 SOL + 25 tUSDC）
node scripts/agent/agent.mjs new   alice
node scripts/agent/agent.mjs fund  alice

# 2. 入座（需先确认目标桌在 crank 列表 + 大厅白名单里）
node scripts/agent/agent.mjs sit   alice 9 0 20

# 3. 开打（打 6 手后自动退出；不带 --hands 则持续运行）
node scripts/agent/agent.mjs run   alice --hands 6

# 4. 站起并兑现（自动等 crank commit → cash_out）
node scripts/agent/agent.mjs stand alice

# 查看状态
node scripts/agent/agent.mjs status [alice]
```

两名 agent 同桌对打 = 起两个进程（各自 run），crank 会自动开局。

## 工作方式

```
        ┌────────────┐  发牌/推进/结算/超时（确定性）
        │   crank    │ ─────────────────────────────┐
        └────────────┘                              ▼
                                    ┌───────────────────────────┐
  agent run ──轮询──▶ devnet-tee ──▶│ Game / 自己的 PlayerHand  │
        │                           └───────────────────────────┘
        │ 轮到我时：策略决策 → act/commit_salt/reveal_salt（agent 私钥直签）
        ▼
   scripts/agent/eval.mjs   7 选 5 评估器（Rust eval.rs 的 JS 移植，自测对拍）
   scripts/agent/strategy.mjs  默认启发式：翻前牌力分级 + 翻后牌力/底池赔率
```

- **签名**：agent 用**自己的密钥对**直接签名所有 ER 动作（设计 §2.2：agent
  的入座交易由 agent 密钥直接签名；无需 Privy/会话密钥）。手续费来自其
  L1 SOL 余额。
- **盐持久化**：每手盐落在 `keys/agents/<name>.salts.json`（保留最近 4 手），
  进程崩溃重启后 commit/reveal 可恢复。
- **崩溃恢复**：网络错误指数退避重试，连续失败自动重新鉴权（getAuthToken）。
- **--hands N**：打满 N 手自动退出（便于脚本化验收）；不带则持续打。

## 自定义策略

```bash
node scripts/agent/agent.mjs run alice --strategy ./my-strategy.mjs
```

模块导出 `decide(ctx)`（或 `{ name, decide }`）。`ctx`（资金均为 BigInt
base units，CENT = 10000）：

| 字段 | 含义 |
|---|---|
| `hole` / `board` | 底牌 / 公共牌（牌号 = rank×4+suit，rank 0..12=2..A） |
| `street` | 0 翻前 1 翻牌 2 转牌 3 河牌 |
| `pot` `toCall` `streetBet` `stack` `currentBet` `lastFullRaise` `minRaiseTo` `bb` | 金额 |
| `liveCount` | 本手仍在场人数 |
| `rng` | `() => [0,1)` |

返回 `{ action: "fold"|"check"|"call"|"bet"|"raiseTo"|"allIn", amount? }`；
`bet`/`raiseTo` 的 `amount` 是**投入后的本街总额**（与链上语义一致）。
把 `eval.mjs` 的 `evaluateBest` / `rankText` 拿去用即可算牌力。

## 现状边界（诚实清单）

- 座位在链上仍记为 **kind=Human**——AgentProfile / agent-only 桌 / 同主人
  拦截（设计 X11/X12）与 **x402 付费入座**是 **Stage 8**，未实现；
- 入座资金目前由运营方手动发（`fund` 子命令），不是 x402 原子支付；
- 决策模式只有 scripted；LLM/MCP 决策与支出上限属 Stage 8；
- agent 需要该桌在 **crank 列表中**（发牌/推进由 crank 负责，这是当前的
  中心化 keeper 假设，与设计 §10 一致）。

## 已验证（2026-10-07）

alice vs bob 在桌 #9 连续对打 6+ 手：盐承诺/揭示、翻牌/转牌/河牌行动、
弃牌与摊牌结算、筹码与 rake 精确守恒、`--hands` 计数退出、`stand` 自动
兑现，全部实链通过。
