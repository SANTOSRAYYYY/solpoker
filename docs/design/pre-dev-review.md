# solpoker 开发前准备报告：核实结果、手册勘误与待确认问题

> 核实时间：2026-09-30（北京时间）。所有「已核实」项均来自 crates.io / npm / GitHub Release、MagicBlock 官方文档、`ephemeral-rollups-sdk v0.17.3` 源码、`magicblock-engine-examples` 仓库，以及对 devnet 各端点的实时 RPC 查询。凡属推断的内容都会明确标注。

---

## 0. 结论速览

1. **整体架构可行，最大风险基本解除。** devnet-tee 上确实存在 VRF 临时队列 `5hBR571x…`，查询时最近一笔交易距当时只有 0–1 秒，说明 PER（TEE）内的 VRF 正在被实际使用。Stage 2B 的任务可以从「探路」降级为「确认」，主链 VRF fallback 大概率用不上。
2. **手册里有 5 处 P0 级错误**，按原文实现会**跑不通或泄牌**：VRF 回调身份校验方式已变更；「成员列表为空」并不等于私有；commit/undelegate 会把牌堆和底牌写到主链上公开；「缺盐仍发牌」会让一方看到全部底牌；盐的揭示时机前后矛盾。
3. **版本上基本对，但有细节漂移**：Anchor 已到 1.2.0，而 SDK 要求的是 `anchor-lang ^1.0`，所以必须写成 `=1.0.2` 才真正钉住；Anchor 1.0 官方推荐的 Solana 是 3.1.10（不是 3.1.9）；官方示例本身停在 SDK 0.16.2；本地 validator 0.14.10 与 devnet 上跑的 0.16.0 版本不一致。
4. **动手前你需要提供/决定三类东西**：devnet SOL（沙盒领水失败）、密钥与代码的持久化方案、约 20 个扑克规则与产品取舍（下文每条都附了推荐默认值，你可以直接回「按默认」）。

---

## 1. 核实结果总表

### 1.1 工具链与依赖版本

| 项目 | 手册写法 | 核实结果 | 结论 / 建议 |
|---|---|---|---|
| Anchor CLI | 1.0.2 | 存在（2026-05-02）。最新为 1.2.0，另有 2.0.0-rc.1。MagicBlock 官方示例**全部**使用 1.0.2 | 保持 1.0.2。但 SDK 声明的依赖是 `anchor-lang ^1.0`，cargo 会自动解析到 1.2.0，**必须写成 `anchor-lang = "=1.0.2"`** |
| Solana CLI (Agave) | 3.1.9 | 3.1.9 存在（2026-02-19）；**Anchor 1.0 发布说明推荐 3.1.10**（2026-03-10）。devnet L1 当前跑 4.3.0，各 ER 跑 solana-core 4.0.0 | 建议改用 3.1.10 |
| Rust | 1.89 | SDK 仓库自带的 `rust-toolchain.toml` 是 **1.93.1** | 先用 1.89；若 IDL build 或依赖因 MSRV 报错，退到 1.93.1 |
| Node | 24 | `@anchor-lang/core@1.2` 要求 ≥20.18，24 没问题 | ✅ |
| `ephemeral-rollups-sdk`（Rust） | 0.17 | 最新 0.17.3（2026-09-24），通过 `anchor` feature 支持 anchor ^1.0 | ✅ 钉成 `=0.17.3`，features 设为 `["anchor","access-control","vrf"]` |
| `ephemeral-vrf-sdk` | 0.17 | 0.17.3 存在，但主 SDK 已**精确锁定** `ephemeral-vrf-sdk =0.17.3`，并通过 `vrf` feature 以 `ephemeral_rollups_sdk::vrf` 形式重新导出 | 不必单独引入。若要单独引入，必须同样写 `=0.17.3` |
| TS SDK | 0.17.3 | ✅ 为最新版。依赖 `@solana/web3.js ^1.98`（v1，不是 kit），以及 `@phala/dcap-qvl`（attestation 用） | ✅ |
| 本地 ER | ephemeral-validator 0.14.10 | ✅ 为 npm 最新版（2026-08-26）。包内自带 6 个命令：`mb-stack`、`mb-test-validator`、`ephemeral-validator`、`vrf-oracle`、`query-filtering-service`、`rpc-router` | ⚠️ devnet 上的 ER 已是 **magicblock-core 0.16.0**，本地与 devnet 行为可能不一致，最终验收必须以 devnet 为准 |
| 官方示例版本 | — | 程序端：anchor-lang 1.0.2 + Rust SDK **0.16.2**；TS 测试端：`@coral-xyz/anchor 0.32.1` + TS SDK **0.14.3** | ⚠️ 官方示例本身没升到 0.17，0.16→0.17 的差异需要自己核对 |
| session-keys | —（Stage 7 提到） | 3.1.1，兼容 anchor <2.0；有效期上限确实是 7 天；程序 ID `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` | 见 §3.6：存在「任何人都能撤销」的问题 |

