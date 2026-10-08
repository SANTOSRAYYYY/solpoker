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

- **（2026-10-08）右上角「连接钱包」消失的修复**（用户反馈：大厅/Agent 页的钱包按钮不见了、要放回右上角）：
  根因是**半登录状态** —— Privy `authenticated=true` 但拿不到 Solana 钱包（内嵌钱包未开通的老问题），
  此时 `ctx.me === null`，`AppNav` 的三个分支（未就绪 / 未登录 / 已登录且有钱包）**全不命中** → 右上角整块空白。
  修：补上第四个分支 ——「连接钱包」（重试登录）＋「退出登录」（重置回干净状态）；大厅/Agent/对局/文档等
  所有 `(app)` 页面共用同一导航，一起恢复。实测：两页右上角显示 `EN · 连接钱包 · 退出登录`、零横向溢出 ✓。
- **（2026-10-08）牌桌页「点了没反应」的按钮修复**（用户反馈：22 号桌点各种按钮没反应）：
  1. 未登录访客的顶部按钮原本是 `disabled` 的「连接 TEE」→ 现在直接渲染成「连接钱包」（一点即走 Privy 登录），
     登录之后才显示「连接 TEE」。
  2. 「入座」面板原本整块被 `ctx.me` 挡掉（访客完全看不到入座入口）→ 现在对所有人显示：未登录时给一句说明 +
     「连接钱包」按钮。
  3. 毡桌上的空座位原来不可点 → 现在可点（hover 高亮 + `title`「点这里入座」）：未登录 → 先登录；
     已登录 → 选中座位并平滑滚到入座面板（`#sit-panel`）。
  4. 反馈兜底：以上三处在未登录点击时都会显示可见提示（新键 `table.loginHint`：「需要先连接钱包才能入座。
     如果登录窗口没有出现，请检查浏览器的弹窗拦截，或刷新页面重试。」）—— 即便 Privy 弹窗被拦截或加载失败，
     点击也绝不再"没反应"。
  实测（未登录访客，1440）：顶部=可点「连接钱包」、入座面板可见、7 个空座位可点；点空座位 → 提示立刻出现 ✓
  （注：本机 IAB 里 Privy 弹窗不渲染属已知环境问题，真机上若弹窗打开但无 Solana 钱包，见 Privy 后台
  `solana_wallet_auth` 那条老坑）。
- **（2026-10-08）官方页导航补「信任」**（用户反馈：首页导航没有信任标签）：`SiteNav` 原本只有页内锚点 + 「产品文档」，
  现补上 **「信任 → /trust」**（排在「常见问题」与「产品文档」之间）；并让这排链接在窄屏也可见 —— 横向滚动
  （`no-bar`）、窄屏只留 logo（品牌文字 `sm:inline`）、字号/内边距按断点收紧。实测：桌面 7 项齐全；
  375px 下链接排 `scrollWidth 413 > clientWidth 159` 可滑动、页面零横向溢出（360/360）。
- **（2026-10-08）信任页交互动画 + GitBook 式双语文档站**（用户："还是可以有点动画交互…另外做一个 gitbook 的全面产品说明"）：
  1. **信任页动起来**：「一手牌的旅程」改成**分步交互** —— 顶部 5 个节点芯片可点选，自动播放（4.2s/步，
     悬停暂停、点选即接管、`prefers-reduced-motion` 时不自播），当前步骤卡片 `animate-rise` 淡入，
     控制条含「下一步 / 暂停自动播放 / 进度点」；「试着作弊」四张卡与「逐项主张」八张卡改成**折叠卡**
     （grid-rows 0fr↔1fr 过渡；主张默认全收，页面文字量约减 70%），均带 `aria-expanded`。
  2. **GitBook 式文档站 `/docs`（12 页 · 中英双语一次性做全）**：新路由 `(app)/docs/[[...slug]]`
     （服务端 `generateMetadata` + 客户端 `DocsShell`）＋ 内容模型 `web/lib/docs/*`（块状双语数据：
     p/h2/h3/ul/ol/code/callout/table/links/cards）＋ 渲染器 `components/doc-blocks.tsx`。
     布局：左侧目录（分组 + 搜索框，跨语言命中标题/摘要/关键词）+ 正文（面包屑、页内目录锚点、上一页/下一页）+
     移动端抽屉；`/docs` 根路径自动落在「产品介绍」。12 页：产品介绍 / 快速开始 / 牌桌与规则 / 隐私模型 /
     发牌与公平性 / 自己验证 / 资金与托管 / x402 付费入座 / AI Agent 接入 / 状态与路线图 / 常见问题 / 术语表
     —— 事实口径与 /trust 一致（含缺口与边界）。
  3. **接线**：应用导航新增「产品文档」（`nav.docs`）；官方页导航与页脚、落地页「技术底座」区的文档卡、
     信任页页脚都指向 `/docs`。
  4. **验证**：`npx tsc --noEmit` 全绿；浏览器实测（1440/375）：分步交互与折叠、文档站 13 条路由 200、
     搜索（输入 "verify" 命中「自己验证」）、页间导航、深链 `/docs/glossary`、英文切换、移动端零横向溢出
     （360/360）、移动目录抽屉。
- **（2026-10-08）devnet-tee 停顿后的排查与修复（附带发现）**：
  1. **~18:17 全局停顿**：crank/agent 的日志同时静默约 1 小时（网络/ER 侧停顿，进程未崩、stderr 干净，
     恢复后自行续跑）。期间 ER 权限账户丢失 —— 重跑 `deploy-tables.mjs`（按缺口续跑）为 **23 桌重建
     `init_permissions`**（全部 ✓），随后 `QUICK_SIT_OK` 复验通过。
  2. **「权限 0/10」的真相**：devnet-tee 自今日起不再经 RPC 暴露权限账户（账户实际存在；重建后功能可证），
     `testnet-health.mjs` 的权限读数因此恒为 0 —— 已改为「委托 15/15」硬判 + 权限仅标注（避免假红）。
  3. 另修：`alice` 钱包补币（crank fund 0.05 SOL + 25 tUSDC）——她此前入座失败的真实原因是
     `SPL Token: insufficient funds`（Custom(1)），不是权限故障。
- **（2026-10-08）信任页改版（借 pokerable.fun/trust 的设计语言，内容全部是我们的实测证据）**（用户："他们这一页的设计还蛮帅的"）：
  1. **「一手牌的旅程」方框流程图**：五个角色盒子（你与对手 · 座位 → Solana VRF 队列 → **TDX 内的私有牌桌 · PER 权限层** → Solana L1 金库与结算凭据 → 你的浏览器 · 开源验证器），
     盒子之间是编号箭头说明（01 盐承诺→揭示 / 02 洗牌种子 / 03 结算凭据 / 04 复算 52 张）；右上角图例区分
     **公开可查**（cyan）与 **只存在于硬件内**（warn）；TEE 盒子带紫调高亮 + `SEALED IN HW` 徽章。
  2. **「试着作弊」四张拦截卡**：01 偷看底牌（PER 权限层 + 无 token 读私有账户实测返回 null）／02 操纵发牌（哈希承诺先于 VRF 种子）／
     03 改派付款（入座钉死 payout ATA + 无许可 cash_out）／04 偷 session key 或断线卡桌（7 天 TTL + 超时自动推进），每张一个 `拦住了 / BLOCKED` 徽章。
  3. **八项主张加小节标题**「逐项主张与证据 / CLAIMS & EVIDENCE」；Hero 文案改成「『别信我们』不是修辞…」。
     原有硬件证明、八项（由什么保证/怎么验证/仍然需要信任）、风险边界、页脚全部保留。
  4. **验证**：`npx tsc --noEmit` 全绿；浏览器实测（1440 桌面 + 375 移动）：中文渲染、流程图/拦截卡/主张卡排版正常、
     移动端零横向溢出（scrollWidth == clientWidth == 360）。
- **（2026-10-08）官方落地页 `/`（产品入口 + 全面介绍，参考 pokerable.fun 的结构）**：应用大厅从 `/` 移到 `/lobby`（牌桌等其余路由不变）。
  1. **新路由组 `(site)`**：`app/(site)/layout.tsx`（`SiteNav` + `SiteFooter`，不挂钱包区 —— 连接钱包发生在进入大厅之后）
     + `app/(site)/page.tsx`（服务端组件，带 metadata/OG，渲染客户端 `components/landing.tsx`）。
  2. **章节**：Hero（徽章 + 主张 + 双 CTA + 纯 CSS 毡桌/底牌/筹码视觉，无新图片素材）→ **链上实时数据条**
     （`components/landing-live.tsx`：readTablesLive 8s 轮询 + SSE 即时刷新 —— 进行中桌数 / 在座（含 AI 数）/
     桌内托管 tUSDC / 盲注档位；实测 1 / 共 23 张、3 在座（AI 2）、59.00 tUSDC）→ 为什么（公开链上三个死穴 → 逐条解法）
     → 玩法五步（配 每手 ~40s / VRF ~1.1s / ≤9 座 / 会话 7 天）→ 公平性可验证（整手复算 / 行动流 / L1 审计 + 诚实缺口）
     → 钱与托管（全额担保 / 付款只付本人 / 随时离桌 / 运营方不持币）→ AI Agent（AgentProfile + MCP 工具清单 + 命令框）
     → 技术底座（Solana/Anchor/PER-Intel TDX + 程序账户 solscan + 文档外链 + 测试网声明）→ FAQ 五条
     → 收尾 CTA（进入大厅 / 看 22 号桌直播）→ 页脚（产品 + 资源两列）。全部文案中英双语（页面内 `L(zh,en)`，能复用字典的复用）。
  3. **导航调整**：`app-nav` 大厅 href → `/lobby`（logo 仍指 `/`，应用内可回官方页）；对局页「返回大厅」→ `/lobby`；
     `SiteNav` 带页内锚点（为什么/怎么玩/公平性/AI Agent/常见问题，均带 `scroll-mt` 避开吸顶栏）+ 语言切换 + 「进入大厅」；
     根布局 `<html>` 加 `scroll-smooth`。
  4. **验证**：`npx tsc --noEmit` 全绿；浏览器实测（1280 桌面 + 375 移动）：中英切换、锚点滚动（#fair ✓）、
     移动端零横向溢出（scrollWidth == clientWidth == 360）、CTA → `/lobby` 正常、页脚 8 个链接齐全；
     `/lobby`、`/table/22`、`/agents`、`/history`、`/trust` 全部回归 200；`TESTNET_HEALTH_OK` 仍绿。
