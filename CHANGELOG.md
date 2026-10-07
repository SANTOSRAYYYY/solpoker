# CHANGELOG

## Stage 7（第一段）：前端对局 + crank 服务 + PER 成员轮换正式化（2026-10-07，devnet-tee）

> 浏览器只签玩家动作、crank 驱动阶段机的最终架构全部打通：
> `node scripts/stage7-player-sim.mjs 9` 输出 `STAGE7_PLAYER_SIM_OK`
> （纯玩家流程：sit_down → crank take_seat → 盐承诺/揭示 → crank 发牌/三条街
> → 结算 → stand_up → crank commit_game → cash_out，全程除玩家动作外零人工）。

### 做了什么

- **程序（3f3d5ad）**：§11.2 落地——`perms.rs` 共享 CPI 助手；take_seat 把
  占用者钱包加入自己 hand 的 PER 成员（`[admin, occupant]`），stand_up 在
  手牌边界恢复 `[admin]`；init_permissions 创建时基线 members=[admin]。
  **普通玩家不再需要任何 admin 引导操作**（admin_set_members 保留为覆盖
  通道）。e2e 在新桌（#9）全流程复验通过。
- **crank 服务 `scripts/crank.mjs`**：轮询驱动——take_seat（比较账本与
  Game 的 occupancy_id）、advance（VRF 街按状态门控：Idle 时 advance 负责
  arm、Ready/Pending 等履行、Fulfilled 时发牌）、request_vrf、claim_timeout
  （过 action_deadline）、commit_game（hands_since_commit 达阈值）。附
  `fund <wallet>` 子命令（devnet 新钱包发 SOL + tUSDC）。
- **前端 `web/`**：牌桌页（Privy 钱包 → TEE attestation 门控 → 入座 → 桌面
  → 行动区 → 兑现）、信任页（§16 逐项证据链接）；`lib/` 客户端层——原始
  字节 Game 解码（anchor-ts zero-copy 枚举解码 bug 绕行）、session key
  （D2/X10：sit_down 一笔签名授权 + 预充 0.001 SOL，此后动作零弹窗）、自动
  盐流程（sessionStorage 按 hand_id 持久化）、ER 交易纪律（1.4M CU ix +
  skipPreflight）、1.5s 轮询（本机无 WebSocket 通道，§13 订阅降级为轮询，
  已记偏差）。
- **脚本**：`stage7-player-sim.mjs`（上述纯玩家验收）、`install-idl.mjs`
  （anchor 1.0.2 `idl build` 只输出到 stdout，提取写入 target/idl）。

### 本阶段发现并修复的问题

1. **crank 死锁（VRF 街 arming）**：advance 门控最初是「VRF 未履行就不推进」，
   但 AwaitStreet/AwaitRunout 的 VRF 恰恰靠 advance 在 Idle 状态 arm——改为
   按 vrfState 精确门控（Idle 推进 arm、Ready/Pending 等、Fulfilled 推进发牌）。
2. **commit_game 的 BadFeeVault（6027）**：magic_fee_vault 的 canonical 派生
   在 **DLP** 下（`["magic-fee-vault", TEE_VALIDATOR]`），不是 MAGIC_PROGRAM。
3. **快照时效判定**：上一手的 L1 快照座位同样是 Left，单看 status 会误判为
   已落地——必须比 occupancy_id（当前账本 vs 快照）。
4. anchor-ts 的 u64 参数必须是 BN（native BigInt 报
   `src.toArrayLike is not a function`）。

### 验收命令及结果

- `cargo test --workspace`：全绿。
- `node scripts/stage6-full-hand-e2e.mjs 9`：`STAGE6_FULL_HAND_E2E_OK`
  （成员轮换正式化后的全流程复验）。
- crank + `node scripts/stage7-player-sim.mjs 9`：`STAGE7_PLAYER_SIM_OK`。
- `cd web && npm run build`：通过（/ 与 /trust 静态预渲染）；浏览器实测：
  牌桌页渲染、Privy 登录框（深色）弹出、信任页渲染，全部正常。

### 遗留问题

- **（2026-10-07）admin_force_stand_up：运营侧清座（弃置座位回收）**。用户问
  「桌子卡住要不要重部署」——重部署只换代码、不动账户数据（卡住的座位在
  Game 账户里），所以加了正确的工具：`admin_force_stand_up(idx)`（ER，
  table.admin 门禁）。**资金纪律：筹码全额转入该座位自己的 owed_total，只有
  占用者入座时固定的 payout 地址能 cash_out 领取——管理员/金库碰不到任何
  资金**；限制：座位须在当前手牌之外（hand_in 时的玩家等本手结束自动离座）。
  已在 #5 的未知密钥遗留座位上实链验收（20 USDC 按其 payout 兑付，
  #5–#9 全部清空）。脚本 `scripts/force-stand-up.mjs`（含 payout ATA 兜底
  创建）。**运维经验：重新部署程序后，ER/TEE 会有短暂窗口仍运行缓存的旧
  二进制（症状：新指令返回 101 InstructionFallbackNotFound，advance 等旧
  指令正常）——等待 ~30–60s 重试即可，无需其他操作。**
- **（2026-10-07）A7 自动离座补齐 + 死桌清理**：用户实测「其他桌上的人很久
  不走」。定位：自动离座只在 `close_hand`（手牌结束）执行，而**手牌卡在
  Commit（掉线玩家从不提交承诺）时 close_hand 永不执行**——strikes 白涨、
  桌子永久卡死（#5 就是活例）。修复（程序 + 回归测试
  `commit_timeout_auto_stands_up_after_max_strikes`）：Commit 超时达
  max_strikes 的座位**就地自动离座**（未开始的手牌无投入，释放同
  close_hand）；离座后不足 2 人 → 本手取消回 Idle（无投入、不写证明条目）。
  crank 同时加固：Idle 无手可开时不再空转发交易（此前每秒一发）、所有 RPC
  请求加 20s 超时（本机中继 keep-alive 假死会让循环永久挂起）。链上复验：
  #5/#6/#7 的遗留玩家与新孤儿座位全部按预期离座；#6/#7/#8/#9 现为空桌。
  清理工具入仓库：`table-status.mjs`（全桌体检）、`cash-out-seat.mjs`
  （permissionless 兑付）、`stand-up-player.mjs` /
  `cleanup-orphan-seat.mjs`（测试玩家/会话密钥离座）。#5 剩一个极早期测试
  玩家的未知密钥座位（无法代为离座，符合「资金不可被第三方移动」设计）。
- **（2026-10-07 用户决定）钱包通道收敛为 Privy 单通道**：SIWS 在后端开启后，
  直连钱包路径（wallet-standard，commit c9dd871）按用户要求移除，实现保留在
  git 历史中可随时恢复。当前所有钱包连接（Phantom/Solflare/Backpack/内嵌/
  邮箱）统一走 Privy；钱包分类简化为「Privy 内嵌 vs 外部 Solana」。浏览器端
  已验证：完整 SIWS 登录（"All set!"）、会话持久、多钱包选择与标签正确。
- **（2026-10-07 已解决替代方案）直连 Solana 钱包上线**：Privy 的 SIWS 仍开着
  服务端开关问题，但前端新增「直接连接 Solana 钱包」通道（`lib/direct-wallet.ts`，
  wallet-standard）：Phantom/Solflare/Backpack 等扩展**不经过 Privy 登录**即可
  完成 TEE attestation 鉴权（钱包签 challenge）、读取余额/牌桌、`sit_down`
  入座与 `cash_out` 兑现（钱包签 L1 交易）；对局动作沿用本地 session key。
  Privy 的角色收敛为「没有钱包的用户」（邮箱登录 + 内嵌钱包）。已在浏览器
  端到端实测（注入 wallet-standard 测试钱包）：探测 → 连接 → TEE 验证 ✓ →
  余额 25 tUSDC → 坐下 → 链上确认 → crank 计入座位（20.00 上桌）。
  另附 `scripts/sit-test-opponent.mjs`（真人坐下后一键安排带筹码的对手）。