### 1.2 地址与端点

| 项目 | 核实结果 |
|---|---|
| Delegation Program `DELeGG…aSeSh` | ✅ 与文档一致 |
| VRF Program `Vrf1RN…QUwGz` | ✅ 与 SDK 常量一致 |
| `VRF_PROGRAM_IDENTITY` `9irBy7…vvAw` | ✅ 地址存在，但 **SDK 已标记为 deprecated**。0.17.x 默认使用按程序派生的 scoped identity：`PDA(["identity", 你的程序ID], VRF程序)`（见 §2 P0-1） |
| `DEFAULT_QUEUE` / `DEFAULT_EPHEMERAL_QUEUE` | ✅ 与 SDK 一致。链上查询显示 ephemeral queue 的委托记录里 validator 字段为全零（不绑定特定 ER），并已在 as/eu/us/tee 四个 ER 上出现 |
| **手册缺失：本地测试队列** | 本地基础层用 `DEFAULT_TEST_QUEUE = GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb`，本地 ER 内用 `DEFAULT_EPHEMERAL_TEST_QUEUE = Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT` |
| Permission Program `ACLseo…Qnp1` | ✅ |
| **手册缺失：validator 公钥**（委托时必须指定） | 已通过各端点的 `getIdentity` 实测：devnet-as `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`、devnet-eu `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e`、devnet-us `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd`、**devnet-tee `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`**、本地 `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev` |
| Magic Router | ✅ 用 curl 可访问。注意：Python 默认 UA 会被 Cloudflare 拦截（返回 403 / 1010），写脚本时要设置 UA |
| devnet-tee 匿名访问 | 实测不带 token 也能读**公开**账户（能读到 VRF 队列）。这与「私有账户必须带 token」并不矛盾，但 Stage 3 的 c) 项需要确认私有账户确实读不到 |
| 本地端口 | ✅ 8899 / 7799 / 6699，另外还有 WS 端口 8900 / 7800 / 6700。本地请求链路为：client → QFS(6699) → ER(7799) → base(8899) |

### 1.3 API 名称与签名

| 手册中的 API | 核实结果 |
|---|---|
| `MagicIntentBundleBuilder` | ✅ 路径为 `ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder`，用法：`.commit(&[..])` / `.commit_and_undelegate(&[..])` 后接 `.build_and_invoke()` |
| `#[ephemeral]` / `#[delegate]` / `#[commit]` | ✅ 路径为 `ephemeral_rollups_sdk::anchor::{ephemeral, delegate, commit}`，另有 `vrf`、`vrf_callback` 两个宏 |
| `create_request_randomness_ix` | ✅ 在 0.17.3 中是**默认的 scoped 版本**（普通优先级）；另有 `create_request_high_priority_scoped_randomness_ix`；旧的全局 identity 版本已 deprecated |
| `invoke_signed_vrf` | ✅ 由 `#[vrf]` 宏注入到 Accounts 结构体上 |
| `rnd::random_u8_with_range` | ✅ 另有 random_u32 / u64 / bool 等 |
| `CreateEphemeralPermissionCpi` / `UpdateEphemeralPermissionCpi` | ✅ 另有 `CloseEphemeralPermissionCpi`。参数类型为 `EphemeralMembersArgs { is_private: bool, members: Vec<Member> }` |
| `EphemeralPermission::size_of(N)` | ✅ 公式为 `35 + (1 + N) * Member::SIZE`，**多出的 1 是「默认成员」**，即被授权账户的 owner。租金算法：`ephemeral_accounts::rent(size)`，每字节 32 lamports |
| 5 个权限位 | ✅ AUTHORITY=1<<0，TX_LOGS=1<<1，TX_BALANCES=1<<2，TX_MESSAGE=1<<3，ACCOUNT_SIGNATURES=1<<4 |
| `getAuthToken` | ✅ 签名为 `(rpcUrl, publicKey, signMessage, template?) → {token, expiresAt}`，要求钱包支持 `signMessage` |
| `verifyTeeRpcIntegrity` | ✅ 另有较快的 `verifyTeeIntegrity`（使用缓存的 quote）。两者都有局限，见 §3.7 |
| 其他有用的 TS API | `getPermissionStatus`、`waitUntilPermissionActive`、`ConnectionMagicRouter`、`GetCommitmentSignature` |