- **（2026-10-08）每手节奏大修：「打完一手再等下一手很久」的实测根因与三处修复**（用户提问）。用逐秒相位观测器（新工具 `scripts/watch-table.mjs <tableId>`）实测桌 #22：
  1. **根因一：commit_timeout_s=60 的死等**。程序侧 `commit_to_await_seed`（hand.rs）在
     hand_mask 全员已承诺时本可立即 arm Preflop VRF + 进 AwaitSeed，但 crank 按
     `phase_deadline(@112)` 门控，而建桌脚本给桌 20–34 配的是 `commitTimeoutS: 60`
     （9/11 旧桌 10s）→ 每手白等最长 60s ✗。修：Commit 阶段先扫 Game 座位
     `salt_commit`（座位基址 152、步长 152、座位内 +32），**全员非零即跳过门控直接
     advance**（程序侧 missing==0 一次完成 arm+转段）。实测冻结→AwaitSeed 60s+ → ~2.4s。
  2. **根因二：crank 串行轮询 24 张桌的轮次延迟 ~17s**（每桌一轮 1 次 game 读 + 2 批
     座位读，串行 24 桌 ≈ 25 次 RTT）。此前把「请求→看到履行」的 17–25s 误判成 VRF 慢 ——
     实测 **VRF 本身只要 ~1.1s** ✗。修：桌间 **mapLimit(6) 并发** + 阶段性动作**连锁**
     （advance/commit_game 成功后同一轮用新鲜状态继续跑
     close→commit_game→freeze→arm→request，≤6 次）。实测轮次延迟 17s → 2.4–3.6s。
  3. **runner 用上 §6.4 预提交**：手牌进行中（phase≥2）为 hand_id+1 写
     `next_salt_commit`（程序早已支持，advance 冻结下一手时提升）→ 下一手 Commit
     阶段在冻结瞬间就「全员已承诺」。盐先落盘再发交易；顺带修掉 AwaitSeed 分支无条件
     `continue` 导致预提交分支不可达的问题。实测整局 `pre0=pre1=1` 稳定成立。
  **实测效果**：手与手之间（Settle → 下一手 Preflop）**~80s → ~11s**；单手全程
  ~2.5–3 分钟 → ~40s。已知小瑕疵：一次进程重启边界上手 #5 漏揭示（MissingSalt
  设计内作废、无资金变化，后续手正常）；runner 把 void 手也计入「第 N 手结束」（文案层面）。
- **（2026-10-08）观战可读性：对局页给「没入座的人」显示当前在等什么（用户反馈"是不是卡了"）**。
  用户观战桌 #22 时看到长时间无动作，怀疑 agent 或合约卡死。实测**都没卡**：手 #2 在
  `AwaitSeed`（等 VRF 履行，devnet 偶尔几十秒）→ 25 秒后自己推进到 `AwaitStreet`，
  底池 0.42 → 0.92、双方筹码 19.99/19.58 → 19.74/19.33（在正常下注）。**真正的问题是 UI**：
  未连接钱包的观众只看到「连接钱包后即可入座」，完全看不出在等 VRF ✗。修：
  1. 对局页新增 `statusText` 统一状态行：`!game` → 加载中；**Await* 且 VRF 未就绪 → 「正在等
     VRF 随机数…（devnet 偶尔要几十秒，超时自动重试）」**；牌局中 → 「观战中 · {阶段}」；
     入座等待 → 「等待座位 N 行动…」；Idle → 「本手结束…」；并追加「连接钱包可入座」提示 ✓。
  2. VRF 徽章换人话：`待命/已请求/等待中/已就绪` → `随机数：未请求/已请求/等待中…/已就绪`
     （英文 `VRF: idle/requested/pending…/ready`）。
  实测（观战 /table/22，未连钱包）：状态行显示「正在等 VRF 随机数… · 连接钱包后即可入座」，
  现场手牌同时进行到第 3 街（翻牌 7♣3♠6♠ + 转牌 2♦、底池 0.92）✓。
- **（2026-10-08）UI 第三批 + 真 agent 上场：大厅折叠、移动端紧凑座位、清掉 mock 页、agent 实盘对局**。
  1. **大厅牌桌列表可展开/收起**：默认只显示前 6 张（`COLLAPSED = 6`），下方居中按钮
     「展开全部（还有 17 张）」/「收起（共 23 张）」。实测：默认 6 张 → 点开 23 张 → 收起 ✓。
     这样 20+ 张桌不再把页面拖得很长，首屏聚焦英雄区 + 前几张桌。
  2. **移动端紧凑座位牌**：毡桌整体缩放（前一批）会把座位文字缩到不可读 —— 现在
     `useFeltFit` 额外返回 `compact`（scale < 0.62 时为真），容器带 `data-compact`，
     `SeatView` 渲染 **92px 小牌（头像 + 筹码，名字/徽章 `sr-only` 保留无障碍）**，
     并用 CSS `transform: scale(1 / var(--felt-scale))` **反向缩放回 1×**（位置仍由毡桌缩放决定）。
     实测 375px 视口：反缩放 `matrix(2.906…)` = 1/0.344 ✓、牌面 91×36 可读（`AI 20.00`）、
     页面零横向溢出。
  3. **删掉 `/mock/*` 设计稿页**（5 屏 + layout/nav/data）—— 全仓库无引用，靠 git 历史可追。
  4. **真 agent 实盘对局**：把 `scripts/agent/agent.mjs`（+ `client.mjs`）端点统一到 `env.mjs`
     （此前默认本机 8898/7799）；修 `status` 子命令：agents 目录里的裸密钥文件
     （`bob-owner.json` 是 64 字节数组）会让它崩（`undefined is not iterable`）→ 现在跳过非档案文件。
     **实测**：bob（座 0）与 carol（座 1，不同主人 → 可同桌）在**新桌 #22**（混合 0.05/0.1）入座，
     两个 runner 后台运行 —— 日志显示「hand#0 盐承诺已提交 → 第 1 手结束 → hand#1 盐承诺已提交」，
     **agent 在真实对局中持续打牌**（各目标 4 手）；大厅英雄区随之显示 `SEATED 3 / ESCROW 59.00`。
  5. **顺带**：行动记录里的「系统/桌面」前缀接入 i18n（英文模式此前会中英混排）。
  6. **移动端英文导航被裁的修复**（用户反馈）：英文菜单项（Lobby 54 + My Agents 86 +
     Hand history 103 + Trust 47 = 296px）超出导航可用宽度（268px），「Trust」被切一半 ✗。
     修法：字典补 `nav.*Short`，导航同时渲染两套标签、CSS 按断点切换 —— 窄屏英文用
     `Lobby / Agents / History / Trust`（中文用 `大厅 / Agent / 验证 / 信任`）。
     实测 390px 英文/中文均 `scrollWidth == clientWidth`（268/268）、四项完整可见 ✓。
- **（2026-10-08）UI 第二批：英雄区压紧 / 窄屏导航 / 移动端毡桌缩放 / `/history` 全页双语**。
  1. **大厅英雄区压紧**（桌面高度约 -20%）：`mb-10→mb-7`、`py-6→py-5/6`、标题 30→27px、
     说明 13→12.5px、按钮上边距收紧 —— 牌桌列表更早进入首屏。
  2. **窄屏导航**：菜单项 `px-2→px-1.5`（`sm` 起恢复）、文字 12.5→12px、品牌文字 `<sm` 隐藏
     （logo 保留）—— 375px 下四个菜单项不再被裁成「手牌!」。
  3. **移动端毡桌改「按宽缩放」**：原来 `min-w-[680px]` 靠横向拖动；现在外层
     `.felt-fit` 用 ResizeObserver 把 1020px 设计宽的毡桌整体等比缩放（`--felt-scale`）并按
     `宽 × 1/1.9` 补偿高度。实测 375px 视口：`scale 0.344`、高度 185px、**页面无横向溢出**，
     整张桌子（9 个座位 + 底池）完整可见，文字信息交给下方侧栏（我的手牌/本手信息/行动记录）。
  4. **`/history` 全页双语（最后一个纯中文页）**：字典新增 `history.*` **86 键 × 2 语言**
     （标题/说明/牌桌选择/手牌列表/结算明细/发牌证明/三个验证按钮与全部结果文案/覆盖度说明三段/
     引擎自检段/审计视图段/空态与占位），页面（含 `HandRow` 子组件）逐条接线。
     实测：英文模式整页英文（`Hand history & verification … What we can and cannot verify`）、
     中文模式整页中文；手牌数、作废徽章（Void）、`(4 used)` 等动态文案都跟着语言走 ✓。
     至此**五个正式页全部双语**（导航/大厅/对局/历史/Agent/信任）。
  过程记录：字典批量插入时锚点选得不好，误删过 EN 块 —— 已用 `git checkout` 恢复并用
  「`} as const;` / `const DICT`」这类结构性锚点重做；`npx tsc --noEmit` 全绿。
