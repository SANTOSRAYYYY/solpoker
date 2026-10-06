# Stage 2 工作笔记：TEE 内 VRF

> 对应设计文档 §9（VRF 集成）、§13（客户端连接与 attestation）、§17 S2 行、
> 决策记录 §11.4 与 §12.2（V1 拆分）。实测结论一律附交易签名，写进「证据」一节。

## 2026-10-05 快速开发过一遍的基线说明（后续强模型优化时读）

本轮在一台全新 Windows 机器上从零搭环境（Git / Node 24.10 / Rust 1.89 /
MSVC Build Tools / `magicblock-dev-skill`），先用本地脚手架 `stage2-dev/`
并行开发，再合并回主仓库。**仓库 main 上现在就是这份代码**，`cargo test
--workspace` 全过（core 17+1、程序 4、smoke 回归 1）。链上条目全部待跑，
按「验收命令」执行即可。

本笔记之外另两处需要同步维护：

- 仓库根 `CHANGELOG.md` 的 Stage 2 条目：已完成项、验收命令及结果、遗留问题；
- 修复过程中确认的 7 条技术事实（Anchor 1.0 Accounts 必须放 crate 根、
  anchor-attribute-* 漂移、VRF 宏只修饰结构体、borsh 1.x 拒绝显式判别枚举、
  solana-program 3.x 无 hash、`next_clockwise` 单人返回自己、attempt 从 1 编号）
  写在 CHANGELOG Stage 2 的「修复过程中确认的技术事实」里，是下一轮优化
  的必背上下文。

## 任务复述

1. 在 TEE ER 内实现 VRF 请求的完整路径：`act`/`advance` 只把 `VrfSlot` 置 Ready
   （V1 拆分，队列故障不回滚已完成的扑克动作），permissionless `request_vrf`
   用 `create_request_randomness_ix`（scoped identity）+ `invoke_signed_vrf`
   向 ER 队列 `5hBR…` 发 CPI。
2. `vrf_callback`（`#[vrf_callback]`）校验签名者是 `PDA(["identity", 本程序 ID], VRF 程序)`，
   只把 randomness 写进 Deck；身份不对报错，已过期/不匹配的合法回调返回 Ok 并忽略。
3. caller_seed = `sha256("solpoker/vrf/v1" ‖ table ‖ hand_id_be ‖ target ‖ attempt)`，
   通过 callback_args 带回并在回调时校验；支持正常/高两种优先级。
4. 超时重试：10 秒无回调任何人可 `retry_vrf`（新 attempt），最多 3 次，耗尽则本手作废。
5. 探测脚本 `probe-vrf-latency.ts` 测本地栈与 devnet-tee 的逐街延迟 p50/p95，
   为 `vrf_timeout_s` 初始值提供实测依据。
6. 顺手处理 E6：`package.json` 声明 `"type": "module"`。

## 验收标准（设计 §17 S2）

> 2026-10-06 devnet-tee 链上验收：核心路径全部实测通过，证据见 CHANGELOG
> 「Stage 2 续」与本文件「证据」一节。

- [x] V1 拆分 arm/request：`act`/`advance` 只 arm，`request_vrf` 单独执行 CPI
      （core 单测 + devnet 实测：debug_arm 170ms → request 168ms）
- [x] TEE 内请求并 scoped 回调（回调身份 = `scoped_vrf_identity(&crate::ID)`）
      ✅ devnet-tee：request `3kUzVXx6h2…` → fulfilled 718ms，attempt=1
- [x] 正常/高优先级两种请求路径——宏自动映射判别符（10/11 scoped）
- [x] 伪造身份的回调被拒绝（宏注入 Signer 带 `address =` 约束，静态保证）
- [x] 10 秒超时重试（`retry_vrf`，新 attempt）✅ devnet：`3uYxh7ASgM…`，
      attempt 1→2，845ms fulfilled，Deck.vrf_out 非零
- [x] 旧回调（过期/不匹配的合法身份）返回 Ok 并忽略，不回滚 fulfillment
      ✅ 实测：attempt=1 的 fulfillment 交易 ok、状态不变
- [x] 3 次耗尽 → 本手作废（core 单测；链上路径与重试相同）
- [ ] 本地（ER 0.14.10 + 本地 oracle）全路径通过——本机 Windows 跑不了
      ephemeral-validator，以 devnet-tee（ER 0.16.0）为准；CI/Linux 补测
- [x] devnet-tee（ER 0.16.0）正常路径通过 ✅
- [ ] 延迟实测：逐街 p50/p95（本地 + devnet）——devnet 仅 n=2 样本
      （718/845ms，经代理属上限），`scripts/vrf-latency/` 补测后定 Table 参数