---

## 2. 必须修正的手册错误（按严重度排序）

### P0-1　VRF 回调的身份校验写法已过时，照写会导致回调失败

手册要求「回调校验 `vrf_program_identity == 9irBy75…`」。但在 0.17.x 中，默认的 `create_request_randomness_ix` 用的是 **scoped identity**：VRF 程序会以 `PDA(["identity", solpoker_program_id], VRF_PROGRAM_ID)` 的身份签名回调，而不是全局的 `9irBy75…`。按手册写死全局地址，回调交易会因地址约束不通过而失败。

**改为**：在回调的 Accounts 结构体上加 `#[vrf_callback]`。这个宏会自动注入 `#[account(address = scoped_vrf_identity(&crate::ID))] pub vrf_program_identity: Signer`，同时校验了地址和签名。「必须校验 signer」这条纪律本身仍然成立，只是校验的对象变了。

### P0-2　「成员列表为空 = 无人可读」并不准确

现行的 EphemeralPermission 模型由 **`is_private` 开关**决定是否私有。SDK 源码中，`is_private == false` 时 members 会被直接忽略；官方 rock-paper-scissor 示例的注释也写明「`is_private=false` 加空成员 ⇒ 任何持有有效 TEE token 的人都能读」。文档里「空成员列表 = 完全私有」的说法来自旧的 `Option<Vec<Member>>` 模型，放在新 API 上容易误读。

**改为**：

- Deck：`is_private: true, members: []`。此时只剩「默认成员」，也就是 owner（solpoker 程序本身，不能签 token），所以玩家都读不到。
- PlayerHand：`is_private: true, members: [该玩家]`。
- Game：不设权限，或设为 `is_private: false`。

### P0-3　commit/undelegate 会把私有数据写到主链上公开（Stage 6 的说法有误）

Stage 6 写的是「Deck/PlayerHand 内容不进公开提交，按 PER 权限天然不可见」。这是错的。PER 的权限只管 **TEE RPC 的读取**；commit 或 undelegate 会把账户数据写回 Solana L1，而 L1 上的账户数据任何人用任何 RPC 都能读（ER 文档原话：delegated 账户在 base layer 上仍可被读取）。

**改为**：

- Deck/PlayerHand 在含有活跃秘密的期间**绝不 commit**。
- undelegate 之前必须先清零。
- 委托时保持默认的 `commit_frequency_ms = u32::MAX`（SDK 默认值，即不自动定时提交），不要改小。
- 备选方案：把 Deck/PlayerHand 做成 **ephemeral account**。这类账户只存在于 ER 中，永不落主链，租金每字节 32 lamports，比主链便宜约 109 倍。它能否挂 EphemeralPermission 需要在 Stage 3 验证。
- 另外，**委托私有账户时必须显式传入 TEE validator `MTEWGuqx…`**。SDK 默认 `validator: None`，存在被非 TEE 的公开 ER 接管的风险。

> 说明：这一条是基于 ER 机制的推断。建议在 Stage 3 加一项实测：commit 一个测试账户后，用普通 devnet RPC 读取它在 L1 上的数据。