- **（2026-10-07 定位）Solana 钱包登录（SIWS）在 Privy 后台未开启**——用户实测
  「所有 Solana 钱包连接失败：Could not log in with wallet」。直接拉取应用配置
  取证（`node scripts/privy-app-config-full.mjs`）：
  `wallet_auth: true`（SIWE 开，所以 EVM 钱包一直能连）但
  **`solana_wallet_auth: false`（SIWS 关）**；`allowed_domains: []`（域名
  白名单为空，不是白名单问题）。**修改途径已穷尽：官方 API 无更新应用配置的
  端点（PATCH/PUT 均 405，`scripts/privy-api-probe.mjs`）；dashboard 内部 API
  （`/api/dashboard/apps/:id`）需要后台登录会话而非 app secret（401 Missing
  auth token，`scripts/privy-try-enable-siws.mjs`）——即 app secret 无法修改
  该配置，只能在后台 UI 或通过 Privy 官方支持开启。** 客户端代码已是官方
  recipe；过渡期把 `walletChainType` 设为 `ethereum-and-solana`（c94c4cf），
  让可用的 SIWE 路径保持可选。另注：应用处于 **development 模式**
  （bundle 文案 "must be upgraded to production to log in new users" +
  `max_accounts_reached`），新用户登录有配额上限，正式对外前需升级。
- 真机 playtest（Privy 登录 + 真钱包走完整对局）——`sit_down` 的 web3.js v1
  序列化经 Privy signTransaction 的兼容性是首验项（README 待核实 #1）。
- 多桌大厅（当前固定桌 #9）；i18n；`showWalletUIs: false` 的授权策略。
- crank 生产化：进程守护、DelegPayer 余额监控、错误告警。

## Stage 6：托管/资金流/游戏循环全链上线，完整对局链上验收通过（2026-10-07，devnet-tee）

> 每桌独立托管（tUSDC）+ ER 游戏循环 + PER 隐私 + D8 commit 路径全部接线；
> `node scripts/stage6-full-hand-e2e.mjs 8` 输出 `STAGE6_FULL_HAND_E2E_OK`：
> 完整 HU 对局（入座→盐承诺→VRF_0→揭示→发牌→翻/转/河三条街→摊牌结算→
> stand_up→commit_game→cash_out→sweep_rake→陌生人读 PlayerHand 被拒）。
> 守恒实测：p0 19.78 + p1 20.21 + rake 0.01 = 40.00 tUSDC。

### 做了什么

- **程序**：资金流 `fund.rs`（CENT=10_000、buy-in 边界、I-ER/I-X 守恒断言）；
  账户模型定稿（`state.rs`，Game/Deck/HandProof/HandSecrets 全部 zero_copy）；
  游戏循环 `hand.rs`（引擎镜像、发牌、结算、证明环、秘密清零，与 core 逐字节
  对齐）；`create_table` 拆分为 create_table/create_seats/create_hands（13/12/12
  账户——31 账户单指令的 try_accounts 帧 4112B > 4096B SBF 栈，会污染 args）；
  `delegate_table` 一次一个账户（14 个映射）；`commit_game`（D8：canonical
  validator-scoped magic_fee_vault + CommitPayer PDA）；`admin_set_members`
  （§11.2 过渡版 PER 成员管理，见下）。
- **本地复现工具链 `tools/local-repro`**：devnet-tee **从不返回交易日志**
  （成功/失败都没有，printf 调试不可能），且本机 Windows 跑不起
  solana-test-validator（genesis.tar.bz2 解包 ACCESS_DENIED）。该工具用
  magicblock-litesvm 0.16（agave 4.2 系 RBPF，与 TEE 同族）+ 账户 dump 合成
  （公开账户实拉、私有账户按公开承诺公式合成），在本地跑出完整日志。

### 本阶段发现并修复的问题（优化时的关键上下文）

1. **CU 预算是硬约束**：advance 的 AwaitSeed→发牌路径实测 **421,246 CU**
   （2 人桌），远超 200k 默认值。症状是 `ProgramFailedToComplete` + 零日志，
   曾误判为栈溢出二分多日。**所有 ER 重指令（advance/act/claim_timeout/
   request_vrf 等）必须带 `ComputeBudgetProgram.setComputeUnitLimit`**，
   e2e 统一 1.4M；前端/agent 同样必须带。
2. **settle.rs 死层奖金 bug**（proptest 新种子 cc 0654… 抓到）：深筹码在后街
   check-fold（能 check 时 fold 是合法动作）会产生「贡献者全部 folded」的
   层级，修复前兜底分支把该层分给了 fold 者。利用 eligible 掩码嵌套
   （elig(T_{i+1}) ⊆ elig(T_i)）证明死层只构成顶部后缀，并入下层归在场玩家。
   回归测试 `folded_excess_tier_merges_down_never_pays_folders` + 种子已入
   `engine_props.proptest-regressions`。
3. **PER 写执行强制**（TEE 行为变更，上周不存在）：成功执行且写了 PER 私有
   账户的交易要求签名者是成员，否则顶层 `InvalidWritableAccount`。成员模型：
   `deck ← [crank]`（**永不加玩家**——含全部盐与 VRF 输出）；`hand_i ←
   [crank, 占用者_i]`（自读无害，reveal_salt 需要）。注意同一个
   InvalidWritableAccount 也可能是「账户未委托」（本阶段被这个假象带偏过一次：
   delegate 门控只查了 game，deck/hands 实际没委托）。
4. **TEE preflight 与执行不一致**：simulateTransaction 拒绝非成员的可写加载，
   执行却接受——ER 交易一律 `skipPreflight: true`。
5. **commit 是异步的**：commit_game 的 intent bundle 落地有约 500ms 延迟，
   cash_out 前必须轮询 L1 快照到座位 Left 可见（否则 6019 StaleSnapshot）。
6. **DelegPayer 需要余额监控**：每张桌 14 次委托，单次约 1.6M lamports 级；
   生产环境要有告警/自动补足。

### 验收命令及结果

- `cargo test --workspace`：全绿（含新回归测试与全部 proptest）。
- `node scripts/stage6-full-hand-e2e.mjs 8`：`STAGE6_FULL_HAND_E2E_OK`
  （每步签名在 `e2e8.log`；VRF 履行延迟稳定在 ~170–190ms）。

### 关键签名（devnet / devnet-tee）

- 程序部署（含 admin_set_members）：`BuGLDt69V2AvCNpfWUJizQY7iL2jzSht46CCm2NfwGvJGqh8ZRLbGGyRBz5CHgE2AHUtxA1M3ymFGQpovzXGZR3`
- 发牌 advance（AwaitSeed→Preflop）：`61bNh5R7o5V8xpquVaL2nt1NMaq5nzFxVWMA9psakF5VqmwQeJXK5JgfmX9qxQyGjVVvHHvCa9qzaKXoevs1JsBQ`
- 结算 advance（Settle→Idle）：`4rosaxLAVpjQ3LVLSggXmtq3oyDYTHRGpNveczLnqZHLN5E8DQaJUPjH5cV2mxoXc4oGq2FJqy3bhJYyF94eWxMH`
- commit_game：`V5y65xwkACDmbzFFBG3pg12NGqaqHdMtt2y9gqFRdZndwn6hKQJ6v2V7NRHPdEBts1fymvHjVju6x28nuv8sp7q`
- sweep_rake：`F6GJASzPj6rNonsZ6YM7uBxFEZDyXxJdzhDnbWaLAdhjVQTRFsHfrtX7KQVepWhPPQuKtPGJyChEZJJqnpSRUnR`

### 遗留问题（Stage 6 收尾/Stage 7 接线清单）

- Phase 3 正式成员轮换（take_seat/stand_up 内联 UpdateEphemeralPermissionCpi）
  ——`admin_set_members` 是过渡版，但已作为 admin 覆盖通道保留。
- advance 对全部 9 个 PlayerHand 的 Anchor 写回使 crank 必须是所有 hand 的
  成员；可考虑 PlayerHand zero_copy 化消除无谓写回。
- 9 人桌 CU 实测未做（2 人发牌 421k，预计 9 人 < 1M）。
- 维护模式/逃生舱仍是 compile-only；混合桌与 x402 在 Stage 7/8。