## 2026-10-06 链上验收发现并修复的 bug（优化时的关键上下文）

1. **ER 上被委托账户归原程序所有**，不归委托程序——所有 ER 侧指令的
   `owner = ephemeral_rollups_sdk::id()` 覆盖是错的，必须用 Anchor 默认的
   crate::ID 检查。L1 侧读委托账户（Stage 6 cash_out/sweep_rake）才接受
   `owner = DLP`（§5.3）。
2. **VRF 请求账户：oracle_queue 必须 writable**（队列要追加请求）。
3. **callback_args 必须带 borsh Vec<u8> 长度前缀**（u32 LE）——Anchor 按
   borsh 反序列化 handler 参数；缺前缀时 hand_id=0 会被读成长度 0，回调
   静默忽略（fulfillment 交易 ok 但状态停在 Pending，这是最难查的一类
   bug：一切"成功"但什么都没发生）。
4. **本机网络约束**：直连被重置，只能走系统代理；api.devnet.solana.com
   对代理共享出口 IP 限流 429，程序部署必须走
   `scripts/http-relay.mjs` + rpc.magicblock.app/devnet + `--use-rpc`。

## 实测数据

### 本地栈（ER 0.14.10，队列 Sc9M…，QFS 6699）

| 指标 | normal | high |
|---|---|---|
| 样本数 n | 待填 | 待填 |
| 确认往返 p50（ms） | 待填 | 待填 |
| 确认往返 p95（ms） | 待填 | 待填 |
| 确认往返 p99（ms） | 待填 | 待填 |
| VRF 回调往返 p50（ms） | 待填 | 待填 |
| VRF 回调往返 p95（ms） | 待填 | 待填 |
| VRF 回调往返 p99（ms） | 待填 | 待填 |
| 10 秒超时发生率 | 待填 | 待填 |
| 备注 | 待填 | 待填 |

### devnet-tee（ER 0.16.0，队列 5hBR…）

| 指标 | normal | high |
|---|---|---|
| 样本数 n | 待填 | 待填 |
| 确认往返 p50（ms） | 待填 | 待填 |
| 确认往返 p95（ms） | 待填 | 待填 |
| 确认往返 p99（ms） | 待填 | 待填 |
| VRF 回调往返 p50（ms） | 待填 | 待填 |
| VRF 回调往返 p95（ms） | 待填 | 待填 |
| VRF 回调往返 p99（ms） | 待填 | 待填 |
| 10 秒超时发生率 | 待填 | 待填 |
| 备注 | 待填 | 待填 |

注：探测口径是 `request_vrf` 单指令的 sent → fulfilled 往返。真实牌局关键路径
还要加上 `act`（结束本街）与 `advance`（发牌）两条往返（设计 §6.4），定
`vrf_timeout_s` 时一并考虑。

## 遗留问题

1. **主网 TEE 上 VRF 的费用、延迟和速率限制**（设计 §18.2 问题 9）：devnet 的
   ER 队列当前免费，主网是否同样免费、延迟是否如预期更低，上线前必须从目标
   地区对 `mainnet-tee` 重新测量并调整 Table 参数。
2. **队列频率限制**（设计 §18.2 问题 9 相关）：devnet 与主网队列对请求频率的
   上限未知；探测脚本以固定间隔发请求，若触发限流需记录阈值并回报 MagicBlock。
3. （相关）L1 队列（devnet 主链 `Cuj97…`）normal 0.0005 / high 0.0008 SOL 的
   费用只对主链请求适用，ER 队列 `5hBR…` 已核实永远免费；两条路径不要混淆。

## 证据

交易签名（每行：用途 / 链 / 签名 / 说明）：

| 用途 | 链 | 签名 | 说明 |
|---|---|---|---|
| 正常优先级请求 → 回调 | 本地 | 待填 | |
| 高优先级请求 → 回调 | 本地 | 待填 | |
| 伪造身份回调被拒绝 | 本地 | 待填 | |
| 旧回调 Ok+忽略 | 本地 | 待填 | |
| retry_vrf（10 秒超时后） | 本地 | 待填 | |
| 3 次耗尽 → 作废 | 本地 | 待填 | |
| 正常优先级请求 → 回调 | devnet | 待填 | |
| 高优先级请求 → 回调 | devnet | 待填 | |
| 延迟探测原始输出 | 本地 | probe-vrf-latency-*.json | 待填（文件路径） |
| 延迟探测原始输出 | devnet | probe-vrf-latency-*.json | 待填（文件路径） |