### P0-4　「一方未 reveal 就用另一方的盐继续发牌」会让揭示方看到全部牌

Stage 4 写的是「若一方未 reveal，种子只用 randomness XOR 已 reveal 方」。VRF 的输出很可能是公开的（它在回调交易的指令数据里，而且 oracle 本身也知道）。这样一来，已揭示盐的一方就掌握了完整种子，能算出**对手底牌和后面所有公共牌**；如果双方都没揭示，种子就等于 VRF 输出，全网都能算出牌堆。

**改为**：任何一方缺盐，本手牌作废并退回盲注，或者判缺盐方弃牌并扣罚。**绝不在种子只被一方掌握的情况下发牌。**

### P0-5　盐的揭示时机前后矛盾

通用上下文写的是「发牌前 reveal」，Stage 4 第 4 步又写「手牌结束后 reveal_salt」，而第 3 步洗牌时已经在用两份盐了。

**改为两段式**：

1. 发牌前把盐**私密地**提交进 TEE（写入私有的 Deck 账户，程序校验 hash）。
2. 手牌结束后再把盐**公开**写入 HandProof。

另外，**盐必须每手更新**。如果入座时只提交一次，第 1 手公开后，第 2 手的种子就能被推算出来。完整协议见 §3.2。

### P1-6　主链 fallback 里「把种子写入 Game 再委托」会泄露种子

Game 是公开账户，委托前它还在 L1 上。只有 VRF 的原始输出可以放在公开位置，与盐的混合必须在 PER 内完成。鉴于 §0 的证据，这条 fallback 大概率用不上，但写法仍需更正。

### P1-7　Anchor 1.0 的测试工具链变了

- `anchor init` 默认生成 **LiteSVM（Rust）** 测试模板。要用 TS 测试，需要写 `anchor init solpoker --test-template mocha`。
- `anchor test` 默认使用 **Surfpool**。要配合 MagicBlock 本地栈，需要先单独启动 `mb-stack`，再运行 `anchor test --skip-local-validator`（官方示例就是这么做的）；也可以用 `--validator legacy`。
- 其他变化：Anchor.toml 里的 `[registry]` 段已移除；TS 包改名为 `@anchor-lang/core`；默认禁止同一可变账户重复传入（需要时用 `dup` 约束）；每个程序只允许一个 `#[error_code]`；`CpiContext` 不再包含 program 字段。

### P1-8　缺少本地 VRF 队列

本地测试必须使用 §1.2 列出的两个测试队列。程序里的队列约束要像官方 roll-dice 示例那样同时接受正式队列和测试队列，或者用 cargo feature 切换。

### P1-9　委托与设权限之间存在「隐私窗口」

EphemeralPermission 是在账户**委托进 ER 之后**才在 ER 上创建的，在那之前账户默认公开。所以 Deck/PlayerHand 委托时必须是空的，要等私有权限生效（客户端可以调用 `waitUntilPermissionActive`）之后才能写入秘密。

### P1-10　Stage 8：USDC 不是 Token-2022

Solana 上的 USDC 是经典 SPL Token；PYUSD 等才是 Token-2022。建议用 `token_interface` 同时兼容两种，devnet 上可以自铸一个测试 mint。

### P2-11　「免 gas」并不是完全免费

`magicblock-delegation-program-api 3.1.0` 中的常量如下：

- 每次 commit 收 **0.0001 SOL**（第一次之后开始收）；
- 每个委托 session 收 **0.0003 SOL**；
- 关闭委托 PDA 时抽取其租金的 **10%**。

每手牌 commit 一次，打 100 手约 0.01 SOL。在 devnet 上可以忽略，但会影响将来主网的经济模型；具体由谁支付需要在 Stage 0 实测确认。

### P2-12　devnet 领水不可行

从沙盒请求 devnet airdrop 返回 `Internal error`，所以 Stage 2/3/4/6 要求的「devnet 交易签名」需要你提供 devnet SOL（估算见 §4-C）。

---

## 3. 需要在 Stage 1 设计文档中补上的内容

### 3.1 账户生命周期：「每手一个 Game」不现实

