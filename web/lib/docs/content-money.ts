// 文档内容 · 资金组：资金与托管 / x402 付费入座。
import type { DocPage } from "./types";

export const MONEY_PAGES: DocPage[] = [
  {
    slug: "money",
    group: "money",
    title: { zh: "资金与托管", en: "Money & escrow" },
    summary: {
      zh: "钱在哪、怎么进、怎么出：每桌一个链上金库，兑现无许可且地址钉死。",
      en: "Where the money sits, how it comes in and how it leaves: a vault per table, permissionless cash-out to a pinned address.",
    },
    keywords: ["资金", "托管", "金库", "兑现", "提现", "money", "escrow", "vault", "cash out", "withdraw"],
    blocks: [
      {
        t: "p",
        c: {
          zh: "筹码只是账本上的数字，钱始终在链上：每张桌一个独立金库（L1 上的 tUSDC 账户），只有程序能划动。牌局在 ER 里加速跑，但资金动作（入金、退款、兑现）只发生在 L1 规则下。",
          en: "Chips are ledger numbers; the money stays on-chain: one dedicated vault per table (an L1 tUSDC account) that only the program can move. The game runs fast inside the ER, but every money movement (deposit, refund, cash-out) happens under L1 rules.",
        },
      },
      {
        t: "h2",
        c: { zh: "入座与买入", en: "Sitting down" },
      },
      {
        t: "ol",
        items: [
          { zh: "你的 tUSDC 从钱包转入该桌金库（一笔标准 SPL 转账）。", en: "Your tUSDC moves from your wallet into the table's vault (a standard SPL transfer)." },
          { zh: "程序记录你的收货地址（payout ATA）与占用号；买入超出桌参数区间会被拒绝。", en: "The program records your payout ATA and occupancy id; a buy-in outside the table's range is rejected." },
          { zh: "入金被计入你的桌上筹码（手与手之间计入，不影响进行中的手牌）。", en: "The deposit is credited to your stack (between hands — a hand in progress is never touched)." },
        ],
      },
      {
        t: "h2",
        c: { zh: "兑现与离桌", en: "Cashing out" },
      },
      {
        t: "ul",
        items: [
          { zh: "兑现无许可：你、对手、甚至任何路人都能替你触发，但钱只会打到入座时钉死的地址。", en: "Cash-out is permissionless: you, an opponent, or any passer-by can trigger it — and it still only pays the address pinned at sit-down." },
          { zh: "掉线不清空：超时自动推进，未结清的部分留在账本里等你回来取。", en: "Disconnecting doesn't wipe anything: timeouts move the game along and unsettled funds stay on the ledger for you." },
          { zh: "多余入金可原路退回（退款记录同样上链）。", en: "Surplus deposits can be refunded back the way they came (refunds are recorded on-chain too)." },
        ],
      },
      {
        t: "h2",
        c: { zh: "审计：任何人都能查账", en: "Audit: anyone can check the books" },
      },
      {
        t: "ul",
        items: [
          { zh: "程序内建审计指令：任何人都可以对一张桌调用，核对「桌内筹码 ↔ 金库余额」是否一致。", en: "A built-in audit instruction: anyone can call it on a table to reconcile in-table chips against the vault balance." },
          { zh: "不变量：状态提交只发生在底池为零时；筹码总量在任何时刻与金库一一对应。", en: "Invariants: state is only committed while the pot is zero, and total chips always map one-to-one to the vault." },
          { zh: "「手牌验证」页的 L1 审计视图把入账、退款、结算逐笔列出（金额与签名可点开）。", en: "The hand-history page's L1 audit view lists deposits, refunds and settlements per transaction (amounts and signatures a click away)." },
        ],
      },
      {
        t: "h2",
        c: { zh: "会话密钥与手续费", en: "Session keys and fees" },
      },
      {
        t: "p",
        c: {
          zh: "入座时一次签名会把一个会话密钥预充 0.001 SOL（用于支付 ER 上的手续费），有效期 7 天，只能替你这一座位行动。链上手续费由会话密钥支付，你不需要为每次行动签钱包。",
          en: "The sit-down signature prefunds a session key with 0.001 SOL for ER fees. It lasts 7 days and can only act for your seat. On-chain fees are paid from the session key — you never sign per action.",
        },
      },
      {
        t: "callout",
        tone: "warn",
        title: { zh: "测试币", en: "Test currency" },
        c: {
          zh: "devnet 上的一切金额都是 tUSDC 测试币，不承载真实价值；主网资金规则将以同样不变量为基础，但需等 MagicBlock 侧的逃生通道与费用确认。",
          en: "All amounts on devnet are test tUSDC with no real value. Mainnet money rules will build on the same invariants but wait on MagicBlock's escape channel and fee confirmation.",
        },
      },
      {
        t: "links",
        items: [
          { href: "/trust", label: { zh: "信任模型（逐项证据）", en: "Trust model (evidence per claim)" } },
          { href: "/docs/x402", label: { zh: "x402 付费入座", en: "x402 pay-per-seat" } },
        ],
      },
    ],
  },

  {
    slug: "x402",
    group: "money",
    title: { zh: "x402 付费入座", en: "x402 pay-per-seat" },
    summary: {
      zh: "为自动化客户端设计的付费通道：402 报价 → 付款 → 入座，两种模式都支持。",
      en: "A payment channel for automated clients: 402 quote → pay → sit, in two supported modes.",
    },
    keywords: ["x402", "付费", "入座", "支付", "网关", "payment", "gateway", "402"],
    blocks: [
      {
        t: "p",
        c: {
          zh: "x402 是本产品为「付费即入座」设计的通道：客户端请求座位会先收到 402 报价，付款后由链上凭据完成入座，全程无需人工确认。适合 agent、脚本、以及任何要批量开座的集成方。",
          en: "x402 is how this product sells a seat: a client asking for one gets a 402 quote first, and the on-chain receipt completes the sit-down — no human confirmation anywhere. Built for agents, scripts and integrators that open seats in bulk.",
        },
      },
      {
        t: "h2",
        c: { zh: "两种模式", en: "Two modes" },
      },
      {
        t: "cards",
        items: [
          {
            title: { zh: "原子模式", en: "Atomic mode" },
            badge: { zh: "一笔交易", en: "one tx" },
            desc: {
              zh: "付款交易本身就是入座：给金库的转账与 sit_down 写在同一笔里，要么同时成功要么同时失败。",
              en: "The payment transaction is the sit-down: the transfer to the vault and the sit_down land in the same transaction — all or nothing.",
            },
          },
          {
            title: { zh: "标准模式", en: "Standard mode" },
            badge: { zh: "网关记账", en: "gateway receipt" },
            desc: {
              zh: "网关先报价、客户端先付款，链上用 credit_x402_deposit 把付款凭据记成入账，再落座；退款走 refund_x402_deposit。",
              en: "The gateway quotes first, the client pays, then credit_x402_deposit records the payment as a credited deposit on-chain before sitting; refunds go through refund_x402_deposit.",
            },
          },
        ],
      },
      {
        t: "h2",
        c: { zh: "链上安全设计", en: "On-chain safety design" },
      },
      {
        t: "ul",
        items: [
          { zh: "网关门禁：入账指令只接受配置里指定的网关收款账户签名，别人无法伪造入账。", en: "Gateway gate: the credit instruction only accepts the configured gateway signer, so receipts can't be forged." },
          { zh: "防重复入账：入账凭据以其付款签名的两半为种子生成唯一账户，同一笔付款不可能入账两次。", en: "Double-credit proof: a receipt's PDA is seeded from both halves of the payment signature — one payment can never credit twice." },
          { zh: "只动盈余：退款只能退回「未被筹码担保覆盖」的部分，永远动不了桌上正在用的钱。", en: "Surplus only: refunds can only return funds not backing live chips — money in play can never be touched." },
        ],
      },
      {
        t: "h2",
        c: { zh: "本地试一下", en: "Try it locally" },
      },
      {
        t: "code",
        caption: { zh: "仓库自带网关与客户端模拟", en: "The repo ships a gateway and a client simulator" },
        text: `node scripts/x402-gateway.mjs --port 8790   # 报价 /health / 重复入账 409 / 退款分支
node scripts/x402-pay.mjs                    # 标准模式客户端：付款 + 入账闭环自检
node scripts/x402-refund.mjs                 # 退款（凭据回编校验）`,
      },
      {
        t: "links",
        items: [
          { href: "/docs/money", label: { zh: "资金与托管", en: "Money & escrow" } },
          { href: "https://github.com/SANTOSRAYYYY/solpoker/blob/main/docs/runbook-testnet.md", label: { zh: "运维手册（x402 网关）", en: "Operator runbook (x402 gateway)" }, external: true },
        ],
      },
    ],
  },
];
