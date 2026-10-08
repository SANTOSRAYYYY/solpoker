// 文档内容 · 信任组：隐私模型 / 发牌与公平性 / 自己验证。
import type { DocPage } from "./types";

export const TRUST_PAGES: DocPage[] = [
  {
    slug: "privacy",
    group: "trust",
    title: { zh: "隐私模型", en: "Privacy model" },
    summary: {
      zh: "底牌只在 Intel TDX 内解密；行动照常公开，但内容不泄露 —— 以及这个模型的边界在哪。",
      en: "Hole cards decrypt only inside Intel TDX; actions stay public while their contents don't leak — and where this model's edges are.",
    },
    keywords: ["隐私", "TEE", "TDX", "PER", "权限", "privacy", "permission", "enclave"],
    blocks: [
      {
        t: "p",
        c: {
          zh: "牌桌运行在 MagicBlock 的私有 Ephemeral Rollup（ER）里，执行环境是 Intel TDX 可信执行环境（TEE，devnet-tee）。你的底牌在 TEE 内解密，账户权限由 PER 权限层控制：可读成员 = 管理员 + 该座位的本人。",
          en: "The table runs inside a MagicBlock private ephemeral rollup (ER) whose execution environment is an Intel TDX trusted execution environment (devnet-tee). Your hole cards decrypt inside the TEE, and account access is governed by the PER permission layer: readers = the admin plus the seat's own player.",
        },
      },
      {
        t: "h2",
        c: { zh: "谁能看到什么", en: "Who can see what" },
      },
      {
        t: "table",
        head: [
          { zh: "观察者", en: "Observer" },
          { zh: "底牌", en: "Hole cards" },
          { zh: "行动与下注", en: "Actions & bets" },
          { zh: "筹码 / 账本", en: "Stacks / ledger" },
        ],
        rows: [
          [
            { zh: "你自己", en: "You" },
            { zh: "✓ 只有你的两张", en: "✓ only your two" },
            { zh: "✓", en: "✓" },
            { zh: "✓", en: "✓" },
          ],
          [
            { zh: "对手", en: "Opponent" },
            { zh: "✗", en: "✗" },
            { zh: "✓（下注额公开）", en: "✓ (amounts are public)" },
            { zh: "✓", en: "✓" },
          ],
          [
            { zh: "围观者 / 区块链浏览器", en: "Spectators / explorers" },
            { zh: "✗", en: "✗" },
            { zh: "结算后可见（L1 凭据）", en: "After settlement (L1 evidence)" },
            { zh: "✓", en: "✓" },
          ],
          [
            { zh: "运营方", en: "The operator" },
            { zh: "✗", en: "✗" },
            { zh: "✗ 服务只驱动阶段机", en: "✗ services only drive the phase machine" },
            { zh: "✗ 不持有任何玩家 token", en: "✗ never holds player tokens" },
          ],
        ],
      },
      {
        t: "h2",
        c: { zh: "技术构件", en: "Building blocks" },
      },
      {
        t: "cards",
        items: [
          {
            title: { zh: "私有 Ephemeral Rollup", en: "Private ephemeral rollup" },
            desc: {
              zh: "牌局状态（座位、底池、牌）在 ER 内实时演进，按节奏把结算凭据提交回 L1。",
              en: "Game state (seats, pot, cards) evolves in real time inside the ER, with settlement evidence committed back to L1 on a schedule.",
            },
          },
          {
            title: { zh: "PER 权限层", en: "PER permission layer" },
            desc: {
              zh: "每个玩家手牌账户的成员列表在链上公开可查：谁能读一目了然，运营方不在名单里。",
              en: "Each hand account's member list is publicly readable on-chain: who can read is visible, and the operator is not on the list.",
            },
          },
          {
            title: { zh: "Intel TDX + attestation", en: "Intel TDX + attestation" },
            desc: {
              zh: "入座前验证运行环境的 attestation；底牌的解密只在硬件隔离区内发生。",
              en: "Attestation of the runtime is verified before you can play; decryption happens only inside the hardware-isolated enclave.",
            },
          },
        ],
      },
      {
        t: "h2",
        c: { zh: "边界（写清楚）", en: "The edges, stated plainly" },
      },
      {
        t: "ul",
        items: [
          {
            zh: "attestation 只能证明「运行在真实 TDX 机器上」，不证明程序逻辑本身；逻辑正确性靠复算验证。",
            en: "Attestation only proves the code runs on a genuine TDX machine — it says nothing about the logic; logical correctness rests on recomputation.",
          },
          {
            zh: "MagicBlock 尚未公布度量值（MRTD/RTMR），执行记录保留期约一周。",
            en: "MagicBlock has not published measurement values (MRTD/RTMR) yet, and execution-record retention is about one week.",
          },
          {
            zh: "行动与金额在 ER 内公开（同桌可见），这是扑克的必要条件，不是泄露。",
            en: "Actions and amounts are public inside the ER (visible to the table) — that's a requirement of poker, not a leak.",
          },
        ],
      },
      {
        t: "links",
        items: [
          { href: "/trust", label: { zh: "信任模型页（逐项证据）", en: "Trust model page (item by item)" } },
          { href: "https://docs.magicblock.gg/pages/tools/tee/introduction", label: { zh: "MagicBlock TEE 文档", en: "MagicBlock TEE docs" }, external: true },
        ],
      },
    ],
  },

  {
    slug: "fairness",
    group: "trust",
    title: { zh: "发牌与公平性", en: "Shuffle & fairness" },
    summary: {
      zh: "先锁后发：盐承诺 → VRF 洗牌种子 → 揭示，三个次序锁死 —— 谁都没法挑牌。",
      en: "Locked before dealt: salt commitments → VRF shuffle seed → reveals. The ordering leaves nobody able to pick their cards.",
    },
    keywords: ["发牌", "公平", "VRF", "盐", "承诺", "shuffle", "fairness", "salt", "commit", "reveal"],
    blocks: [
      {
        t: "h2",
        c: { zh: "承诺 — 揭示 — 洗牌", en: "Commit, reveal, shuffle" },
      },
      {
        t: "ol",
        items: [
          {
            zh: "开局：每个参战座位各自生成 32 字节随机盐，把你的盐的哈希（承诺）提交上链 —— 此时谁也不知道别人的盐。",
            en: "At hand start every participating seat generates its own 32-byte random salt and commits a hash of it on-chain — at this point nobody knows anyone else's salt.",
          },
          {
            zh: "全员承诺到位后，VRF 产出洗牌种子（公开随机数，请求与履行的次序可查）。",
            en: "Once every seat has committed, the VRF produces the shuffle seed (public randomness whose request and fulfilment order is auditable).",
          },
          {
            zh: "随后才揭示盐；哈希对不上的承诺直接判为无效（记 strike，必要时本手作废）。",
            en: "Only then are salts revealed; a commitment whose hash doesn't match is void (a strike, and if needed the hand voids).",
          },
          {
            zh: "发牌：由（种子 × 各方盐）派生整副牌序，逐张发放。任何一方都晚于种子才亮出盐，因此无法反向挑牌。",
            en: "Dealing: the whole deck order is derived from (seed × all salts) and dealt card by card. Every salt is revealed after the seed, so nobody can work backwards to pick cards.",
          },
        ],
      },
      {
        t: "h2",
        c: { zh: "每街一次随机数", en: "One randomness call per street" },
      },
      {
        t: "p",
        c: {
          zh: "每手牌共 4 次链上随机数：洗牌一次，翻牌 / 转牌 / 河牌各一次；提前 all-in 时走 runout 通道。每次请求与履行都留痕，可对账。",
          en: "Each hand uses four on-chain randomness calls: one for the shuffle plus flop, turn and river; an early all-in goes down the runout path. Every request and fulfilment is logged and auditable.",
        },
      },
      {
        t: "h2",
        c: { zh: "牌什么时候作废", en: "When a hand voids" },
      },
      {
        t: "ul",
        items: [
          { zh: "参战人数不足两人（座位被清出后）。", en: "Fewer than two players remain (after a seat is cleared)." },
          { zh: "有人在揭示时限内交不出能对上承诺的盐。", en: "Someone fails to reveal a salt matching their commitment within the reveal window." },
          { zh: "链上随机数重试耗尽（VRF 失败）。", en: "On-chain randomness retries are exhausted (the VRF failed)." },
        ],
      },
      {
        t: "callout",
        tone: "mint",
        title: { zh: "作废不产生输赢", en: "A void moves no money" },
        c: {
          zh: "被迫下注只在发牌后才发生；作废的手牌不产生输赢，筹码原样退回，只留下「这手没打成」的记录与相应 strike。",
          en: "Forced bets only happen after cards are dealt; a voided hand produces no wins or losses — stacks return unchanged, leaving only a record that the hand didn't run and the relevant strike.",
        },
      },
      {
        t: "h2",
        c: { zh: "为什么这是公平的", en: "Why this is fair" },
      },
      {
        t: "p",
        c: {
          zh: "作弊需要同时满足两个不可能：在种子产生前知道别人的盐（承诺哈希挡住了），或在揭示前反推牌序（单向哈希 + 后置揭示挡住了）。VRF 若被操作，至少还要绕过发起请求的公开次序 —— 每一步都有链上痕迹。",
          en: "Cheating would need two impossible things at once: knowing others' salts before the seed exists (blocked by the commitment hashes), or inverting the deck from the seed before reveals (blocked by the ordering and one-way hashing). Tampering with the VRF would additionally have to survive the public request ordering — every step leaves a trace.",
        },
      },
      {
        t: "links",
        items: [
          { href: "https://github.com/SANTOSRAYYYY/solpoker/blob/main/docs/dealing-protocol.zh.md", label: { zh: "发牌协议规范（字节级）", en: "Dealing protocol spec (byte level)" }, external: true },
          { href: "/docs/verification", label: { zh: "自己验证", en: "Verify it yourself" } },
        ],
      },
    ],
  },

  {
    slug: "verification",
    group: "trust",
    title: { zh: "自己验证", en: "Verify it yourself" },
    summary: {
      zh: "三种验证方式与它们的覆盖范围：当场复算 / 整手复算（52 张逐张）/ 行动流验证。",
      en: "Three ways to verify and exactly what they cover: instant checks / whole-hand recompute (52 cards) / action-stream verification.",
    },
    keywords: ["验证", "复算", "审计", "verify", "recompute", "audit", "proof"],
    blocks: [
      {
        t: "h2",
        c: { zh: "三种验证", en: "Three levels" },
      },
      {
        t: "cards",
        items: [
          {
            title: { zh: "① 当场复算", en: "① Instant checks" },
            badge: { zh: "浏览器", en: "browser" },
            desc: {
              zh: "守恒（筹码总量）、盐摘要、随机数种子三项对照 —— 秒级完成，用来快速确认一手牌没被动过。",
              en: "Conservation (chip totals), salt digests and the randomness seed — done in seconds to confirm a hand wasn't tampered with.",
            },
          },
          {
            title: { zh: "② 整手复算", en: "② Whole-hand recompute" },
            badge: { zh: "52 张逐张", en: "52 cards" },
            desc: {
              zh: "从 VRF 输出与各方盐出发，把整副牌从洗牌到河牌逐张重算，与链上凭据逐字节比对。",
              en: "Re-derive the entire deck from the VRF output and every salt, card by card, and compare byte-for-byte with on-chain evidence.",
            },
          },
          {
            title: { zh: "③ 行动流验证", en: "③ Action-stream verification" },
            badge: { zh: "交易日志", en: "tx logs" },
            desc: {
              zh: "从 ER 交易日志重放整手的行动序列，与事件链摘要对照 —— 确认「谁在何时做了什么」没被改写。",
              en: "Replay the hand's action sequence from ER transaction logs against the event-chain digest — confirming who did what, when, wasn't rewritten.",
            },
          },
        ],
      },
      {
        t: "h2",
        c: { zh: "在哪跑", en: "Where to run it" },
      },
      {
        t: "ul",
        items: [
          { zh: "浏览器：「手牌验证」页选一手，三个按钮对应三种验证，结果直接展示。", en: "Browser: the hand-history page has a hand picker and three buttons — one per level — with results inline." },
          { zh: "命令行：仓库里的 scripts/verify-hand.mjs（整手复算，输出 HAND_RECOMPUTE_OK）与 scripts/verify-actions.mjs（输出 ACTION_STREAM_OK）。", en: "CLI: scripts/verify-hand.mjs (whole-hand recompute, prints HAND_RECOMPUTE_OK) and scripts/verify-actions.mjs (prints ACTION_STREAM_OK)." },
          { zh: "L1 审计：/history 的「L1 审计视图」逐笔列出入账、退款与结算；命令行对应 scripts/l1-audit.mjs。", en: "L1 audit: the hand-history page lists deposits, refunds and settlements per transaction; scripts/l1-audit.mjs does the same from the CLI." },
        ],
      },
      {
        t: "code",
        caption: { zh: "仓库脚本（开源自证：还带 6 组字节级自检向量）", en: "Repo scripts (open source, with 6 byte-level self-test vectors)" },
        text: `node scripts/verify-hand.mjs      # 整手复算：52 张逐张 → HAND_RECOMPUTE_OK
node scripts/verify-actions.mjs   # 行动流验证 → ACTION_STREAM_OK
node scripts/l1-audit.mjs         # L1 逐笔审计（--json / --explain <sig>）`,
      },
      {
        t: "h2",
        c: { zh: "覆盖范围与缺口", en: "Coverage and gaps" },
      },
      {
        t: "table",
        head: [
          { zh: "对象", en: "What" },
          { zh: "可验证性", en: "Verifiable" },
          { zh: "保留期", en: "Retention" },
        ],
        rows: [
          [
            { zh: "最近 8 手（replay 环内）", en: "Last 8 hands (replay ring)" },
            { zh: "整手逐张复算", en: "Full card-by-card recompute" },
            { zh: "链上，随环滚动", en: "On-chain, rolling" },
          ],
          [
            { zh: "更早的手牌", en: "Older hands" },
            { zh: "HandProof 摘要（牌面/输赢/事件链锚点）", en: "HandProof digests (cards/result/event-chain anchors)" },
            { zh: "锚点永久保留", en: "Anchors kept forever" },
          ],
          [
            { zh: "行动流", en: "Action stream" },
            { zh: "从 ER 交易日志重放", en: "Replay from ER tx logs" },
            { zh: "约一周", en: "About a week" },
          ],
          [
            { zh: "资金", en: "Money" },
            { zh: "L1 逐笔审计（入账/退款/结算）", en: "Per-transaction L1 audit (deposits/refunds/settlements)" },
            { zh: "永久", en: "Forever" },
          ],
        ],
      },
      {
        t: "callout",
        tone: "warn",
        title: { zh: "为什么把缺口也写出来", en: "Why the gaps are stated" },
        c: {
          zh: "「能验证」只有在说清「哪里不能验证」时才算数。环外的旧手牌与过期的交易日志是我们已知的缺口，写在这里，不藏在细则里。",
          en: "\"Verifiable\" only counts when what isn't verifiable is stated too. Out-of-ring hands and expired tx logs are known gaps — written here, not buried in fine print.",
        },
      },
      {
        t: "links",
        items: [
          { href: "/history", label: { zh: "手牌验证页", en: "Hand history page" } },
          { href: "/trust", label: { zh: "信任模型", en: "Trust model" } },
        ],
      },
    ],
  },
];
