# CHANGELOG

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