- **（2026-10-08）UI 评审 + 修复一批（移动端溢出、历史页空态与默认桌、一处解码边界、一处文案）**。
  逐页截图评审（桌面 1440 与移动 390）后发现并修掉：
  1. **移动端横向溢出（最严重）**：大厅英雄区的徽章行没有 `flex-wrap`，把整个页面撑宽 →
     标题「链上可验证」被裁、桌卡的买入列被裁。加 `flex-wrap` 后实测
     `scrollWidth == clientWidth`（375/375）、标题正常折行 ✓。
  2. **历史页空态**：默认选中的桌（白名单第一张 #5）没有已结算手牌时，左侧列表被
     `max-h-[720px]` 撑成一块巨大空面板、右侧只有一行占位 ✗。改：无手牌时不再撑高；
     桌下拉**显示每桌已结算手牌数**（并发读每桌 HandProof 的 `head`，6 路，23 桌≈一次延迟）；
     **默认选「手牌最多」的桌**（实测落到了 #9 · 10 手），页面对新访客立刻有内容可看。
  3. **`decodeHandProof` 的空槽判据漏项**：`hand_id == 0 && rake == 0` 会被当成空槽，
     而 **hand #0 是合法的一手**且 rake 可能为 0（没见翻牌的收池）→ 桌 #6 的 `head=1`
     却在列表里显示「没有手牌」。判据补齐为 `hand_id/rake/hand_mask/status` 全零
     （在浏览器里实测：桌 #9 的 **手 #0 现在正常显示**，含牌面/结算明细/发牌证明）。
  4. **对局页噪音**：筹码为 0 的座位不再画筹码图标（已离座座位只剩「0.00」）。
  5. **文案**：桌卡的「入座 0/9」在中文下语义错（那是**座位占用数**，不是按钮）→
     改为「在座 0/9」（英文 `Seats taken` 本来就对）。
  **顺带确认 UI 的诚实性**：桌 14 座 1 的「待兑现」徽章经链上核对是**对的**
  （`deposited 40 > paid 23.75`，确有 16.25 tUSDC 未兑付，等 crank sweep）。
  `npx tsc --noEmit` 通过；移动端/桌面截图复验通过。
- **（2026-10-08）测试网产品收尾：一条命令自检 + i18n 补完（agents/trust）+ 运维手册**。
  **① `scripts/testnet-health.mjs`（只读）**：一条命令查「端点/程序账户/23 桌（委托 15/15 +
  ER 权限 10/10）/四个本地服务/crank 日志新鲜度」，`--deep <tableId>` 再跑整手复算与行动流验证。
  实测输出 **`TESTNET_HEALTH_OK`**（23 桌全绿、服务在线、`HAND_RECOMPUTE_OK` + `ACTION_STREAM_OK`）。
  **② i18n 补完**：`/trust` 与 `/agents` 此前是纯中文（当初标注的覆盖边界），现在两页把
  数据/文案就地双语化（条目 `by/how/trust` + 8 项信任条目 + 硬件表 + 风险边界表 + 页脚、
  agent 页的工具清单/向导三步/同桌规则/安全边界/操作与通知），渲染按 `lang` 取值；
  `AGENT_STATUS` 本来就是英文 ✓。浏览器实测两页英文模式渲染完整（"Trust model / No slogans
  here…"、"My Agents / Register an on-chain identity…"），`npx tsc --noEmit` 通过。
  **③ `docs/runbook-testnet.md`（运维手册）**：四个进程怎么起、`.env.local` 各项含义、
  加桌（含 DelegPayer 估算与补币）、六种验证命令、排障表（僵尸座位/6199 快照陈旧/Commit 卡住/
  401 token/「部署成功但跑旧 .so」/ER 不给日志时改用 L1 原始 JSON-RPC 模拟）、x402 三种用法、
  已知边界（devnet 特性、v2 无 occupants、托管 MCP、逃生通道、4 条历史退款记录）、
  改程序后的发布清单 + **SBF 栈纪律**。README 顶部加了指引。
  **④ `scripts/program-parity.mjs`（新常驻）**：链上程序数据 vs 本地 `.so` 逐字节比对
  （防「部署成功但跑的是旧 .so」），实测 `PROGRAM_PARITY_OK`。
- **（2026-10-08）新桌端到端实测：15 张新桌不只会「能入座」，完整一手从发牌到复算全通**。
  `node scripts/stage7-player-sim.mjs 20`（两名测试玩家、除玩家签名外全由 crank 驱动）
  实测输出 **`STAGE7_PLAYER_SIM_OK`**：`sit_down ×2 → crank take_seat ×2（同时更新 PER
  成员）→ 手 #1 开始（Commit）→ 双方 commit_salt → AwaitSeed + VRF_0 fulfilled →
  双方 reveal_salt → 发牌（pot=0.17）→ 四条街的 act（check/call）→ 结算完成（p0=20 p1=20）
  → stand_up ×2 → crank commit_game → cash_out ×2`，两位玩家余额各自回到 59.86 / 80.1 tUSDC ✓。
  **链上验证三连（同一手 #1）**：① 新 CLI `scripts/verify-hand.mjs`（= /history 页
  「整手复算」的同一套引擎，命令行版）**`HAND_RECOMPUTE_OK`：逐张 9/9 与链上一致**、
  `salt_digest=dd9893…`、`draw_digest k0..k3` 与 `street_end k0..k3` 全部非零、`attempts=[1,1,1,1,0]`；
  ② `verify-actions` **`ACTION_STREAM_OK`**（扫 50 笔交易解出 8 条规范事件，四街各 2 条全闭合、
  `transcript_final` 匹配）；③ `replay-status` 显示 `layout=v2 / streets=0b1111 / ended=0b1111`。
  **过程里顺手修的两处**：① **引擎对 v2 条目的假失败** —— `dealFromReplay` 总是复算
  salt_digest，而 v2 条目不再存 occupants（链上只存摘要），于是逐张全对也会报 FAIL；
  现在加显式 `skipSaltDigestCheck`（CLI 与 `/history` 页在 occupants 不可得时设置），
  并把「v2 无法独立复算摘要、以链上摘要为输入」作为 note 如实展示；② `stage7-player-sim.mjs`
  端点统一走 `env.mjs`（此前默认本机 8898/7799，要靠环境变量才对得上 devnet-tee）。
  另：`verify-hand.mjs` 用 `process.exitCode` 代替 `process.exit`（少一处 Windows libuv 退出噪音）。
