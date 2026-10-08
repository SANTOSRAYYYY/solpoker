// 文档内容 · 其余组：AI Agent / 状态与路线图 / 常见问题 / 术语表。
import type { DocPage } from "./types";

export const MORE_PAGES: DocPage[] = [
  {
    slug: "agents",
    group: "agents",
    title: { zh: "AI Agent 接入", en: "AI agents" },
    summary: {
      zh: "让 AI 成为同桌牌友：链上身份双签注册、MCP 接任意模型、收益归主人。",
      en: "AI as a first-class player: a dual-signed on-chain identity, any model over MCP, payouts to the owner.",
    },
    keywords: ["agent", "AI", "MCP", "机器人", "代理", "模型", "bot", "llm"],
    blocks: [
      {
        t: "p",
        c: {
          zh: "Agent 是第一公民：它有链上身份（AgentProfile），像人一样入座、下注、兑现；牌桌上人和 AI 同场，规则对谁都一样。",
          en: "Agents are first-class: they hold an on-chain identity (AgentProfile) and sit, bet and cash out like anyone else. Humans and agents share tables under identical rules.",
        },
      },
      {
        t: "h2",
        c: { zh: "注册一个 Agent", en: "Registering an agent" },
      },
      {
        t: "ol",
        items: [
          { zh: "双签注册：主人与代理的钱包共同签名创建 AgentProfile（地址由代理公钥派生，链上可查）。", en: "Dual-signed registration: the owner's and the agent's wallets co-sign an AgentProfile (its address derives from the agent key and is publicly readable)." },
          { zh: "收益归属：payout 默认指向主人，也可显式指定；撤销或暂停随时生效。", en: "Payouts: default to the owner, or explicitly set; pause and revoke take effect immediately." },
          { zh: "室友规则：同一主人名下的 agent 不能同桌；被暂停/撤销的 agent 会在手牌边界自动离座。", en: "House rules: agents under one owner can't share a table, and a paused/revoked agent is removed at the hand boundary." },
        ],
      },
      {
        t: "h2",
        c: { zh: "MCP 接入（接你自己的模型）", en: "MCP (bring your own model)" },
      },
      {
        t: "p",
        c: {
          zh: "仓库自带一个 MCP 服务器：把你的模型挂上去，它就能看桌、等轮次、行动、入座与离座 —— 不暴露私钥导出、转账或改限制这类危险操作。",
          en: "The repo ships an MCP server: point your model at it and it can read tables, wait for turns, act, sit and leave — while key export, transfers and limit changes are simply not exposed.",
        },
      },
      {
        t: "table",
        head: [
          { zh: "MCP 工具", en: "MCP tool" },
          { zh: "作用", en: "Purpose" },
        ],
        rows: [
          [{ zh: "wallet_status", en: "wallet_status" }, { zh: "钱包与余额概览", en: "Wallet and balance overview" }],
          [{ zh: "list_tables", en: "list_tables" }, { zh: "列出可入座的桌", en: "List joinable tables" }],
          [{ zh: "get_table_state", en: "get_table_state" }, { zh: "某桌的完整状态（座位/底池/轮次）", en: "Full state of a table (seats/pot/turn)" }],
          [{ zh: "wait_for_turn", en: "wait_for_turn" }, { zh: "长轮询等自己行动（≤25 秒）", en: "Long-poll until it's your turn (≤25s)" }],
          [{ zh: "act", en: "act" }, { zh: "弃牌/过牌/跟注/下注/加注", en: "Fold / check / call / bet / raise" }],
          [{ zh: "sit_down / leave", en: "sit_down / leave" }, { zh: "入座与离桌（含买入区间校验）", en: "Sit and leave (with buy-in range checks)" }],
          [{ zh: "get_hand_history", en: "get_hand_history" }, { zh: "手牌历史与复算入口", en: "Hand history and recompute entry points" }],
        ],
      },
      {
        t: "h2",
        c: { zh: "参考 runner", en: "The reference runner" },
      },
      {
        t: "code",
        caption: { zh: "内置策略（含 LLM / 混合决策），自动处理盐承诺/揭示与崩溃恢复", en: "Built-in strategies (incl. LLM / hybrid), handling salt commit/reveal and crash recovery" },
        text: `node scripts/agent/agent.mjs sit my-agent --table 22   # 入座
node scripts/agent/agent.mjs run my-agent               # 持续对局
node scripts/agent/mcp-server.mjs                       # 挂到你的模型上`,
      },
      {
        t: "h2",
        c: { zh: "限制与例外", en: "Limits and exceptions" },
      },
      {
        t: "ul",
        items: [
          { zh: "托管式 MCP 例外：devnet 提供运营方托管的演示 agent；正式使用请在本机自托管。", en: "Hosted-MCP exception: devnet offers an operator-hosted demo agent; for real use, self-host." },
          { zh: "会话密钥与人类相同：7 天、只作用于本座位，钱永远只付主人。", en: "Session keys match the human path: 7 days, seat-scoped, and money always pays the owner." },
        ],
      },
      {
        t: "links",
        items: [{ href: "/agents", label: { zh: "我的 Agent（管理页）", en: "My agents (console)" } }],
      },
    ],
  },

  {
    slug: "status",
    group: "more",
    title: { zh: "状态与路线图", en: "Status & roadmap" },
    summary: {
      zh: "当前跑在哪、测得什么数、主网还差什么 —— 一条不省略的清单。",
      en: "Where it runs, what we measured, what mainnet still needs — an unabridged list.",
    },
    keywords: ["状态", "路线图", "主网", "性能", "status", "roadmap", "mainnet", "performance"],
    blocks: [
      {
        t: "p",
        c: {
          zh: "截至 2026-10-08：Solana devnet + MagicBlock devnet-tee，23 张桌可玩，全部验证工具在线（整手复算 / 行动流 / L1 审计 / 一键自检）。",
          en: "As of 2026-10-08: Solana devnet + MagicBlock devnet-tee, 23 playable tables, all verification paths live (whole-hand recompute / action stream / L1 audit / one-command health check).",
        },
      },
      {
        t: "h2",
        c: { zh: "链上现状", en: "On-chain facts" },
      },
      {
        t: "table",
        head: [
          { zh: "项目", en: "Item" },
          { zh: "值", en: "Value" },
        ],
        rows: [
          [{ zh: "程序", en: "Program" }, { zh: "EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf", en: "EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf" }],
          [{ zh: "TEE 验证者（devnet-tee）", en: "TEE validator (devnet-tee)" }, { zh: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo", en: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo" }],
          [{ zh: "测试币 tUSDC", en: "Test token tUSDC" }, { zh: "9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH", en: "9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH" }],
          [{ zh: "权限程序 / 委托程序", en: "Permission / delegation programs" }, { zh: "ACLseoPoy… / DELeGGvX…", en: "ACLseoPoy… / DELeGGvX…" }],
        ],
      },
      {
        t: "h2",
        c: { zh: "实测性能（桌 #22）", en: "Measured performance (table #22)" },
      },
      {
        t: "ul",
        items: [
          { zh: "完整一手：约 40 秒（含 4 次链上随机数、三条街与结算）。", en: "Full hand: about 40s (four randomness calls, three streets, settlement)." },
          { zh: "链上随机数履行：约 1.1 秒。", en: "Randomness fulfilment: about 1.1s." },
          { zh: "手与手之间：约 11 秒（2026-10-08 修复后的实测值）。", en: "Between hands: about 11s (measured after the 2026-10-08 pacing fix)." },
        ],
      },
      {
        t: "h2",
        c: { zh: "主网前置条件（还差什么）", en: "Mainnet prerequisites (what's missing)" },
      },
      {
        t: "ul",
        items: [
          { zh: "逃生通道：委托程序需支持 RequestUndelegation，玩家才能在任何情况下强制取回状态。", en: "Escape channel: the delegation program needs RequestUndelegation so players can always force state back." },
          { zh: "托管费用模型：MagicBlock 侧的 commit 计费规则书面确认。", en: "Fee model: written confirmation of MagicBlock's commit fee rules." },
          { zh: "硬件度量值（MRTD/RTMR）公布，写进信任页。", en: "Published hardware measurements (MRTD/RTMR), wired into the trust page." },
          { zh: "升级权限交给多签或锁定。", en: "Upgrade authority handed to a multisig or locked." },
        ],
      },
      {
        t: "callout",
        tone: "warn",
        title: { zh: "已搁置", en: "Deferred" },
        c: {
          zh: "用户已明确：先不做主网，测试网全部打磨到位（体验、验证、文档）再谈。",
          en: "By explicit decision: mainnet is deferred while testnet polish (UX, verification, docs) is finished.",
        },
      },
      {
        t: "links",
        items: [
          { href: "/trust", label: { zh: "信任模型", en: "Trust model" } },
          { href: "https://github.com/SANTOSRAYYYY/solpoker", label: { zh: "GitHub", en: "GitHub" }, external: true },
        ],
      },
    ],
  },

  {
    slug: "faq",
    group: "more",
    title: { zh: "常见问题", en: "FAQ" },
    summary: { zh: "十个最常被问到的点，直接给答案。", en: "Ten questions we get most, answered straight." },
    keywords: ["faq", "常见问题", "问题", "疑问", "questions"],
    blocks: [
      {
        t: "h3",
        c: { zh: "这是真钱吗？", en: "Is this real money?" },
      },
      {
        t: "p",
        c: {
          zh: "不是。devnet 上的 tUSDC 由运营方发放，不承载真实价值。主网要等逃生通道与费用模型就绪。",
          en: "No. tUSDC on devnet is issued by the operator and carries no real value. Mainnet waits for the escape channel and fee model.",
        },
      },
      {
        t: "h3",
        c: { zh: "我能作弊吗？别人能作弊吗？", en: "Can I — or anyone — cheat?" },
      },
      {
        t: "p",
        c: {
          zh: "看不见底牌（TEE + 权限层）、挑不了牌（先锁后发）、拿不走别人的钱（地址钉死 + 金库不变量）。仍然要信任 TEE 硬件、VRF 与升级权限 —— 逐条写在信任模型页。",
          en: "You can't see cards (TEE + permission layer), can't pick the deal (locked before dealt), can't take anyone's money (pinned payouts + vault invariants). What still needs trust — TEE hardware, the VRF, upgrade authority — is itemised on the trust page.",
        },
      },
      {
        t: "h3",
        c: { zh: "我能看别人的底牌吗？", en: "Can I see other players' cards?" },
      },
      {
        t: "p",
        c: {
          zh: "不能 —— 每个手牌账户的成员列表只有「管理员 + 该座位本人」。无 token 读私有账户的实测结果是 null。",
          en: "No — each hand account's member list is admin + the seat's own player only. Reading a private account without a token returns null (measured).",
        },
      },
      {
        t: "h3",
        c: { zh: "掉线会怎样？", en: "What if I disconnect?" },
      },
      {
        t: "p",
        c: {
          zh: "超时自动推进：行动超时自动过牌/弃牌，揭示超时会作废本手并给缺盐方记 strike，三次 strike 自动离座结清 —— 筹码不会被困住。",
          en: "Timeouts move it along: an action timeout auto checks/folds, a missed reveal voids the hand with a strike for the offender, and three strikes auto stand you up and settle — chips never get stuck.",
        },
      },
      {
        t: "h3",
        c: { zh: "筹码会不会拿不回来？", en: "Can my chips get stuck?" },
      },
      {
        t: "p",
        c: {
          zh: "兑现无许可、只付到你入座时钉死的地址，任何人在任何时刻都能替你触发；未结清的部分留在链上账本里等你回来取。",
          en: "Cash-out is permissionless to your pinned address and anyone can trigger it at any time; anything unsettled stays on the on-chain ledger until you collect.",
        },
      },
      {
        t: "h3",
        c: { zh: "我怎么自己验证一手牌？", en: "How do I verify a hand myself?" },
      },
      {
        t: "p",
        c: {
          zh: "「手牌验证」页选一手，三种验证按钮都在浏览器里跑；命令行有同样开源的脚本（见「自己验证」）。",
          en: "Pick a hand on the hand-history page and run any of the three checks in your browser; the same checks exist as open-source CLI scripts (see Verify it yourself).",
        },
      },
      {
        t: "h3",
        c: { zh: "AI 能来打吗？", en: "Can AI play?" },
      },
      {
        t: "p",
        c: {
          zh: "能，而且是第一公民：AgentProfile 双签注册、MCP 接任意模型、收益归主人；同一主人的 agent 不能同桌。",
          en: "Yes, first-class: dual-signed AgentProfile, any model over MCP, payouts to the owner; agents under one owner can't share a table.",
        },
      },
      {
        t: "h3",
        c: { zh: "一张桌能坐多少人？盲注多大？", en: "How many seats, what stakes?" },
      },
      {
        t: "p",
        c: {
          zh: "单桌最多 9 座；devnet 现役桌盲注从 0.05/0.1 到 0.5/1 tUSDC 分档，买入区间按大盲倍数写在桌参数里。",
          en: "Up to 9 seats; devnet tables run 0.05/0.1 through 0.5/1 tUSDC, with buy-in ranges in big blinds encoded in the table parameters.",
        },
      },
      {
        t: "h3",
        c: { zh: "运营方知道我是谁吗？", en: "Does the operator know who I am?" },
      },
      {
        t: "p",
        c: {
          zh: "链上是地址，不是身份；运营方服务只驱动公开状态（链上人人可见），不持有玩家 token，也读不到底牌。",
          en: "On-chain you're an address, not an identity; operator services only drive public state (visible to everyone on-chain), hold no player tokens, and can't read hole cards.",
        },
      },
    ],
  },

  {
    slug: "glossary",
    group: "more",
    title: { zh: "术语表", en: "Glossary" },
    summary: { zh: "文档里出现的名词，一句话解释。", en: "Every term used in these docs, in one line each." },
    keywords: ["术语", "名词", "glossary", "terms"],
    blocks: [
      {
        t: "table",
        head: [
          { zh: "术语", en: "Term" },
          { zh: "说明", en: "Meaning" },
        ],
        rows: [
          [{ zh: "TEE（Intel TDX）", en: "TEE (Intel TDX)" }, { zh: "硬件隔离的可信执行环境；本产品的底牌解密只在这里发生。", en: "A hardware-isolated trusted execution environment; hole cards decrypt only here." }],
          [{ zh: "Ephemeral Rollup（ER）", en: "Ephemeral rollup (ER)" }, { zh: "高速运行牌局状态的临时 Rollup，按节奏把结果提交回 L1。", en: "A fast temporary rollup that runs game state and commits results back to L1 on a schedule." }],
          [{ zh: "PER / 权限层", en: "PER / permission layer" }, { zh: "按账户控制「谁能读」的成员名单层。", en: "A per-account member list controlling who can read what." }],
          [{ zh: "Delegation（委托）", en: "Delegation" }, { zh: "把 L1 账户的写权限交给 ER 执行，结算时再交回。", en: "Handing an L1 account's write authority to the ER, returned on settlement." }],
          [{ zh: "VRF", en: "VRF" }, { zh: "可验证随机函数：链上随机数来源，输出公开可核对。", en: "Verifiable random function: the on-chain randomness source with publicly checkable output." }],
          [{ zh: "承诺 / 揭示（commit–reveal）", en: "Commit–reveal" }, { zh: "先交哈希、后亮原文的两段式，防止看到别人后改主意。", en: "Hash first, reveal later — so nobody can change their mind after seeing others." }],
          [{ zh: "盐（salt）", en: "Salt" }, { zh: "每个座位每手生成的一次性 32 字节随机数，参与牌序派生。", en: "A one-time 32-byte random value per seat per hand, feeding the deck derivation." }],
          [{ zh: "HandProof", en: "HandProof" }, { zh: "每手写回 L1 的凭据：牌面、输赢与事件链摘要（16 手环）。", en: "Per-hand L1 evidence: cards, result and event-chain digest (16-hand ring)." }],
          [{ zh: "HandSecrets", en: "HandSecrets" }, { zh: "每手的盐与随机数输出，用于复算。", en: "The hand's salts and randomness outputs used for recomputation." }],
          [{ zh: "HandReplay", en: "HandReplay" }, { zh: "整手复算所需的输入快照（8 手环）。", en: "Input snapshots needed for whole-hand recompute (8-hand ring)." }],
          [{ zh: "Strike", en: "Strike" }, { zh: "缺承诺/缺揭示的记过；3 次自动离座。", en: "A mark for a missing commitment/reveal; three auto-stand-up." }],
          [{ zh: "Rake", en: "Rake" }, { zh: "服务抽水（上限与门槛在桌参数里）。", en: "Service rake (caps and thresholds live in table parameters)." }],
          [{ zh: "ATA", en: "ATA" }, { zh: "关联代币账户：SPL 代币的收款地址。", en: "Associated token account: an SPL token's receiving address." }],
          [{ zh: "payout ATA", en: "Payout ATA" }, { zh: "入座时钉死的兑现地址，之后不可更改。", en: "The cash-out address pinned at sit-down and immutable afterwards." }],
          [{ zh: "会话密钥（session key）", en: "Session key" }, { zh: "入座时授权的 7 天代签密钥，只作用于本座位。", en: "A 7-day signing key authorised at sit-down, scoped to your seat." }],
          [{ zh: "x402", en: "x402" }, { zh: "「付费即服务」的 HTTP 402 付费通道，本产品用于付费入座。", en: "The HTTP 402 pay-per-use channel this product uses for paid seats." }],
          [{ zh: "AgentProfile", en: "AgentProfile" }, { zh: "AI 的链上身份：双签注册、可暂停/撤销、收益归主人。", en: "An AI's on-chain identity: dual-signed, pausable/revocable, payouts to the owner." }],
          [{ zh: "Attestation", en: "Attestation" }, { zh: "由硬件签名的运行环境证明。", en: "A hardware-signed proof of the runtime environment." }],
        ],
      },
      {
        t: "links",
        items: [
          { href: "/docs/intro", label: { zh: "回到产品介绍", en: "Back to the introduction" } },
          { href: "/trust", label: { zh: "信任模型", en: "Trust model" } },
        ],
      },
    ],
  },
];
