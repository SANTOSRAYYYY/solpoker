# solpoker 通用上下文块 v3（合并第二轮决策）

> 用法：每个 Stage 开头粘贴下面代码块里的全部内容。标有「（默认，待确认）」的条目，在你答复前按默认值执行。与 v2 相比新增了 USDC 每桌托管、档位、ante 与 rake、逐街 VRF 发牌协议、常驻桌、逃生通道和 UI 规范（2026-09-30 第三轮已同步）。

```text
你在为 solpoker 项目工作：一个 Solana 上的隐私德州扑克（No-Limit Hold'em，v1 为 heads-up）。v1 只做现金桌，下注和结算都用 USDC。SNG 和 Flip 玩法以后再做，v1 不做，但托管设计为 SNG 预留 TourneyVault。运营方持有牌照，计划上主网。

【项目文件】
- 项目文件（新任务中用 find / -name 'solpoker-*' 2>/dev/null 查找位置）：设计依据是 solpoker-pre-dev-review.md（版本核实与勘误）和 solpoker-decisions.md（全部产品与架构决策，§8、§9 为最新）。本块与文档冲突时，以文档中最新一节为准。
- devnet 密钥：solpoker-key-deployer.json（部署者 541kpQWNTnAGG2Lie54D3qqhLvNJ5UKKpJPFyoi1P33H：升级权限、手续费、devnet treasury、tUSDC mint authority）；solpoker-key-program.json（程序 ID EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf，写进 declare_id!）；solpoker-key-tusdc-mint.json（tUSDC mint 9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH）。
- 密钥只用于 devnet，不得提交到 git（仓库里的 .gitignore 必须包含 keys/ 和 solpoker-key-*.json；在仓库中使用时复制到 keys/ 目录）。主网密钥另行管理，升级权限交给多签。

【Agent 与 AI 桌（Stage 8，细节待确认，未确认前不要实现）】
- 三类牌桌：真人桌（每档 3 张，已定）、AI 桌（agent vs agent）、混合桌（人 vs agent，座位带链上 AI 标记）。
- agent 通过 AgentProfile PDA 注册，需要主人和 agent 双签。
- 入座有两条路径：x402 路径——网关返回 402，payTo = vault_auth PDA，付款直接进入 TableVault；自建 facilitator（@x402/svm 2.28.x）验证并上链后，由 credit_x402_deposit 入账，DepositRecord 以交易签名为种子防重复。原生路径——SDK 直接调用 sit_down。
- agent 用自己的密钥直接连 TEE，读取自己的底牌；推荐的接入方式是本地 MCP（@solpoker/agent-mcp）。

【产品规则（已确认）】
- 现金桌三档：0.1/0.2、0.5/1、1/2 USDC；买入 100–1000BB；允许手间补码，补码后不超过 1000BB。档位写在 TableConfig PDA 里，不写死在代码中。
- 链上金额一律用 u64 的 USDC 基础单位（6 位精度）；下注额和 rake 都取 0.01 USDC 的整数倍；奇数筹码（0.01）给非庄位（BB）。
- 最小加注：加注增量 ≥ 上一次加注增量；不足额 all-in 不重新开放行动。
- 第一手庄位由 VRF 决定。行动超时 30 秒：能 check 就 check，否则 fold；连续 3 次超时自动站起。
- 牌局中离桌或断线视为 fold；手牌结束后站起，筹码直接回到玩家钱包。
- 手牌结束后公开全部种子、盐和事件流（可以完整复算牌序）；链上 HandProof 用环形缓冲保留最近 16 手。
- 常驻桌：每档 3 张，共 9 张，由部署脚本创建，空桌也不关。同一钱包可以同时坐多张桌，但同一张桌只能占一个座位。
- Ante：每手翻前每人 0.1BB（三档分别为 0.02 / 0.1 / 0.2 USDC），先于盲注投入。ante 是死钱，不计入当轮下注额，进底池归本手赢家（已定）；平台收入只有 rake。
- Rake：只在发出了翻牌时收（含翻前 all-in 后自动发完公共牌）。先退回未跟注的下注，剩余底池（含 ante）为基数；rake = min(向下取整到 0.01 USDC(底池 × 2.5%), 3BB)；底池 ≤ 1BB 时不收。先扣 rake 再分底池。
- 作废的手牌（缺盐、VRF 连续失败）：所有投入（含 ante）全额退回，不收 rake。短码先投 ante 再投盲注，不足则 all-in；stack 为 0 自动站起。

【资金托管（USDC 不进 rollup）】
- 每桌独立托管：同一个 solpoker 程序为每张桌派生 TableVault。TableVault 必须是 ATA(vault_auth, mint)，vault_auth = PDA ["vault_auth", table]；做成 ATA 是为了兼容 x402 和普通钱包转账。TableVault 放在 L1、永不委托；vault_auth 与 Game 分开派生。不给每张桌单独部署程序。
- Seat（每桌每座一个账本，字段 owner / stack / total_deposited / total_paid_out / 已计入的补码累计值）：会话期间委托给 TEE。
- 入座：一笔 L1 交易完成钱包 → TableVault 转账和创建 Seat，然后委托 Seat。需要钱包签名，session key 不能碰资金。
- 补码：一笔 L1 交易完成钱包 → TableVault 转账，并让 TopUpReceipt.total_topped_up 增加；ER 在手与手之间把差额计入 Seat.stack。首选让 ER 读取 L1 上的 TopUpReceipt，需要 Stage 3 spike 验证；兜底是 Seat undelegate → 在 L1 补码 → 重新委托。必须防止同一笔补码被计两次；补码后 stack 超过 1000BB 的部分退回钱包。
- 离桌：在 ER 里站起（session key 可签）→ 只对这个 Seat 执行 commit_and_undelegate（Game 保持委托）→ 在 L1 上执行 cash_out，把钱从 TableVault 转到 seat.owner 的 USDC ATA。cash_out 是 permissionless 的，收款地址在程序里钉死，任何人都可以代为触发，断线玩家的钱会被自动退回。
- Rake：记在 Game.rake_accrued；会话结束、Game 回到 L1 后，由 permissionless 的 sweep_rake 从 TableVault 划到 treasury。
- SNG：同样的模式，每场一个 TourneyVault。
- 每桌守恒不变量（proptest，每条资金指令末尾都要断言）：TableVault 余额 = Σ Seat.stack + 底池 + 尚未计入的补码 + 尚未划走的 rake。每手 commit 后底池为 0，L1 状态总是全额有担保。
- 主网前必须把 program upgrade authority 交给多签或锁定升级，因为它理论上能动所有 TableVault。
- mint 地址可配置。本地和 devnet 联调用自铸的 6 位精度 tUSDC；Circle devnet USDC = 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU（经典 SPL Token）。用 token_interface 兼容 Token-2022。
- 逃生通道：委托程序 v3.1.0 提供 RequestUndelegation（由 owner 程序 CPI 调用，被委托的 PDA 签名），等待 ≥ 9000 slot（约 60 分钟）后调用 UndelegateWithRollbackAfterTimeout，把账户回滚到最后一次提交的状态。SDK 0.17.3 没有封装，需要用 magicblock-delegation-program-api 3.1.0 的 instruction builder 自己写 CPI；按源码注释，包装层必须在调用前后保存并恢复账户数据。devnet 上的委托程序最后部署于 2026-04-27（约 v2.0.x），大概率不支持这两条指令：代码预留，按运行时条件启用。主网上线前必须具备。

【架构】
- 链上程序用 Anchor（Rust），部署在 Solana devnet。对局运行在 MagicBlock Private Ephemeral Rollup（Intel TDX，devnet-tee）上。
- 同一张桌的 Game、Deck、PlayerHand x2 和 Seat x2 必须委托给同一个 TEE validator：MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo。委托时显式传入，禁止使用默认的 validator: None。
- 权限（EphemeralPermission，委托后在 ER 上用 CreateEphemeralPermissionCpi 创建）：
  - Deck：is_private = true，members = []（只有 owner 即程序本身，玩家读不到）。
  - PlayerHand：is_private = true，members = [该玩家]。
  - Game 和 Seat：公开。
  - is_private = false 时 members 会被忽略，账户完全公开。
  - 委托时 Deck/PlayerHand 必须是空的，等私有权限生效后（waitUntilPermissionActive）才能写入秘密。
- 提交规则：commit/undelegate 会把账户数据写回 L1，任何人都能读。
  - Deck/PlayerHand 在含有秘密期间绝不 commit；undelegate 前必须清零；保持默认 commit_frequency_ms = u32::MAX。
  - 每手结算后只 commit Game、Seat、HandProof。
  - Deck/PlayerHand 也可以改用 ephemeral account，以 Stage 3 结论为准。
- 常驻桌长期委托：Game、Deck、PlayerHand ×2、RakeAccount 一直留在 TEE；Seat 在入座时委托、离桌时解除委托。
- 换人时的底牌权限：PlayerHand 按座位固定。新玩家入座后必须按顺序执行：确认 PlayerHand 已清零 → UpdateEphemeralPermissionCpi 把 members 从旧玩家改为新玩家 → 等新权限生效 → 才开下一手。旧玩家不能读到新玩家的底牌，必须有测试覆盖。
- Rake 划转：ER 内 move_rake 把 Game.rake_accrued 转入 RakeAccount → 对 RakeAccount 执行 commit_and_undelegate → L1 上 permissionless 的 sweep_rake 从 TableVault 划到 treasury（地址钉死）→ 重新委托 RakeAccount。默认每天一次。
- 维护模式（仅管理员）：在手牌边界进入维护 → 清零秘密账户 → 解除全部委托 → 升级程序或迁移账户结构 → 重新委托。正常运营中不关桌。
- 随机数：在 TEE ER 内请求 MagicBlock VRF（devnet 用 DEFAULT_EPHEMERAL_QUEUE，本地用 DEFAULT_EPHEMERAL_TEST_QUEUE）。
  - 用 create_request_randomness_ix（scoped identity）+ invoke_signed_vrf 发起请求。
  - 回调结构体必须加 #[vrf_callback]，由它校验 scoped identity = PDA(["identity", 本程序ID], VRF程序) 且是 signer。
  - 回调里只存 randomness，不洗牌、不抽牌。
- 发牌协议（借鉴 CHIPCHIP CSRP v1，按可证明公平改造）：
  1) 承诺：每人公开提交 C_i = sha256("solpoker/salt/v1" ‖ table ‖ hand_id ‖ player ‖ salt_i)。salt_i 每手重新生成，32 字节。
  2) 双方承诺都齐后请求 VRF；随后每人把 salt_i 私密发送进 TEE，程序校验哈希后存入 Deck。任何一方缺盐或超时，本手作废（退回盲注）；绝不在只有一方掌握种子时发牌。
  3) 逐街 VRF（已定）：翻前、翻牌、转牌、河牌各请求一次新的 VRF，第 k 街的种子 seed_k = sha256(VRF_k ‖ saltA ‖ saltB)；盐每手只提交一次。第一手的庄位用 seed_0 的另一段决定。等待 VRF 期间暂停行动计时器。超时（默认，待确认）：10 秒没有回调就对同一条街重新请求，最多 3 次，仍失败则作废本手并全额退款。
     all-in 合并（已定）：本街下注结清、最多只剩一人还能行动时，追加 RunoutStarted 事件，只请求一次 VRF_r，用 seed_r 按顺序逐张抽出剩余的公共牌；draw_no 接续编号，每张牌都绑定最新的事件流。HandProof 记录每张公共牌用的是哪一个 VRF。前端照样逐街翻出。
  4) 事件流：Game 里维护链式哈希 transcript = sha256(transcript ‖ 规范编码的事件)。事件包括阶段开始、强制投入、动作、公共牌发出、阶段跳过；底牌不进入事件流。
  5) 抽牌：HMAC-SHA256(key = seed_k, msg = "solpoker-v1" ‖ table ‖ hand_id ‖ draw_no ‖ retry ‖ transcript_digest)，取前 8 字节（大端），小于 2^64 mod n 就重抽，下标 = 值 mod n。牌堆是有序列表，抽出一张删掉一张。底牌从 SB 开始，每人一张，共两轮。
  6) 手牌结束后，把全部 VRF 输出、两份盐和事件流摘要写入 HandProof。
  7) 仓库必须包含 docs/dealing-protocol.{zh,en}.md、reference/solpoker_deal.py、vectors/v1/*.json；CI 校验链上 Rust 实现、Python 参考实现和测试向量三者逐字节一致。
- Session key：程序内自建 Session PDA（owner、session_pubkey、expires_at ≤ 7 天），只有 owner 能撤销，只授权对局动作，不能充值、买入或提现；所有动作都保留钱包直接签名的兜底路径。
- 费用：按 api 3.1.0 的常量，每次 commit 收 0.0001 SOL（第一次之后），每个委托 session 收 0.0003 SOL，关闭委托 PDA 时抽取租金的 10%。devnet 上实际收费以实测为准。

【前端】
- 中英双语，功能优先的极简风格。
- 深色底，主色 #9945FF（Solana Purple），正向操作用强调色 #14F195（Solana Green），fold 等危险操作用低饱和红色。
- 对局流量走 devnet-tee（带 token）；入场前做 attestation 校验，challenge 用 crypto.getRandomValues 生成。
- 提供「信任页」，逐项链接到可验证的证据。

【版本钉死 — 不要装别的版本】
- Anchor CLI 1.0.2；Cargo 中写 anchor-lang = "=1.0.2"（SDK 声明 ^1.0，不写死会被解析到 1.2.0）。
- Solana CLI (Agave) 3.1.10。
- Rust 1.89；若依赖的 MSRV 报错，改用 1.93.1 并记录。
- Node 24。
- ephemeral-rollups-sdk = { version = "=0.17.3", features = ["anchor", "access-control", "vrf"] }；VRF 通过 ephemeral_rollups_sdk::vrf 使用。
- TS：@magicblock-labs/ephemeral-rollups-sdk@0.17.3、@anchor-lang/core@1.0.x、@solana/web3.js@1.98.x。
- 本地测试：@magicblock-labs/ephemeral-validator@0.14.10（mb-stack）。devnet 上的 ER 是 0.16.0，最终以 devnet 为准。
- Anchor 1.0 注意事项：
  - 初始化用 anchor init --test-template mocha。
  - 测试时先启动 mb-stack，再运行 anchor test --skip-local-validator。
  - 不要写 [registry]；每个程序只能有一个 #[error_code]；同一可变账户重复传入需加 dup 约束。
- 官方示例停留在 SDK 0.16.2，只借鉴思路，API 以 0.17.3 源码为准。
- 提交一律用 MagicIntentBundleBuilder；commit_accounts 等已废弃。

【关键地址】
- Delegation Program：DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh
- Permission Program：ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1
- VRF program：Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz
- VRF 回调身份：scoped_vrf_identity(&crate::ID)。9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw 已废弃，不要用。
- VRF 队列：
  - devnet 主链 Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh
  - devnet ER 5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc
  - 本地主链 GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb
  - 本地 ER Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT
- Validator：
  - devnet-tee MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo
  - 本地 mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev
- 端点：
  - https://devnet-tee.magicblock.app（getAuthToken 后以 ?token= 连接）
  - https://devnet-router.magicblock.app（仅用于 L1 操作和路由，脚本里要设 UA）
  - https://api.devnet.solana.com
- 本地端口：base 8899/8900，ER 7799/7800，QFS 6699/6700。

【权威文档 — 动手前先读】
- ER 总览：https://docs.magicblock.gg/pages/get-started/introduction/ephemeral-rollup
- PER quickstart：https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart
- PER access control：https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/access-control
- TEE 介绍：https://docs.magicblock.gg/pages/tools/tee/introduction
- VRF quickstart：https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/how-to-guide/quickstart
- SDK 源码：https://github.com/magicblock-labs/ephemeral-rollups-sdk/tree/v0.17.3
- 委托程序源码（逃生通道）：https://github.com/magicblock-labs/delegation-program
- 官方示例：https://github.com/magicblock-labs/magicblock-engine-examples
- 可借鉴的同类项目：https://pokerable.fun/trust（产品与信任模型）；https://github.com/chipchiptw/CHIPCHIPGAME（发牌协议的写法，CC BY 4.0 / MIT）
- Anchor 1.0 发布说明：https://www.anchor-lang.com/docs/updates/release-notes/1-0-0

【纪律】
- 动手写代码前，先用 5–10 行复述本阶段的任务和验收标准，等我确认。
- 不确定的 API，先查 v0.17.3 源码或本地依赖，不要凭记忆编函数签名。
- 任何种子、盐、randomness、牌面都不得出现在 msg! 日志、事件或错误信息中。
- 私有账户委托时必须显式指定 TEE validator；含秘密的账户不得 commit，undelegate 前必须清零。
- 读不到数据必须是 PER 权限层强制的结果，不能靠「服务端不返回」来隐藏。
- 资金相关的指令（充值、买入、离桌、提现、rake 划转）必须有守恒断言和对应的单测、proptest。
- 每个 Stage 结束都输出 CHANGELOG：做了什么、验收命令及结果、devnet 交易签名、遗留问题。
```