- **（2026-10-08）更正 + 全桌可玩：`init_permissions` 的 6010 是本仓库脚本 bug（不是 ER 故障）；15 桌权限补齐，23 张桌全部可入座**。
  **更正**：前一条「devnet ER 权限创建被阻塞」的判断**是错的**。真因在
  `scripts/lib/deploy-table.mjs`：局部 helper `const pda = (seeds) => …programId…` 只接受一个
  参数，`permission: (acc) => pda([b"permission:", acc], PERMISSION_PROGRAM)` 里第二个实参被
  **静默忽略** → 权限 PDA 按**我们程序**而不是 **ACL 权限程序**推导 → 客户端传错地址 → 程序端
  按 ACL 正确派生后 `require_keys_eq!` 失败，报 `SeatMismatch(6010)`。之前「老桌权限也消失」
  同样是这个错误推导造成的误判：用正确派生查，桌 9/14/**20** 的权限**一直是 10/10**
  （`owner=ACLseoPoy…`），ER 从未重置或拒绝过任何东西。**唯一一次真 ER 抖动**是本会话早期的
  401 InvalidToken（`getAuthToken` 没解构 `{ token }`，也是我自己的 bug）。
  **排查关键（值得复用）**：**在 L1 上模拟该指令并读日志** —— 日志直接给出
  `AnchorError thrown in programs/solpoker/src/instructions/init_permissions.rs:126` 与
  `Left: 3qfjaBx1…`（客户端传入）/ `Right: HaUJ9vVm…`（程序按 ACL 派生）两个地址，一眼定位
  是哪一侧派生错了。注意 web3.js 的 `simulateTransaction` 会拒绝 `sigVerify` +
  `replaceRecentBlockhash` 组合（"sigVerify may not be used with replaceRecentBlockhash"），
  改用原始 JSON-RPC + `{ encoding:"base64", sigVerify:false, replaceRecentBlockhash:true }`。
  **修复**：`tablePdas` 加 `pdaWith(seeds, program)` 显式传程序 + 注释警告；
  `scripts/er-perm-probe.mjs` 改为**先 L1 模拟（失败则打印日志）再发 ER**，以后一眼就能诊断。
  **结果**：`deploy-tables.mjs` 一次跑通 **11/11**（桌 22–26、28–33 补齐权限；20/21/27/34 此前已建）
  → 逐桌复验 **23 张桌权限全部 10/10（`ALL_PERMISSIONS_OK`）**；大厅白名单更新为 23 桌；
  crank 以全表列表重启（`crank-all.log`）。**端到端验收**：桌 20 座 0 = x402 入账的测试钱包
  （10 tUSDC，`credit_x402_deposit`）、座 1 = `quick-sit carol`（10 tUSDC）→ crank 实测
  **`[t20] take_seat[0]` / `take_seat[1]` 成功**（这条路径过去正因为「权限」而不可用）→
  大厅显示 23 张桌、牌桌页显示「2 seated」、手牌进入 Commit 阶段 ✓。随后两个测试座位
  `stand_up` 撤除（crank 会在手牌边界 commit 后兑付）。
  **顺手修掉两个真问题**：① `scripts/stand-up-player.mjs` 的 ER 端点硬编码（本机 7799）改走
  `env.mjs`（上次统一时漏网）；② **crank 在 Commit 阶段每秒空转 `advance`** —— 程序语义是
  「每次敲 1 记 strike（上限 3）后重新计时」，所以无揭示的手牌要 ~3 分钟才自动释放座位，
  而每秒一发纯烧手续费（实测白烧 ~180 笔）；现在按 `Game.phase_deadline(@112)` 门控，
  重启后日志只剩必要动作。**撤座闭环实测**：crank 自动 strike-out → 释放座位 → commit →
  `sweep cash_out` 把押金退回付款人（测试钱包 +10.01 → 49.86、carol +10 → 38.75，
  桌 20 金库归零、两座 `occupant=default` 且 `deposited == paid`）—— 全程无需人工。
- **（2026-10-08）`refund_x402_deposit` 落地 + 一个 SBF 栈破坏 bug 的完整排查（x402 标准模式两件套齐了）**。
  **程序**：新指令 `refund_x402_deposit(amount, sig_lo, sig_hi)` —— `config.gateway` 门禁；
  把「付了款但未入账」的钱从 TableVault 退回 `ATA(payer, mint)`（地址约束钉死收款方）；
  **只允许动盈余**（退款后余额仍须 ≥ I-X 要求，复用 `required_vault_backing`）；
  `RefundRecord`（PDA `["x402refund", sig_lo, sig_hi]`）防重复退款 + 记录签名供审计；
  9 个座位账本走 `remaining_accounts`。
  **网关/CLI**：`POST /v1/tables/:id/refunds?payer=&amount=` + `X-PAYMENT`（复用同一套
  付款校验，反向退款）、`scripts/x402-refund.mjs`（含记录签名回编自检）。
  **实测**：桌 20 那笔因 `SameOwner` 卡住的 10 tUSDC 已退回原付款人（vault 20→10、
  付款人 +10、`RefundRecord` 落链）；随后桌 24–28 共 5 次退款（含经网关接口的一次）
  全部 **记录签名回编 == 付款签名 ✓**；`program-smoke` 4/4（新增退款探针：金额超盈余
  → 6021 Conservation，不动钱）；`audit_table` 在 credit/top-up/退款后都通过（I-X 守恒 ✓）。
  **中间抓到一个非常隐蔽的 bug，值得记档**：退款记录里 `sig` 的**后 24 字节稳定地被
  冲成别处数据**（前 40 字节正确），而 PDA 种子只用前 32+32 字节 → 链上校验照过、
  引用付款签名却查不到那笔交易 —— 靠 ① 的审计闭环（回编比对）才暴露。排查路径：
  ① 交易数据逐字节核对（客户端序列化正确）→ ② 两独立 RPC 读账户一致（不是缓存）→
  ③ Anchor 按 IDL 反序列化确认字段布局无误 → ④ 临时 `msg!` 打印 handler 收到的分片，
  发现 **入参在入口正确（种子校验通过）但在 handler 里被覆盖** → ⑤ 对照实验：
  同一构建下 `credit_x402_deposit` 存 64 字节**完全正确**，`refund` 坏 → 定位到
  refund 的栈占用（9 份 `SeatLedger` 局部变量 + 重活 + 尾巴上才写签名）。
  **修法**：`fund::read_seat_counters`（零拷贝逐座读计数器）+
  `required_vault_backing_iter`（同一公式、迭代版，附与切片版等价的单测）+
  I-X/转账拆成 `#[inline(never)]` 独立函数 + **签名写入移到 handler 最前面**；
  另加 `seat_ledger_counter_offsets_match_borsh` 单测把硬编码字段偏移钉死。
  修后 5/5 退款签名正确；gPA 枚举全部记录：**8 条 RefundRecord 中 4 条（修复前创建，
  桌 20/21/22/23）尾部损坏、4 条（修复后）正确；DepositRecord 3/3 全对** ——
  那 4 条历史记录的 sig 字段是错的（钱都对），审计时请以
  `/history` 的 L1 审计视图 + vault 流水为准。
  排查途中还顺手修掉两个测试基础设施问题：临时调试脚本曾按「已删除的命名账户」发座位
  （交易其实是 6010 失败，而 `confirmTransaction` 没抛错）→ 现在所有脚本都会显式检查
  `getSignatureStatuses().err`。
- **（2026-10-08）全面测试 + 优化：clippy 清零、加载并发化（大厅冷加载 15s→2s）、x402 网关加固、派发烟测常驻化**。
  **测什么**：`cargo test --workspace`（32+90+7+1+1+1 全绿）、`cargo clippy --workspace --all-targets`
  （我们三个 crate 的警告 **27 → 0**）、`npx tsc --noEmit`（web 全量类型检查）、脚本自检
  （`deal-verify-selftest` 6/6、`x402-gateway --selftest`、`replay-status 14`、`verify-actions 14`
  `ACTION_STREAM_OK`、`deploy-tables --check`）、浏览器五路由巡检（`?debug=1` 诊断面板 0 错误）
  + 引擎自检 6/6 + 审计视图渲染。
  **改了什么（每条都有实测）**：
  - **clippy 27 → 0**：core 的 `VrfSlot::fulfill` 去掉永不可达的 `Result<_, ()>`（改为直接返回
    `FulfillOutcome`，与 `retry -> RetryOutcome` 同风格，`vrf_callback` 少一个 unreachable 分支）；
    程序侧 7 处 `needless_range_loop`/7 处 `too_many_arguments` 以**模块级 allow + 理由**处理
    （座位号就是数组下标、手牌 helper 参数多是域特性），修掉 4 处 doc 缩进、1 个未用变量、1 处
    复杂类型（加 `type FullRun`）。改完 `cargo test` 全绿 → `anchor build --ignore-keys` 重建 →
    `solana program extend` + 部署 → **链上 1,212,880B 与本地逐字节一致**（slot 508,713,620）。
  - **新脚本 `scripts/program-smoke.mjs`（常驻）**：部署后派发烟测 —— 对 `top_up`（非法金额）、
    `credit_x402_deposit`（非法金额）发故意失败的调用，从交易日志里确认
    `Program log: Instruction: <Name>` 真的出现（今天 101 事故的教训固化）；再跑 `audit_table`
    （permissionless 只读）验证 I-X 守恒。实测 **PROGRAM_SMOKE_OK 3/3**。
  - **加载并发化**：`readTablesLive` 原来逐桌串行 `await`（每桌 L1+ER 一跳，ER 单跳 1–3s），
    7 桌冷加载要十几秒；改为 `mapLimit(…, 6)` 受限并发。**实测浏览器五路由渲染 1.9–3.5s**
    （大厅 15s+ → **2.0s**）。顺带记录一个测量陷阱：对局页根节点是 fragment **没有 `<main>`**，
    巡检必须用 `body.innerText`（否则误判为「页面空白」）。
  - **实时推送合并窗口**：`useLiveUpdates` 加 250ms 合并（L1 事件成批到达时只重拉一次）。
  - **审计视图**：补 `credit_x402_deposit → 「x402 入账」` 标签（CLI + 服务端两处）；`/api/l1-audit`
    加 `Cache-Control: private, max-age=10`。
  - **x402 网关加固**：报价从链上 Table 账户读买入区间（去掉硬编码 100/1000BB，避免报价与程序
    校验不一致）、新增 `GET /health`、**报价前座位预检**（座位被占/被本人占用 → 409，从源头避免
    「付了钱入不了账」）、重复入账 409、入账失败时响应里写明「付款已在 TableVault、退款需人工」。
    bs58 抽成 `scripts/lib/bs58.mjs`（与 bs58 4.0.1 逐字节一致，已对照）；`x402-pay.mjs` 现在
    **自验证审计闭环**：读回 `DepositRecord.sig` 并 base58 编码，必须等于付款交易签名
    （实测桌 21 座 0：`X402_PAY_OK`，`sigBack === paySig`）。
  - **修掉的真 bug**：`KIND_ZH` 类型注解漏 `en` 字段（`tsc` 报 4 错）；对局页页脚「数据：」标签
    重复成「ER live (authorized): ER live (authorized)」；**已全额兑现的空座仍标「待兑现」**
    （改为 `deposited > paid` 才显示 —— 实测桌 14 有余额的 8wM8 显示、清零的 Gj2p 不显示）；
    `install-idl.mjs` 只认 `\n{`（Windows `\r\n` 下报 "JSON start not found"）。
  - **端点统一**：11 个活跃脚本（replay-status / verify-actions / scan-table-ids / table-status /
    init-replay / quick-sit / cash-out-seat / check-seat-ledger / force-stand-up / sit-test-opponent /
    stage6-check-delegpayer）的 L1/ER 端点改走 `scripts/env.mjs`（`L1_URL > HELIUS_RPC >
    NEXT_PUBLIC_L1_RPC`），本地栈用户仍可用环境变量覆盖。`create-table.mjs` 的白名单提示改成
    读取 `.env.local` 并合并（不再硬编码老桌号）。
  - **新发现（如实记录）**：同一钱包占同桌第二座被链上 `credit_x402_deposit` 以
    `SameOwner`（6030）拒绝 —— 顺带证明新指令里的 §2.2/§2.3 身份规则真的在跑。这次「付款成功、
    入账被拒」在桌 20 的 TableVault 里留下 **10 tUSDC 未归属盈余**（`audit_table` 会如实报成盈余
    ≥ 0），正是设计文档 §4.3 里 `refund_x402_deposit` 待实现的场景：网关已在 400 响应里写明
    「请勿重复付款、退款需人工」，报价前预检则避免再次发生。
  **程序**：新指令 `credit_x402_deposit(idx, payer, amount, sig_lo, sig_hi)` ——
  `config.gateway` 门禁；`DepositRecord`（PDA `["x402", sig_lo, sig_hi]`，~154B，`init`
  语义防重复入账）记下付款人/桌/座/金额/时间/付款签名；座位为空按入座处理（金额与
  §2.2/§2.3 身份规则同 `sit_down`，payout 钉死，**不设 session key**——占用者之后自己
  `set_session`），已有同付款人座位按补码处理；金额须为 CENT 整数倍且 ≤ 最大买入；
  `X402DepositCredited` 事件只含公开数据。信任边界如实写进指令文档：程序读不到别人的
  交易，「谁付的钱」由网关认定，但 `DepositRecord` 的付款签名可让任何人到 L1 逐笔核对
  （正好由 ① 的 L1 审计视图承接）。设计文档 §4.3 从「延后」改写为交付状态。
  **本地模拟（零依赖，可跑）**：`scripts/x402-gateway.mjs`（402 报价 → 校验 → 入账 →
  重复 409；`FACILITATOR_URL` 未设时用本地链上校验，**facilitator 选型仍是待定项**）+
  `scripts/x402-pay.mjs`（标准客户端：ComputeBudget + TransferChecked + Memo）。
  **devnet 实测（桌 #20 座 0）**：报价 `payTo` = 该桌 `vault_auth`（USDC 直达 TableVault，
  不经运营方钱包）、最小买入 10 tUSDC → 付款 `3GbCEXrk…` → 入账 200（credit `5ujwU8hk…`、
  DepositRecord `AMGT1bPb…`）→ 链上复核：`occupant = 付款人`、`payout = 付款人`、
  `deposited_total = 10,000,000`、`paid_total = 0`、session_key 未设；重复提交同一签名 → 409。
  **顺带修掉两个真坑**（都影响本轮 15 桌部署）：
  ① `anchor build` 一直在 ID 校验上中止（`Program ID mismatch … Keypair file has E1fv…`），
  导致 `target/deploy/solpoker.so` **从未重建**：链上程序看起来「部署成功」，实际跑的是旧
  二进制（新指令派发报 `Custom:101 InstructionFallbackNotFound`，用 `sha256("global:<ix>")`
  逐字节核对 discriminator 才定位到）。处理：`anchor build --ignore-keys -p solpoker` → 校验
  `.so` 含各指令的 4 字节判别式半段 → `solana program extend` + `solana program deploy`。
  现链上程序 1,213,008B 与本地逐字节一致（slot 508,698,938），新指令派发正常（回归测试：
  非法金额返回 6014 BadBuyIn）。
  ② `scripts/install-idl.mjs` 只认 `\n{`，Windows 的 `\r\n` 下报 "JSON start not found" ——
  改为行首 `{` 正则。
- **（2026-10-08）15 桌部署脚本 + 批量部署：L1 侧全部就绪（20–34），ER 权限被 devnet ER 阻塞**。
  `scripts/deploy-tables.mjs`（配 `scripts/lib/deploy-table.mjs` 共享单桌逻辑，
  `create-table.mjs` 也改成调用它）：预设 15 桌矩阵（20–34：盲注 0.05/0.1、0.1/0.2、
  0.25/0.5、0.5/1.0 × 真人/混合/AI 三种桌型，ante = bb/10）；**按缺口续跑**（已存在的桌
  只补缺失的委托与 ER 权限）；DelegPayer 余额预检 + `--topup` 自动补币 + 白名单/crank
  参数输出。**实测**：15 桌 create_table + seats + hands + init_replay + 委托 ×15 全部成功
  （DelegPayer 实测 ≈3.18M lamports/次委托，比旧估值高 36%——已更新估算常量并写进脚本）；
  重跑三次全部走「续跑」路径（#31 补 3 个委托、#32–34 各补 15 个）。
  **被阻塞的一步**：`init_permissions`（ER）对所有桌都失败：`Custom:6010`
  （新程序下重测仍失败；L1 侧排查排除我方原因：权限 PDA 派生、8 座扫描、ACL 程序常量
  `ACLseoPoy…` 两端一致、`solana program show` 显示委托记录齐全；**旧桌 5/9/13/14 的权限
  账户也全数消失**（`0/10`），说明 devnet ER 发生过状态重置/ACL 侧变化——本会话前它们
  还在正常跑）。已按「如实记录」处理：15 桌保持 L1 就绪，权限建好即可玩（`node
  scripts/deploy-tables.mjs` 幂等续跑即补），大厅白名单暂不加 20–34 以免展示不能入座的桌。
  ER 健康快照（存档）：`solana-core 4.0.0 / magicblock-core 1.0.0 / commit cc32775`，
  ER 上程序账户已缓存为新版（1,213,056B）、ACL 程序存在（215,976B, LoaderV4）。
- **（2026-10-08）i18n：字典 + Provider + 持久化，导航/大厅/对局全部接线（中英切换实测通过）**。
  `web/lib/i18n.tsx`：zh/en 双语字典（~160 键）+ `I18nProvider`（挂在根 `Providers` 里）
  + `useI18n()`。默认语言 = 浏览器语言（`zh*` → 中文，其余 → 英文）；用户点右上角
  「EN / 中」切换后写 `localStorage("solpoker.lang")`，此后以存储值为准，并同步
  `document.documentElement.lang`。SSR 首帧恒 zh、hydration 后再切（避免 hydration
  mismatch —— 与项目既有的 `?demo=1` 处理同一套路）。`t(key, vars)` 支持 `{x}` 插值，
  缺键回退中文并 `console.warn`（开发期暴露漏配，不静默显示 key）。
  **接线范围**：导航（含切换钮）+ 大厅（英雄区徽章/统计卡/筛选/牌桌卡全部标签/我的区域/
  信任速览标题）+ 对局页（顶栏/座位牌/行动坞全部按钮与状态文案/侧栏面板/E3 离座确认/
  页脚/行动记录 feed/提交通知）。
  **实测**（浏览器，devnet-tee）：点「EN」→ 导航 `Lobby / My Agents / Hand history / Trust`、
  英雄区标题与说明、牌桌卡（`Table #5 · Waiting · Blinds · Ante · Buy-in · Seats taken 0/9`）、
  对局页（`Table #14 · Mixed · Blinds 0.10/0.20 · Hand #5 · Connect TEE · VRF idle · POT ·
  Seat 2…8 · Pending payout`）全英文；`localStorage="en"`、`<html lang="en">`，刷新保持。
  **覆盖边界（如实）**：信任页/验证页的长解释段落与 mock 页仍是中文（字典已留扩展位）。
  **顺带修复一个开发环境坑**：dev server 在跑时执行 `npm run build` 会覆盖 `.next` 的
  vendor chunk，导致 `/table/[id]` 编译期 500（`Cannot find module './vendor-chunks/viem.js'`）
  —— 处理：停 dev → 清 `.next` → 重启（CI/本地构建前先停 dev）。
- **（2026-10-08）L1 审计视图：Helius 解析历史 + 我们自己的指令解码 → `/history` 表级时间线**。
  **实测发现（决定架构的关键）**：Helius 的地址解析历史对我们程序返回
  `type/source=UNKNOWN`、`description=""`、`events={}` —— 它没有我们的 IDL，**不做语义解析**；
  它给的是「按地址聚合的完整签名 + 时间戳 + 费用 + 失败标记」。所以审计视图 =
  **Helius 解析历史（聚合/时间线）＋ 我们自己从 L1 原始交易日志解码语义**
  （anchor 每个指令打 `Program log: Instruction: <Name>`，与 IDL 对齐）。
  **落地**：
  - `scripts/l1-audit.mjs`（CLI，引擎与 web 一致）：覆盖 Table/Game/9×Seat/Replay
    共 12 个地址，按签名去重、slot 倒序取前 30，逐笔解出指令名 + tUSDC 移动量
    （token 余额正向 delta）+ 付款人 + 费用；`--json` 机器可读、`--explain <sig>`
    打印单笔原始日志（排查标签用）。
  - `web/app/api/l1-audit/route.ts`（服务端）：浏览器**不直连** Helius —— 解析历史 API
    要 key，key 只在服务端 `HELIUS_RPC`（非 `NEXT_PUBLIC_`，永远进不了 bundle）。
    15s 内存缓存；无 key 时自动降级为原始 RPC（`getSignaturesForAddress`），徽章如实标
    「原始 RPC（降级）」。
  - `/history` 新增全宽「L1 审计视图」小节：来源徽章 + 事件推送徽章（复用 ① 的 SSE tick，
    L1 有动静即刷新）+ 手动刷新；每行 = 语义徽章 / slot / 时间 / 金额 / 涉及账户 / Solscan 外链。
  **实链证据**：CLI 对桌 #14 输出 sweep 的 `CashOut`（23.75 / 35.44 tUSDC，付款人=玩家钱包）；
  浏览器 `/history` 实测渲染出「入座 20 tUSDC」「兑现 20 tUSDC」「委托 ER」「初始化复算环」等条目，
  另有若干「PER 快照/委托」条目 —— 那些是 TEE 验证者付款、只含 DLP+ComputeBudget 的
  快照/委托流量（无指令日志），标签如实区分而不是硬套成玩家动作。`npm run build` 通过。
  **边界**：玩家行动（跟注/加注/弃牌）在 ER，不在这条时间线上 —— 页面文案已写明。
- **（2026-10-08）实时推送：L1 事件 → SSE 中继 → 大厅即时刷新（无中继时自动回落轮询）**。
  中继 `scripts/helius-webhook.mjs`（零依赖 `node:http`，127.0.0.1:8787）：
  `POST /` 吃 Helius webhook（enhanced 或原始 payload 统一摘要成
  `{signature, description, slot, accounts[]}`）、`GET /events` 是 SSE 流
  （CORS `*`、keep-alive、`hello` 握手事件）、`GET /health` 报客户端与计数、
  `POST /simulate` 走同一 handler 本地造事件。前端 `web/lib/live-updates.ts`
  的 `useLiveUpdates()`：设了 `NEXT_PUBLIC_SSE_URL` 就订阅（四态
  `off/connecting/live/error`），没设保持现状轮询；大厅轮询 effect 依赖
  `live.tick` → 每条 L1 事件立即重拉，英雄区徽章如实显示
  「L1 事件推送 / 连接推送… / 轮询 8s」。**实测**：页面订阅后中继日志
  `[sse] 客户端接入（当前 1）`，`POST /simulate` →
  `[in] simulate → 1 笔 (TESTSIG1) → 广播给 1 个客户端`，页面徽章切到
  「L1 事件推送」并即时刷新（徽章由 SSE 连接状态驱动，不会假装）。
  **架构边界**：Helius 只看得到 L1——ER 交易对它不可见（实测 helius∩er=0/40
  签名），所以推送覆盖 L1 侧活动（入座/兑现/commit_game/委托/注册），牌桌上的
  行动实时性仍靠 ER 轮询。接真实 webhook：`ngrok http 8787` 后在 Helius 控制台
  把 Webhook URL 指向隧道地址（API key 只存 gitignored 的 `web/.env.local`）。
- **（2026-10-08）行动序列可验证：能验证的边界推到"每一手都与链上承诺一致"**。
  方案 A 落地（详见 `docs/design/hand-replay-design.md` §7）。**实链证据**：
  - v2 街锚点在真手上确认（桌 #14 手 #2）：`layout=v2`、`streets=0b1111`、
    `ended=0b1111`、四条街 `street_end` 摘要全部非零；
  - 规范事件 emit 部署 `4zBRP6Buv7z5…`；手 #3（已结算）实测：从 ER 交易日志解出
    **8 条规范事件**，四街各 2 条**全部闭合**、`transcript_final` 匹配 →
    Node `scripts/verify-actions.mjs` 输出 `ACTION_STREAM_OK`，浏览器
    `/history`「验证行动流」按钮显示通过 ✓；
  - **验证器不会说谎**（两次负面测试）：对 emit 之前打的手 #2（扫 123 笔交易）解出 0 条事件
    → 逐街如实报失败；对未结算的手 #3 报"proof 里没有这一手"。
  **实现要点**：① 锚点 4 处捕获（`await_street` 用 `street-1`、runout、settle、void），
  幂等先到先得；② entry 仍 504B（复用 occupants 段）→ 无迁移；③ 事件从 ER 交易日志取
  （新→旧 + 提前停止 + 8 路并发，浏览器可用）；④ 自分段：追加行动直到摘要等于
  `street_end[k]`，不需要事件带街号。
  **剩余边界**：环外（8 手以外）旧手牌无法整手复算；行动事件在 ER 交易日志里，受 RPC
  历史保留期（约一周）限制（链上锚点永久）。信任页与验证器页面文案已同步更新。
- **（2026-10-08）整手复算闭环：链上存证 → 浏览器逐张复算通过（9/9）**。
  从零建成"发牌可验证"的完整链路，**实链证据**：
  - 程序两次部署：`61hGftv1d7x…`（HandReplay 账户 + init_replay + advance 账户表）、
    `5yKznAbk…`（commit_game 带上 HandReplay + 程序扩容 20480）；
  - 7 张老桌 `init_replay` + `delegate_table[14]` 全部成功（DelegPayer 付租金）；
  - 混合桌 **#14**（0.1/0.2/ante 0.02，kind=2）由 bob（agent 身份，座 0）+
    carol（真人身份，座 1）打出一手**正常结算**的牌（手 #1，bob 19.58 → 39.4）；
  - 链上 `HandReplay` 该手条目：`salt_digest=e488fb50…741e`、四街 `draw_digest`
    （k0=fb83…bbe / k1=8ed1…f63 / k2=e75b…8c9 / k3=c203…e47d）、`occupants` 两个、
    `vrf_attempt_used=[1,1,1,1,0]`、`streets_used=0b1111`；
  - `/history`「整手复算（52 张逐张比对）」**实测通过：逐张 9/9**（单挑 = 4 底牌 + 5 公共牌）；
    `salt_digest` 独立复算（occupants + 盐）也命中链上值。
  验证链条：链上盐与 VRF → 链上四条街首摘要 → 每张牌重新推导并与链上 proof 逐张相等。
  **过程中修掉**：`used` 位图 Number 起步与 BigInt 混型崩溃；页面把 table PDA / occupants
  传成 base58（引擎要 hex，两次同类错误，最后用探针脚本按 "replay.occupants +
  proof.occupancy_ids + secrets.salts + table + hand_id + hand_mask" 逐字节复现链上值定位）；
  `proof`/`secrets` 是委托账户而页面只读 L1（改为 ER 优先、L1 回落）。
  **顺带完成**：僵尸座位自动清算（crank sweep，实测清 8+ 座位、退回 40+ tUSDC）、
  crank 并行读提速、VRF 超时重试（`retry_vrf`，把"AwaitSeed 必作废"变成"打完三条街"）、
  `quick-sit.mjs`（真人身份入座）、座位死态成因记录。
  **仍差**：① replay 环（8 手）外的旧手牌无法整手复算；②「事件流 → transcript_final」
  无法独立验证（事件流无界、未存证，见 hand-replay-design.md 新增章节）；
  ③ 座位死态的程序级修复（`cash_out` 的释放条件依赖 L1 快照，快照陈旧时座位卡住 ——
  当前用"先 commit 再 sweep"的运营手段绕开）。
- **（2026-10-08）HandReplay：整手复算输入上链（程序侧落地 + **已部署 devnet**）**。
  用户选方案 B（程序升级）。设计见 `docs/design/hand-replay-design.md`：整手复算真正缺的
  只有两个**中间摘要** —— `salt_digest` 与每条街**第一张牌抽取前**的 transcript 摘要
  （街内后续牌的前置摘要可由牌序 + HoleDealt/BoardDealt 事件确定性重建，所以有界）。
  **关键决策：新建独立账户 `HandReplay`（PDA `["replay", table]`，ring 8，每手 485B，
  账户 4,048B）而不是扩 HandProof/Deck** —— 扩既有布局会让所有活桌失效；独立账户可给现有桌
  补一次 `init_replay` 就开始记录，历史手牌只是「没有 replay entry」。捕获放在发牌过程中
  （`capture_draw_digest` 在每条街第一张牌前调），所以 Deck 不需要加字段。
  **本提交落地**（`cargo test --workspace` 全绿：solpoker 32 + core 90 + 7 + 1 + 1）：
  `state.rs` 的 `HandReplay`/`ReplayEntry` + 尺寸钉子测试（504B/条、账户 4,048、槽位
  `hand_id % 8`）；`hand.rs` 的 `capture_draw_digest`/`finalize_replay` + 3 个捕获点
  （preflop/flop-turn-river/runout）+ 在 `write_proof_entry` 收尾写入；`lib.rs` 的
  `Advance.hand_replay` 账户与 `init_replay` 指令（幂等，L1 建账户）；`instructions/init_replay.rs`。
  **规范测试 `replay_entry_rebuilds_every_drawn_card`**：打完一手 → 只用 replay（draw_digest +
  salt_digest + occupants）+ HandSecrets（VRF/盐）+ HandProof（board/hole）把每一张牌重新抽出，
  逐张比中（含 salt_digest 从 occupants+盐的独立复算）。
  **下一步（必须一起做，否则现有工具会挂）**：① `Advance` 新增了**必填**账户 `hand_replay` ——
  部署新程序后，crank、agent runner、e2e/模拟脚本、`sit-test` 等所有 `advance` 调用点都要传它；
  ② 构建 + 部署 devnet + 给现有桌补 `init_replay`（+ 委托）+ 跑一手 e2e 产出真 replay 数据；
  ③ JS 侧：`chain-read.readHandReplay`、`deal-verify.dealFromReplay`、`/history` 的
  「整手复算 52/52 ✓」按钮（引擎已就绪，只差入口函数）。
- **（2026-10-08）发牌复算引擎移植 + 向量自证整齐（verify_hand 的地基）**。
  新增 `web/lib/deal-verify.mjs`：`reference/solpoker_deal.py` 的 JS 移植（salt_commitment /
  salt_digest / street_seed / first_button / encode_event 13 种事件 / transcript_init+append /
  draw_card 拒绝采样 / deal_hand 整手发牌），**crypto 可插拔**（浏览器用 WebCrypto、
  Node 用 `web/lib/deal-verify-node.mjs` 的 node:crypto）——同一份算法，两条后端，不会漂移。
  注意：`deal-verify.mjs` 里**不能出现 `node:` 前缀 import**（webpack 会 `UnhandledSchemeError`
  直接 500，实测踩过），所以 Node 后端单独成文件。
  **自证整齐**：`scripts/agent/deal-verify-selftest.mjs` 跑 `vectors/v1/*.json` 六个 Stage-4 向量
  （单挑/3人/满桌9人/庄位轮转/拒绝采样重抽/全下 runout），逐字段比对 board / board_src / button /
  draws（含 retry 计数）/ hole / salt_digest / 各街 seed / transcript_final —— **6/6 与 Rust/Python
  参考实现逐字节一致**（`DEAL_VERIFY_SELFTEST_OK`）。同一套引擎也搬进了 `/history` 页面：
  「复算引擎自检」按钮用**页面里这份代码 + 浏览器 WebCrypto** 当场跑 6 个向量，实测 6/6 PASS。
  **然后是一个必须讲清楚的结论**：整手 52 张复算除了盐与 VRF（HandSecrets 有）之外，还需要
  **开局筹码快照**与**下注事件流**（盲注、每次行动都进 transcript，而 transcript_digest 是每张牌的
  抽取输入）。v1 的 HandProof 只存了事件流的**最终哈希**（设计 §8.7 的记档偏差："v1 不存完整事件
  字节"），哈希不可逆 —— 所以历史手牌无法从当前链上账户整手复算，这不是实现没做，是数据没上链。
  两条补齐路线（待用户拍板）：**A. 记录器**（crank 或第三方在对局进行时记录每手输入成 JSON 证据包，
  用同一引擎复算并与链上 HandProof/HandSecrets 对锚——记录器无法造假，只能选择不给数据）；
  **B. 程序升级**（把开局筹码与事件流写进 proof entry，§8.7 本来就打算公开）。
  页面上两个面板都写明了现状，并给出「已能验证 / 待补齐 / 链上锚点齐备」三格小结。
- **（2026-10-08）UI 接真实数据：五个正式页面全部落地（/、/table/[id]、/agents、/trust、/history）**。
  视觉稿经用户确认（"可以非常好"）后按「大厅 → 对局页 → Agent → 信任 → 手牌验证」逐屏接入链上数据。
  **主题**：`web/app/mock/mock.css` → `web/app/theme.css` 挂到**根布局**（全局 Tailwind + Solana
  设计系统），`mock/ui.tsx` → `web/components/ui.tsx` 供正式页复用；旧 `/`（738 行单页）与旧
  `/trust` 删除，`table.css` 删除。
  **链上读层 `web/lib/chain-read.ts`（新增，全部实测核对）**：SeatLedger 203B
  （occupant@41/occupancy_id@73/kind@81/agent_owner@82/payout@154/deposited@186/paid@194）、
  AgentProfile 211B（owner@40/status@73/name@74）、HandProof 3728B（entries[16]×232B @8，head@3720，
  `head % 16` 环形缓冲、HandSecrets 同槽 456B）、Game 1552B；`findMySeats`/`findAgentSeats`
  用 gPA（dataSize + memcmp@41 / @82）一次拿到「我的座位 / 我 agent 的座位」。
  **重要发现：ER（devnet-tee）对公开账户允许无 token 读取**（game 账户 tokenless 200；
  PER 私有 PlayerHand 无 token 返回 null——隐私边界实测成立）。因此大厅/观战/历史页读的是
  **ER 实时状态**（回落 L1 快照），只有行动/自己的底牌才需要 TEE 会话。
  **大厅 `/`**：真实桌列表（类型/盲注/买入区间=bb 倍数×bb/在座/待兑现/AI 数）、实时手号与底池、
  我的座位（gPA）、我的 agent 卡、MCP 接入卡、信任速览。
  **对局页 `/table/[id]`**（旧页交易路径完整移植：Privy 单通道钱包、TEE 会话门、session key、
  ER 交易纪律、入座一笔签名含 ATA+预充+买入、兑现/离座）：新设计 + 真实 9 座（我的座位恒在正下方）、
  座位三态（Seated / Left「已离座·待兑现」/ 空座可点选）、下注筹码、行动者倒计时圆环、
  行动坞（跟注额/加注滑杆/½¾池与底池预设/全下，金额走 parseUsdcInput）、右侧栏（底牌/本手信息/
  发牌证明：事件链+VRF+盐提交揭示状态/行动记录：由观测到的状态变化生成，不造假）、
  离座确认（E3）、混合桌 X11 确认（入座面板内勾选）、`?demo=1` 免登录排版走查。
  **Agent 页 `/agents`**：AgentProfile 列表（状态/收益去向/在座桌号）+ 主人权限操作
  （暂停/恢复/吊销/改 payout，都是 L1 钱包签名）+ **浏览器内注册向导**（本地生成密钥 →
  下载 JSON → 双签注册）——钱包不支持部分签名交易时回落到 CLI。
  **信任页 `/trust`**：按设计 §16 八项重写（每项三栏 + 真实链接：repo/solscan/TEE 文档），
  加 attestation 与「诚实边界」。
  **手牌验证 `/history`**：HandProof 环形缓冲逐手展示（牌面/每座 delta/抽水/事件链摘要/hand_mask），
  **当场复算**（浏览器 WebCrypto）：守恒 Σdeltas = −rake（真实数据已验证：−0.22+0.21 = −0.01 ✓）、
  salt_digest、逐街 seed；对**当前手**还能把盐承诺与链上 Game.seats[i].salt_commit 逐一比对。
  明确写出「整手 52 张复算还需要重放 L1 交易历史（transcript_digest 是每张牌的抽取输入）」——
  这是 `verify_hand` 工具的下一步，参考 `reference/solpoker_deal.py`。
  **修复**：① `Array.from({length:9}).filter((i)=>…)` 里 `i` 是元素（undefined）不是索引
  → `occupancyIds[undefined].toString()` 崩溃（历史页选中真实手牌时报「Cannot read properties
  of undefined」）；② `?demo=1` 在 render 期读 `window.location.search` 造成 hydration 失败
  （改为 effect 内设置）；③ 买入区间显示用 `minBuyBb/100` 算错（应为 `minBuyBb × bb`）；
  ④ 座位 status=2（Left）此前被当成在座（改为独立「已离座·待兑现」态 + 在座只数 status=1）；
  ⑤ 错误边界加「显示堆栈」，新增 `?debug=1` 诊断面板（捕获 window 错误/unhandledrejection/
  console.error + 边界错误）。
  **验证**：`npx tsc --noEmit` 干净（`.next/types` 里指向已删除旧页的陈旧条目除外）；
  10 条路由全部 200；浏览器实测：大厅真实 7 桌（SEATED 5 / ESCROW 100.00 tUSDC）、
  对局页真实 3 座 + ER 实时标注、历史页真实 4 手（#1/#2/#5/#6）且守恒复算通过、无 hydration/运行时错误。
- **（2026-10-08）UI 重设计 · 视觉稿（Solana 品牌配色 + 赌场拟物结构，等用户过目后接真实数据）**。
  按用户拍板的四方向落地：四模块全做（大厅+导航 IA / 对局页重做 / Agent 管理 /
  手牌历史+验证器）、Tailwind v4 + shadcn 依赖链、混合桌座位不固定（不动程序）；
  **色调以 Solana 科技感为主**（用户提供官方 Solana Brand Assets 参照）——拟物结构
  保留（毡桌/筹码/扑克牌/座位），材质换成深空+霓虹玻璃。
  配色全部取自官方 brandkit（`Solana Brand Assets/Color Palettes` + `Gradient`，
  用 System.Drawing 采样核对）：主色 #9945FF / #14F195，招牌渐变 133°
  #9945FF 8% → #8752F3 30% → #5497D5 50% → #43B4CA 60% → #28E0B9 72% → #19FB9B 97%
  （与 logomark 渐变定义逐字节一致），副色 Cyan #00DAFF / Pink #EB54BC /
  Orange #FF623A / Lime #E8F180 / Lavender #B6B0FF。导航品牌标记直接用官方
  Solana Logomark SVG（三斜杠渐变，内联为 `SolMark` 组件）。**ABC Diatype 是
  商业授权字体，未随仓库分发**（字体栈用系统近似；如需上字体需单独谈授权）。
  做法是**先在 `/mock/*` 出可点视觉稿**，真实 app 在 `/` 完全不受影响（Tailwind
  只在 mock 路由的 layout 里加载；根路由继续用旧 CSS）。新增：
  `web/app/mock/mock.css`（设计系统：@theme tokens accent(紫)/mint(绿)/cyanx/
  felt(深紫绒面)/frame(黑曜石)/ink(深空)/mist(冷白)/chip + 拟物基元
  `.felt`(噪点+细网格绒面)/`.rail`(黑曜石+渐变描边+霓虹辉光)/`.rail-quiet`(卡片静音版)/
  `.pcard`(白牌面+渐变斜纹牌背)/`.chip`(Solana 配色筹码)/`.holo`(渐变描边玻璃铭牌)/
  `.btn-brand`(招牌渐变 CTA)/`.btn-glass`/`.btn-mint`/`.btn-danger`(品牌橙)/`.btn-ghost`
  + `bg-brand`/`text-brand`/`ring-brand` 工具类）、`mock/{layout,nav,ui,data}.tsx`，
  五屏：`/mock/lobby`（英雄条+桌卡片/9 座迷你桌预览/筛选/我的区+Agent 卡/MCP 接入卡/
  信任速览）、`/mock/table`（椭圆毡桌+9 座椭圆定位（我的座位固定正下方）+下注筹码+
  倒计时圆环+行动坞（滑杆+½¾池预设）+右侧栏（底牌/本手信息/发牌证明/行动记录）+
  弹窗示例：X11 混合桌入座确认、结算、E3 离座、A7 自动离座）、`/mock/agents`
  （Agent 卡+注册向导+MCP 配置+安全边界）、`/mock/history`（手牌列表+详情+
  发牌证明+事件流+三步验证器说明）、`/mock/trust`（严格按 §16 八项，每项三栏 +
  attestation + 诚实边界）。手机宽度已适配（大厅零横向溢出；对局页横向滚动容器，
  立式桌布局待定）。浏览器实测：五屏渲染正常（截图存档），lobby 筛选交互
  （hydration）正常，375px 宽 scrollWidth == clientWidth。
  **未做**：i18n 接线（导航 ZH/EN 为视觉占位）、接真实链上数据、移动端对局页专用布局。
  dev server 在 3100。**修复（同日，用户指出导航区有两条丑东西）**：导航链接区
  内容 591px 超出容器 571px（桌面宽也一样），浏览器因此画出原生横向滚动条
  （浅色轨道 + 右端方块），且末尾 "TRUST" 副标被裁成一块紫色残影。修法：收紧
  链接内边距与英文副标（1280–1920 全部 overflow=0）+ 新增 `.no-bar`
  （`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`）让窄屏仍可滑动
  但不显示滚动条；牌桌的横向滚动容器同样处理。**顺带修掉一个更严重的 bug**：
  mock 布局根节点的 `overflow-x-hidden` 会把容器变成滚动容器，导致吸顶导航
  `position:sticky` 失效（滚动后导航消失）——改用 `overflow-x: clip`
  （裁剪但不建立滚动容器），实测 scrollY=700 时 header top=0。
- **（2026-10-08）top_up 全链路**（Stage 8 打磨）：`ixTopUp` + MCP `top_up`
  工具 + **crank 新增 `apply_deposits` 分支**（此前没有任何角色把 L1 补码计入
  ER —— 补码会静默躺在账本上）。实链验收 `TOPUP_TEST_OK`：L1 入金 4 USDC →
  crank 785ms 内计入 ER（筹码 20 → 24）。测试脚本
  `scripts/agent/topup-test.mjs`。
- **（2026-10-07）Stage 8 第二块：MCP 通道 ——「用户接自己的 AI」**。新增
  `scripts/agent/`：`client.mjs`（共享客户端层：连接/解码/指令构建/档案与
  盐持久化，CLI 与 MCP 共用）、`executor.mjs`（**牌桌执行器**：自动盐承诺/
  揭示、回合与截止跟踪、§5.5 兜底（剩 3 秒 check/fold）、掉线自动重新鉴权）、
  `mcp-server.mjs`（**MCP 服务，stdio**：官方 SDK 1.32.1 + zod，暴露
  `wallet_status/list_tables/get_table_state/wait_for_turn/act/sit_down/
  leave/leave_all/get_hand_history` 九个工具 + `solpoker://rules/{zh,en}`
  资源 + `play-nlhe` 提示词；刻意不提供签名/转账/密钥/限额类工具）、
  `mcp-smoke.mjs`（标准 MCP 客户端冒烟：入座→长轮询→act→leave 全流程）。
  用户只需在 Claude Desktop / Cursor 等 MCP 客户端里配置一行 command，即可
  把自己的 LLM 接上桌；协议细节全部由执行器处理，LLM 只做决策。
  **实链验收（MCP_SMOKE_OK）**：bob 经 MCP 入座混合桌 #11 → 执行器自动
  承诺/揭示 → 两手真实对局（河牌池打到 1.68 USDC）→ leave 自动 stand_up +
  等 commit + cash_out 到主人 payout（39.99 → 58.93）。
  **产品化修复随行**：leave/sit_down 幂等（含「自动离座但未兑现」僵尸态
  的明确指引：先 leave 兑现再入座）；create-table 默认超时调整为生产值
  （commit 60s / reveal 30s——10s 会让客户端短暂掉线被 A7 误清场）；
  MCP 工具错误改为可读状态返回。**未做**：x402 付费入座、`verify_hand`
  复算工具、`top_up` 工具、`set_style`/hybrid 模式、每手 X12 复查。
- **（2026-10-07）Stage 8 第一块：AgentProfile 链上身份 + 三类桌与同主人规则**。
  新增：`AgentProfile`（PDA ["agent", agent_pubkey]，§2.1 全字段）+ 9 条指令
  （register/update/set_payout/pause/resume/revoke/set_agent_status +
  allow_owner/remove_owner KYC 白名单，主网由 `ProgramConfig.flags` 位门禁）、
  `fund::check_sit_identity`（三类桌 0/1/2 + §2.3 同主人规则，纯函数 3 组单测）、
  `sit_down` 重构（其余 8 个座位账本随交易传入做全桌去重扫描；传 Active
  AgentProfile 即以 agent 入席——ledger 记 kind=Agent、agent_owner、payout
  按 X7）。所有调用方（e2e/sim/opponent/agent runner/web）同步更新。
  **实链验收**：alice/bob/carol 注册（bob 主人为独立新钱包并付租金）→
  alice、bob 以 kind=Agent 入座混合桌 #11（链上逐字段核对）、人类座位同席
  → carol（与 alice 同主人）被拒 6029 SameOwner、真人在 AI 桌 #12 被拒
  6007 KindNotAllowed → alice vs bob 三手（含一手因人类缺盐作废、人类
  3 strike 自动离座）→ 各自兑现到**主人**的 payout ATA（X7），守恒精确
  （39.98 + 0.02 rake = 40.00）。**未做（后续）**：每手开始的 X12 状态复查
  （暂停/封禁后下一手自动离座——需把 profile 状态镜像进 ER 路径）、
  x402 付费入座、MCP/LLM 决策模式。踩坑记录：create_table 的 vault ATA 由
  ctx `init` 创建，预建会撞 IllegalOwner 且 ATA 无法回收（该桌号报废）——
  create-table.mjs 已加防护；DelegPayer 每张新桌 14 次委托需 ~0.02 SOL，
  脚本已提示。新桌：**#11 混合桌 / #12 AI-only 桌**（各 0.1/0.2 ante 0.02）。
- **（2026-10-07）Agent Runner：机器人上桌打牌（Stage 8 的第一块）**。
  `scripts/agent/` 三个模块：`eval.mjs`（7 选 5 评估器，`eval.rs` 的 JS
  移植，自测与 Rust 语义对拍 9/9）、`strategy.mjs`（默认启发式策略：翻前
  牌力分级 + 翻后牌力/底池赔率，BigInt 精确金额；`--strategy path.mjs`
  可换自定义策略）、`agent.mjs`（CLI：new/fund/sit/run/stand/status，盐
  持久化 + 崩溃重启恢复 + 自动重新鉴权）。agent 用自己密钥对直签全部 ER
  动作（设计 §2.2）。**实链验收**：alice vs bob 在桌 #9 连续对打 6+ 手
  （盐承诺/揭示、三条街行动、弃牌与摊牌、筹码/rake 精确守恒、
  `--hands` 退出、`stand` 自动兑现全部通过）。**现状边界（诚实清单）**：
  座位仍记 kind=Human（AgentProfile/agent-only 桌/同主人拦截未做）；x402
  付费入座未做；决策模式仅 scripted，LLM/MCP 与支出上限属 Stage 8 后续。
  详见 `scripts/agent/README.md`。
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
