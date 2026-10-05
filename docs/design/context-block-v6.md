# solpoker 通用上下文块 v6（2–9 人修订 + Stage 2 + Privy 钱包层）

> 用法：代码块里的全部内容就是项目指令，新任务会自动带上。v6（2026-10-06）：Stage 2 基线已合并进 main（commit 7e7842b）；前端钱包层定为 Privy。v5 加入 D7（v1 完整 2–9 人）和 Stage 2 V1 拆分 VRF；覆盖 v4 的 heads-up、×2 和固定混合座位假设。

```text
你在为 solpoker 项目工作：一个 Solana 上的隐私德州扑克（No-Limit Hold'em，v1 每桌完整支持 2–9 人）。v1 只做现金桌，下注和结算都用 USDC。SNG 和 Flip 玩法以后再做，托管设计为 SNG 预留 TourneyVault。运营方持有牌照，计划上主网。

【仓库与项目文件】
- 代码：GitHub 私有仓库 SANTOSRAYYYY/solpoker（main 分支，GitHub Actions CI）。新任务先 gh repo clone；工具链按 README 安装，用 scripts/check-pins.sh 校验。
- Stage 2 代码已合并进 main（commit 7e7842b）：crates/solpoker-core、programs/solpoker 的 VRF 切片、scripts/probe-vrf-latency.ts、docs/stage2-notes.md；stage2-dev 脚手架只在本地，未入库。
- 纯 Rust 状态机放在 crates/solpoker-core（无 Anchor/Solana 依赖）：VRF 状态机、caller_seed、九席掩码和 next_clockwise/位置 helper；链上程序只做账户校验和调用核心逻辑。
- 设计依据（仓库 docs/design/ 下，项目文件里是带 solpoker- 前缀的副本，以仓库版本为准）：stage1-design.md（主设计文档，定稿 v1.1，编码依据）、stage1-agents-x402.md（AI 桌与 x402，定稿 v1.1）、stage1-fees-escape.md、decisions.md（§12 为最新）、pre-dev-review.md。外部事实在 docs/stage0-notes.md、docs/stage1-research-notes.md。优先级：主设计 D7/其余章节 > 配套文档 > 决策记录 > 本块；旧 heads-up 条目只作历史。
- devnet 密钥（项目文件，用 find / -name 'solpoker-key-*' 2>/dev/null 查找）：solpoker-key-deployer.json（部署者 541kpQWNTnAGG2Lie54D3qqhLvNJ5UKKpJPFyoi1P33H：升级权限、手续费、devnet treasury、tUSDC mint authority）；solpoker-key-program.json（程序 ID EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf）；solpoker-key-tusdc-mint.json（tUSDC mint 9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH）。smoke 程序（Stage 0/3 spike）的 ID 是 BU1Ad3zgoJWrP11kZTzomMTJtebVGYdVweMjkQHtfQW4。
- 密钥只用于 devnet，不得提交到 git：使用时复制到仓库 keys/（已在 .gitignore），提交前运行 scripts/precommit-check.sh。主网密钥另行管理，升级权限交给多签。

【产品规则（已定）】
- 现金桌三档：0.1/0.2、0.5/1、1/2 USDC；买入 100–1000BB；允许手间补码，补码后超过 1000BB 的部分退回。档位和计时参数写在 Table 账户里，不写死。
- 链上金额一律用 u64 的 USDC 基础单位（6 位精度）；下注额和 rake 都是 0.01 USDC 的整数倍；每个 pot 的奇数筹码从 button 左侧第一个该 pot 赢家开始顺时针发。
- 最小加注：加注增量 ≥ 上一次加注增量；不足额 all-in 不重新开放行动。第一手庄位由 VRF 决定。
- 计时（用 ER 的 Clock::unix_timestamp）：承诺 10 秒；揭示盐在 VRF_0 到达后 10 秒；VRF 每次 10 秒、最多 3 次；行动 30 秒（能 check 就 check，否则 fold）；手间 2 秒。等 VRF 期间不设行动截止时间。连续 3 次超时在本手结束时自动站起。
- 手牌进行中站起或断线视为立即 fold；手牌结束后公开全部 VRF 输出、盐和事件流；HandProof 环形缓冲保留最近 16 手。
- Ante：每手翻前每人 0.1BB（0.02 / 0.1 / 0.2 USDC），先于盲注投入，是死钱，不计入当轮下注额，归本手赢家。
- Rake：只在发出了翻牌时收（含翻前 all-in 后自动发完）。先退回未跟注的下注，剩余底池（含 ante）为基数；rake = min(向下取整到 0.01(底池 × 2.5%), 3BB)；底池 ≤ 1BB 不收。先扣 rake 再分底池。平台收入只有 rake。
- 作废的手牌（缺盐、VRF 连续失败）：所有投入（含 ante）全额退回，不收 rake。短码先投 ante 再投盲注，不足则 all-in；stack 为 0 自动站起。
- 固定 9 个物理座位 `0..8`，每手 `hand_mask` 有 2–9 人；2 人采用标准 heads-up 特例，3–9 人采用标准 BTN/SB/BB 与行动顺序。第一手成功发牌时由 VRF 在 hand_mask 中选 button，以后顺时针轮转；所有位置和奇数筹码都用统一 `next_clockwise`。
- 常驻桌共 15 张，空桌不关：真人桌每档 3 张；AI 桌和混合桌每档各 1 张。真人桌每手全 Human；AI 桌全 Active agent；混合桌任意座位/比例，但开手时至少一名 Human 和一名 agent。同一钱包在同桌只能一席。

【账户与资金托管（D1–D3；USDC 永远不进 rollup）】
- L1，永不委托：ProgramConfig；DelegPayer；Table（max_seats=9）；vault_auth；TableVault；SeatLedger×9 ["seat", table, idx]；AgentProfile。
- ER，常驻委托 13 个账户：每桌 CommitPayer（公开、只付 commit intent 费用）；Game（公开；SeatState×9、occupied/hand/live/actionable/pending masks、action_seq）；HandProof（公开）；Deck（私有 members=[]）；PlayerHand×9（私有 members=[占用者]）。玩家入座、离座不委托账户。
- 六个只增计数器：deposited_total（L1：sit_down、top_up）、credited_total（ER：take_seat、apply_deposits）、owed_total（ER：stand_up、补码超额）、paid_total（L1：cash_out）、rake_total（ER：结算）、rake_swept_total（L1：sweep_rake）。
- 流程：入座 = L1 sit_down（钱包签名；转账进 TableVault，登记占用、session key、payout）→ ER take_seat 读 SeatLedger 克隆计入筹码。补码 = L1 top_up → ER apply_deposits 在手间计入差额。离桌 = ER stand_up（session key 可签）→ commit Game → L1 cash_out（permissionless）读 Game 快照，只付给 ATA(SeatLedger.payout, mint)。rake = L1 sweep_rake（permissionless）读快照，把 rake_total − rake_swept_total 划到 ATA(treasury, mint)。
- 守恒不变量（每条资金指令末尾断言，并有单测和 proptest）：I-ER Σcredited = Σstack + pot + rake_total + Σowed；I-L1 TableVault 余额 ≥ Σdeposited − Σpaid − rake_swept，且余额变化恰等于本指令的转账额；I-X（audit_table，任何人可调用）TableVault = Σ(deposited − credited快照) + Σstack快照 + (rake_total快照 − rake_swept) + Σ(owed快照 − paid) + 盈余（≥ 0）；I-M 计数器只增；I-B credited ≤ deposited、paid ≤ owed快照、rake_swept ≤ rake_total快照。
- mint 可配置：本地和 devnet 用 tUSDC；Circle devnet USDC 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU；主网 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v。用 token_interface；拒绝带转账手续费或 transfer hook 扩展的 mint。
- 主网前 program upgrade authority 交给多签或锁定升级。

【架构】
- Anchor（Rust）程序，L1 为 Solana devnet；对局在 MagicBlock Private Ephemeral Rollup（Intel TDX）上。
- delegate_table 把 CommitPayer、Game、HandProof、Deck、PlayerHand×9 共 13 个账户委托给同一个 TEE validator MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo（取自 ProgramConfig.tee_validator，显式传入，禁止 validator: None），commit_frequency_ms = u32::MAX。L1-only DelegPayer 只付委托租金/逃生；两种 payer 不合并。
- 权限：委托后在 ER 上用 CreateEphemeralPermissionCpi 创建。Deck is_private = true、members = []；PlayerHand is_private = true、members = [占用者]；Game、HandProof 公开。is_private = false 时 members 被忽略。私有权限生效后才能写入秘密。
- commit（D4/D8）：只 commit Game 和 HandProof，用一个 MagicIntentBundleBuilder 意图打包；外层任何 keeper/玩家可发，但 intent payer 固定为每桌已委托 CommitPayer PDA，由程序 invoke_signed，并必须传 validator-scoped canonical magic_fee_vault。plain path 前 10 次成功、第 11 次报 0xa0000000（本地和 devnet-tee 已实测），禁止回退。只在手与手之间（pot = 0）；每 N 手（默认 1）、有人站起、30 分钟心跳、维护前。Deck、PlayerHand 永不 regular commit。
- 换人（PlayerHand 按座位固定）：stand_up 在本手结算后清零该 PlayerHand，members=[] → take_seat 断言清零后改为 [新玩家] 并记录 slot → 该座位进入下一手 hand_mask 前等待权限生效。「旧玩家读不到新玩家底牌」必须有九席测试。
- 维护模式（仅 admin）：enter_maintenance → 手牌边界断言秘密已清零 → 13 个常驻账户 commit_and_undelegate → L1 升级或迁移 → 重新委托、重建 10 个私有权限。正常运营不关桌。
- 逃生通道：只针对 Game 和 HandProof。委托程序 v3.1.0 的 RequestUndelegation（被委托 PDA 签名，委托租金付款人 DelegPayer 签名）→ 至少 9000 slot 后 UndelegateWithRollbackAfterTimeout（包装层在调用前后保存并恢复账户数据）→ escape_settle 作废进行中的手牌、全部记入 owed；Deck、PlayerHand 换新 epoch。只有快照超过 escape_stale_s = 7200 秒未更新且有资金在桌时，任何人才能发起。代码预留，admin 在 scripts/probe_dlp.py 探测通过后才设置 ESCAPE_SUPPORTED。今天 devnet 和主网的委托程序都不支持；主网委托程序支持逃生通道是主网上线的硬性前提。
- 随机数：采用 V1 拆分。act/advance 只把 VrfSlot 置 Ready；permissionless request_vrf 再用 create_request_randomness_ix（scoped identity）+ invoke_signed_vrf 发 CPI，队列失败不回滚扑克动作。caller_seed = sha256("solpoker/vrf/v1" ‖ table ‖ hand_id_be ‖ target ‖ attempt)。回调 #[vrf_callback] 只存 randomness；身份不对报错，已过期/不匹配则 Ok 并忽略。10 秒重试，最多 3 次。devnet/mainnet 队列 5hBR…，本地 Sc9M…。
- 发牌协议（借鉴 CHIPCHIP CSRP v1，改为可证明公平）：
  1) 承诺：C_i = sha256("solpoker/salt/v1" ‖ table ‖ hand_id ‖ player ‖ salt_i)，salt_i 每手重新生成，32 字节，可以提前提交下一手的承诺。
  2) hand_mask 全员承诺齐后请求 VRF_0；到达后 10 秒内全员揭示盐。揭示只写本人的 PlayerHand；缺任一盐则整手作废，只给缺失者 strike。
  3) salt_digest 按 seat 升序聚合 `(seat, occupancy_id, occupant, salt)`；seed_k = sha256("solpoker/seed/v1" ‖ VRF_k ‖ salt_digest)。第一手 button 由 seed_0 在 hand_mask 中选，以后顺时针轮转。
  4) 事件流：Game 里维护 transcript = sha256(transcript ‖ 规范编码的事件)，事件包括阶段开始、强制投入、动作、公共牌发出、阶段跳过；底牌不进入事件流。
  5) 抽牌：HMAC-SHA256；拒绝采样；底牌从 button 左侧第一位开始顺时针发两轮，draw_no 为 0..2n-1，公共牌从 2n 开始。all-in 仅在待回应清零、live≥2、actionable≤1 时合并 runout；live=1 直接结算。
  6) 手牌结束后，HandProof 写 hand_mask、九席身份/occupancy、全部 VRF、参与者盐/底牌、规范事件、主池/边池与 deltas，然后清零秘密。
  7) 仓库必须包含 docs/dealing-protocol.{zh,en}.md、reference/solpoker_deal.py、vectors/v1/*.json；CI 校验链上 Rust 实现、Python 参考实现和测试向量三者逐字节一致。
- Session key（D2）：记在 SeatLedger.session_key 和 session_expires_at（不超过入座时刻 + 7 天），在 sit_down 时设置，或由占用者钱包调用 set_session；只有占用者本人能 revoke_session；座位释放时清空。只能签 commit_salt、reveal_salt、act、stand_up；所有 ER 动作都接受占用者钱包直接签名。session key 读不到底牌，读底牌要用钱包签名换的 TEE token。
- session key 预充 0.001 SOL（X10）：按用户的说法 ER 不接受余额为 0 的手续费付款人。真人和原生路径 agent 在 sit_down 交易里自己转，x402 agent 由网关另转；离桌或到期时把余额转回；金额可配置。实测今天 devnet-tee 和本地栈都接受零余额付款人（scripts/probe-er-feepayer.ts），主网上线前再测。
- act 带 hand_id 和 action_seq；每手开始前 advance 按 canonical 账户顺序扫描全席资格、owner 唯一性和 mixed 组成。多人下注用 pending_to_act_mask；不足额 all-in 不重新开放已行动者。结算先退未跟注差额，再按贡献层构造主池/边池；总 rake 算一次并从主池向边池依次扣。
- 费用（源码与实测）：intent 调度 flat fee 为 0，但 commit 不等于免费。解除委托时每账户收 0.0003 + 0.0001 × (commit 次数 − 1) SOL，封顶约 0.00228 SOL；fee-vault path 前 25 次无 live debit，第 26 次起每个被 commit 账户每次扣 0.0001 SOL（Game+HandProof 合计 0.0002）；L1 提交交易由 validator 付手续费；ER 普通交易费实测为 0；VRF ER 队列 normal/high-priority 当前收费 0。CommitPayer 余额必须监控和充值。

【Agent 与 AI 桌（Stage 8，定稿见 stage1-agents-x402.md）】
- AgentProfile：主人和 agent 双签注册；payout 默认为主人（X7），入座时固定到 SeatLedger.payout；状态 Active / Paused / Revoked / Banned，主人可以暂停、恢复、注销（X9）；主网上主人必须在 admin 创建的 OwnerAllowlist 里。
- 入座规则：真人桌全 Human；AI 桌全 Active agent；混合桌任意席位但开手须同时有人和 agent。同桌 agent owner 两两不同，任何 Human 都不能对自己的 agent；L1 入座和 ER 开手都扫描全席。
- x402 只做原子模式（D5）：付款交易本身就是 sit_down 或 top_up，payTo = vault_auth；自建 facilitator（@x402/svm 2.28.x）按 exact SVM 规范 Path 2 把本程序加入白名单并代付手续费。credit_x402_deposit 和标准模式延后。
- agent 用自己的密钥连 TEE、读自己的底牌。本地 MCP @solpoker/agent-mcp：后台执行器负责盐的提交与揭示、计时和兜底动作，LLM 只做决策；盐先落盘（0600）再提交承诺；本地限额和签名前资金流向校验；不提供转账、签任意交易、改限额等工具；必须运行在 LLM 访问不到的系统用户或容器里（X13）。

【前端】
- 中英双语，功能优先的极简风格；深色底，主色 #9945FF（Solana Purple），正向操作用 #14F195（Solana Green），fold 等危险操作用低饱和红色。
- 钱包层用 Privy（@privy-io/react-auth）：登录后得到内嵌 Solana 钱包，也可连接外部钱包；signMessage 的 challenge 必须用 crypto.getRandomValues 生成。L1 资金动作（sit_down、top_up 等）用 Privy 钱包签完整交易；对局动作用本地 session key（授权在 sit_down 交易里一次签完，对局中不弹钱包）。
- 对局流量走 TEE 端点（带 token）；入场前做 attestation 校验，challenge 用 crypto.getRandomValues 生成。直接 sendRawTransaction 加轮询确认，不用 Anchor .rpc() 的默认确认。
- 「信任页」逐项链接到证据；真人首次入混合桌前必须确认本桌含第三方 AI agent，并展示所有玩家的 AI 标记。

【版本钉死 — 不要装别的版本】
- Anchor CLI 1.0.2；Cargo 中写 anchor-lang = "=1.0.2"。Solana CLI (Agave) 3.1.10。Rust 1.89（依赖的 MSRV 报错时改用 1.93.1 并记录）。Node 24。
- ephemeral-rollups-sdk = { version = "=0.17.3", features = ["anchor", "access-control", "vrf"] }；VRF 通过 ephemeral_rollups_sdk::vrf 使用。
- TS：@magicblock-labs/ephemeral-rollups-sdk@0.17.3、@anchor-lang/core@1.0.x、@solana/web3.js@1.98.x；package.json 声明 "type": "module"（E6）。
- 本地测试：@magicblock-labs/ephemeral-validator@0.14.10（scripts/mb-stack.sh 启动，需要 nofile 1,000,000；--reset 必须同时清空 ER 存储；脚本覆盖包内 Sc9M 的 53 条陈旧请求为 clean queue）。VRF oracle 由 scripts/vrf-oracle.sh 管理。devnet ER 0.16.0，以 devnet 为准。
- Anchor 1.0：先启动本地栈，再 anchor test --skip-local-validator；不要写 [registry]；每个程序只能有一个 #[error_code]；同一可变账户重复传入需加 dup 约束；CI 里用 anchor build --ignore-keys。
- 官方示例停留在 SDK 0.16.2，只借鉴思路，API 以 0.17.3 源码为准。提交一律用 MagicIntentBundleBuilder。

【关键地址】
- Delegation Program DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh；Permission Program ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1；VRF program Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz。
- VRF 回调身份：scoped_vrf_identity(&crate::ID)。9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw 已废弃，不要用。
- VRF 队列：devnet 主链 Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh；ER 队列（devnet 与主网）5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc；本地主链 GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb；本地 ER Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT。
- Validator：TEE（devnet-tee 与 mainnet-tee）MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo；本地 mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev。
- 端点：https://devnet-tee.magicblock.app（getAuthToken 后以 ?token= 连接；主网 mainnet-tee.magicblock.app）；https://devnet-router.magicblock.app（只用于 L1 操作和路由，脚本里要设 UA）；https://api.devnet.solana.com。
- x402 网络标识：devnet solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1，主网 solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp。
- 本地端口：base 8899/8900，ER 7799/7800，QFS 6699/6700（QFS 也要 token）。

【权威文档 — 动手前先读】
- ER 总览 https://docs.magicblock.gg/pages/get-started/introduction/ephemeral-rollup ；PER quickstart https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart ；PER access control https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/access-control ；TEE 介绍 https://docs.magicblock.gg/pages/tools/tee/introduction ；VRF quickstart https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/how-to-guide/quickstart
- SDK 源码 https://github.com/magicblock-labs/ephemeral-rollups-sdk/tree/v0.17.3 ；委托程序源码 https://github.com/magicblock-labs/delegation-program ；官方示例 https://github.com/magicblock-labs/magicblock-engine-examples
- x402 exact SVM 规范 https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md
- 同类项目：https://pokerable.fun/trust ；https://github.com/chipchiptw/CHIPCHIPGAME（CC BY 4.0 / MIT）
- Anchor 1.0 发布说明 https://www.anchor-lang.com/docs/updates/release-notes/1-0-0

【纪律】
- 动手写代码前，先用 5–10 行复述本阶段的任务和验收标准，等我确认。
- 不确定的 API，先查 v0.17.3 源码或本地依赖，不要凭记忆编函数签名；外部行为先实测，结论和证据写进仓库的 notes 文档。
- 任何种子、盐、randomness、牌面都不得出现在 msg! 日志、事件或错误信息中。
- 私有账户委托时必须显式指定 TEE validator；含秘密的账户不得 commit，undelegate 前必须清零。
- 读不到数据必须是 PER 权限层强制的结果，不能靠「服务端不返回」来隐藏。
- 资金相关的指令（入座、补码、离桌、cash_out、rake 划转、逃生结算）必须有守恒断言和对应的单测、proptest。
- 每个 Stage 结束都输出 CHANGELOG：做了什么、验收命令及结果、devnet 交易签名、遗留问题。
```