## Stage 5：规则引擎与结算（solpoker-core，proptest 全绿，2026-10-06）

> 纯 Rust 规则引擎全部落在 `solpoker-core`（设计 §6/§7）：牌型评估、位置与
> 行动、强制投入、最小加注、runout 条件、贡献层边池结算、rake、奇数筹码。
> §7.3 的全部 proptest 性质跑通。链上接线（事件、时限、计分、HandProof、
> CU 实测）归 Stage 6。

### 做了什么

- **`src/eval.rs`**：7 选 5 牌型评估（21 组合枚举），`HandRank`（类别 +
  比较序踢脚，可 Ord）；wheel A2345 高牌记 5；皇家同花顺 = A 高同花顺；
  花色不参与比较（分池友好）；`best_indices` 返回全部并列赢家。19 个单测
  （含 500 组随机不变量扫描）。
- **`src/engine.rs`**：手牌状态机——2–9 人位置（3–9 标准 BTN/SB/BB；
  heads-up 特例 button=SB、翻前 button 先、翻后 BB 先）；强制投入（ante
  按座位升序→SB→BB，短码先 ante 后盲注、不足即 all-in；ante 死钱不计入
  street_bet）；动作（fold/check/call/bet/raise/all-in，金额必须 CENT 整数
  倍）；完整加注重开 pending、不足额 all-in 不重开（acted 玩家只能
  call/fold）；`live==1` 立即结算；runout 条件（pending 清零、live≥2、
  actionable≤1）；超时能 check 就 check 否则 fold 并记 strikes。
- **`src/settle.rs`**：先退唯一未跟注差额 → 贡献层主/边池（folded 贡献但
  永不 eligible）→ rake（`min(floor_cent(gross×2.5%), 3BB)`，不见翻牌不
  收、≤1BB 不收，主池向边池依次扣）→ 逐池评估并列赢家平分、余数从
  button 左侧第一个该池赢家顺时针发 → 守恒断言。`void_hand` 全额退回。
- **`tests/engine_props.rs`**：§7.3 全部性质的 proptest（守恒、单调、
  合法性、终止、确定性、rake 边界、边池划分、奇数筹码、HU 特例），
  每性 48–64 例；`engine_props.proptest-regressions` 钉住开发中抓到真
  bug 的种子（保留）。

### 规则定案（优化时的关键上下文）

1. `live == 1` 在一条街中途也立即结算（即使该玩家还在 pending 里）。
2. 不足额 all-in 抬高 current_bet 时：未行动者保留加注权；已行动者只能
   call/fold（`RaiseNotReopened`）。
3. strikes 引擎内只增；主动行动清零与 3 次自动站起归链侧（§6.3）。
4. 翻前 runout 时 `flop_dealt` 由链上 runout advance 在 settle 前置位
   （rake 以实际发出翻牌为准）。
5. `Bet` 与 `RaiseTo` 在 `current_bet == 0` 时同一路径，翻后最小下注 1BB、
   翻前最小加注到 2BB 自然成立。
6. `settle` 对 `R: Ord` 泛型，直接接 `eval::evaluate7`。

### 验收命令及结果

| 命令 | 结果 |
| --- | --- |
| `cargo test -p solpoker-core` | ✅ 89 单测（17 引擎 + 11 结算 + 19 评估 + 42 既有）+ 1 向量集成 + 7 proptest + 1 文档测试 |
| `cargo test --workspace` | ✅ 全部（含 Stage 2/3/4 回归） |
| `cargo fmt --all -- --check` | ✅ 干净 |

### 遗留问题（Stage 6 接线清单）

- 事件流：从引擎转移追加 transcript 事件（引擎本身不发事件）；
  `claim_timeout` 前的截止时间检查；strikes 清零与自动站起；runout
  advance 调 `DealSession::deal_runout` 后置 `flop_dealt` 再 settle；
  rake_total/credited/owed 累计、HandProof 写入、leave_requested/零筹码
  站起处理。
- §7.4 计算预算：九人最坏结算 CU 实测；必要时拆「评估固定结果」与
  「分配」两条指令。

## Stage 4：发牌协议三件套，三方逐字节一致（2026-10-06）

> 字节级规范 + Rust 实现 + Python 参考实现 + 测试向量全部落地，**三方逐字节一致**
> 已在本机跑通（§17 S4 验收口径）。链上 PlayerHand/发牌指令依赖座位模型，
> 归 Stage 5/6（规范 §1 已注明）。

### 做了什么

- **规范**：`docs/dealing-protocol.zh.md` / `.en.md`——牌编码、盐承诺/聚合、
  逐街种子、首手庄位、13 种事件的字节布局、transcript 链、HMAC 拒绝采样
  抽牌、runout 合并、验证流程、安全性质。事件规范顺序：
  `HandStart → SaltCommitted(升序) → VrfFulfilled(0) → ForcedBet →
  StreetStart(0) → HoleDealt → VrfFulfilled(k) → StreetStart(k) → BoardDealt`。
- **Rust**：`crates/solpoker-core/src/deal.rs`（约 1100 行）——全部公式与
  `DealSession` 编排（`deal_hole` / `deal_street` / `deal_runout` /
  `append_event` 分步可调），43 个单测 + 1 文档测试；
  `crates/solpoker-core/tests/deal_vectors.rs` 向量集成测试（std 手写极简
  JSON 解析，无新依赖）。
- **Python 参考**：`reference/solpoker_deal.py`（纯标准库）+
  `reference/generate_vectors.py`（确定性生成，重复生成逐字节相同）。
- **测试向量** `vectors/v1/`：`hu_2p`、`3p_sparse`（稀疏座位 0/4/8）、
  `9p_full`、`button_rotation`（庄位轮转）、`runout`（翻前 all-in 合并）、
  `redraw`（拒绝采样重抽，force_retry 测试钩子——自然拒绝概率 ≤2.8e-18
  不可暴力搜索）。
- **编码定案**（优化时的关键上下文）：
  - `salt_digest = sha256("solpoker/salts/v1" ‖ table ‖ hand_id ‖ hand_mask
    ‖ 升序 (seat,occupancy_id,occupant,salt))`；`seed_k =
    sha256("solpoker/seed/v1" ‖ VRF_k ‖ salt_digest)`——与设计 §8.3 逐字节
    一致，table/hand_id 经 salt_digest 传递绑定，不做额外绑定；
  - `VrfFulfilled.attempt` 一律 1 起（与链上 caller_seed 的 attempt 约定
    一致），各 target 取值写入 inputs 的 `vrf_attempts`，保证 inputs
    完整决定 expected；
  - runout 的 `BoardDealt.street` 记实际牌位（1/2/3），仅 `vrf_src=4`
    （HandProof 的 board_src 与 vrf_src 一致）；
  - 拒绝采样阈值 `2^64 mod n` 用 u128 计算：mod 52=16、mod 51=1、
    mod 3=1、mod 2=0。

### 验收命令及结果

| 命令 | 结果 |
| --- | --- |
| `cargo test -p solpoker-core` | ✅ 43 单测 + 1 向量集成测试（6 条向量全部逐字节一致）+ 1 文档测试 |
| `py -3 reference/solpoker_deal.py verify` | ✅ 6/6 OK |
| `py -3 reference/generate_vectors.py`（重复生成） | ✅ 逐字节相同 |
| `cargo test --workspace` | ✅ 全部（含 Stage 2/3 回归） |

### 遗留问题

- 链上接线（Stage 5/6）：`advance`/发牌指令调 `DealSession` 各步，传真实
  attempt（VrfSlot），在正确位置注入 ForcedBet/Action/Timeout/
  StreetSkipped/HandEnd/HandVoid，事件字节写入 Game.events/ProofEntry；
  发牌时校验各座位 salt_commitment（缺失/不符 → HandVoid(MissingSalt)）；
  首手 `first_button`，之后 `next_clockwise` 轮转，Game 存 prev_button/
  button_initialized。`set_force_retry` 是测试钩子，链上禁用。
- CI 把「Rust + Python + 向量」三方一致性纳入流水线（本机已验证，
  ci.yml 待加一步 `py -3 reference/solpoker_deal.py verify` +
  `cargo test -p solpoker-core --test deal_vectors`）。