账户在委托进 ER 期间，每手牌都去 L1 新建 PDA 再委托，会失去 ER 的低延迟，还要反复付租金和 0.0003 SOL 的 session 费。**建议方案**：

- Game：每桌一个，复用，带 `hand_id` 字段。
- HandProof / HandSettlement：每桌一个环形缓冲（保留最近 K 手），每手 commit；完整历史靠交易日志或链下索引。
- Deck / PlayerHand：二选一，由 Stage 3 的 spike 决定——方案 A 是「委托 + 清零后才 undelegate」，方案 B 是用 ephemeral account。
- 同一张桌的 Game、Deck、两个 PlayerHand 必须**委托给同一个 TEE validator**，因为一条指令会同时读写它们。

### 3.2 洗牌协议（建议的完整规格）

1. **承诺**：上一手结束时（第一手则在入座时），每位玩家公开提交 `C_i = sha256("solpoker/salt/v1" ‖ table ‖ hand_id ‖ player ‖ salt_i)`。加入 table、hand_id、player 做域分离，是为了防止复制对手的承诺或跨手重放。
2. **请求 VRF**：双方承诺都齐了之后，在 TEE ER 内请求 VRF。
3. **VRF 回调**：只把 randomness 存进私有的 Deck，不在回调里洗牌。原因有二：一是回调交易的 CU 上限未知；二是回调交易的可见性不确定。
4. **私密揭示**：玩家把 `salt_i` 通过交易发给 TEE，程序校验 hash 后存入 Deck。
5. **洗牌发牌**：randomness 和两份盐都到齐后，任何人都可以触发 `shuffle_and_deal`：
   - 种子 = `sha256(randomness ‖ saltA ‖ saltB)`。手册写的 XOR 也可以接受，用 hash 则可以避免线性结构。
   - 用确定性 PRNG（SHA-256 计数器模式，或 ChaCha20）驱动 Fisher–Yates，取下标时做拒绝采样。
   - 牌堆写入 Deck，底牌写入两个 PlayerHand。
6. **公开证明**：手牌结束后，把 randomness、两份盐（和牌序，取决于 §3.4 的决定）写入 HandProof，客户端可以重算验证。
7. **流水线优化**：「公开第 N 手的盐」和「提交第 N+1 手的承诺」放在同一笔交易里，省一个往返。
8. **每一步都要有超时**：承诺或揭示超时，按 P0-4 处理（作废或判负）；VRF 在 T 秒内没回调，允许重新请求。
9. **纪律**：任何种子、盐、牌面都不得出现在 `msg!` 日志里。注意官方 roll-dice 示例会打印 randomness，**不要照抄**。

### 3.3 盐的揭示交易与 VRF 回调交易，对其他人可见吗？

这一点目前未知。交易消息的可见性受 `TX_MESSAGE` / `TX_LOGS` 等权限位控制，但一笔交易涉及多个账户（包括公开账户和 VRF 队列）时，规则是怎样的并不清楚。**建议 Stage 3 增加测试项**：玩家 B 用自己的 token 对「A 的揭示交易」和「VRF 回调交易」调用 `getTransaction`，确认读不到指令数据和日志。

### 3.4 公开完整牌序等于公开弃牌方的底牌

HandProof 公开完整牌堆后，弃牌一方的底牌（muck）和没发出的公共牌都会被看到。在 heads-up 中，这会暴露诈唬频率等策略信息。这是**公平可验证性和 muck 隐私之间的取舍**，需要你决定（见 §4-A8）。

### 3.5 超时机制：谁来触发？

Solana 上没有「到点自动执行」。可选方案：

- 允许任何人调用 `claim_timeout`，由对手的前端自动发起（最简单）；
- 使用 ER 的 crank（SDK 有 `crank` 模块，官方有 crank-counter 示例）。

还需要确定：

- 用 `Clock::unix_timestamp` 计时，不要用 slot（ER 的出块节奏和 L1 不同）；
- 超时时能 check 就自动 check，不能才 fold（这是行业惯例）；
- 非行动阶段（承诺、揭示、等 VRF）的超时怎么处理。

### 3.6 Session key 的两个坑

