/* 视觉稿演示数据（全部为本地假数据，与链上状态无关） */



export type TableKind = "human" | "mixed" | "agent";

export const KIND_META: Record<
  TableKind,
  { zh: string; en: string; tone: "plain" | "grad" | "cyan" }
> = {
  human: { zh: "真人桌", en: "HUMAN", tone: "plain" },
  mixed: { zh: "混合桌", en: "MIXED", tone: "grad" },
  agent: { zh: "AI 桌", en: "AGENTS", tone: "cyan" },
};

export type MockTable = {
  id: number;
  name: string;
  nameEn: string;
  kind: TableKind;
  sb: number;
  bb: number;
  ante: number;
  minBuy: number;
  maxBuy: number;
  occupied: number[]; // 已占座位
  agents: number[]; // 其中是 agent 的座位
  phase: "idle" | "live";
  handNo: number;
  pot: number;
  avgPot: number;
  mySeat?: number;
  myStack?: number;
};

export const TABLES: MockTable[] = [
  {
    id: 5,
    name: "翡翠厅",
    nameEn: "EMERALD",
    kind: "human",
    sb: 0.1,
    bb: 0.2,
    ante: 0.02,
    minBuy: 20,
    maxBuy: 200,
    occupied: [0, 2, 3, 5, 6],
    agents: [],
    phase: "live",
    handNo: 14,
    pot: 4.8,
    avgPot: 3.2,
  },
  {
    id: 9,
    name: "红木厅",
    nameEn: "MAHOGANY",
    kind: "human",
    sb: 0.1,
    bb: 0.2,
    ante: 0.02,
    minBuy: 20,
    maxBuy: 200,
    occupied: [1, 3, 4, 7],
    agents: [],
    phase: "live",
    handNo: 31,
    pot: 2.1,
    avgPot: 2.8,
    mySeat: 3,
    myStack: 42.5,
  },
  {
    id: 11,
    name: "紫晶厅",
    nameEn: "AMETHYST",
    kind: "mixed",
    sb: 0.1,
    bb: 0.2,
    ante: 0.02,
    minBuy: 20,
    maxBuy: 200,
    occupied: [0, 2, 4, 6],
    agents: [2, 6],
    phase: "live",
    handNo: 8,
    pot: 6.4,
    avgPot: 5.1,
  },
  {
    id: 12,
    name: "霓虹厅",
    nameEn: "NEON",
    kind: "agent",
    sb: 0.1,
    bb: 0.2,
    ante: 0.02,
    minBuy: 20,
    maxBuy: 200,
    occupied: [1, 4, 5, 8],
    agents: [1, 4, 5, 8],
    phase: "live",
    handNo: 52,
    pot: 12.6,
    avgPot: 7.4,
  },
  {
    id: 6,
    name: "橡木厅",
    nameEn: "OAK",
    kind: "human",
    sb: 0.2,
    bb: 0.5,
    ante: 0.05,
    minBuy: 50,
    maxBuy: 500,
    occupied: [],
    agents: [],
    phase: "idle",
    handNo: 0,
    pot: 0,
    avgPot: 0,
  },
  {
    id: 8,
    name: "黑檀厅",
    nameEn: "EBONY",
    kind: "human",
    sb: 0.5,
    bb: 1,
    ante: 0.1,
    minBuy: 100,
    maxBuy: 1000,
    occupied: [2, 5],
    agents: [],
    phase: "idle",
    handNo: 3,
    pot: 0,
    avgPot: 9.6,
  },
];

/* ------------------------------------------------------------- Agent */
export type MockAgent = {
  name: string;
  addr: string;
  status: "ACTIVE" | "PAUSED";
  stack: number;
  tableId?: number;
  seat?: number;
  hands: number;
  pnl: number;
  spark: number[];
  payout: string;
  model: string;
  uptime: string;
};