- 2 人时 button_pick 的 mod 2 与原 heads-up 公式等价性已在规范 §5.3 注明。

## Stage 3：PER 隐私层上线（2026-10-06，devnet-tee 实测）

> Deck 现在有真实的 PER 私有权限：陌生 token 读取被 validator 拒绝（不是
> 「服务端不返回」，是权限层强制）。PlayerHand 的 9 个权限随 Stage 4 发牌
> 一起做。

### 做了什么

- **`init_permissions`（ER，admin-gated）**：对 Deck 调
  `CreateEphemeralPermissionCpi`（`is_private=true, members=[]`，SDK 0.17.3
  源码核对签名）；权限为 ER 本地账户，不在 L1 建/委托（§4）。
- **CommitPayer 测试台雏形（D8）**：`create_table` 新建程序 PDA
  `["commit_payer", table]`（0 字节，充 0.05 SOL），`delegate_game` 一并
  委托。起因是 Stage 3 首次上链发现的 ER 规则：**被修改的付款账户必须是
  委托账户**——用未委托的 deployer 付权限租金会被拒
  （`Feepayer was modified without being delegated` → `InvalidAccountForFee`）。
- **程序扩容**：access-control 引入后 .so 从 225KB 涨到 382KB；Agave 3.x
  要求 ProgramData 扩容最少 10,240 字节，先 `solana program extend … 33000`
  再部署（此前曾触发 "only 1072 were requested" 的部署失败）。
- **端到端脚本**：`scripts/stage3-privacy-e2e.mjs`（全路径+可见性检查）、
  `scripts/stage3-sim-probe.mjs`（模拟取证）、
  `scripts/stage3-identify-account.mjs`（账户识别）。

### 验收命令及结果（devnet-tee，table_id=46）

| 验收项（设计 §4/§17 S3 核心项） | 结果 |
| --- | --- |
| create_table + delegate_game（含 commit_payer） | ✅ `uhUBqf91dsmU…`、`5wnTMEGbezQk…` |
| init_permissions（Deck members=[]） | ✅ `dtvyaVsAKtXy…`（195ms） |
| **陌生人读 Deck 被拒** | ✅ 全新随机钱包 + 自有 token：返回 null/拒绝——PER 强制生效 |
| 陌生人读 Game 照常（公开账户） | ✅ 281 bytes 可读 |
| PER 就位后 VRF 链路照常（CPI 写不受限） | ✅ arm 196ms → request 197ms → fulfilled 791ms，attempt=1 |

### devnet 交易签名

部署：extend+deploy `5tC8ncbztHtm9DkVixrjNxoX1GCH8ADPyqFssBYDcbwcKFfV6em8YJmF5Lkm1FLFQsuow9NFAVfLPdf45urGGGEH`。
table 46：create `uhUBqf91…`、delegate `5wnTMEGbez…`、init_permissions
`dtvyaVsAKtXyM9TS1muWEsyURnpwvKTXLe2TCDepWj6TxuDfCvsuc7hW2J1eyk18bcQ7iwLKa3LXGDAdFkQ5xuM`、
arm `5NNibjizjp9s…`、request `3XMbNkn1VfPq…`。

### 本阶段发现并修复的问题（优化时的关键上下文）

1. **ER 费用规则**：ER 内任何「修改账户」的操作，被修改账户必须是委托
   账户；未委托账户在 ER 是只读克隆。权限租金、未来的 commit 费用都要走
   委托的 CommitPayer（D8 的正确性再获实证）。
2. **`#[delegate]` 宏对每个 `del` 字段各生成一个方法**，handler 必须逐
   个调用——加了字段忘了调用，账户就「传了但没委托」（Stage 3 实测踩过：
   commit_payer 没被委托，`illegally used as writable`）。
3. **权限创建 CPI 里 permissioned_account 是 readonly+signer**，由我们的
   PDA seeds 签名；rent 从 payer 扣，permission 账户归 ACL 程序所有。
4. **Agave 3.x ProgramData 扩容最少 10,240B**；程序变大前先 `solana
   program extend`。

### 遗留问题

- PlayerHand×9 的权限（members=[占用者]）随 Stage 4 发牌落地；换人时
  `UpdateEphemeralPermissionCpi` 的顺序测试（§11.2）也归 Stage 4/6。
- `waitUntilPermissionActive`：本次建权限后立即读就被拒（同 slot 生效），
  未遇到需要等待的情形；换人权生效时机仍待实测（§18.2 问题 6）。
- `commit_payer` 余额监控/充值走运维流程，测试台未做（设计 R1b）。
- 权限账户租金 4096 lamports/个已实测；13 账户全量权限的成本在 Stage 4
  建齐账户后再核算。

## Stage 2 续：devnet-tee 链上验收通过（2026-10-06）

> 在全新 Windows 机器上装齐工具链（Solana CLI 3.1.10 + Anchor 1.0.2 官方
> 预编译二进制），程序升级到 devnet 并完成 VRF 端到端实测。机器只能经
> 系统代理出网，公共 RPC 对共享出口 IP 限流（429），最终方案：
> `scripts/http-relay.mjs` 本地 Host 重写中继 + **rpc.magicblock.app/devnet**
> （无限流）+ `solana program deploy --use-rpc`（TPU 直连被网络阻断）。

### 做了什么

- **测试台指令**（admin-gated）：`create_table` / `delegate_game` /
  `debug_arm_vrf`——没有它们链上验收走不到 Ready；生产版建桌（§11.1）
  在 Stage 5/6。`#[ephemeral]` 宏已加，Table 加 `admin` 字段。
- **修复三个首次上链才发现的 bug**：
  1. **ER owner 约束错误**：被委托账户在 ER 上归原程序所有（不归委托
     程序），`owner = ephemeral_rollups_sdk::id()` 覆盖已从全部 5 个 ER
     侧上下文移除（smoke Stage 0 的 ER increment 即为证据）。
  2. **oracle_queue 未标 writable**：VRF 程序要求队列可写（
     `AccountMeta::new(queue, false)`），漏标导致
     "unauthorized writable account"。
  3. **callback_args 缺 borsh 长度前缀**：Anchor 对 `Vec<u8>` 参数按
     borsh 反序列化（u32 LE 长度 + 数据），不传前缀时 hand_id 的前 4 字节
     被当长度——hand_id=0 时回调收到空 Vec 被静默忽略，fulfillment 交易
     ok 但状态停在 Pending。编码已改为 `[u32 len] ‖ hand_id_be ‖ target ‖
     attempt`。
- **端到端脚本**：`scripts/stage2-vrf-e2e.mjs`（全路径）、
  `scripts/stage2-vrf-retry.mjs`（重试路径）、
  `scripts/stage2-probe-state.mjs`（状态取证）。
- **前端 TEE 鉴权**：`web/lib/tee-auth.ts`（attestation 校验用
  `crypto.getRandomValues` 挑战，替代 SDK 的 `Math.random`；token 只存
  内存）+ 页面「连接 TEE」按钮。

### 验收命令及结果（devnet，§17 S2）

| 验收项 | 结果 |
| --- | --- |
| 程序升级部署 | ✅ 3 次升级签名：`3pQC8MatX6…`（slot 508049397）、`2EScTnTWda…`、`3ByhTg3kmW…` |
| create_table + delegate_game（L1 → MTEW…） | ✅ `61ahPgdCKQ…`、`56EFcLVzjk…` |
| TEE 内请求 + scoped 回调 | ✅ request_vrf `3kUzVXx6h2…`（168ms）→ fulfilled，attempt=1，Deck.vrf_out[Flop] 已填（`77d1eb8b…`） |
| 超时重试 | ✅ retry_vrf `3uYxh7ASgM…`（211ms）→ fulfilled 845ms，attempt 1→2，Deck.vrf_out 非零 |
| 旧回调 Ok+忽略 | ✅ attempt=1 的 fulfillment 交易执行 ok、状态不变（在修复编码 bug 前的真实观测） |
| ER 队列费用 | ✅ 无 payer 扣费（余额比对） |
| 伪造身份拒绝 | 宏静态保证：注入的 Signer 带 `address = scoped_vrf_identity(&crate::ID)` 约束 |
| 3 次耗尽 → 作废 | core 单测覆盖（17+1）；链上路径与重试相同 |
| 延迟 p50/p95 | 样本 n=2：718ms / 845ms（sent → fulfilled，经代理+relay，属上限） |
| 本地栈全路径 | 本机 Windows 无法跑 ephemeral-validator，以 devnet-tee 为准 |

