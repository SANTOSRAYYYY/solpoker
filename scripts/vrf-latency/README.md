# solpoker Stage 2 脚本

本目录是 Stage 2（TEE 内 VRF）的探测/取证脚本。依赖已按【版本钉死】锁定：

- `@magicblock-labs/ephemeral-rollups-sdk` **0.17.3**
- `@solana/web3.js` **1.98.4**（1.98.x 最新 patch）
- `typescript` **7.0.2**
- `package.json` 声明 `"type": "module"`（E6，Stage 2 顺手处理）

安装与运行需要 **Node 24**（原生 type stripping，直接 `node xxx.ts` 即可，
脚本不使用 enum/namespace 等不可擦除语法）。

```bash
cd scripts/vrf-latency
npm install

# devnet-tee 探测（需要已部署的 solpoker 程序，见下）
ER_AUTH_TOKEN=<token> \
ER_KEYPAIR=<keypair.json 路径> \
SOLPOKER_PROGRAM_ID=<程序 ID> \
SOLPOKER_TABLE=<Table 地址> \
npm run probe:vrf-latency -- --n 50 --priority normal
```

## 本地 MagicBlock 栈

主仓库 `scripts/mb-stack.sh` / `scripts/mb-health.sh` / `scripts/mb-diagnose.sh`
负责本地栈的启动、健康检查与诊断（nofile 1,000,000、`--reset` 同时清空 ER 存储）。
Stage 2 探测在其之上运行；`scripts/vrf-oracle.sh` 见下。

## vrf-oracle.sh 的角色

`scripts/vrf-oracle.sh` 管理**本地** VRF oracle 进程：它监听本地队列
（`GKE6d7…` 主链队列 / `Sc9M…` ER 队列）上的随机数请求并按时返回回调。
没有它，本地栈上的 `request_vrf` 会一直处于 Pending，重试/超时路径无法测试。
devnet-tee 和 mainnet-tee 的队列回调由 MagicBlock 运营，不需要我们跑 oracle。

注意：oracle 回调的**身份**必须来自 VRF 程序的 scoped identity
（`scoped_vrf_identity(&crate::ID)`，9irBy… 的旧身份已废弃，不要用）——
伪造身份必须被 `vrf_callback` 拒绝，这是 §17 S2「伪造身份拒绝」测试的一部分。

## probe-vrf-latency.ts

测量 TEE ER 内逐街 VRF 延迟（设计 §17 S2「延迟 p50/p95」）：

- 通过 solpoker 程序的 `request_vrf` 指令（V1 拆分后的 permissionless 指令）
  向 ER 队列发起请求，`sendRawTransaction` + 轮询确认（设计 §13.3，不用 Anchor
  `.rpc()`）；
- 轮询 Game 的 VrfSlot 直到回调落地，记录 sent → fulfilled 往返；
- 逐街循环 Preflop/Flop/Turn/River/Runout，输出整体与分街的 p50/p95/p99，
  写入 `--out` 指定的 JSON 文件。

**前置条件**：本脚本依赖已部署并完成 Stage 2 V1 拆分的 solpoker 程序
（`request_vrf` / `vrf_callback` 指令、Game/Deck 账户）。指令编码与回调检测在
脚本里有明确的 `TODO(Stage 2)` 标记，链上实现与账户布局定稿后填实。

常用参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--n` | 20 | 请求次数（逐街循环） |
| `--priority` | normal | normal / high；high 如何表达以 SDK 0.17.3 源码为准 |
| `--out` | `probe-vrf-latency-<ts>.json` | 汇总输出文件 |
| `--program-id` / `--table` | env | solpoker 程序 ID 与 Table 地址 |

## devnet 前置条件

- **SOL**：探测/部署钱包需要 devnet SOL。faucet：https://faucet.solana.com
  （或 `solana airdrop`，devnet 上限约 2 SOL/次，多试几次）。
- **tUSDC mint**：`9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH`
  （mint authority 是 `solpoker-key-tusdc-mint.json`）。牌桌资金用 tUSDC；
  VRF 探测本身不花 USDC，但建桌/委托流程会用到。
- **ER 端点**：`https://devnet-tee.magicblock.app?token=…`。token 用钱包
  `signMessage` 调 `getAuthToken` 换取（challenge 必须用 `crypto.getRandomValues`
  生成）；token 只放内存。Magic Router（`devnet-router.magicblock.app`）只用于
  L1 操作，脚本里要设 UA。
- **密钥纪律**：devnet 密钥只放本机，不得提交 git（复制到主仓库 `keys/`，
  提交前跑 `scripts/precommit-check.sh`）。
