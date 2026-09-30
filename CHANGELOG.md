# CHANGELOG

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