1. **任何人都能撤销任意 session token**（session-keys 3.1.1 源码注释里明确写了）。在对抗性对局中，对手可以在你行动前撤销你的 session，逼你超时弃牌。
2. `@magicblock-labs/gum-sdk@3.0.10` 依赖 `@coral-xyz/anchor ^0.30.1`，和 `@anchor-lang/core 1.x` 同时出现在前端，会有两份 Anchor 包。

**建议**：在 solpoker 程序内自建一个极简 Session PDA，包含 owner、session_pubkey、expires_at，只有 owner 能撤销，只能签对局动作指令。另外，所有动作指令都保留钱包直接签名的兜底路径。

还要注意：session key 不带 PlayerHand 的**读取权限**。读权限绑定的是钱包公钥，需要钱包 `signMessage` 一次换取 token（SDK 中 session 时长常量是 30 天，实际以服务端返回的 `expiresAt` 为准）。

### 3.7 Attestation 的保证有限

`verifyTeeRpcIntegrity` 做的是：通过 Phala PCCS 校验 TDX quote 的 Intel 签名，再确认 reportData 等于客户端发出的 challenge。它**不校验 MRTD/RTMR 等度量值**，所以只能证明「对面是一台真的 TDX 机器」，不能证明「运行的是 MagicBlock 那份特定代码」。另外，challenge 是用 `Math.random()` 生成的，不是密码学安全的随机数。

**建议**：在它外面包一层自己的校验，使用 `crypto.getRandomValues`，并在能拿到官方度量值后加上度量值比对。需要向 MagicBlock 确认他们是否公布度量值（见 §4-C）。Stage 7 的「attestation 门控」目前只能做到「真 TDX 门控」这一层。

### 3.8 Stage 7 的连接方式需要调整

所有对局账户都在 TEE validator 上，所以对局交易和读取实际上都走 devnet-tee（带 token）。Magic Router 只用于 L1 操作（建桌、委托等）以及自动路由。Router 能否把交易正确转发到 TEE validator，需要在 Stage 3 顺带验证。

### 3.9 计算预算

需要实测以下操作的 CU 消耗：洗牌（52 张 Fisher–Yates + 拒绝采样）、7 选 5 评估（21 种组合 × 2 名玩家）、结算。如果超出单笔交易的上限，就拆成多条指令。

---

## 4. 待你确认的问题

每条都附了推荐默认值。可以只回「全部按默认」，或者只列出要改的编号。

### A. 扑克规则与产品

| # | 问题 | 推荐默认 |
|---|---|---|
| A1 | v1 形态：现金桌（固定盲注、手间可离桌）还是 SNG（打到一方输光）？ | 现金桌 |
| A2 | 游戏币从哪来？ | 每个钱包一个全局 PlayerAccount，首次可领 10,000 筹码；入座时从中划转买入额到 Seat，离桌时划回 |
| A3 | 盲注与买入范围 | SB=1 / BB=2，买入 40–200 筹码（20–100BB），允许手间补码 |
| A4 | 最小加注规则 | 标准 NLHE：加注增量 ≥ 上一次加注增量；不足额 all-in 不重新开放行动 |
| A5 | 平分底池的奇数筹码给谁 | 给非庄位（BB，翻后先行动者），与行业惯例一致 |
| A6 | 第一手的庄位 | 由 VRF 决定（与第一次洗牌复用同一个随机数的另一段字节） |
| A7 | 超时时长与处理 | 30 秒；能 check 则自动 check，否则 fold；连续 3 次超时自动站起 |
| A8 | 手牌结束后公开什么 | v1 公开完整牌序和种子（最简单、完全可验证），接受 muck 牌被看到的代价；v2 再考虑只公开摊牌牌 + 承诺值 |
| A9 | 手牌进行中离桌或断线 | 视为 fold；本手结束后站起，筹码回到全局账户 |
| A10 | 链上保留多少手牌历史 | 链上环形缓冲保留最近 16 手，更早的靠链下 |
| A11 | 前端语言与风格 | 中英双语，功能优先的极简风格 |

### B. 技术选型