### devnet 交易签名

部署：`3pQC8MatX6fQPwpnrbPWjHmC4qipPJvnTSdcXfZjdgRy7QtKAv65nt3R1ocY2NY21M1iM8jdcUCHJq76CGhF2qzF`、
`2EScTnTWdaAeZmdmfTmBS6gW42Kq8GfGhhfLyiHPjNgFqJKc5DsDyEa797UW1RUQjiTRX7UHbimfoHUiyG9bUL6W`、
`3ByhTg3kmWd1nUzHosXZcFs1imveqDiJ2kTLBPEng27hbStULNtv4BNBFMuXPayyo9RnEx98cZ5nTdDM3coprvLg`。

table_id=42（重试路径）：create `4yYVBk8hZcug…`、delegate `4XbREyxQJ4A…`、
arm `3EZyKinG2VHp…`、request（旧编码，ok+忽略）`4VPdALAvsJU…`、
retry `3uYxh7ASgM3QdeW2G31TTSAya1JizUffHnDb2KKPQoTRAW2aHhwDDLSxv9WwB21Wj9nYpf8XJmtYjnNKbXnV7vhm`。

table_id=43（正常路径）：create `61ahPgdCKQoa…`、delegate `56EFcLVzjk1v…`、
arm `2XkfzopPwRrn…`、request `3kUzVXx6h2xr…` → fulfilled 718ms。

### 遗留问题

- 延迟样本 n=2，不足以定 `vrf_timeout_s`；用 `scripts/vrf-latency/` 的
  probe 跑 ≥20 组后再调 Table 参数（当前默认 10s 远大于实测 ~0.8s）。
- 本地栈（ER 0.14.10）路径未测——本机 Windows 跑不了 ephemeral-validator；
  CI 或 Linux 机器上补。
- `vrf_timeout_s` 期间 fulfillment 的 PrivilegeEscalation 失败交易
  （`35SPoMeir…`）出现在 writable 修复之前，属预期历史遗留，非新问题。
- deployer 余额 90.09 SOL；中断的部署曾留 buffer，当前无遗留可收。

## Stage 2：TEE 内 VRF — 本地快速开发基线（2026-10-05）

> 本轮在一台全新 Windows 机器上从零搭环境（Git 2.55 / Node 24.10 / Rust 1.89 /
> MSVC Build Tools / `magicblock-dev-skill`），先用本地脚手架 `stage2-dev/`
> 并行开发，再合并回主仓库。**仓库 main 上现在就是这份代码**，workspace
> 全量测试通过；链上实测（本地栈 / devnet-tee）待有 Solana/Anchor 工具链后
> 按「验收命令」执行。

### 做了什么

- V1 拆分：VRF 状态机（arm / request / fulfill / retry / 耗尽 Void）落在
  [`crates/solpoker-core`](crates/solpoker-core)（纯 Rust，无 Anchor/Solana
  依赖，sha2 + hmac）。链上 `Game.vrf` 是可序列化镜像（**不存 randomness**，
  未公开输出只进私有 Deck，§3.2/§15），经 `core_replay` / `sync_from_core`
  调用核心逻辑，规则只有 core 一份。
- `request_vrf` / `retry_vrf` / `vrf_callback` / `advance` stub 在
  [`programs/solpoker`](programs/solpoker)，替换 Stage 0 模板骨架（`initialize`）。
  全部用 crates.io 拉取的 SDK 0.17.3 真实源码核对签名（见各文件头部注释）。
- 探测脚本 [`scripts/probe-vrf-latency.ts`](scripts/probe-vrf-latency.ts)
  （sendRawTransaction + 轮询确认，normal/high，p50/p95/p99）与
  [`scripts/vrf-latency/`](scripts/vrf-latency)（独立 Node 24 ESM 子包，
  依赖按【版本钉死】锁定）。
- E6：仓库根 `package.json` 声明 `"type": "module"`；[`docs/stage2-notes.md`](docs/stage2-notes.md)
  带任务复述与 §17 S2 验收清单（已验证项打勾，链上项待跑）。
- CI 校验关系：`check-pins.sh` 的 crate 钉死检查不变（attribute 钉死不影响
  `anchor-lang` 唯一性），根 `package.json` 的 `"type": "module"` 需 yarn 重装
  后以 Stage 2 本地栈测试为准（Stage 0 遗留问题 6 已处理）。

### 验收命令及结果

| 验收项（§17 S2） | 命令 | 结果 |
| --- | --- | --- |
| V1 拆分 arm/request（纯逻辑层） | `cargo test -p solpoker-core` | ✅ 17 单测 + 1 文档测试全过（含 caller_seed 钉死向量） |
| 回调编解码 / caller_seed 一致 | `cargo test -p solpoker` | ✅ 4 单测（复算 core 钉死向量、args 往返、坏输入拒绝） |
| 程序编译（无告警） | `cargo check -p solpoker` | ✅ 干净通过（修复过程中解决 3 类问题，见下） |
| workspace 全量 | `cargo test --workspace` | ✅ core 17 + 程序 4 + smoke 回归 1 全过 |
| TEE 内请求 + scoped 回调 | 本地栈 `anchor test --skip-local-validator` | ⏳ 待跑（需 Solana CLI 3.1.10 + Anchor 1.0.2） |
| 正常/高优先级 | 同上 + probe 脚本 | ⏳ 待跑 |
| 伪造身份拒绝 / 超时重试 / 3 次耗尽作废 | 同上 | ⏳ 待跑（宏约束已静态验证签名者地址） |
| 延迟 p50/p95 | `cd scripts/vrf-latency && npm run probe:vrf-latency -- --n 50`（四组） | ⏳ 待跑 |

### 修复过程中确认的技术事实（比设计文档新增）

1. **Anchor 1.0 布局约束**：`#[program]` 生成 `pub use crate::__client_accounts_<ix>::*;`，
   而 1.0.x 的 `#[derive(Accounts)]` 把 `__client_accounts_*` 模块放在结构体所在模块——
   两者只对得上当**所有 Accounts 结构体定义在 crate 根**。已把 4 个上下文结构体移到
   `programs/solpoker/src/lib.rs` 根，handler 留在 `src/instructions/`。
2. **anchor-lang 1.0.2 的 attribute crate 会漂移**：`anchor-attribute-* = "1"` 区间会
   解析到 1.2.0，导致宏/运行时错配（E0432、unexpected_cfg 噪音）。已在
   `programs/solpoker/Cargo.toml` 与 `programs/smoke/Cargo.toml` 把 10 个
   `anchor-attribute-*`/`anchor-syn` 钉到 `=1.0.2`。
3. **`#[vrf]` 只能用于结构体**，不能放在父上下文的字段上；嵌套 VRF 账户作为普通
   字段即可。
4. **borsh 1.x 拒绝带显式判别值的枚举**；`VrfState`/`VrfTarget` 去掉 `#[repr(u8)]`
   和显式判别值，线上编码走显式 `to_u8()`（与 core 钉死向量同源）。
5. **solana-program 3.x 没有 `solana_program::hash`**；`vrf_callback_discriminator`
   改用 sha2（与 core 同库，链上可用）。
6. **`next_clockwise` 单人语义**：mask 只剩自己时返回自己（total 函数，调用方循环
   无需特判）；`None` 仅表示空 mask。文档注释与测试已固定此语义。
7. 默认决定待确认：**attempt 从 1 开始编号**（0 保留为非法值）。

### devnet 交易签名

待跑（本地栈与 devnet-tee 验证后填入 [`docs/stage2-notes.md`](docs/stage2-notes.md)「证据」一节）。

### 遗留问题

