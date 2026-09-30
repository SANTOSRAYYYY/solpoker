# solpoker 第二轮：已确认决策、设计影响与剩余问题

> 更新时间：2026-09-30。本文件是在 [pre-dev-review.md](./pre-dev-review.md) 基础上的增量：记录你对 A1–A11 的答复，分析 [pokerable.fun/trust](https://pokerable.fun/trust#flip) 和 [chipchiptw/CHIPCHIPGAME](https://github.com/chipchiptw/CHIPCHIPGAME)（CSRP v1 发牌协议）可以借鉴的地方，并列出由此带来的新问题。

---

## 1. 已确认的产品规则

| # | 决定 | 对实现的影响 |
|---|---|---|
| A1 | 平时开现金桌，有活动时开 SNG | 引擎按「现金桌」和「锦标赛」两种模式设计，共用同一套规则引擎和发牌协议。SNG 放在现金桌稳定之后（见 §6 路线图） |
| A2 | 入座时把 USDC 转入 Seat，离桌时划回；**采用每桌独立托管**（2026-09-30 修订） | **真实 token 托管从原 Stage 8 提前到核心阶段**，设计见 §2 |
| A3 | 三档桌：0.1/0.2、0.5/1、1/2（USDC）；买入 100–1000BB；允许手间补码 | 见 §2.3 的档位表 |
| A4 | 标准 NLHE 最小加注规则 | 按默认实现 |
| A5 | 奇数筹码给非庄位（BB） | 最小单位定为 0.01 USDC（见 §2.3） |
| A6 | 第一手庄位由 VRF 决定 | 按默认实现 |
| A7 | 30 秒超时；能 check 就 check，否则 fold；连续 3 次超时自动站起 | 按默认实现 |
| A8 | v1 公开完整牌序和种子 | 按默认实现。若采用 §4 的逐街抽牌，「完整牌序」变成「全部种子 + 事件流」，同样可以完全复算 |
| A9 | 牌局中离桌或断线视为 fold，手牌结束后站起，筹码离桌 | 采用每桌独立托管后没有全局账户，**筹码直接回到玩家钱包**（见 §2.1） |
| A10 | 链上环形缓冲保留最近 16 手 | 按默认实现 |
| A11 | 中英双语，功能优先的极简风格，**Solana 紫色调** | 深色底；主色 `#9945FF`（Solana Purple），正向操作用强调色 `#14F195`（Solana Green），可用两者的渐变做品牌元素；fold 等危险操作用低饱和红色 |

B 组技术选型（Anchor 1.0.2、Solana 3.1.10、`@anchor-lang/core`、自建 Session PDA 等）你没有提出异议，**按默认值执行**，想改随时告诉我。

---

## 2. USDC 托管设计（新增，参考 pokerable）

### 2.1 每桌独立托管（2026-09-30 修订：采纳你的方案，取代原来的全局 Vault + PlayerBalance）

**Solana 上的实现方式**：不给每张桌单独部署一个程序。Solana 的程序只是代码，状态存在账户里。每张桌部署一个程序要花 2–4 SOL 租金，升级和审计也要做 N 份，没有必要。正确的做法是：同一个 solpoker 程序为每张桌派生一个**托管 PDA**，由它持有这张桌的 USDC token account。效果相当于 EVM 上用工厂合约为每张桌部署一个 escrow 合约：钱按桌隔离，任何人都能在浏览器里查到每张桌的余额。

| 账户 | 所在位置 | 是否委托 | 作用 |
|---|---|---|---|
| `TableVault`：**必须是 `ATA(vault_auth, mint)`**，其中 `vault_auth` = PDA `["vault_auth", table]` | L1 | **永不委托** | 这张桌的全部 USDC。authority PDA 单独派生、与 Game 分开，所以 Game 委托期间，L1 上的程序仍能以 authority 身份签名。用标准 ATA 的原因是：x402 和普通钱包转账都按「收款地址的 ATA」付款，这样 agent 的 x402 付款能直接进入 TableVault（§9.4） |
| `Seat`：记录 `owner`、`stack`、`total_deposited`、`total_paid_out`、`pending_topup` | 会话期间在 TEE ER | 是 | 桌上筹码的账本。ER 里移动的只是这个数字，USDC 本身不进 rollup |
| `TopUpReceipt`：每座一个，记录单调递增的 `total_topped_up` | L1 | 否 | 补码时 L1 已经收到钱的凭证，用于跨层同步（见 §2.2） |

对应的资金流：

- **入座**：一笔 L1 交易完成「钱包 → TableVault」转账和「创建或重置 Seat」，然后委托 Seat。**需要钱包签名。**
- **补码**：一笔 L1 交易完成「钱包 → TableVault」转账和 `TopUpReceipt.total_topped_up += x`，然后 ER 在手与手之间把差额计入 Seat.stack。**需要钱包签名。**
- **离桌**：
  1. 在 ER 里站起（session key 即可签），同时对这个 Seat 执行 commit_and_undelegate。Game 保持委托，牌桌继续。
  2. Seat 回到 L1 后执行 `cash_out`：TableVault → 该座位 owner 的 USDC ATA。
  3. `cash_out` 是 **permissionless** 的，收款地址在程序里钉死为 `seat.owner` 的 ATA，所以任何人都可以代为触发（前端、对手、keeper 都行）。断线玩家的钱会被自动送回，不需要本人再签一次（这与 pokerable 的「delivery 地址钉死、陌生人代付手续费也安全」一致）。
  4. 从站起到钱包到账约需几秒，因为要等 undelegate 在 L1 上完成。
- **Rake**：记在 Game 里的 `rake_accrued`；会话结束、Game 回到 L1 后，由 permissionless 的 `sweep_rake` 从 TableVault 划到 treasury。
- **SNG**：同样的模式，每场锦标赛一个 `TourneyVault`，报名时打入，结束时付给赢家。

**每桌守恒不变量**（写成 property test，并在每条资金指令末尾断言）：

> TableVault 余额 = Σ Seat.stack + 当前底池 + Σ 尚未计入的补码 + rake_accrued − 已划走的 rake

每手结算并 commit 后，底池为 0，这时 L1 上的状态总是「全额有担保」。即便将来用逃生通道回滚到最后一次 commit，账也是平的：正在打的那一手作废，各人按上一手结束时的 stack 从 TableVault 取回。

**与原方案（全局 Vault + PlayerBalance）的比较：**

| 维度 | 每桌独立托管（采用） | 全局 Vault（弃用） |
|---|---|---|
| 故障隔离 | 一张桌出 bug 或 ER 卡住，只影响这张桌的钱 | 所有桌的钱在同一个池子里，一处出问题会波及全部 |
| 可审计性 | 每张桌的余额在浏览器里就能对账 | 只能对全局总额，无法按桌对账 |
| 离桌到账 | 直接回到钱包，一步完成 | 先回 PlayerBalance，再单独提现 |
| 断线处理 | permissionless 的 cash_out 自动退回钱包 | 钱留在 PlayerBalance，要本人回来提 |
| 连续换桌 | 每次换桌都要用钱包签一次入座 | 钱留在 PlayerBalance，换桌可以少一次 token 转账，但仍需钱包签名授权（session key 不碰资金） |
| 多桌同时玩 | 每张桌分别入座 | 相同 |
| 成本 | 每张桌一个 token account，租金约 0.002 SOL，关桌可回收 | 更少 |
| 信任边界 | 程序 upgrade authority 理论上能动所有 TableVault | 相同。主网前应把 upgrade authority 交给多签，或锁定升级 |

### 2.2 手间补码的跨层同步（需要 spike）

TableVault 在 L1 上且从不委托，所以补码的钱随时可以打进来；难点是把这笔钱计入**委托中的** Seat.stack：

- **方案 X（首选，需验证）**：ER 内的 `apply_topup` 指令读取 L1 上 `TopUpReceipt` 的只读克隆，把 `total_topped_up − 已计入值` 的差额加到 stack 上。这个做法依赖 ER 克隆 L1 账户**足够及时**，并入 Stage 3 的 spike 验证。
- **方案 Y（兜底）**：Seat undelegate → 在 L1 上补码 → 重新委托，只允许在手与手之间进行，需要几秒。
- 无论选哪种，都要在 Seat 里记录「已计入」的累计值，防止同一笔补码被计两次；补码后的 stack 不能超过 1000BB，超出部分直接退回钱包。

### 2.3 档位与单位

| 档位 | SB / BB（USDC） | 最小买入（100BB） | 最大买入（1000BB） |
|---|---|---|---|
| Micro | 0.1 / 0.2 | 20 | 200 |
| Low | 0.5 / 1 | 100 | 1,000 |
| Mid | 1 / 2 | 200 | 2,000 |

- 链上一律用 u64 的 USDC 基础单位（1 USDC = 1,000,000）。
- 所有下注额和 rake 都取 **0.01 USDC 的整数倍**（即 10,000 基础单位）。A5 说的奇数筹码就是 0.01 USDC。
- 档位写在 `TableConfig` PDA 里，由管理员创建，不写死在代码里。
- 补码后的总 stack 不能超过 1000BB。

### 2.4 USDC mint（已核实）

devnet 上的 Circle 官方测试 USDC 是 `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`：经典 SPL Token 程序，6 位精度，有 freeze authority。这个币要从 Circle 水龙头手动领取，数量有限，用 1/2 档（最小买入 200 USDC）做双人测试会很吃力。

**默认做法**：

- mint 地址写进配置，不写死；
- 本地测试和 devnet 联调用我们自铸的 6 位精度测试币 `tUSDC`（数量不限）；
- devnet 另开一张 Circle USDC 的 Micro 桌，验证真实 USDC 的兼容性；
- 程序用 `token_interface`，将来可兼容 Token-2022 的稳定币。

### 2.5 卡死风险：devnet 上可能没有逃生通道

这是本轮最重要的发现。

**背景**：Seat 委托进 TEE 之后，如果 TEE validator 长期不响应，Seat 就一直被委托程序锁住，里面记着的 USDC 无法离桌。

**官方的解法**：委托程序 v3.1.0（2026-07-08 发布）新增了两条指令：

1. `RequestUndelegation`：由我们的程序通过 CPI 调用，Seat PDA 签名。
2. 等待至少 9,000 个 slot（约 60 分钟）后，调用 `UndelegateWithRollbackAfterTimeout`，把账户**回滚到主链上最后一次提交的状态**，交还给我们的程序。

因为我们每手结算都会 commit，回滚最多只损失正在进行的那一手，相当于这手作废。

**问题在于**：

- devnet 上委托程序的 programData 最后一次部署在 **2026-04-27**（slot 458,511,904，已用 `getBlockTime` 核实）。这个时间在 v2.0.0（04-19）之后、v3.0.0（05-11）之前，**所以 devnet 上大概率没有这两条指令**。
- SDK 0.17.3 依赖的是 `magicblock-delegation-program-api 3.1.0`，比 devnet 上的程序新。Stage 0 必须实测 delegate / commit / undelegate 在 devnet 上都能通过。
- SDK 0.17.3 没有封装这两条指令，需要用 api crate 的 instruction builder 自己写 CPI 包装。按源码注释，包装层必须在调用前后保存并恢复账户数据。
- 我在 §2.2 用到的 commit 费用常量同样来自 api 3.1.0，devnet 上的实际收费可能不同。

**默认处理**：

- devnet 阶段接受这个风险（反正是测试币）。
- 代码里预留逃生指令：devnet 上的程序支持时就启用，不支持时先编译进去但关闭。
- **上主网前必须具备逃生通道**，这是硬性门槛。
- 需要向 MagicBlock 确认 devnet 和主网各自部署的委托程序版本（见 §5 Q8）。

### 2.6 常驻桌：永不关桌（2026-09-30 确认 Q7、Q9，取代原来的会话生命周期方案）

- **数量**：每个档位 3 张，一共 9 张（Micro、Low、Mid 各 3 张）。部署后由脚本一次性创建并委托，**空桌也不关**。
- **哪些账户长期委托**：Game、Deck、PlayerHand ×2、RakeAccount 一直留在 TEE。Seat 跟随玩家：入座时委托，离桌时解除委托，因为离桌必须回到 L1 才能 cash_out。
- **换人时的底牌权限**：PlayerHand 按座位固定，不随玩家重建。新玩家入座后，ER 内按以下顺序执行，任一步不满足就不开下一手：
  1. 确认 PlayerHand 已清零；
  2. 用 `UpdateEphemeralPermissionCpi` 把 members 从旧玩家改为新玩家（SDK 0.17.3 已提供）；
  3. 等新权限生效。
  
  必须先移除旧玩家，确保旧玩家读不到新玩家的底牌，并写成测试。
- **Rake 划转**：Game 永远不回 L1，所以 rake 改走一个类似「庄家座位」的流程：
  1. ER 内的 `move_rake` 把 Game.rake_accrued 转入 RakeAccount；
  2. 对 RakeAccount 执行 commit_and_undelegate；
  3. L1 上 permissionless 的 `sweep_rake` 把钱从 TableVault 划到 treasury（地址在程序里钉死）；
  4. 重新委托 RakeAccount。
  
  默认每天一次，由 keeper 或管理员触发。
- **维护模式**（仅管理员可用，专为升级程序设置）：在手牌边界把牌桌置为维护状态 → 清零秘密账户 → 解除全部账户的委托 → 升级程序 → 重新委托。正常运营期间不会关桌。账户结构（layout）变化只能在维护模式下迁移。
- **成本**（按上限估算）：每张桌的账户租金约 0.064 SOL，其中 HandProof 的 16 手环形缓冲占一半以上；委托相关 PDA 约 0.025 SOL；9 张桌合计约 0.8 SOL。每手提交 Game、2 个 Seat 和 HandProof 约 0.0004 SOL（每千手约 0.4 SOL），由运营方的 payer 支付。空桌不提交，不产生费用。

---

## 3. 从 pokerable 借鉴的内容

pokerable 公开了它的做法，但**没有公开源码**。它的架构和我们的计划几乎一致：MagicBlock TEE，seed = VRF ⊕ 每位玩家的盐，每张底牌一个只对本座位可读的账户，手牌结束时清空牌堆，session key 有效期一周，入场前做 attestation 校验。这说明我们的路线是走得通的。

| pokerable 的做法 | solpoker 的处理 |
|---|---|
| 手牌结束时先清空牌堆，再做任何公开提交 | 已在 P0-3 勘误中写入，一致 |
| 一个诚实玩家就足以保证种子不被操纵（VRF ⊕ 所有人的盐） | 一致。你的缺盐规则更严格：缺盐则整手作废 |
| session key 只能打牌，不能充值或提现；有效期一周，只存在本地浏览器，可随时撤销 | 一致。自建的 Session PDA 只授权对局指令 |
| 登录 validator 前先检查 TDX quote；主网还要求批准的 workload measurement | 说明度量值拿得到。C5 仍需向 MagicBlock 索取 |
| MagicBlock validator 只保留执行轨迹（commit、克隆、限流），不存账户数据和程序日志，保留一周 | 作为信任模型的一部分写进 Stage 1 设计文档；同时坚持「日志里不打印任何秘密」的纪律 |
| 断线自动 fold；validator 重启后手牌能接着打 | **新增验收项**：本地栈在牌局中途杀掉并重启 ephemeral-validator，手牌能从断点继续 |
| 规则引擎做 property test，保证确定性 | 已计划。Stage 5 增加 proptest（筹码守恒、状态机不变量） |
| 「What you can check」清单 | Stage 7 的前端做一个同样的「信任页」，每一项链接到可验证的证据 |
| **Rake**：翻牌后的底池收 2.5%，上限 3BB；不见翻牌不收（no flop no drop）；≤1BB 的底池不收；向下取整 | 采纳，另加每人 0.1BB 的 ante，见 §8.1 |
| **Flip 玩法** + `$POKER` bonding curve | v1 不做（Q3） |

---

## 4. 从 CHIPCHIP CSRP v1 借鉴的内容

CSRP 的核心主张是：**不预先洗好整副牌，每张牌在需要时才抽**，每次抽牌都用 HMAC-SHA256 绑定一份公开的事件流摘要（到那一刻为止的所有动作）和一个秘密随机数，再用拒绝采样映射到剩余牌堆。它的规范 §11.5 自己承认**不是「可证明公平」**，因为秘密随机数来自服务器、不公开。

它的许可证是文档 CC BY 4.0、代码 MIT，可以在注明出处的前提下借鉴。

### 4.1 值得采用的

| 内容 | 做法 |
|---|---|
| 规范 + 参考实现 + 测试向量 + CI 四件套 | 仓库里放 `docs/dealing-protocol.{zh,en}.md`、`reference/solpoker_deal.py`、`vectors/v1/*.json`；CI 同时检查链上 Rust 实现和 Python 参考实现的结果与测试向量逐字节一致 |
| 事件流摘要 | 在 Game 里维护一条链式哈希：`transcript = sha256(transcript ‖ 规范编码的事件)`。事件包括阶段开始、盲注、每个动作、公共牌发出、阶段跳过。底牌不进入公开事件流 |
| HMAC 抽牌加拒绝采样，带版本标签 | `HMAC-SHA256(key = 本街种子, msg = "solpoker-v1" ‖ table ‖ hand_id ‖ draw_no ‖ retry ‖ transcript_digest)`，取前 8 字节，小于 `2^64 mod n` 就重抽 |
| 牌堆定义为有序列表，抽出一张就删掉一张 | 采用。底牌的抽取顺序固定为「从 SB 开始，每人一张，共两轮」 |

### 4.2 不采用的

- **服务器 CSPRNG 作为秘密**：不可验证，我们用 VRF 加玩家盐代替，而且手牌结束后公开。
- **ElapsedMs（行动耗时）**：ER 里没有可靠的毫秒时钟，这个字段也不增加熵。

### 4.3 关键取舍：要不要逐街抽牌

「未来的牌不存在」这个性质，只有**每条街都用新的随机数**才真正成立。如果整手牌只有一个种子，TEE 内存里就已经隐含了未来的牌面：一旦 TEE 在牌局中途被攻破，攻击者可以对每种可能的行动序列算出后面的公共牌。

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **S（单种子）** | 每手请求一次 VRF。本手种子 = H(VRF ‖ 盐A ‖ 盐B)，每张牌按 §4.1 用事件流摘要派生 | 延迟最低，和 pokerable 相同 | TEE 在牌局中途被攻破时，未来的公共牌可以推算 |
| **P（逐街 VRF）** | 翻前、翻牌、转牌、河牌各请求一次 VRF。第 k 街种子 = H(VRF_k ‖ 盐A ‖ 盐B)，盐每手只提交一次 | 未来的牌在那条街开始前根本不存在；TEE 被攻破也只泄露已经发出的牌 | 每手多 3 次 VRF 往返；all-in 时要连续等 3 次；超时状态也更多 |

**已定（2026-09-30）：采用方案 P，每条街都请求一次 VRF。** Stage 2 仍然要测延迟，但测量结果只用来设置超时和优化 UX，不再用来选方案。细节见 §8.2。

---

## 5. 本轮新增的待确认问题

每条都附了推荐默认值，可以只回「全部按默认」。

| # | 问题 | 推荐默认 |
|---|---|---|
| Q1 | **Rake 规则** | **已定**：每人翻前 0.1BB ante，进底池归赢家（Q1a 选 a）；见翻牌的底池收 2.5%，上限 3BB；不见翻牌不收；≤1BB 不收；向下取整到 0.01 USDC |
| Q2 | **SNG 规格** | **已定：v1 不做**，以后再做。托管模式预留 TourneyVault |
| Q3 | **Flip 玩法和 `$POKER` 代币** | **已定：v1 不做** |
| Q4 | 抽牌方案 S 还是 P（见 §4.3） | **已定：P，每条街请求一次 VRF**（§8.2） |
| Q5 | 资金托管形态 | **已定（2026-09-30）**：每桌独立托管，TableVault PDA 负责入座、补码和离桌（钱直接回到钱包），见 §2.1 |
| Q9 | 牌桌怎么产生 | **已定**：每档 3 张常驻桌，共 9 张，空桌也不关（§2.6） |
| Q10 | 同一钱包能否同时坐多张桌 | **已定（按默认）**：可以，但同一张桌只能占一个座位 |
| Q6 | devnet 用什么币 | 你未提及，**按默认执行**：9 张常驻桌用自铸的 `tUSDC`；另开一张非常驻的 Circle devnet USDC Micro 桌，只做兼容性验证 |
| Q7 | 会话生命周期 | **已定：不关桌**。改为长期委托，另设管理员维护模式（§2.6） |
| Q8 | devnet 上没有逃生通道 | 你未提及，**按默认执行**：devnet 接受这个风险；代码预留逃生指令；主网上线前必须具备。给 MagicBlock 的问题清单见 §8.4 |

### 第一轮里还需要你提供的（没有默认值）

| # | 事项 | 当前状态 |
|---|---|---|
| C1 | devnet SOL，建议 15–20 个 | 未提供。沙盒领不到水 |
| C2 | 部署者和程序 keypair 存在哪里 | 未决定。候选是 Manus 项目文件或你本地保存 |
| C3 | 代码是否推送到 GitHub | GitHub connector 目前未启用 |
| C5 | TEE 度量值 | pokerable 能拿到，说明可行。需要向 MagicBlock 索取，可以和 Q8 的问题一起问 |
| C6 | 两个支持 `signMessage` 的 devnet 测试钱包 | Stage 7 才需要 |
| C7 | 是否计划上主网 | **现在接入了真实 USDC，这一项更重要了**。devnet 用测试币没有问题；上主网等于经营真钱扑克，需要单独评估牌照和地域限制 |
| C8 | 是否把上下文块保存为项目指令 | 未决定 |

C4（pokerable 的来源）已解决：它没有公开源码，以它的公开说明作为参考。

---

## 6. 调整后的阶段路线图

| Stage | 内容 | 相比原手册的变化 |
|---|---|---|
| S0 | 工具链 + 本地栈 + devnet-tee 冒烟测试 | 新增：确认 devnet 委托程序版本，验证 SDK 0.17.3 与它兼容 |
| S1 | 设计文档 | 纳入 §2 的托管模型、§4 的发牌协议规范、§2.6 的常驻桌与维护模式、§8.1 的 ante 与 rake 规格 |
| S2 | TEE 内 VRF | 新增：测量逐街 VRF 的 p50 和 p95 延迟，确定超时参数；实现 VRF 超时重试和作废流程 |
| S3 | 隐私 spike | 新增三项：ER 克隆 L1 账户的及时性（决定 §2.2 选方案 X 还是 Y）；validator 重启后能否恢复；换人时用 UpdateEphemeralPermission 替换成员后，旧玩家确实读不到新底牌 |
| S4 | 发牌协议 | 按 CSRP 风格交付「规范 + Python 参考实现 + 测试向量 + CI」 |
| S5 | 规则引擎 | 增加 proptest |
| S6 | **USDC 托管与结算** | 原 Stage 8 的 token 部分提前到这里：每桌 TableVault、入座/补码/离桌（permissionless 的 cash_out）、每手 commit、ante 与 rake、经 RakeAccount 划转 rake、维护模式、9 张常驻桌的初始化脚本、逃生指令预留 |
| S7 | 前端 | Solana 紫色调、中英双语、信任页、attestation 门控 |
| S8 | **Agent 接入与 AI 桌**（新增，§9） | AgentProfile 注册、Seat 身份标记、x402 入座网关（自建 facilitator）、agent SDK 和本地 MCP、示例 bot、AI 桌和混合桌 |
| 以后 | SNG、Flip | v1 不做（Q2、Q3）。托管和引擎已经为 SNG 预留了扩展点 |
| — | 主网准备 | 逃生通道、度量值比对、法律评估、审计 |

---

## 7. 本轮证据

- pokerable：[/trust](https://pokerable.fun/trust#flip) 和首页，2026-09-30 抓取。
- CHIPCHIP：仓库 commit `9e93c93`（2026-09-15），阅读了 `docs/zh-CN/dealing-protocol.md` 和 `reference/csrp_v1.py`。
- 委托程序：[magicblock-labs/delegation-program](https://github.com/magicblock-labs/delegation-program) 源码中的 `src/processor/fast/undelegate_with_rollback_after_timeout.rs` 注释；`magicblock-delegation-program-api 3.1.0` 中的 `DEFAULT_UNDELEGATION_REQUEST_TIMEOUT_SLOTS = 9000`；GitHub Releases：v3.1.0 为 2026-07-08，v3.0.0 为 05-11，v2.0.0 为 04-19。
- devnet 实测：DLP programData 最后部署在 slot 458,511,904，`getBlockTime` 返回 2026-04-27T20:38:44Z；Circle devnet USDC mint 由 Token 程序拥有，精度 6，有 freeze authority。
- 在 SDK 0.17.3 源码中 grep `request_undelegation` 和 `rollback_after_timeout`，没有结果，说明没有封装。

---

## 8. 第三轮答复（2026-09-30）

### 8.1 Ante 与 Rake 规格（Q1）

**Ante**：每手翻前，每人投入 0.1BB，先于盲注投入。

| 档位 | Ante（每人） | SB | BB | 翻前底池起点 |
|---|---|---|---|---|
| 0.1 / 0.2 | 0.02 | 0.1 | 0.2 | 0.34 |
| 0.5 / 1 | 0.1 | 0.5 | 1 | 1.7 |
| 1 / 2 | 0.2 | 1 | 2 | 3.4 |

三档的 ante 都是 0.01 USDC 的整数倍，符合 §2.3 的最小单位。ante 是死钱，不计入这一轮的下注额；BB 的当前注额仍然是 1BB，SB 补 0.5BB 就算跟注。

**Rake 计算规则**：

1. **触发条件**：本手发出了翻牌，包括翻前 all-in 后自动发完公共牌的情况。不见翻牌不收。
2. **计算基数**：先退回未被跟注的下注，剩下的最终底池（含 ante）就是基数。
3. **公式**：rake = min(向下取整到 0.01 USDC(底池 × 2.5%), 3BB)。底池 ≤ 1BB 时 rake = 0。有 ante 以后，见翻牌的底池至少是 2.2BB（limp 后 check），所以「≤1BB 不收」只在极端短码 all-in 时才会用到。
4. **顺序**：退回未跟注的下注 → 计算 rake → 余额发给赢家；平分时奇数的 0.01 给 BB（A5）。
5. **作废的手牌**（缺盐、VRF 连续失败）：所有投入全额退回，包括 ante，不收 rake。
6. **短码**：先投 ante，再投盲注；不够就剩多少投多少，按 all-in 处理。stack 为 0 时自动站起。

**示例**（0.5/1 桌）：

1. 两人各投 ante 0.1，SB 0.5，BB 1，底池 1.7。
2. SB 加注到 3，BB 跟注，底池 6.2。
3. 翻牌，BB 下注 4，SB 弃牌。BB 的 4 未被跟注，退回。
4. rake = 6.2 × 2.5% = 0.155，向下取整为 0.15。
5. BB 拿到 6.05，本手净赢 2.95。

**Q1a：ante 归谁？已定（2026-09-30）：选 (a)，ante 进底池。** 以下是当时列出的两个选项：

- **(a) 进底池（推荐）**：ante 是死钱，归本手赢家。平台只收翻牌后的 2.5%。这是常见的 BB-ante 或 ante 结构，作用是扩大底池、鼓励行动。
- **(b) 平台服务费**：ante 每手直接归平台，见不见翻牌都收，另外再收翻牌后的 2.5%。单这一项，平台每手就收 0.2BB，每 100 手是 20BB，玩家长期很难盈利。

结论：ante 是死钱，进底池，归本手赢家。平台收入只有翻牌后的 2.5% rake。作废的手牌连 ante 一起全额退回。

### 8.2 逐街 VRF 的完整流程（Q4 已定）

每手最多 4 次 VRF：翻前（发底牌，第一手还要决定庄位）、翻牌、转牌、河牌。

1. **手牌开始**：双方提交盐的承诺 → 请求 VRF_0 → 回调后双方把盐私密发进 TEE → 用 seed_0 发 4 张底牌（第一手先用 seed_0 的另一段决定庄位）。
2. **后续每条街**：本街下注结束 → 请求 VRF_k → 回调后用 seed_k 抽公共牌 → 事件流追加「公共牌发出」。
3. **等待 VRF 期间**：暂停行动计时器，前端显示「发牌中」。
4. **VRF 超时（Q12，默认值）**：10 秒内没有回调，就对同一条街重新请求一个新的 VRF；最多重试 3 次，仍失败就作废本手，全额退款。Stage 2 实测延迟后再调整这个参数。
5. **盐只提交一次**：盐每手提交一次，每条街都复用。因为每条街的 VRF 都是新的，已经发出的牌推不出后面的牌。

**Q11：all-in 后剩下的街要不要合并成一次 VRF？已定（2026-09-30）：合并。**

**触发条件**：本街的下注已经结清，并且最多只剩一名玩家还有筹码可以行动。heads-up 下就是「有一方 all-in，而且下注已被跟注或补齐」。这个判断在规则引擎里只写一处，并用 proptest 覆盖。

**做法**：

1. 事件流里追加一个 `RunoutStarted` 事件。
2. 请求一次 VRF_r，令 seed_r = sha256(VRF_r ‖ saltA ‖ saltB)。
3. 按原来的顺序，把剩余的公共牌逐张抽出。抽牌公式仍是 HMAC(seed_r, … draw_no … transcript_digest)：draw_no 接着前面编号；每抽一张，就把「公共牌发出」事件写进事件流，因此下一张牌仍然绑定到最新的事件流。
4. HandProof 记录每张公共牌是用哪一个 VRF 抽出的，第三方可以据此完整复算。
5. 前端按固定节奏逐街翻出，观感和逐街发牌一样。

**安全性说明**：合并以后，剩余几张公共牌会在同一时刻存在于 TEE 里。但这时双方已经没有任何决策，提前知道这些牌也无法用来获利，所以并没有削弱「未来的牌不存在」这个性质的实际意义。

### 8.3 本轮其他结论

| 项 | 结论 |
|---|---|
| SNG、Flip | v1 都不做，路线图里标为「以后」 |
| 常驻桌 | 每档 3 张，共 9 张，永不关桌；长期委托，换人时替换底牌权限，rake 经 RakeAccount 划转，另设维护模式（§2.6） |
| 多桌 | 可以同时坐多张桌，但同一张桌只能占一个座位 |
| Q6、Q8 | 你未提及，按默认执行（§5） |

### 8.4 还没搞清楚的

**需要你回答：**

| # | 事项 | 阻塞哪一步 |
|---|---|---|
| ~~Q1a~~ | 已定：(a) ante 进底池 | — |
| ~~Q11~~ | 已定：all-in 后合并为一次 VRF | — |
| Q12 | VRF 超时参数：10 秒 × 3 次重试，然后作废 | Stage 2 会用实测数据校准；默认值可以先用 |
| C1 | devnet SOL：程序部署约需数 SOL，9 张桌约 0.8 SOL，加上每千手约 0.4 SOL 的提交费，**建议准备 15–20 SOL** | Stage 0 的 devnet 部分 |
| C2 | 部署者和程序 keypair 存在哪里 | Stage 0 |
| C3 | 代码是否推送到 GitHub（需要启用 GitHub connector） | Stage 0 起 |
| C7 | 是否计划上主网（接入真钱后涉及牌照和地域限制） | 不阻塞 devnet 开发；影响主网准备 |
| C8 | 是否把上下文块 v3 保存为项目指令 | 不阻塞 |

**需要问 MagicBlock 的**（可以直接转发这份清单）：

1. devnet 和主网目前部署的委托程序版本是什么？v3.1.0 的 `RequestUndelegation` / `UndelegateWithRollbackAfterTimeout` 什么时候上 devnet？
2. SDK 0.17.3（依赖 `magicblock-delegation-program-api` 3.1.0）和 devnet 上现有的委托程序兼容吗？
3. devnet-tee 和主网 TEE validator 的 workload measurement（MRTD/RTMR）是多少？应该怎么校验？
4. 账户长期委托在 TEE validator 上（数周甚至数月）有没有限制？validator 升级或重启时，委托账户的状态会保留吗？
5. 在 TEE ER 里请求 VRF：典型延迟是多少？有没有频率限制？每次收费多少？
6. ER 读取未委托的 L1 账户（克隆）时，数据新鲜度有什么保证？L1 更新后，多久能在 ER 里读到？
7. devnet 和主网实际的 commit 收费是多少？
8. `UpdateEphemeralPermission` 执行后，新权限是立即生效，还是要等下一个 slot？

---

## 9. 第四轮（2026-09-30）：密钥、主网计划、AI 桌与 x402

### 9.1 已确认

| 项 | 结论 |
|---|---|
| devnet SOL | 你来转账，收款地址是部署者 `541kpQWNTnAGG2Lie54D3qqhLvNJ5UKKpJPFyoi1P33H`，建议转 15–20 SOL |
| 密钥 | devnet 的密钥放在项目文件里（见 §9.2）。**主网密钥不能这样存**：主网的升级权限要交给多签，运营热钱包要单独管理 |
| 主网 | 会上主网，运营方已持有牌照。所以逃生通道、TEE 度量值校验、审计、升级权限交给多签，都是**上主网的硬性门槛** |
| 项目指令 | 上下文块 v3 存为项目指令 |
| GitHub | 代码推送到 GitHub，需要你在弹出的卡片里授权 |

### 9.2 生成的密钥（devnet）

| 用途 | 公钥 | 项目文件 |
|---|---|---|
| 部署者：升级权限、手续费、devnet treasury、tUSDC mint authority | `541kpQWNTnAGG2Lie54D3qqhLvNJ5UKKpJPFyoi1P33H` | `keys/deployer.json` |
| solpoker 程序 ID（写进 `declare_id!`，永久不变） | `EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf` | `keys/solpoker-program.json` |
| tUSDC mint（6 位精度） | `9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH` | `keys/tusdc-mint.json` |

x402 facilitator 的手续费账户等到 Stage 8 再生成。

### 9.3 三类牌桌

| 类型 | 谁在打 | 身份怎么标记 | 默认数量（Q15） |
|---|---|---|---|
| 真人桌 | 人 vs 人 | Seat.kind = Human | 每档 3 张，共 9 张（已定） |
| AI 桌 | agent vs agent | 只接受已注册的 agent | 每档 1 张，共 3 张 |
| 混合桌 | 人 vs agent | 座位上有链上标记，前端明确显示「AI」 | 每档 1 张，共 3 张 |

**什么是 agent**：agent 有自己的 Solana 钱包，并由一个真人主人注册。注册信息存在链上的 `AgentProfile` PDA（种子 `["agent", agent_pubkey]`）：`owner`（主人钱包）、`agent_pubkey`、`name`、`meta_uri`、`registered_at`、`flags`。注册必须由主人和 agent 同时签名，证明双方都同意绑定。

**必须说清楚的一点**：链上能证明「这个座位是已注册的 agent」，但**无法证明某个普通钱包背后一定是人**。任何人都可以用普通钱包跑 bot 坐进真人桌。「真人桌」的保障只能靠用户协议、行为检测和风控，密码学做不到。这一点需要你在合规层面接受，或者另外给出方案（Q21）。

### 9.4 x402 怎么用（推荐方案）

x402 是 HTTP 原生的付款协议：服务器返回 `402 Payment Required`，并附上付款要求；客户端签好付款后重试请求。devnet 的网络标识是 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`，当前 SDK 是 `@x402/core`、`@x402/svm`、`@x402/express`、`@x402/fetch`、`@x402/mcp`，均为 2.28.0（2026-09-29 发布）。

它和我们设计的契合点在于：**x402 付款的收款账户是 `payTo` 地址的 ATA**。我们把 `payTo` 设成这张桌的 `vault_auth` PDA，agent 的 USDC 就会**直接转进 TableVault**，全程不经过运营方的钱包。

**agent 入座流程**：

1. agent 调用 `POST /v1/tables/{table}/seats`，参数为 `{agent_pubkey, session_pubkey, buy_in}`。网关检查座位空闲、买入额合法、agent 已注册，然后锁定座位 60 秒。
2. 网关返回 402，付款要求是：`asset` = USDC mint，`amount` = 买入额，`payTo` = vault_auth PDA，`extra.feePayer` = 我们的 facilitator，`extra.memo` = `solpoker:r:<预约号>`。
3. agent 的 x402 客户端构造交易：从 agent 的 ATA 用 `TransferChecked` 转到 TableVault，附带 memo，签名后提交。
4. 我们**自建的 facilitator**（进程内的 `@x402/svm` ExactSvmScheme）验证交易、代付手续费并提交上链。
5. 交易确认后，网关调用程序指令 `credit_x402_deposit`，把 Seat 分配给付款人，然后委托 Seat。
6. 网关返回 200，附上座位信息和 TEE 连接方式。之后 agent 用**自己的密钥**直接连 TEE 打牌、读取自己的底牌。

**为什么要分两步**：x402 标准钱包路径（fast path）只接受「计算预算 + TransferChecked + Memo」这几类指令，不能在同一笔交易里夹带我们的入座指令。所以先付款，再单独执行入座。

**程序层面的防护**：

- `DepositRecord` PDA 以付款交易签名为种子，保证同一笔付款只能入账一次。
- 入账金额不能超过 TableVault 里「尚未记账的余额」。
- 只有网关 authority 能调用 `credit_x402_deposit`。
- 座位的 owner 只能是这笔付款的转出人（TransferChecked 的 authority）。
- 每条 DepositRecord 都能对应到一笔链上交易，里面有付款人、金额和 memo。我们会提供公开的对账脚本。

**信任边界（如实说明）**：我们的程序读不到别的交易的内容，所以「这笔钱是谁付的」由网关认定。这是 x402 路径里唯一需要信任运营方的地方，但事后可以完全审计。不想信任网关的 agent，可以走**原生路径**：用 SDK 直接调用 `sit_down` 指令，和真人入座一样，完全不需要信任。两条路径都支持。

**离桌**：x402 只管付款进来，不管付款出去。agent 离桌同样走 permissionless 的 `cash_out`，钱直接回到 agent 的钱包。

**facilitator 必须自建**：一方面不依赖第三方（CDP 托管的 facilitator 在 2026-08-23 到 08-26 之间曾拒绝有效的 Solana 付款，见 x402 issue #3268）；另一方面，持牌运营也需要自己掌控结算。每笔付款的手续费由我们代付，约 0.000005 SOL。

**devnet 的 tUSDC 水龙头**：agent 需要测试币，由网关提供限速的领币接口。

### 9.5 agent 怎么打牌

| 接入方式 | 适合谁 | 私钥在哪 | 能否看到别人的牌 |
|---|---|---|---|
| **本地 MCP 服务**（`npx @solpoker/agent-mcp`，推荐） | 任何支持 MCP 的 LLM agent，比如 Claude、GPT 或自建 agent | 用户自己的机器 | 不能。agent 只能用自己的密钥从 TEE 读自己的底牌，运营方也看不到 |
| **TS / Python SDK** | 写代码的规则 bot 或强化学习 bot | 用户自己的机器 | 同上 |
| 托管 MCP（运营方代持 session key） | 只用于 devnet 演示 | 运营方 | **运营方能看到这个 agent 的底牌**，所以不能用于真钱 |

本地 MCP 提供这些工具：`list_tables`、`get_table_state`、`get_my_cards`、`sit_down`（内部走 x402 付款）、`act(action, amount)`、`top_up`、`leave`、`get_hand_history`。牌桌状态和合法动作按 JSON Schema 输出，并附带双语规则说明，方便 LLM 理解。

另外提供开源示例 bot：一个随机 bot 和一个规则 bot，用于测试和陪练。

### 9.6 需要你回答的问题

| # | 问题 | 推荐默认 |
|---|---|---|
| Q13 | x402 用在哪些地方 | v1：agent 的入座和补码走 x402，同时保留原生 SDK 路径。v2 可选：给 AI 桌的观战直播或牌局历史做付费 API（按次收费） |
| Q14 | AI 桌和混合桌是否也只做 heads-up | **v1 全部 heads-up**，所以混合桌就是一个人对一个 agent。多人桌（6-max）会同时牵动边池、N 份盐、权限和作废规则，是一次大改，放到 v2 |
| Q15 | 数量和档位 | AI 桌、混合桌每档各 1 张，共 6 张，同样常驻（加上真人桌共 15 张，租金多约 0.5 SOL） |
| Q16 | agent 的行动超时 | 与真人相同：30 秒，连续 3 次超时自动站起 |
| Q17 | 平台自己放 bot 吗 | 示例 bot 只在 devnet 和 AI 桌上陪练；**混合桌上不放平台 bot**，因为真钱下平台 bot 对真人，相当于庄家对赌。持牌主体是否允许这样做由你决定 |
| Q18 | 同一主人的 agent 能否同桌 | **禁止同桌对打**，防止转移筹码（chip dumping）和洗钱。同一主人的 agent 可以分别坐不同的桌 |
| Q19 | AI 桌和混合桌的 rake | 与真人桌相同 |
| Q20 | agent 注册的门槛 | devnet 上任何人都能注册；主网按你们牌照的 KYC/AML 要求，给主人钱包加白名单 |
| Q21 | 真人桌能否挡住 bot | 做不到密码学保证。默认靠用户协议加后续的行为检测，这一点需要你确认可以接受 |