| # | 问题 | 推荐默认 |
|---|---|---|
| B1 | Anchor 版本 | 保持 1.0.2（与官方示例一致），Cargo 里写 `=1.0.2` |
| B2 | Solana CLI | 3.1.10（Anchor 1.0 的官方推荐） |
| B3 | Rust | 1.89；不行就退到 1.93.1 |
| B4 | TS Anchor 客户端 | `@anchor-lang/core@1.0.x`（基于 web3.js v1，与 MagicBlock TS SDK 一致） |
| B5 | Session key | 程序内自建极简 Session PDA（见 §3.6），不用 gum session-keys |
| B6 | Deck/PlayerHand 的存储方式 | Stage 3 的 spike 同时测「委托 + 清零」和「ephemeral account + 权限」，选更安全的 |
| B7 | 种子合成方式 | `sha256(randomness ‖ saltA ‖ saltB)`（手册的 XOR 也可以接受） |
| B8 | PRNG | 用 Solana 的 sha256 syscall 做计数器模式，不引入外部 crate |
| B9 | 超时触发 | v1 由对手前端自动调用 permissionless 的 `claim_timeout`；crank 留到 v2 |
| B10 | 前端框架与部署 | Next.js（与官方 gachapon 示例的 16.x 对齐）+ wallet-adapter；开发阶段用沙盒临时 URL，正式部署再定 |

### C. 需要你提供的资源或信息

| # | 事项 | 说明 |
|---|---|---|
| C1 | **devnet SOL** | 沙盒领水失败。估算：一个 300–600KB 的程序要 2.1–4.3 SOL 租金，部署时 buffer 会让峰值翻倍到 4.3–8.6 SOL。算上 Stage 0/2/3 的 spike 程序和主程序，建议准备 **15–20 devnet SOL**，spike 程序用完可以 close 回收。可以由我生成部署地址你来转账，也可以你直接提供 devnet keypair |
| C2 | **密钥持久化** | 部署者 keypair、各程序的 keypair（决定程序 ID 是否稳定）、两个测试玩家钱包。沙盒可能被重置，需要确定存放位置。候选：Manus 项目文件，或你本地保管。**绝不提交到公开仓库** |
| C3 | **代码托管** | 是否每个 Stage 推送到 GitHub？项目里有 GitHub connector，但目前是**未启用**状态 |
| C4 | **pokerable 的来源** | 手册多次引用它（reservation release、attestation 门控、rake 规则），但公开的 GitHub 上搜不到，请提供链接或源码。我搜到一个同类项目 `starkdevx/Shield-Poker`，但它用的是旧 SDK 0.8 加客户端种子，公平性方面不值得参考 |
| C5 | **MagicBlock 的 TEE 度量值** | 是否能从 MagicBlock（Discord）拿到 devnet-tee 的 MRTD/RTMR 期望值？这是 §3.7 加度量值比对的前提 |
| C6 | **测试钱包** | Stage 7 双窗口实测需要两个支持 `signMessage` 的 devnet 钱包（Phantom / Solflare / Backpack 均可），用两个浏览器 profile 分开 |
| C7 | **Stage 8 的定位** | 只在 devnet 演示，还是计划上主网？真钱扑克在大多数司法辖区属于受监管的博彩，上主网前需要单独评估牌照和地域限制 |
| C8 | **项目指令** | 是否把 §5 的修订版通用上下文块保存为项目指令？这样每个 Stage 就不用再重复粘贴了 |

---

## 5. 修订版通用上下文块（替换原版）

完整文本见同目录下的 `context-block-v2.md`。与原版相比的主要改动：

- 把 §2 的 P0/P1 勘误全部写进了【架构】；
- 【版本】中改为精确锁定，并补充了 Anchor 1.0 的测试注意事项；
- 【关键地址】中补上了 validator 公钥、本地 VRF 队列，以及 scoped identity 的说明；
- 【纪律】中增加了「不在日志中输出秘密」「私有账户必须显式指定 TEE validator」「不得 commit 含秘密的账户」三条。

## 6. 各 Stage 的补充建议