- 本地栈 / devnet-tee 全路径实测：需装 Solana CLI (Agave) 3.1.10 + Anchor CLI 1.0.2，
  按 `scripts/mb-stack.sh` 启动本地栈后 `anchor test --skip-local-validator`。
- probe-vrf-latency.ts 的指令编码 TODO：依赖部署后的程序 IDL 与 Game/Deck 回调解码。
- 主网 TEE 上 VRF 的费用、延迟和速率限制（设计 §18.2 问题 9）。
- 队列频率限制未知，探测若触发限流需记录阈值并回报 MagicBlock。
- `owner = ephemeral_rollups_sdk::id()` 约束 + solana-program 3.0 类型统一、回调
  账户顺序假设（identity signer 在前，`[deck, game]` 在后）、ER 队列是否扣 payer——
  首次 `anchor build` 与本地栈 fulfillment 时确认（记录于
  [`programs/solpoker/README.md`](programs/solpoker/README.md)）。

## Stage 1 定稿（2026-09-30）

### 做了什么

- **D1–D6、E1–E7、X1–X6 全部确认**：[`stage1-design.md`](docs/design/stage1-design.md) 和 [`stage1-agents-x402.md`](docs/design/stage1-agents-x402.md) 改为定稿 v1，[`stage1-fees-escape.md`](docs/design/stage1-fees-escape.md) 改为已确认的初步方案；决策记录新增 §11。
- **混合桌、本地 MCP 打牌和资金安全的详细审查**（配套文档一重写）：混合桌细则、MCP 进程结构（执行器与决策分开）、每手时序与时间预算、过期动作防护、崩溃恢复、工具清单、五层资金防线、限额的精确定义、签名前校验、威胁模型。新增 X7–X13，已按推荐默认执行，并同步到主设计文档：`SeatLedger.payout`、`Game.action_seq`、`AgentProfile.payout` 与 `Paused` 状态、`act` 带 `hand_id` 和 `action_seq`、`advance` 每手复查座位资格、session key 预充。
- **ER 手续费付款人实测**（`scripts/probe-er-feepayer.ts`）：你说 ER 不接受余额为 0 的付款人；实测今天 devnet-tee（ER 0.16.0）和本地栈（ER 0.14.10）都接受，ER 内交易费为 0。设计仍按保守方案：session key 预充 0.001 SOL（X10），金额可配置，主网上线前再测。
- **核实 mainnet-tee**：`getIdentity` 返回 MTEW…，版本与 devnet-tee 相同（magicblock-core 0.16.0，git e66d914）。
- **项目指令更新为上下文块 v4**（[`docs/design/context-block-v4.md`](docs/design/context-block-v4.md)），项目文件同步了三份 Stage 1 文档和决策记录。

### 验收命令与结果

| 命令 | 结果 |
| --- | --- |
| `node scripts/probe-er-feepayer.ts`（devnet-tee） | 有余额、0 lamports、只有免租最低额三种付款人全部成功，手续费 0，余额不变 |
| 同上，`PROVIDER_ENDPOINT=http://127.0.0.1:8899 EPHEMERAL_PROVIDER_ENDPOINT=http://127.0.0.1:6699` | 结果相同；回收交易把临时账户清零 |
| `curl … getIdentity` 查询 mainnet-tee 与 devnet-tee | 都是 `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |
| GitHub Actions | 见本次推送的运行结果 |

### devnet 交易签名（付款人探测，smoke 程序计数器）

| 步骤 | 签名 |
| --- | --- |
| 委托计数器给 MTEW… | `3kjBxb7WzgCpsQpdy8KWn36EXcewss4JHdgk83RkCn4yyyU9wyGgK25iF5xg6pK7XAadHzX5iNwkQbJYoXGAMMCb` |
| A 部署者付款（ER） | `4HsmzeUQrdvAgQUwzag995AtCrdByFJQdjL2aYYff8YAke43JuobyLzVRJfcRDPDRQDPfX25BTNFTmBWUHVJw7pJ` |
| B 零余额付款人（ER） | `3wDQZk9jFnuWvkQsMxE9A7w6eG2YWpSQzceWZLeyUt8Kz6fprBU4ch1n7TzphAnFgXYxHzfBt1DfSnARrKt9eEcY` |
| 给 C 转入免租最低额（L1） | `ozbT8Z2B1z8o69AHcDgWQiAF6EMPFEUnw6dwNqxox6WWDwv2cesPgb7zhfhXmyXsUgLVH8XVq2BphQHbycjBek8` |
| C 免租最低额付款人（ER，两次） | `621m5FG9KVvbzn2hbk63TH9by5J5YXjMmW4qVedPR7Ns8MCfAepzjFRmtunyyLS9b9si4r1Z4M18vJ14kBu9Xhb3`、`2ttCRLHKte9i3VAkWaPiFZ8pCBRrnwHW4ST8shNe5myK3kD5YwNq1eatj8RMd2knKXYkmUPzjKJvDKtWgACenCef` |
| commit 并解除委托 | `VvjcCNeaVLVELDdX8S3FgAgQAnSy4Uen9ShEMqRc9MPq7twALiFVQNV93EJ7KASmTNyo4R7KCVdyQmRfQ6ULAFP` |

### 遗留问题

1. devnet 上临时账户 `7g2ushdgbcHjAuRaQQCwGewUwyaKw8tX6RaVFXZqRGhY` 里的 650,240 lamports 没能收回：手续费付款人扣费后必须仍然免租，所以只有最低额的账户不能自己付费转出。脚本已改为由部署者代付手续费，本地复测清零。
2. 需要 MagicBlock 回答的问题见主设计文档 §18.2 与配套文档二 §2.6，新增一条：主网 ER 是否接受零余额付款人、是否收 ER 交易费。
3. Stage 0 遗留问题 6（`"type": "module"`）在 Stage 2 处理。

## Stage 1 — 设计文档（2026-09-30）

### 做了什么

- **主设计文档** [`docs/design/stage1-design.md`](docs/design/stage1-design.md)：账户与字段、权限矩阵、资金流与守恒（6 个只增不减的累计计数器和 I-ER、I-L1、I-X 三条不变量）、手牌状态机与超时、heads-up 规则引擎与 rake 伪代码、发牌协议（设计级）、VRF 集成、commit 策略、常驻桌与换人、维护模式、会话密钥、客户端连接、指令清单、日志纪律、信任模型、测试计划。附录 A 逐条对照核实报告 §3 和路线图 S1。
- **提出 6 项设计修订，等你确认**：D1 座位账本放进 Game，Seat 不再委托（修复多账户 commit 不原子带来的对账风险）；D2 会话密钥记在 SeatLedger 里；D3 委托租金由程序 PDA `DelegPayer` 支付；D4 commit 策略可配置；D5 x402 以原子模式入座；D6 揭示盐的交易只写本人的 PlayerHand。
- **AI 桌与 x402 架构** [`docs/design/stage1-agents-x402.md`](docs/design/stage1-agents-x402.md)：AgentProfile 与双签注册、三类牌桌的入座规则与同主人规则、组件与密钥权限表、x402 原子入座（付款交易本身就是 `sit_down`，走规范的 Path 2，由自建 facilitator 把 solpoker 程序加入白名单）、facilitator 校验清单与攻击测试、本地 MCP 的工具与安全措施、反作弊、Stage 8 分解。
- **commit 费用与逃生通道的初步方案** [`docs/design/stage1-fees-escape.md`](docs/design/stage1-fees-escape.md)：从委托程序源码核实了计费方式，并用 Stage 0 实测数据对上了账；给出成本模型、风险与调节手段；逃生通道的取证结果、设计（只对 Game 和 HandProof 发起、Deck 和 PlayerHand 按 epoch 换新、快照陈旧门槛加心跳）、测试计划和主网门槛。
- **调研笔记** [`docs/stage1-research-notes.md`](docs/stage1-research-notes.md)：本阶段核实的全部外部事实及出处。
- **取证脚本** `scripts/probe_dlp.py`：用模拟交易判断某条链上的委托程序是否支持逃生通道指令，不签名、不发送。

### 验收命令与结果

| 命令 | 结果 |
| --- | --- |
| `python3 scripts/probe_dlp.py https://api.devnet.solana.com <付款人>` | solana-core 4.3.0；判别符 26、27 与不存在的 250 一样返回 `InvalidInstructionData`；已知的 3 返回 `NotEnoughAccountKeys` → **devnet 不支持逃生通道** |
| `python3 scripts/probe_dlp.py https://api.mainnet-beta.solana.com <付款人>` | 结果相同 → **主网不支持** |
| 查询 VRF ER 队列 `5hBR571x…` 的委托记录（devnet 与主网） | 两条链上都委托给了「任意 validator」（全 1 地址），TEE ER 可以直接使用；主网的队列地址与 SDK 常量相同 |
| 三份文档中的 6 张 Mermaid 图用 `manus-render-diagram` 渲染 | 全部成功 |
| GitHub Actions | 见本次推送的运行结果 |

