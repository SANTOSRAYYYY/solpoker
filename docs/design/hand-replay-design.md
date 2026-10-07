# HandReplay：把「整手复算」所需的输入放上链（设计冻结，2026-10-08）

> 目标：让任何人只用链上数据，就能把一手牌从 VRF + 盐一路复算到 52 张牌，
> 而不需要任何离线记录器。对应 §8.7「手牌结束后公开全部 VRF 输出、盐和事件流」。

## 1. 为什么现在做不到

整手复算的输入 = `salt_digest` + 每张牌抽取时的 `transcript_digest` + VRF 输出 + 盐。
链上现有：
- `HandSecrets`：VRF 输出、盐 ✓
- `HandProof`：牌面、输赢、`transcript_final`（**最终哈希**）✓/✗

缺的是**过程中的两个中间量**（都是哈希，不可逆）：
1. `salt_digest`（seeds 的输入之一）；
2. 每张牌抽取前的 `transcript_digest`（`draw_value` 的输入之一）。

> 注：v1 的记档偏差是「HandProof 不存完整事件字节」——这是刻意的（事件流无界，
> 且每手都进账户会爆 10,240B 的 CPI 限额）。下面的方案不存事件流，只存**少量可
> 复算的中间摘要**，因此是有界大小。

## 2. 最小充分集（数学上够用）

- `salt_digest: [u8; 32]` —— 有它 + HandSecrets 的 VRF 输出，就能算出 5 个 `seed_k`；
- `draw_digest: [[u8; 32]; 5]` —— **每条街第一张牌抽取前**的 transcript 摘要。
  街内后续牌的前置摘要可以**确定性地重建**：牌序已知（proof 里有 board/hole），
  每抽一张牌，程序只会追加一个事件（`HoleDealt` 或 `BoardDealt`，字段全部由
  `draw_no` / 座位 / 牌 / `vrf_src` 决定），验证器照着追加即可。
- 街与街之间要补的事件也只有 2 个（`VrfFulfilled(k, attempt_k)`、`StreetStart(k)`；
  runout 街额外一个 `RunoutStarted`），所以再存 `vrf_attempt_used: [u8; 5]`
  就能精确重建（该数组 Deck 里已经有）。
- `occupants: [Pubkey; 9]` —— 让「occupants + salts → salt_digest」这一步也能被验证
  （否则只能信 store 下来的 digest）。

每条 entry = occupants(288) + salt_digest(32) + draw_digest(160) + vrf_attempt(5) = 485B。

## 3. 账户设计（关键：不动现有布局）

**新增独立账户 `HandReplay`**，PDA `["replay", table]`，ring = 8 手（8 × 488 ≈ 3.9KB，
远低于 10,240B 限额，可 CPI create_account）。

为什么独立账户而不是扩 `HandProof`：
- `HandProof`/`Deck`/`HandSecrets` 都是**既有布局**，扩字段 = 改账户大小 = 老桌全部失效
  （`Deck` 是每桌一个、`HandProof` 是 16 槽环，都要重建）。独立账户则**老桌零影响**：
  新程序部署后，给老桌补一个 `init_replay` 调用即可开始记录，历史手牌只是「没有
  replay entry」（页面继续显示「该手缺少复算输入」）。
- 也避免把无界的事件流塞进账户。

写入时机：
- **发牌时**（`advance` 的每条街第一张牌之前）：把当前 `game.transcript` 写进
  `replay.entries[hand_id % 8].draw_digest[k]`——此时 Deck 不需要新增字段，
  因为过程量直接落在 replay 账户里；
- **手牌结束**（`write_proof_entry` 同路径）：写 `occupants` / `salt_digest` /
  `vrf_attempt_used` / `status`（以及 `hand_id` 做槽位校验）。

需要新增/修改的指令账户：`advance`（发牌街 + 结束时都要 mut 传 `handReplay`）、
`init_replay`（L1 创建 + 委托，加进 `delegate_table` 的 del_index 表或单独脚本）。

## 4. 验证器侧（JS，已就绪）

`web/lib/deal-verify.mjs` 已经是逐字节对齐的引擎（6/6 向量自证）。只需加一个入口：

```
dealFromReplay({ table, handId, board, hole, boardSrc, drawDigest[5],
                 vrfAttempt[5], vrfOut[5], salts[9], occupants[9], occupancyIds[9] })
```

流程：
1. `salt_digest' = saltDigest(...)` → 与链上 `salt_digest` 比对（**验证第 2 节的第 4 项**）；
2. `seed_k = streetSeed(vrfOut[k], salt_digest)`；
3. 按 `board_src` 排出的实际街序逐街：从 `draw_digest[k]` 出发补
   `[RunoutStarted?] + VrfFulfilled(k, attempt) + StreetStart(street)`，
   然后逐张抽牌并在每抽之后追加对应的 `HoleDealt`/`BoardDealt`；
