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

## 7. 补最后一步：事件流存证（设计选项，2026-10-08 记）

现状：HandReplay 让「VRF + 盐 + 每街前置摘要 → 52 张牌」可验证（实测 9/9 通过）。
不可验证的是「事件流 → transcript_final」—— 也就是说，无法从链上证明**某条转录就是真实
发生的行动序列**。原因：行动事件流大小无界（一手可能有几十条 Action），不可能塞进定长账户。

三个选项（按推荐度）：

**A. 每街 Merkle 根（推荐，成本最低）**
每街结束时把该街的事件字节算出 Merkle 根，写进 HandReplay 的空位（每街 32B，5 街 = 160B，
现有 `_pad` 与 ring 调整即可容纳）。玩家/观察者拿到完整事件流（链下publish，例如 IPFS 或
crank 的日志包）后，可以验证「这些事件 → 这条街的根」并对上 HandProof 里的
`transcript_final`。
- 优点：链上成本固定且小（每手 +160B），事件流仍然链下（不膨胀账户）；
- 缺点：事件流本身要在链下拿到（但我们本来就需要它才能复算 —— 现在连它都没有，
  因为 transcript 只链进哈希；所以这一步同时解决"复算式验证"的数据来源问题）；
- 落地：程序 +1 个累积器（Merkle 或简单哈希链，后者更省：每街一条 `sha256` 链值）；
  客户端（crank + 浏览器）按同样规则重算。

**B. 全事件流按手上链（最彻底、最贵）**
每手开一个独立账户（或 PDA 追加），把事件字节原样写入。
- 优点：一切自明，不需要链下数据；
- 缺点：账户数量/租金与 CU 都显著上升（几千字节/手），16 手/桌的 ring 也放不下，
  需要新的生命周期设计；主网成本前必须实测。

**C. 不做（接受现状）**
把「行动序列不可独立验证」写进信任页的「仍然需要信任」一栏（当前已经写了）。
- 适合：主网上线初期，等 A 或 B 的成本/收益算清楚再补。

**结论**：按 A 走。它把"能验证的边界"从"牌是公开随机数的函数"推进到"每一手的事件序列都与
链上承诺一致"，且链上成本只有每手 160 字节。B 留作后续（例如需要监管级存证时）。
