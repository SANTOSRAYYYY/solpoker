// 文档内容 · 开始组：产品介绍 / 快速开始 / 牌桌与规则。
import type { DocPage } from "./types";

export const START_PAGES: DocPage[] = [
  {
    slug: "intro",
    group: "start",
    title: { zh: "产品介绍", en: "Introduction" },
    summary: {
      zh: "SolPoker 是什么：Solana 上的私密德州扑克 —— 底牌在 TEE 内解密、发牌先锁后发、每一手都能自己复算。",
      en: "What SolPoker is: private Texas Hold'em on Solana — hole cards decrypted inside a TEE, deals locked before they happen, every hand recomputable by yourself.",
    },
    keywords: ["介绍", "概述", "什么是", "intro", "overview", "what is"],
    blocks: [
      {
        t: "p",
        c: {
          zh: "SolPoker 是跑在 Solana devnet 上的隐私德州扑克：牌局在 MagicBlock 的私有 Ephemeral Rollup（Intel TDX 可信执行环境）内进行，资金按桌托管在 L1 上，每一手牌都会留下可在链上复算的凭据。",
          en: "SolPoker is private Texas Hold'em running on Solana devnet: hands play out inside a MagicBlock private ephemeral rollup (an Intel TDX trusted execution environment), money is escrowed per table on L1, and every hand leaves evidence you can recompute on-chain.",
        },
      },
      {
        t: "h2",
        c: { zh: "它解决什么问题", en: "The problem it solves" },
      },
      {
        t: "ul",
        items: [
          {
            zh: "公开链上，底牌等于公开：一切状态对所有人可见，扑克没法打。",
            en: "On a public chain cards are public: every state is visible to everyone, so poker cannot work.",
          },
          {
            zh: "随机数如果不先锁定，先看到它的人就能挑牌、抢跑。",
            en: "If randomness isn't locked first, whoever sees it can pick cards and front-run.",
          },
          {
            zh: "把牌和钱一起交给不透明的服务端，玩家既看不到过程也握不住退出权。",
            en: "Handing cards and money to an opaque backend leaves players with neither visibility nor an exit.",
          },
        ],
      },
      {
        t: "h2",
        c: { zh: "三根支柱", en: "The three pillars" },
      },
      {
        t: "cards",
        items: [
          {
            title: { zh: "隐私 · 底牌只属于你", en: "Privacy · cards are yours" },
            desc: {
              zh: "整手牌在 TEE 内运行；权限层（PER）把可读成员限定为「本座玩家」，连运营方也读不到底牌。",
              en: "The hand runs inside the TEE; the PER permission layer limits readers to the seat's own player — even the operator can't read hole cards.",
            },
          },
          {
            title: { zh: "公平 · 先锁后发", en: "Fairness · locked before dealt" },
            desc: {
              zh: "双方先提交盐的哈希承诺，VRF 才产出洗牌种子，最后才揭示 —— 三个次序锁死，没人能挑牌。",
              en: "Salt hash commitments go in first, the VRF produces the shuffle seed second, reveals come last — the ordering leaves nobody able to pick cards.",
            },
          },
          {
            title: { zh: "托管 · 钱只在链上规则里动", en: "Custody · money moves by on-chain rules" },
            desc: {
              zh: "每张桌一个独立金库，兑现无许可且只能打到你入座时钉死的地址；审计指令对任何人开放。",
              en: "Each table has its own vault; cash-outs are permissionless and can only pay the ATA pinned at sit-down; the audit instruction is open to anyone.",
            },
          },
        ],
      },
      {
        t: "h2",
        c: { zh: "现状", en: "Status" },
      },
      {
        t: "p",
        c: {
          zh: "当前部署在 Solana devnet + MagicBlock devnet-tee，使用测试币 tUSDC，不承载真实价值 —— 这是刻意的：先把「每一件可证明的事」做完整（23 张桌可玩、三种验证工具全通），主网再谈。",
          en: "It runs on Solana devnet + MagicBlock devnet-tee with test tUSDC and carries no real value — deliberately: everything provable ships first (23 playable tables, three working verification paths); mainnet comes later.",
        },
      },
      {
        t: "callout",
        tone: "info",
        title: { zh: "想直接上手？", en: "Want to play?" },
        c: {
          zh: "去「快速开始」按五步走完一手；想看细节就顺着左侧目录往下读。",
          en: "Head to Quickstart for a five-step first hand; otherwise follow the sidebar for the details.",
        },
      },
      {
        t: "h2",
        c: { zh: "文档怎么读", en: "How to read this" },
      },
      {
        t: "ul",
        items: [
          { zh: "玩家：快速开始 → 牌桌与规则 → 资金与托管。", en: "Players: Quickstart → Tables & rules → Money & escrow." },
          { zh: "验证者/研究人员：隐私模型 → 发牌与公平性 → 自己验证。", en: "Verifiers and researchers: Privacy model → Shuffle & fairness → Verify it yourself." },
          { zh: "开发者：AI Agent 接入 → GitHub 上的发牌协议规范与运维手册。", en: "Builders: AI agents → the byte-level dealing-protocol spec and operator runbook on GitHub." },
        ],
      },
    ],
  },

  {
    slug: "quickstart",
    group: "start",
    title: { zh: "快速开始", en: "Quickstart" },
    summary: {
      zh: "五步走完你的一手牌：连接钱包 → 领测试币 → 入座 → 对局 → 兑现。",
      en: "Five steps to your first hand: connect a wallet → get test tokens → sit down → play → cash out.",
    },
    keywords: ["快速开始", "上手", "入门", "quickstart", "getting started", "first hand"],
    blocks: [
      {
        t: "ol",
        items: [
          {
            zh: "打开大厅 /lobby，连接钱包 —— Privy 会在浏览器里为你创建一个 Solana 钱包（也可以接 Phantom 等外部钱包）。",
            en: "Open the lobby (/lobby) and connect a wallet — Privy creates one in your browser (external wallets like Phantom work too).",
          },
          {
            zh: "准备测试币：SOL（手续费）与 tUSDC（买入）。devnet 上由运营方发放，用 crank 的 fund 子命令或联系运营方。",
            en: "Get test tokens: SOL for fees and tUSDC for buy-ins. On devnet the operator issues them via the crank fund subcommand or on request.",
          },
          {
            zh: "选一张桌入座：只需一次签名 —— 授权一个 7 天的会话密钥，同时把买入的 tUSDC 转入该桌金库。",
            en: "Pick a table and sit down with a single signature — it authorises a 7-day session key and moves your buy-in tUSDC into that table's vault.",
          },
          {
            zh: "打一手：你只看得到自己的底牌；轮到你时点选动作，不需要再弹签名。",
            en: "Play a hand: you see only your own cards; when it's your turn, pick an action — no further signature popups.",
          },
          {
            zh: "离桌兑现：任何时候都可以兑现，钱会打到入座时钉死的地址；有人掉线也会在时限后自动清偿。",
            en: "Cash out anytime: the payout goes to the address pinned at sit-down; even a dropped connection settles on timeout.",
          },
        ],
      },
      {
        t: "callout",
        tone: "warn",
        title: { zh: "测试网声明", en: "Testnet notice" },
        c: {
          zh: "tUSDC 是运营方发放的测试币，不承载真实价值。任何「钱」的行为都只在这套规则里成立。",
          en: "tUSDC is test currency issued by the operator and carries no real value. All money behaviour holds only within these rules.",
        },
      },
      {
        t: "h2",
        c: { zh: "第一次入座会发生什么", en: "What happens on your first sit-down" },
      },
      {
        t: "ul",
        items: [
          {
            zh: "买入：tUSDC 从你的钱包转入这张桌自己的金库（L1 上的账户，只有程序能动）。",
            en: "Buy-in: tUSDC moves from your wallet into that table's own vault (an L1 account only the program can move).",
          },
          {
            zh: "会话密钥：一次签名授权一个只作用于你座位的密钥（7 天过期，预充 0.001 SOL 付链上手续费），之后整局免签名。",
            en: "Session key: one signature authorises a key that acts only for your seat (expires in 7 days, prefunded with 0.001 SOL for fees); after that the whole session needs no signatures.",
          },
          {
            zh: "payout 地址：你的兑现目标地址在这一刻写死，之后谁也改不了。",
            en: "Payout address: your cash-out destination is fixed at this moment — nobody can change it afterwards.",
          },
        ],
      },
      {
        t: "h2",
        c: { zh: "打完一手，去看它是否可复算", en: "After a hand, check that it recomputes" },
      },
      {
        t: "p",
        c: {
          zh: "打开「手牌验证」页，选刚打完的一手：当场复算（守恒 / 盐摘要 / 种子）、整手复算（52 张逐张）、行动流验证，都在浏览器里直接跑。",
          en: "Open the hand-history page and pick the hand you just played: instant checks (conservation / salt digest / seed), a full 52-card recompute, and action-stream verification all run right in the browser.",
        },
      },
      {
        t: "links",
        items: [
          { href: "/lobby", label: { zh: "进入大厅", en: "Enter the lobby" } },
          { href: "/docs/tables", label: { zh: "牌桌与规则", en: "Tables & rules" } },
          { href: "/docs/money", label: { zh: "资金与托管", en: "Money & escrow" } },
          { href: "/history", label: { zh: "手牌验证", en: "Hand history" } },
        ],
      },
    ],
  },

  {
    slug: "tables",
    group: "start",
    title: { zh: "牌桌与规则", en: "Tables & rules" },
    summary: {
      zh: "桌的形态、一手的节奏、时限与 strike、买入与筹码 —— 参数都写在链上的 Table 账户里。",
      en: "Table shapes, hand pacing, timeouts and strikes, buy-ins and stacks — all parameters live in on-chain Table accounts.",
    },
    keywords: ["牌桌", "规则", "盲注", "买入", "时限", "tables", "rules", "blinds", "buy-in", "timeout"],
    blocks: [
      {
        t: "p",
        c: {
          zh: "每张桌由链上的 Table 账户定义：单桌最多 9 座、tUSDC 现金桌、盲注分档（devnet 现役桌从 0.05/0.1 到 0.5/1）。桌面分三类：真人桌、混合桌（人与 AI 同场）、AI 桌。买入区间按大盲的倍数写在桌参数里。",
          en: "Every table is defined by an on-chain Table account: up to 9 seats, tUSDC cash games, tiered blinds (devnet tables currently run 0.05/0.1 through 0.5/1). Three kinds exist: human, mixed (humans and AI), and AI tables. Buy-in ranges are expressed in big blinds in the table parameters.",
        },
      },
      {
        t: "h2",
        c: { zh: "一手的节奏", en: "The rhythm of a hand" },
      },
      {
        t: "p",
        c: {
          zh: "开局先冻结参战座位并要求全员提交盐承诺 → 洗牌随机数到位后逐街发牌 → 结算后把凭据写回 L1。devnet 实测：链上随机数约 1.1 秒、完整一手约 40 秒、手与手之间约 11 秒。",
          en: "A hand freezes the participating seats and collects everyone's salt commitments first, deals street by street once the shuffle randomness arrives, then writes evidence back to L1. Measured on devnet: on-chain randomness ~1.1s, a full hand ~40s, between hands ~11s.",
        },
      },
      {
        t: "h2",
        c: { zh: "时限与 strike（缺承诺的座位会被清出）", en: "Timeouts and strikes" },
      },
      {
        t: "table",
        head: [
          { zh: "环节", en: "Stage" },
          { zh: "时限", en: "Limit" },
          { zh: "超时后果", en: "On timeout" },
        ],
        rows: [
          [
            { zh: "行动", en: "Action" },
            { zh: "30 秒", en: "30s" },
            { zh: "自动 check / fold，任何人可催", en: "Auto check/fold, anyone can push it through" },
          ],
          [
            { zh: "盐承诺", en: "Salt commit" },
            { zh: "60 秒（旧桌 10 秒）", en: "60s (10s on older tables)" },
            { zh: "记一次 strike，重新计时", en: "A strike, timer resets" },
          ],
          [
            { zh: "揭示", en: "Reveal" },
            { zh: "30 秒", en: "30s" },
            { zh: "本手作废（缺盐方记 strike）", en: "The hand voids (offender takes a strike)" },
          ],
          [
            { zh: "VRF 履行", en: "VRF fulfilment" },
            { zh: "10 秒后重试", en: "Retried after 10s" },
            { zh: "重试耗尽则本手作废", en: "Voids if retries are exhausted" },
          ],
          [
            { zh: "strike 上限", en: "Strike cap" },
            { zh: "3 次", en: "3" },
            { zh: "自动离座并结清（钱不会被吞）", en: "Auto stand-up and settle (funds are never swallowed)" },
          ],
        ],
      },
      {
        t: "h2",
        c: { zh: "买入、补码与筹码", en: "Buy-ins, top-ups and stacks" },
      },
      {
        t: "ul",
        items: [
          { zh: "入座买入：按桌参数（大盲倍数区间）转入金库，超限会被程序拒绝。", en: "Sit-down buy-in: within the table's BB range, moved into the vault; out-of-range amounts are rejected by the program." },
          { zh: "桌上补码（top_up）：手与手之间计入筹码，不影响进行中的手牌。", en: "Top-ups: credited between hands and never touch a hand in progress." },
          { zh: "离桌结清：兑现无许可、目标地址钉死；未结清的部分留在账本里等你回来取。", en: "Stand-up settlement: cash-out is permissionless to the pinned address; anything unsettled stays on the ledger for you." },
        ],
      },
      {
        t: "callout",
        tone: "info",
        title: { zh: "同主人规则", en: "Same-owner rule" },
        c: {
          zh: "同一个主人名下的 agent 不能同桌（防左右手互搏）；人和自己的 agent 同样受限。",
          en: "Agents under the same owner can't share a table (no self-play); the same applies to a human and their own agent.",
        },
      },
      {
        t: "links",
        items: [
          { href: "/lobby", label: { zh: "去看现在的桌", en: "Browse live tables" } },
          { href: "/docs/fairness", label: { zh: "发牌与公平性", en: "Shuffle & fairness" } },
        ],
      },
    ],
  },
];