### devnet 交易签名

本阶段只写文档，没有发送交易。探测和查询都是只读的模拟调用或账户查询。

### 遗留问题与待确认

1. 主设计文档 §18.1：D1–D6、E1–E7 需要你确认。确认之后同步更新项目指令（附录 B 列出了要改的条目），再进入 Stage 2。
2. 配套文档一 §10：X1–X6（x402 原子模式、混合桌固定座位、主人白名单、封禁的处理、agent 的 gas 兜底、并发座位上限）。
3. 主设计文档 §18.2 和配套文档二 §2.6：需要 MagicBlock 回答的问题共 14 条，最关键的是委托程序 v3.1.0 的部署时间表、多账户 commit 是否原子，以及主网的收费规则。
4. Stage 0 遗留问题 6（`"type": "module"`）计划在 Stage 2 顺手处理；遗留问题 9（smoke 程序占用 1.52 SOL 租金）在 Stage 3 spike 结束后关闭。

## Stage 0 — 工具链、仓库骨架与委托冒烟（2026-09-30）

### 做了什么

工具链全部按钉死版本安装，并用 `scripts/check-pins.sh` 自动校验：Rust 1.89.0、Solana CLI 3.1.10（Agave）、Anchor CLI 1.0.2（官方预编译二进制，已记录 sha256）、Node 24.21.0（已校验官方 SHASUMS256），本地 MagicBlock 栈 `@magicblock-labs/ephemeral-validator@0.14.10`。首次构建没有遇到依赖要求更高 Rust 版本的问题，所以没有切换到 1.93.1。

仓库用 `anchor init solpoker --test-template mocha` 初始化，包含两个程序：

| 程序 | ID | 内容 |
| --- | --- | --- |
| `solpoker` | `EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf` | 空骨架（模板里的 `initialize`），依赖已钉死 |
| `smoke` | `BU1Ad3zgoJWrP11kZTzomMTJtebVGYdVweMjkQHtfQW4` | 一次性 spike：初始化计数器 → 委托给显式指定的 validator → ER 内加一 → `MagicIntentBundleBuilder` commit → commit_and_undelegate |

依赖钉死方式：Cargo 用 `anchor-lang = "=1.0.2"`、`ephemeral-rollups-sdk = { version = "=0.17.3", features = ["anchor", "access-control", "vrf"] }`；npm 用精确版本，并通过 yarn `resolutions` 把 `@anchor-lang/borsh`、`@anchor-lang/errors` 锁在 1.0.2（否则 `^1.0.2` 会被解析到 1.2.0）。`.gitignore` 排除了 `keys/`、`solpoker-key-*.json`、`*-keypair.json` 和 `.env*`。`smoke` 的 `delegate` 指令要求 validator 在白名单内（devnet-tee `MTEW…` 或本地 `mAGic…`），不使用 SDK 默认的 `validator: None`。

新增的脚本与 CI：`scripts/mb-stack.sh`（启动本地栈，修复了就绪检测，见遗留问题 1）、`scripts/mb-health.sh`、`scripts/check-pins.sh`、`scripts/tee-latency.ts`、`.github/workflows/ci.yml`（钉死版本安装 → 格式检查 → 构建 → 版本校验 → 本地栈端到端测试；CI 使用一次性钱包，程序通过 `--upgradeable-program` 预装到声明的 ID，真实密钥不进入 CI）。设计文档复制到了 `docs/design/`。

### 验收命令与结果