export const AGENTS: MockAgent[] = [
  {
    name: "bob-1",
    addr: "7xKX…9fQm",
    status: "ACTIVE",
    stack: 45.2,
    tableId: 11,
    seat: 4,
    hands: 26,
    pnl: 12.4,
    spark: [2, -1, 3, 2, 5, -2, 4, 6, 3, 8],
    payout: "主人钱包 (默认)",
    model: "Claude · MCP",
    uptime: "6d 4h",
  },
  {
    name: "carol-x",
    addr: "9ZEm…F5Aj",
    status: "ACTIVE",
    stack: 63.8,
    tableId: 12,
    seat: 1,
    hands: 112,
    pnl: 21.7,
    spark: [1, 2, -1, 4, 3, 2, 6, 5, 9, 7],
    payout: "主人钱包 (默认)",
    model: "GPT · MCP",
    uptime: "11d 2h",
  },
  {
    name: "dave-tight",
    addr: "Dghw…JF8E",
    status: "PAUSED",
    stack: 18.0,
    tableId: undefined,
    seat: undefined,
    hands: 8,
    pnl: -3.1,
    spark: [-1, -2, 1, -1, -3, 0, 2, -1, 1, -2],
    payout: "0x71C9…88f2 (EVM)",
    model: "自建脚本",
    uptime: "—",
  },
];

/* ------------------------------------------------------------- 对局 */
export type MockSeat = {
  seat: number;
  name: string;
  addr?: string;
  kind: "human" | "agent" | "me";
  stack: number;
  bet?: number;
  act?: "acting" | "folded" | "allin" | "waiting" | "sitting";
  lastAction?: string;
};

export const TABLE_SEATS: MockSeat[] = [
  { seat: 0, name: "lin", addr: "JB22…Xxn", kind: "human", stack: 22.4, bet: 2.0, act: "folded", lastAction: "弃牌" },
  { seat: 1, name: "kai", addr: "6yBz…bnS6", kind: "human", stack: 38.2, bet: 0, act: "folded", lastAction: "弃牌" },
  { seat: 2, name: "σ-agent", addr: "8kQd…3vRt", kind: "agent", stack: 0, bet: 22.4, act: "allin", lastAction: "全下 19.6" },
  { seat: 3, name: "sora", addr: "9ZEm…F5Aj", kind: "human", stack: 12.8, bet: 0, act: "folded", lastAction: "弃牌" },
  { seat: 4, name: "我", kind: "me", stack: 41.2, bet: 6.4, act: "acting", lastAction: "过牌" },
  { seat: 5, name: "momo", addr: "Dghw…JF8E", kind: "human", stack: 30.1, bet: 2.0, act: "folded", lastAction: "弃牌" },
];

export const BOARD: { rank: string; suit: "♠" | "♥" | "♦" | "♣" }[] = [
  { rank: "7", suit: "♥" },
  { rank: "K", suit: "♠" },
  { rank: "3", suit: "♦" },
  { rank: "7", suit: "♣" },
];

export const HOLE = [
  { rank: "A", suit: "♠" as const },
  { rank: "A", suit: "♦" as const },
];

export type FeedItem = {
  t: string;
  who: string;
  what: string;
  tone?: "brand" | "mint" | "danger" | "plain" | "cyan";
};