| Stage | 建议增补 |
|---|---|
| S0 | 用 `--test-template mocha` 初始化；用 `mb-stack` 启动本地栈并以 `--skip-local-validator` 运行测试；锁定 `anchor-lang =1.0.2`、SDK `=0.17.3`；**额外对 devnet-tee 跑一次 delegate/commit**，提前暴露 0.14 与 0.16 之间的版本差异；实测 commit 费用由谁支付 |
| S1 | 纳入 §3.1–3.6 的决定：账户复用和环形缓冲、完整洗牌协议、超时触发方、session 设计、muck 策略；权限矩阵中写清 `is_private` 取值和「默认成员 = owner」 |
| S2 | B 项改为「确认 devnet-tee 内 VRF 可用」（已有旁证）；回调使用 `#[vrf_callback]`；回调只存 randomness；实测回调交易对非成员是否可见 |
| S3 | 增加 4 项测试：commit 后在 L1 读取数据（验证 P0-3）；B 读取 A 的揭示交易（§3.3）；ephemeral account 能否挂权限；隐私窗口测试（委托后、设权限前的可读性） |
| S4 | 按 §3.2 实现，不在回调里洗牌；缺盐时作废本手而不是降级；测试中增加「复制对手承诺」和「跨手重放盐」两个恶意用例 |
| S5 | 规则按 §4-A 的决定实现；评估器单测覆盖 A-2-3-4-5（wheel）顺子和同花里的 wheel |
| S6 | 结算后先清零 Deck/PlayerHand，再 commit_and_undelegate；commit 只包含 Game / Seat / HandProof；奇数筹码规则写进单测 |
| S7 | 对局流量走 TEE 连接；自建的 attestation 校验包一层 `getRandomValues`（有官方度量值时再加比对）；实现 session 撤销和钱包兜底签名 |
| S8 | 使用 `token_interface`；rake 规则待 pokerable 来源确认；先完成法律定位 |

## 7. 证据与来源

- 版本信息：crates.io API（ephemeral-rollups-sdk、ephemeral-vrf-sdk、anchor-lang、session-keys、magicblock-delegation-program-api）；npm（@magicblock-labs/ephemeral-rollups-sdk、ephemeral-validator、@anchor-lang/core、gum-sdk）；GitHub Releases（solana-foundation/anchor、anza-xyz/agave、magicblock-labs/magicblock-validator、ephemeral-rollups-sdk）。
- 源码：`magicblock-labs/ephemeral-rollups-sdk@v0.17.3` 中的 `rust/vrf-sdk/src/{consts,instructions}.rs`、`rust/vrf-macro/src/lib.rs`、`rust/sdk/src/{cpi,types,ephemeral_accounts}.rs`、`rust/sdk/src/access_control/structs/{member,ephemeral_permission}.rs`、`ts/web3js/src/access-control/{auth,verify}.ts`；`magicblock-delegation-program-api 3.1.0` 中的 `consts.rs`；`session-keys 3.1.1` 中的 `lib.rs`。
- 官方示例：[magicblock-engine-examples](https://github.com/magicblock-labs/magicblock-engine-examples) 中的 private-counter、roll-dice、rock-paper-scissor、sealed-auction、session-keys，以及 `scripts/local-env.sh` 和 `scripts/test-locally.sh`。
- 文档：[PER Access Control](https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/access-control)、[TEE 介绍](https://docs.magicblock.gg/pages/tools/tee/introduction)、[ER 总览](https://docs.magicblock.gg/pages/get-started/introduction/ephemeral-rollup)、[Anchor 1.0.0 Release Notes](https://www.anchor-lang.com/docs/updates/release-notes/1-0-0)。
- 链上实测（2026-09-30 00:46–00:48）：
  - 在 devnet L1 查询 `DEFAULT_EPHEMERAL_QUEUE`：owner 为 Delegation Program，委托记录中 validator 为全零、原 owner 为 VRF 程序。
  - 在 devnet-as/eu/us/tee 四个端点上查询：均为 magicblock-core 0.16.0，都能读到该队列账户；**tee 端点上最近一笔队列交易距查询时 0–1 秒**。
  - 用 `getIdentity` 获取了各 validator 的公钥。
  - devnet L1 为 solana-core 4.3.0。
  - 从沙盒请求 airdrop 失败。