| 命令 | 结果 |
| --- | --- |
| `scripts/check-pins.sh` | 16/16 ok（工具链 5 项、Cargo 3 项、npm 6 项、IDL 地址 2 项） |
| `cargo fmt --all -- --check` | 通过 |
| `anchor build` | 通过；首次 5 分 28 秒（含 platform-tools v1.52 下载）；`solpoker.so` 65,240 B，`smoke.so` 299,856 B |
| `anchor test --skip-local-validator`（本地栈） | 7 passing（smoke 6 + solpoker 1），其中包括「上一轮残留委托 → 自动解除委托恢复」路径 |
| `anchor deploy --provider.cluster devnet` | 两个程序部署成功，升级权限 = 部署者 `541kp…`，花费 1.8726 SOL（含 IDL 元数据账户） |
| devnet-tee 冒烟（命令见 README） | 6 passing（2 分 47 秒）：`verifyTeeRpcIntegrity` 通过、`getAuthToken` 通过、委托记录的 validator = `MTEW…`、commit 后 L1 = ER 值、解除委托后 owner 回到 `smoke` 程序且 L1 可写 |
| `node scripts/tee-latency.ts` | 完成，数据见下方「延迟」 |
| GitHub Actions（[run 36685484158](https://github.com/SANTOSRAYYYY/solpoker/actions/runs/36685484158)，commit `9c9f64c`） | 全部步骤通过，7 passing；命中构建缓存时约 2 分钟。前两次运行失败的原因见遗留问题 14 |
| CI 模拟（全新克隆，按 `ci.yml` 逐步执行：一次性钱包、`anchor build --ignore-keys`、预装程序、`anchor test --skip-local-validator --skip-build --skip-deploy`） | 7 passing；从零构建约 2 分 35 秒 |

### devnet 交易签名

| 步骤 | 签名 |
| --- | --- |
| 部署者收到 devnet SOL（slot 505804744） | `5hQKBwo7z4Mpysw9cn4yWU9fZLdxSBYpMm1FZEWXf7vna5XArPNbTGyWcLnCmWbpawDq4wpdwYscBaV5tNq8oB23` |
| 部署 `solpoker`（slot 505814626） | `2Lyc8wZ9tTXgVzKZevfReeizoKWpva4FxB4kSuyyozBBPxNvTb6Cn966iHXDWXNuqDWHXLj2HdgGYoPJPxGBertM` |
| 部署 `smoke`（slot 505815054） | `679RDERsDExVtYdQwDgNfmCU6zF2m2Cnrzrapu7Xr361quc4EYnk2bbk1eFqhfFa8zM6wrV4afWBRsyZHcZSwAmD` |
| L1 `initialize` | `3wyuPugVedGDP8YaVRsZiy2hhHa2HNPRA9be6cBsPcQ4Wk6uzcMijPqpT7tKN5CRjwHXNwAytzmELqkgcLpFs1SE` |
| L1 `delegate`（→ TEE `MTEW…`） | `2Yh47oLEWDHgYhVx8W3pH1rEqX3mYe9xas7AchDdmPj7RpY6179JuQipL7NP8KoA8JRJyMUhy2RUDbrafd6WSx7U` |
| ER `commit` → L1 提交交易 | ER `53yS76yLwKQXhT9xYbepbvwVLe1w6vA8irVpEuPozPg539FMoN9xgnktjd8Ri1rRFJetnvzUTZnLqmyX9U7VmrmJ` → L1 `27U7WUyRt5xWRrs66eiXR13rpmK6WkExCKgBQxakYqEwJbgQpRq3S4cHUyMLLY6DxNvYfBE6BJk1s47bpFWNBBad` |
| ER `undelegate` → L1 提交交易 | ER `5Kj5xPE5PyB3GpvVViXgpMVjwkXhVnAqLCe3ZH2FetRUVbT1SoCjYAndCfa7h46Bncuk9FbDsZ9fpPxG3eHsWdza` → L1 `5kxkTdTtCXG3t79R1edTcH3vhtSDXtVkUFiKHj51msivknbdHd4nav9RfAPfxX7Kmd46xHYEhgpKKehNmoF4uY1V` |
| 解除委托后 L1 `increment` | `3gV9CF3yu7WgbvGuqAevLVXR8PPeQxtPFSvHQn94ANdgEr8wTPRZpj7tkBXUTMH13xxdhEYqA7TsLNJTH7oWByVs` |
| 延迟测试：L1 `delegate` | `4RKdWMdpKFUUcRJaCmP4VxC1mYDb48xRSoNxfSzbFwzt7ZKRkspZfq4FjmpBVNBLT35adyj3PnLc6jkkHJarVABi` |
| 延迟测试：ER `undelegate` → L1 | ER `5hifKEnPFEF1LkS6ks1B894z7qoBjt8qz2xZkdjG3SjvKSMpLT75Pi35efNafmro1vxJ5iXMuBAMMfuJmjKeW2i7` → L1 `PRkr6sBoAkVyJ6trNhBcnnhFbWcTZZVoRSsMzunV34iJnxrn2uBAqUgdhvF4BAmVdL7X2Am5SwDBsj2uCp2tT1t` |

ER 内的交易签名（例如 3 次 `increment`）只存在于 devnet-tee，需要带令牌的 RPC 才能查到，完整列表在本地的 `.anchor/smoke-report-devnet-tee.json` 和 `.anchor/tee-latency-report.json` 里（不入库，里面不含令牌）。

### 实测费用（devnet）

| 项目 | 金额 | 说明 |
| --- | --- | --- |
| `delegate` 扣款 | 2,331,640 lamports | 含委托记录、元数据账户的租金 |
| `commit_and_undelegate` 退款 | 1,926,640 lamports | 租金退回 |
| 一次完整委托周期的净成本 | **405,000 lamports ≈ 0.000405 SOL** | = 0.000005 交易费 + 0.0004。0.0004 与 api 3.1.0 的常量对得上：会话费 0.0003 + 第一次之后的 commit 0.0001（本周期共 commit 2 次） |
| L1 上的 commit / undelegate 交易 | 24,200 / 33,800 lamports | 由 TEE validator `MTEW…` 付费，不直接向玩家收取 |
| 本地栈同一周期 | 净 404,992 lamports | 与 devnet 基本一致 |

### 延迟（从本沙盒发起，中位数）

| 项目 | devnet-tee | 本地栈 |
| --- | --- | --- |
| 普通 RPC 往返（getSlot） | 615 ms（到 api.devnet 也是 593 ms，主要是沙盒所在网络的开销） | — |
| `sendRawTransaction` | 605 ms | — |
| 发送 + 每 50 ms 轮询，直到 confirmed | 1,193 ms（约 2 个往返；TEE 内执行几乎不花时间） | 12–54 ms（Anchor `.rpc()`） |
| Anchor `.rpc()` 默认确认方式 | 1.8–9.3 s，中位数 5.3 s | — |
| ER commit → 拿到 L1 签名 | 15.3 s；之后 0.6 s 即可在 L1 读到新状态 | 0.5 s |
| `verifyTeeRpcIntegrity` / `getAuthToken` | 11.9 s / 5.7 s | 鉴权 39 ms（本地不做 attestation） |

### 遗留问题

1. **mb-stack 就绪检测失效（已绕过，建议向上游反馈）**：`mb-stack` 0.14.10 用 `/^JSON RPC URL:/` 判断 L1 已就绪；只要设置了 `CLICOLOR_FORCE=1`（本沙盒默认就有），Agave 3.1.10 就会给这一行加 ANSI 加粗转义符，正则永远匹配不上，120 秒后整个栈被关掉。`scripts/mb-stack.sh` 里已经 unset `CLICOLOR_FORCE`/`FORCE_COLOR` 并设置 `NO_COLOR=1`。
2. **对局客户端不能用 Anchor `.rpc()` 的默认确认**：它在 devnet-tee 上要 1.8–9.3 s，而直接发送加快速轮询只要约 2 个往返。Stage 3/6 的客户端要改成直接发送加轮询，或者提前订阅账户变化；websocket 签名通知 10 次只到了 4 次（订阅注册在发送之后，存在竞态），需要在 Stage 3 用「先订阅再发送」重新测。沙盒的 600 ms 往返不代表真实玩家；上线前要从目标地区实测。
3. **attestation 和鉴权较慢**：`verifyTeeRpcIntegrity` 11.9 s、`getAuthToken` 5.7 s。前端应在入场时各做一次并缓存结果，不能放在每手牌的路径上。
4. **鉴权令牌有效期约 30 天**（本次签发 2026-09-30，到期 2026-10-30）。持有令牌即可读取该钱包有权访问的私有账户（例如自己的底牌），所以前端只能把令牌放在内存里、不做长期持久化，并提供「重新鉴权」入口；Stage 6 的信任页要说明这一点。
5. **本地查询过滤入口（6699）同样强制令牌鉴权**：这对我们有利，Stage 3 可以在本地测权限（PlayerHand 只有本人能读），不必每次都上 devnet-tee。
6. **Node 24 原生 TS 类型剥离**：mocha 会把 `tests/*.ts` 当成 ES 模块加载，`require` 和 `__dirname` 都不可用（测试已改成用 `fs` 加 `process.cwd()`），并且会打印 `MODULE_TYPELESS_PACKAGE_JSON` 警告。Stage 1 再决定是否在 `package.json` 里显式声明 `"type": "module"`。
7. **`solana-program` 两个版本并存**：Anchor 用 v3.0.0，`ephemeral-rollups-sdk` 0.17.3 的兼容层直接引入 v2.3.0。构建和运行都正常，先记为观察项。
8. **`@anchor-lang/core` 1.0.3 已发布**（TS 补丁版本）。按「与 CLI 一致」的原则仍钉在 1.0.2，如需要其中的修复再单独升级。
9. **`smoke` 程序仍部署在 devnet**（程序数据租金 1.52 SOL）。Stage 3 的 spike 可能还要用它来做 devnet 健康检查，之后用 `solana program close` 收回租金。
10. **commit 费用的计费粒度未确定**：本次每个 commit 只含 1 个账户。Stage 3 要实测「每手 commit Game + Seat×2 + HandProof」是按意图还是按账户收费，这会直接决定每手的平台成本。
11. 模板遗留的 `pub use state::*;` 未使用告警，Stage 1 写入真实状态后自然消失。
12. devnet 委托程序是否支持 `RequestUndelegation` / 超时回滚（逃生通道）仍待 Stage 3 验证，现状与开发前报告一致。
13. **CI 注意事项（已修复，写在这里备查）**：(a) Anchor 1.0 的 `anchor build` 会比对 `target/deploy/*-keypair.json` 和 `declare_id!`，CI 没有程序密钥，所以要加 `--ignore-keys`，程序 ID 改由 `check-pins.sh` 校验 IDL 地址；(b) `scripts/mb-stack.sh` 在 `.mb-stack/` 目录里启动 validator，所以传给它的 `.so` 路径和 `solana config` 里的钱包路径都必须是绝对路径，否则程序加载失败、钱包拿不到创世余额。
14. **本地 ER 需要 100 万个文件描述符（已修复）**：magicblock-validator 0.14.10 启动时会把 `RLIMIT_NOFILE` 提到 1,000,000，硬上限不够就直接退出（`unable to set open file descriptor limit`）。GitHub runner 的硬上限是 65,536，所以 CI 的前两次运行都卡在这里。`mb-stack` 只转发含 error/failed/fatal/panic 的子进程输出行，这条错误被过滤掉了，看起来就是「ER 无故退出」。现在的处理：CI 在启动栈前执行 `sudo prlimit --pid $$ --nofile=1048576:1048576`；`scripts/mb-stack.sh` 启动前检查硬上限，不够就报错并给出修复命令；新增 `scripts/mb-diagnose.sh`，单独前台运行 base 和 ER 并保留完整输出，CI 失败时自动运行。开发者本机如果遇到同样问题，也按这个办法处理。