export const FEED: FeedItem[] = [
  { t: "00:12", who: "系统", what: "手牌 #8 开始 · VRF 已就绪", tone: "cyan" },
  { t: "00:12", who: "lin", what: "小盲 0.1 入池" },
  { t: "00:12", who: "σ-agent", what: "大盲 0.2 入池" },
  { t: "00:13", who: "系统", what: "前注 0.02 × 5", tone: "plain" },
  { t: "00:15", who: "我", what: "加注到 0.8", tone: "brand" },
  { t: "00:17", who: "kai", what: "弃牌", tone: "danger" },
  { t: "00:18", who: "sora", what: "弃牌", tone: "danger" },
  { t: "00:19", who: "momo", what: "跟注 0.8", tone: "mint" },
  { t: "00:20", who: "lin", what: "跟注 0.7", tone: "mint" },
  { t: "00:21", who: "σ-agent", what: "跟注 0.6", tone: "mint" },
  { t: "00:23", who: "系统", what: "翻牌 7♥ K♠ 3♦ 已揭示", tone: "cyan" },
  { t: "00:25", who: "我", what: "下注 2.0", tone: "brand" },
  { t: "00:27", who: "momo", what: "弃牌", tone: "danger" },
  { t: "00:28", who: "lin", what: "弃牌", tone: "danger" },
  { t: "00:30", who: "σ-agent", what: "跟注 2.0", tone: "mint" },
  { t: "00:32", who: "系统", what: "转牌 7♣ 已揭示", tone: "cyan" },
  { t: "00:35", who: "我", what: "过牌" },
  { t: "00:38", who: "σ-agent", what: "全下 19.6", tone: "danger" },
  { t: "00:39", who: "系统", what: "等待你的行动 · 剩 14s", tone: "brand" },
];

/* ------------------------------------------------------------- 手牌历史 */
export type MockHand = {
  id: string;
  tableId: number;
  when: string;
  players: number;
  pot: number;
  delta: number;
  board: [string, string][];
  mine: [string, string][];
  shown?: { name: string; cards: [string, string][] }[];
  verified: boolean;
  sig: string;
};

export const HANDS: MockHand[] = [
  {
    id: "#128",
    tableId: 11,
    when: "10-05 21:14",
    players: 6,
    pot: 12.8,
    delta: 8.2,
    board: [["7", "♥"], ["K", "♠"], ["3", "♦"], ["7", "♣"], ["2", "♠"]],
    mine: [["A", "♠"], ["A", "♦"]],
    shown: [
      { name: "lin", cards: [["K", "♦"], ["9", "♦"]] },
      { name: "σ-agent", cards: [["Q", "♠"], ["Q", "♥"]] },
    ],
    verified: true,
    sig: "4XkQ…8pRt",
  },
  {
    id: "#127",
    tableId: 11,
    when: "10-05 21:09",
    players: 5,
    pot: 4.2,
    delta: -2.0,
    board: [["J", "♣"], ["8", "♥"], ["2", "♦"]],
    mine: [["A", "♣"], ["J", "♦"]],
    verified: true,
    sig: "3WmN…6hQd",
  },
  {
    id: "#126",
    tableId: 11,
    when: "10-05 21:04",
    players: 6,
    pot: 6.6,
    delta: 4.4,
    board: [["9", "♠"], ["9", "♦"], ["4", "♣"], ["T", "♥"], ["3", "♠"]],
    mine: [["9", "♣"], ["T", "♠"]],
    verified: true,
    sig: "2PqL…5fVc",
  },
  {
    id: "#125",
    tableId: 9,
    when: "10-05 20:41",
    players: 4,
    pot: 3.0,
    delta: -1.2,
    board: [["A", "♥"], ["6", "♠"], ["5", "♦"]],
    mine: [["T", "♦"], ["T", "♣"]],
    verified: true,
    sig: "1NbK…4dWs",
  },
  {
    id: "#124",
    tableId: 9,
    when: "10-05 20:36",
    players: 5,
    pot: 8.9,
    delta: -8.9,
    board: [["Q", "♥"], ["Q", "♠"], ["7", "♦"], ["2", "♣"], ["2", "♥"]],
    mine: [["A", "♦"], ["K", "♦"]],
    shown: [{ name: "kai", cards: [["Q", "♦"], ["J", "♠"]] }],
    verified: true,
    sig: "9JtR…2xYe",
  },
  {
    id: "#123",
    tableId: 9,
    when: "10-05 20:31",
    players: 6,
    pot: 5.4,
    delta: 2.6,
    board: [["8", "♦"], ["8", "♣"], ["K", "♥"], ["4", "♠"], ["J", "♦"]],
    mine: [["8", "♥"], ["A", "♥"]],
    verified: true,
    sig: "8HsD…1zUv",
  },
  {
    id: "#122",
    tableId: 11,
    when: "10-05 20:12",
    players: 3,
    pot: 2.2,
    delta: 1.1,
    board: [["3", "♣"], ["K", "♦"], ["9", "♥"]],
    mine: [["K", "♣"], ["Q", "♣"]],
    verified: false,
    sig: "7GrT…0aSq",
  },
];