4. 逐张比对抽出的牌与 proof 里的 `board`/`hole`；全中 = 该手 52 张复算通过。

## 5. 落地清单

- [ ] `state.rs`：`HandReplay` + `ReplayEntry`（含 `INIT_SPACE`/size 常量与单测）
- [ ] `hand.rs`：`write_replay_*`；在发牌循环里捕获街首发牌摘要
- [ ] `lib.rs`：`init_replay` 指令 + `advance` 账户表加 `handReplay: Account<HandReplay>`
- [ ] Rust 单测：合成一手走 deal 路径 → 断言从 replay 数据可重建全部 draw 摘要
      （即本设计的「规范测试」）
- [ ] 部署 devnet；给现有桌补 `init_replay`；跑一手 e2e
- [ ] JS：`chain-read.ts` 加 `readHandReplay`；`deal-verify.mjs` 加 `dealFromReplay`
- [ ] `/history`：有 replay 的手牌显示「整手复算 52/52 ✓」按钮；没有的继续显示说明
- [ ] CHANGELOG + 记忆

## 6. 边界（诚实写清）

- ring = 8：一桌只保留最近 8 手的完整复算数据（与 HandProof 的 16 手不同步；
  更早的手牌只能靠 HandProof 的最终哈希 + 守恒部分验证）。
- 本方案**不**公开完整事件流（下注序列仍不进链），所以「事件流 → transcript_final」
  这一步依然无法从链上独立验证；能验证的是「VRF + 盐 + 每街前置摘要 → 这 52 张牌」，
  加上玩家自己的盐承诺（当前手可比对）。要覆盖最后一步，需要把事件流也上链
  （无界大小，需要另行设计，例如按手存到独立账户或 NFT 式存证）。

---

## 7. 事件流存证：**已落地**（2026-10-08）

**目标**：把"能验证的边界"从"牌是公开随机数的函数"推进到"**每一手的行动序列也与链上承诺一致**"。

**最终方案（比本文档初稿更强）**：不需要链下发布事件流 —— 程序把规范事件 emit 成
**链上交易日志**，验证器从 ER 交易历史里把它们取回来：

1. **锚点**（程序，已上链）：每条街**结束时**的 transcript 写进 `HandReplay.street_end[k]`
   （4 街 × 32B，`streets_ended` 位掩码）。捕获点是"下一条街开始发牌之前"/runout 前/
   HandEnd·HandVoid 之前，**幂等先到先得**（runout 不会污染已锚定的街）。
   注意发牌那一刻 `game.street` 已是新街，所以 `await_street` 里要记 `street-1`。
2. **事件**（程序，已上链）：每次 `act` / `claim_timeout` emit
   `HandEventLog { hand_id, seq, event_tag, seat, kind, amount }` ——
   **规范事件**，即真正写进 transcript 的那个（`call` = 实际支付额、`bet/raise/allin` = 目标额；
   超时自动行动也在其中，它在 act 交易里看不见）。日志被篡改是**可发现**的：
   同样的事件已经哈希进 `street_end` / `transcript_final`。
3. **验证器**（`web/lib/act-log.mjs` + `deal-verify.verifyActionStream`）：
   抓桌子的 ER 交易（新→旧、命中目标手前提前停止、8 路并发）→ 解 `Program data:` 日志
   → 从 `draw_digest[k]` 追加该街发牌事件（由 proof 的牌确定性给出）→ 逐条追加行动事件
   → 摘要等于 `street_end[k]` 时该街闭合（**自分段**，不需要事件带街号）→
   最后追加 `HandEnd{deltas, rake}` 比对 `transcript_final`。

**实链验证**（桌 #14 手 #3，已结算）：8 条规范事件，四街各 2 条、全部闭合，
`transcript_final` 匹配 ✓（Node：`scripts/verify-actions.mjs` 输出 `ACTION_STREAM_OK`；
浏览器：`/history` 的「验证行动流」按钮显示通过）。

**为什么不"从交易参数推导"**：`act` 指令带的是**请求的行动**，而规范事件需要 `call` 的实际
支付额、`allIn` 的目标额 —— 那要重放整个下注引擎（把 Engine 移植到 JS），成本远高于一行日志。

**剩余边界（诚实写清）**：
- 环长 8 手：更早的手牌只有最终哈希，无法整手复算；
- 事件在 **ER 交易日志**里，受 RPC 历史保留期（约一周）限制 —— 链上锚点永久保留，
  但"重放行动流"所需的日志会过期。主网前需向 MagicBlock 确认保留期与是否提供归档。

**备选（未采用）**：全事件流按手上链（最彻底但账户/租金/CU 成本高）；接受现状（已不必要）。
