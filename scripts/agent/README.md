# SolPoker Agent（机器人 / AI 上桌）

把「机器人上桌打牌」做成一条命令，并把 **MCP 通道**开放给用户自己的 AI。
发牌/结算由 crank 驱动；协议细节（盐承诺/揭示、过期防护、兜底动作、崩溃
恢复）由执行器自动处理，**决策来源只做决策**（设计 §5.1 执行器/决策分离）。

三种决策来源：

| 方式 | 谁在决策 | 入口 |
|---|---|---|
| `--strategy` 文件 | 你的脚本 | `agent.mjs run --strategy ./my.mjs` |
| `run` 默认 | 内置启发式（脚本策略） | `agent.mjs run` |
| **MCP** | **你的 LLM**（Claude / Cursor / 任意 MCP 客户端） | `mcp-server.mjs`（见下） |

## 模块

| 文件 | 作用 |
|---|---|
| `client.mjs` | 共享客户端层：连接/token/解码/指令构建/档案与盐持久化 |
| `executor.mjs` | 牌桌执行器：自动盐、回合跟踪、§5.5 兜底（剩 3 秒 check/fold）、崩溃重连 |
| `agent.mjs` | CLI：new/register/fund/sit/run/stand/status（scripted 决策） |
| `mcp-server.mjs` | MCP 服务（stdio）：把牌桌暴露成工具给 LLM（llm 决策） |
| `eval.mjs` / `strategy.mjs` | JS 版 7 选 5 评估器 + 默认策略（供 `--strategy` 复用） |

## 快速开始（CLI，scripted）

```bash
node scripts/agent/agent.mjs new      alice
node scripts/agent/agent.mjs register alice          # 上链注册 AgentProfile（Stage 8）
node scripts/agent/agent.mjs fund     alice          # 0.05 SOL + 25 tUSDC
node scripts/agent/agent.mjs sit      alice 11 0 20  # 混合桌 #11、座 0、买入 20
node scripts/agent/agent.mjs run      alice --hands 6
node scripts/agent/agent.mjs stand    alice          # 站起 + 自动等 commit + 兑现
```

## 接入你自己的 AI（MCP）

任何支持 MCP 的客户端都可以把用户自己的 LLM 接上桌：

```jsonc
// Claude Desktop / Cursor 的 mcpServers 配置
{
  "mcpServers": {
    "solpoker": {
      "command": "node",
      "args": ["<repo>/scripts/agent/mcp-server.mjs"],
      "env": { "SOLPOKER_AGENT": "alice", "SOLPOKER_MAX_TABLES": "2" }
    }
  }
}
```

**工具**（设计 §6.1）：`wallet_status` / `list_tables` / `get_table_state` /
`wait_for_turn`（长轮询 ≤25s）/ `act` / `sit_down` / `leave` / `leave_all` /
`get_hand_history`。资源 `solpoker://rules/{zh,en}`；提示词 `play-nlhe`。

**刻意不提供**：签名任意交易、转账、导出密钥、改限额/payout、注册或暂停
agent——这些需要主人参与（CLI/网页）。agent 私钥与盐永远不出本进程。

**建议的 LLM 循环**（`play-nlhe` 提示词内置）：

```
sit_down(table, "20")
loop {
  r = wait_for_turn(table)                  // 轮到你: r.status == "your_turn"
  if r.status == "hand_ended" { 记录结果; continue }
  if r.status == "your_turn" {
    决策（可用 r.my_cards / r.board / r.to_call / r.pot / r.deadline_s）
    act(table, r.hand_id, r.action_seq, "call")   // 或 fold/check/bet/raiseTo/allIn
  }
}
leave(table)     // 站起 + 自动等 commit + 兑现到 payout（X7：agent 默认付给主人）
```

**时机与兜底**：每个行动 30 秒；执行器在剩 3 秒仍未收到决策时自动
check（免费时）或 fold（§5.5），连续 3 次兜底应在手牌结束后离桌。
`wait_for_turn` 超时返回 `{"status":"waiting"}`，再调一次即可。

**崩溃恢复**：盐先落盘（`keys/agents/<name>.salts.json`）再发承诺；进程重启
后重入同一手照常揭示。agent 掉线时的链上兜底：行动超时 check/fold 记
strike，**连续 3 次（或 Commit 阶段缺承诺达 3 次）自动离座**，筹码记 owed；
重新入座前调用一次 `leave` 即可兑现并把座位归零。

**开发自测**：`node scripts/agent/mcp-smoke.mjs <agent> <table> <hands>`
（当作标准 MCP 客户端驱动服务端打 N 手）。

## 现状边界（诚实清单）

- 座位在链上记为 **kind=Agent**（含 agent_owner 与 X7 payout）；AgentProfile
  注册/暂停/注销已上链（Stage 8 第一块）。
- **未做**：x402 付费入座（当前入座前需运营方/自己先 `fund` 充值）、
  `verify_hand` 工具（复算可用 Python 参考实现）、`set_style`/hybrid 模式、
  `top_up` 工具（链上指令已存在，工具未暴露）、每手 X12 状态复查。
- 每张桌需要 crank 在跑（当前中心化 keeper 假设，设计 §10 一致）。
- 生产建桌参数：`commit_timeout_s=60` / `reveal_timeout_s=30`
  （`create-table.mjs` 默认值；测试桌的 10 秒值会让客户端短暂掉线被误清场）。

## 已验证（2026-10-07）

- CLI：alice vs bob 连续 6 手（桌 #9）——盐/三条街/摊牌/守恒/兑现全通过；
- 身份：注册、混合桌 kind=Agent 落链、同主人拒绝（6029）、真人拒 AI 桌（6007）；
- **MCP**：bob 经标准 MCP 客户端入座混合桌 #11、自动盐、两手（河牌池 1.68
  USDC）、leave 自动兑现到主人账户（39.99 → 58.93）——`MCP_SMOKE_OK`。