/* ------------------------------------------------------- 信任页（§16 底稿） */
export type TrustItem = {
  zh: string;
  en: string;
  by: string;
  how: string;
  links: { label: string; href: string }[];
  trust: string;
};

export const TRUST_ITEMS: TrustItem[] = [
  {
    zh: "钱只能付给本人",
    en: "Payouts are pinned",
    by: "程序钉死了收款地址（入座时固定的 payout ATA：真人为本人，agent 默认为主人）；cash_out 任何人都能触发",
    how: "读开源代码、核对可验证构建、看 L1 上的余额",
    links: [
      { label: "合约源码", href: "https://github.com/" },
      { label: "可验证构建", href: "https://github.com/" },
    ],
    trust: "程序升级权限（主网交给多签或锁定升级）",
  },
  {
    zh: "每张桌全额有担保",
    en: "Fully collateralized",
    by: "I-X 不变量；commit 只在 pot = 0 时发生",
    how: "任何人都可以调用 audit_table 检查桌内筹码与账本",
    links: [{ label: "audit_table", href: "https://solscan.io/" }],
    trust: "同上：升级权限",
  },
  {
    zh: "牌局中底牌保密",
    en: "Hole cards stay private",
    by: "TEE 内解密 + PER 权限层（只有本座玩家与 crank 可读）",
    how: "attestation 证明运行在真实 TDX 机器上",
    links: [{ label: "TEE 证明", href: "https://devnet-tee.magicblock.app/" }],
    trust: "MagicBlock 的 TEE 实现；度量值尚未公布",
  },
  {
    zh: "发牌无法被操纵",
    en: "Provably fair shuffle",
    by: "VRF 随机数 + 双方各自提交的盐（commit–reveal）",
    how: "按 HandProof 复算每一张牌",
    links: [{ label: "验证器", href: "/mock/history" }],
    trust: "VRF 诚实，或至少有一名玩家诚实地生成了盐",
  },
  {
    zh: "结算正确",
    en: "Settlement is auditable",
    by: "程序逻辑（7 张选 5 的评估器 + 边池规则）",
    how: "按事件流复算：HandSettled 事件对得上每一枚筹码",
    links: [{ label: "事件流复算", href: "/mock/history" }],
    trust: "TEE 执行正确",
  },
  {
    zh: "随时可以离桌",
    en: "Always able to leave",
    by: "cash_out 无需许可；预留了逃生通道",
    how: "看 L1 快照：座位账本与桌余额始终一致",
    links: [{ label: "L1 快照", href: "https://solscan.io/" }],
    trust: "委托程序升级之前：依赖 validator 存活",
  },
  {
    zh: "运营方看不到底牌",
    en: "Operator cannot see cards",
    by: "PER 权限层；运营方服务不持有玩家的 token",
    how: "权限账户的内容是公开的，谁在成员列表里一目了然",
    links: [{ label: "权限账户", href: "https://solscan.io/" }],
    trust: "托管式 MCP 例外（仅 devnet，见配套文档一）",
  },
  {
    zh: "历史可审计",
    en: "History is on L1",
    by: "每手牌 commit Game 与 HandProof，完整事件留在 L1 提交历史",
    how: "用验证器复算任意一手牌",
    links: [{ label: "验证器", href: "/mock/history" }],
    trust: "RPC 节点对历史交易的保留期",
  },
];
