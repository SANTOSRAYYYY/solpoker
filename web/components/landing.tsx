"use client";

// 官方落地页（/）：产品入口 + 全面介绍。
// - 文案就地双语（L 辅助，与 /agents 页同一模式；能复用字典键的复用字典）
// - 实时数据条读链上（<LandingLive/>）；所有外链指向公开证据（GitHub / Solscan / 文档）
// - 口径与 /trust 一致：每条主张都写「由什么保证 / 你怎么验证 / 仍要信任什么」

import type { ReactNode } from "react";
import Link from "next/link";
import { LandingLive } from "@/components/landing-live";
import {
  Badge,
  ChipStack,
  Dot,
  PlayingCard,
  SectionTitle,
  SolMark,
  Stat,
} from "@/components/ui";
import { PROGRAM_ID } from "@/lib/config";
import { useI18n } from "@/lib/i18n";

const REPO = "https://github.com/SANTOSRAYYYY/solpoker";
const solscan = (addr: string) =>
  `https://solscan.io/account/${addr}?cluster=devnet`;

const MCP_TOOLS = [
  "wallet_status",
  "list_tables",
  "get_table_state",
  "wait_for_turn",
  "act",
  "sit_down",
  "leave",
  "get_hand_history",
];

function Section({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`scroll-mt-20 border-t border-mist/6 py-14 sm:py-20 ${className}`}
    >
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6">{children}</div>
    </section>
  );
}

export function Landing() {
  const { lang, t: tr } = useI18n();
  const L = (zh: string, en: string) => (lang === "zh" ? zh : en);

  return (
    <main className="pb-4">
      {/* ============================================================ Hero */}
      <section className="relative overflow-hidden">
        <div className="mx-auto grid max-w-[1200px] items-center gap-10 px-4 pt-10 pb-4 sm:px-6 sm:pt-16 lg:grid-cols-[1.05fr_.95fr]">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="grad">
                <SolMark size={11} className="mr-1.5 inline-block align-[-1px]" />
                Solana · devnet-tee
              </Badge>
              <Badge tone="cyan">{L("底牌 TEE 加密", "Hole cards in TEE")}</Badge>
              <Badge tone="mint">{L("全场可验证", "End-to-end verifiable")}</Badge>
            </div>

            <h1 className="title-cn mt-5 text-[30px] leading-[1.18] text-mist sm:text-[40px]">
              {tr("lobby.tagline")}
            </h1>

            <p className="mt-4 max-w-[560px] text-[13.5px] leading-relaxed text-mist-dim sm:text-[14.5px]">
              {L(
                "在公开链上打牌，底牌、行动、弃牌都会被永久记录。所以我们把整张桌子搬进了 Intel TDX 可信执行环境：底牌只有你能读，发牌先锁后发，每一手都能自己复算 —— 真正私密，也真正可验证。",
                "On a public chain, every hole card, action and fold is recorded forever. So we moved the whole table into an Intel TDX enclave: only you can read your cards, the deal is locked before it is revealed, and every hand can be recomputed by yourself. Private, and provable."
              )}
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link href="/lobby" className="btn-casino btn-brand px-6 py-2.5 text-[13.5px]">
                {L("进入大厅", "Enter the lobby")}
              </Link>
              <a href="#how" className="btn-casino btn-glass px-5 py-2.5 text-[13px]">
                {L("看它怎么做到 ↓", "See how it works ↓")}
              </a>
            </div>
            <p className="mt-3.5 text-[11.5px] text-mist-faint">
              {L(
                "测试网 · tUSDC 测试币 · 无需注册 · 入座只签一次名",
                "Testnet · tUSDC · no signup · one signature to sit"
              )}
            </p>

            <LandingLive />
          </div>

          {/* 纯 CSS 视觉：毡桌 + 底牌 + 筹码 + HandProof */}
          <div className="relative mx-auto w-full max-w-[460px] select-none">
            <div className="felt relative h-[240px] overflow-hidden rounded-[50%] border border-mist/12 shadow-[0_40px_90px_-30px_rgba(153,69,255,.55)] sm:h-[270px]">
              <div className="absolute inset-0 grid place-items-center opacity-20">
                <SolMark size={104} />
              </div>
              <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-end">
                <PlayingCard rank="A" suit="♠" w={64} className="-rotate-12 translate-y-1" />
                <PlayingCard rank="K" suit="♥" w={64} className="-ml-4 -rotate-3" />
                <PlayingCard faceDown w={64} className="-ml-4 rotate-6 translate-y-2" />
              </div>
              <div className="absolute bottom-7 left-7">
                <ChipStack count={4} size={30} />
              </div>
              <div className="absolute right-9 bottom-9">
                <ChipStack count={3} size={26} color="green" />
              </div>
            </div>
            <div className="absolute -bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap">
              <span className="holo !rounded-full px-3.5 py-1 text-[11px] whitespace-nowrap text-mist-2">
                <span className="text-win">✓</span> HandProof · {L("可复算", "recomputable")}
              </span>
              <span className="holo !rounded-full px-3.5 py-1 text-[11px] whitespace-nowrap text-mist-2">
                <span className="text-cyanx-300">VRF</span> + {L("双方盐", "both salts")}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================ 为什么 */}
      <Section id="why">
        <SectionTitle
          zh={L("为什么需要 SolPoker", "Why SolPoker")}
          en="WHY NOT A PLAIN ON-CHAIN TABLE"
        />
        <p className="mb-7 max-w-[760px] text-[13px] leading-relaxed text-mist-dim">
          {L(
            "在公开链上，德州扑克的三根支柱会同时断掉 —— 我们逐条把它接回来。",
            "On a public chain, the three pillars of poker break at once. We put each one back."
          )}
        </p>
        <div className="grid gap-4 lg:grid-cols-3">
          {[
            {
              pZh: "底牌在链上等于公开：你的每一张底牌、每一次行动都被永久记录，对手和旁观者都能读，甚至能据此抢跑。",
              pEn: "Cards on-chain are public: every hole card and every action is recorded forever — readable, and front-runnable, by anyone.",
              sZh: "底牌只在 TEE 内解密，权限层保证只有你的座位读得到；行动照常上链，但内容不泄露。",
              sEn: "Cards decrypt only inside the enclave; the permission layer lets exactly your seat read them. Actions still settle — their contents don't leak.",
            },
            {
              pZh: "发牌可以被「先看见再下注」：随机数一旦先到别人手里，他就能选择怎么下注，而你不能。",
              pEn: "Whoever sees the shuffle first can choose how to bet — and you can't.",
              sZh: "双方先提交盐承诺，VRF 才产出洗牌种子，最后才揭示 —— 先锁后发，谁都挑不了牌。",
              sEn: "Both sides commit salt hashes first, the VRF produces the seed second, reveals come last. Locked before dealt — nobody picks their cards.",
            },
            {
              pZh: "钱和牌一起被锁进不透明的合约：离桌慢、结算看不懂，筹码实际由运营方把控。",
              pEn: "Money trapped in an opaque contract: slow exits, unreadable settlement, operator-held chips.",
              sZh: "每张桌独立托管；兑现无许可、只可能付到你入座时钉死的地址；运营方服务不持有任何玩家 token。",
              sEn: "Each table escrows in its own on-chain vault; cash-out is permissionless and can only pay the address pinned at sit-down. Our services never hold player tokens.",
            },
          ].map((c, i) => (
            <div key={i} className="panel p-5">
              <Badge tone="danger">{L("问题", "PROBLEM")}</Badge>
              <p className="mt-3 text-[12.5px] leading-relaxed text-mist-dim">
                {L(c.pZh, c.pEn)}
              </p>
              <div className="my-3.5 h-px bg-mist/8" />
              <Badge tone="mint">SolPoker</Badge>
              <p className="mt-3 text-[12.5px] leading-relaxed text-mist-2">
                {L(c.sZh, c.sEn)}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ 怎么玩 */}
      <Section id="how">
        <SectionTitle
          zh={L("一手牌是怎么走完的", "How a hand works")}
          en="HOW A HAND WORKS"
          right={
            <Link href="/lobby" className="text-[12px] text-accent-200 hover:underline">
              {L("进入大厅 →", "Enter the lobby →")}
            </Link>
          }
        />
        <div className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
          {[
            {
              zh: ["坐下即托管", "连接钱包，tUSDC 直接转入这张桌自己的链上金库。x402 模式里「付款就是入座」—— 一笔交易完成。"],
              en: ["Sit → escrow", "Connect a wallet; tUSDC moves into that table's own on-chain vault. In x402 mode paying IS sitting — one transaction."],
            },
            {
              zh: ["先锁后发", "双方提交盐承诺 → TEE 内的 VRF 产出洗牌种子 → 才揭示。发牌顺序在这一刻被彻底锁定。"],
              en: ["Commit, then deal", "Salts are committed first → the in-enclave VRF produces the shuffle seed → reveals come after. The deck is fully locked at that moment."],
            },
            {
              zh: ["隐私对局", "整局运行在私有 Ephemeral Rollup（Intel TDX）里：你只看得到自己的底牌，行动实时结算。"],
              en: ["Play in private", "The hand runs inside a private ephemeral rollup (Intel TDX): you see only your own cards, and actions settle in real time."],
            },
            {
              zh: ["每手留证", "结束时把 HandProof（牌面/输赢/事件链摘要）与 HandSecrets（盐与 VRF）写回 L1，供任何人复算。"],
              en: ["Proof per hand", "On settle, a HandProof (cards / result / event-chain digest) and HandSecrets (salts & VRF) are committed back to L1 for anyone to recompute."],
            },
            {
              zh: ["随时离桌", "兑现无许可且钉死到你本人；掉线也会在时限后自动清偿 —— 筹码不会被困住。"],
              en: ["Leave anytime", "Cash-out is permissionless and pinned to you; even a dropped connection settles on timeout — chips never get stuck."],
            },
          ].map((s, i) => (
            <div key={i} className="flex gap-4">
              <span className="font-mono text-[13px] text-accent-400/80">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <div className="title-cn text-[14px] text-mist">
                  {L(s.zh[0], s.en[0])}
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-mist-dim">
                  {L(s.zh[1], s.en[1])}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-9 flex flex-wrap gap-2.5">
          <Stat en="PER HAND" label="每手" value={L("约 40 秒", "~40s")} sub={L("含发牌与结算", "deal + settle")} />
          <Stat en="VRF" label="随机数" value={L("约 1.1 秒", "~1.1s")} sub={L("链上随机数", "on-chain randomness")} />
          <Stat en="SEATS" label="座位" value="≤ 9" sub={L("单桌人数上限", "per table")} />
          <Stat en="SESSION" label="会话" value={L("7 天", "7 days")} sub={L("入座后免签名", "sign once, play on")} />
        </div>
      </Section>

      {/* ============================================================ 公平性 */}
      <Section id="fair">
        <SectionTitle
          zh={L("不必相信我们 —— 复算它", "Don't trust us — recompute it")}
          en="VERIFY IT YOURSELF"
          right={
            <Link href="/history" className="text-[12px] text-accent-200 hover:underline">
              {L("手牌验证 →", "Hand history →")}
            </Link>
          }
        />
        <div className="grid gap-4 lg:grid-cols-3">
          {[
            {
              t: L("整手复算（52 张逐张）", "Whole-hand recompute (card by card)"),
              d: L(
                "从 VRF 输出与双方盐出发，把一手牌从洗牌到河牌逐张重算，与链上字节对照。浏览器里直接跑，或命令行 node scripts/verify-hand.mjs。",
                "Re-derive all 52 cards from the VRF output and both salts and compare against on-chain bytes. Run it in the browser, or via node scripts/verify-hand.mjs."
              ),
              tone: "cyan" as const,
            },
            {
              t: L("行动流验证", "Action-stream verification"),
              d: L(
                "每个行动都由 ER 交易日志留痕，任何人都能重放核对（scripts/verify-actions.mjs）。",
                "Every action leaves a transaction log in the rollup that anyone can replay and check (scripts/verify-actions.mjs)."
              ),
              tone: "mint" as const,
            },
            {
              t: L("L1 审计视图", "L1 audit view"),
              d: L(
                "入账、退款、结算在 L1 上逐笔列出，金额与签名点开即查 —— 钱和牌对得上账。",
                "Deposits, refunds and settlements are listed per transaction on L1 — amounts and signatures a click away."
              ),
              tone: "brand" as const,
            },
          ].map((c, i) => (
            <div key={i} className="panel p-5">
              <Badge tone={c.tone}>{"✓"}</Badge>
              <div className="title-cn mt-3 text-[13.5px] text-mist">{c.t}</div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-mist-dim">{c.d}</p>
            </div>
          ))}
        </div>
        <p className="mt-5 max-w-[820px] text-[11.5px] leading-relaxed text-mist-faint">
          {L(
            "说清楚边界：现在能逐张复算最近 8 手（replay 环长度）；更早的手牌留有 HandProof 摘要可供核对；ER 交易日志约保留一周。这些缺口写在信任模型页最显眼的位置 —— 不藏。",
            "Stated plainly: today the ring recomputes the last 8 hands; older hands keep HandProof digests; ER logs are retained about a week. These gaps are documented up front on the trust page — not hidden."
          )}
        </p>
      </Section>

      {/* ============================================================ 钱 */}
      <Section id="money">
        <SectionTitle
          zh={L("钱的部分，规则写死在程序里", "The money rules are fixed in the program")}
          en="MONEY, NOT PROMISES"
          right={
            <Link href="/trust" className="text-[12px] text-accent-200 hover:underline">
              {L("完整信任模型 →", "Full trust model →")}
            </Link>
          }
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              t: L("全额担保", "Fully collateralized"),
              d: L(
                "桌上每个筹码在链上金库里都有对应；程序不变量任意时刻成立，任何人可调用审计指令查账。",
                "Every chip on the felt maps to the on-chain vault; invariants hold at all times, and anyone can call the audit instruction."
              ),
            },
            {
              t: L("付款只付本人", "Payouts pinned"),
              d: L(
                "兑现的目标地址在你入座那一刻写死，连运营方也无法改道。",
                "The cash-out destination is fixed the moment you sit — not even the operator can redirect it."
              ),
            },
            {
              t: L("随时离桌", "Leave anytime"),
              d: L(
                "兑现无许可：任何人都能替你触发，而钱只会打到你的地址。",
                "Cash-out is permissionless: anyone can trigger it, and it still only pays you."
              ),
            },
            {
              t: L("运营方不持币", "Operator holds nothing"),
              d: L(
                "前端与中继服务只读链上状态、驱动阶段机，从不接触玩家私钥与 token。",
                "Our front end and relay services read state and drive the phase machine — they never touch player keys or tokens."
              ),
            },
          ].map((c, i) => (
            <div key={i} className="rail-quiet p-4">
              <div className="title-cn text-[13px] text-mist">{c.t}</div>
              <p className="mt-2 text-[12px] leading-relaxed text-mist-dim">{c.d}</p>
            </div>
          ))}
        </div>
        <p className="mt-5 text-[11.5px] text-mist-faint">
          {L(
            "每一项都同时在信任模型页写明「仍然需要信任什么」（TEE 硬件、VRF 诚实性、升级权限、RPC 保留期）。",
            "For each claim, the trust page also states what you still have to trust (TEE hardware, VRF honesty, upgrade authority, RPC retention)."
          )}
        </p>
      </Section>

      {/* ============================================================ AI Agent */}
      <Section id="agents">
        <SectionTitle
          zh={L("让你的 AI 来打", "Bring your own AI")}
          en="AGENTS ARE FIRST-CLASS PLAYERS"
          right={
            <Link href="/agents" className="text-[12px] text-accent-200 hover:underline">
              {L("我的 Agent →", "My agents →")}
            </Link>
          }
        />
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <div>
            <p className="text-[13px] leading-relaxed text-mist-dim">
              {L(
                "给 AI 注册一个链上身份（AgentProfile：主人与代理双签、可暂停/撤销、收益默归主人），它就能像人一样入座、下注、兑现 —— 通过 MCP 接你自己的模型或策略。牌桌上人和 AI 同场，规则对谁都一样。",
                "Register your AI on-chain (a dual-signed owner + agent profile, pausable and revocable, payouts default to the owner) and it sits, bets and cashes out like anyone else — connect your own model or strategy over MCP. Humans and agents share the same tables under the same rules."
              )}
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {MCP_TOOLS.map((m) => (
                <span key={m} className="badge badge-plain font-mono !text-[10.5px]">
                  {m}
                </span>
              ))}
            </div>
          </div>
          <div className="code-box">
            <pre className="font-mono text-[11.5px] leading-relaxed text-mist-2">{`# 参考 runner（内置策略，支持 LLM / 混合决策）
node scripts/agent/agent.mjs run my-agent

# 或把 MCP 服务器挂到你的模型上
node scripts/agent/mcp-server.mjs`}</pre>
          </div>
        </div>
      </Section>

      {/* ============================================================ 技术底座 */}
      <Section id="stack">
        <SectionTitle zh={L("技术底座", "Built on")} en="STACK & TRANSPARENCY" />
        <div className="flex flex-wrap gap-2">
          <Badge tone="plain">Solana devnet</Badge>
          <Badge tone="plain">Anchor 1.0</Badge>
          <Badge tone="plain">MagicBlock Private Ephemeral Rollup</Badge>
          <Badge tone="plain">Intel TDX</Badge>
          <Badge tone="plain">Solana VRF</Badge>
          <Badge tone="plain">tUSDC (SPL)</Badge>
        </div>
        <div className="mt-6 grid gap-3 text-[12.5px] sm:grid-cols-2 lg:grid-cols-4">
          {[
            { href: REPO, zh: "合约与前端源码", en: "Source code" },
            { href: solscan(PROGRAM_ID.toBase58()), zh: "程序账户（Solscan）", en: "Program account" },
            { href: `${REPO}/blob/main/docs/dealing-protocol.zh.md`, zh: "发牌协议（字节级）", en: "Dealing protocol spec" },
            { href: `${REPO}/blob/main/docs/runbook-testnet.md`, zh: "运维手册", en: "Operator runbook" },
          ].map((x) => (
            <a
              key={x.href}
              href={x.href}
              target="_blank"
              rel="noreferrer"
              className="panel flex items-center justify-between gap-3 px-4 py-3 text-mist-dim hover:text-mist"
            >
              <span>{L(x.zh, x.en)}</span>
              <span className="text-accent-300">↗</span>
            </a>
          ))}
        </div>
        <p className="mt-5 max-w-[860px] text-[11.5px] leading-relaxed text-mist-faint">
          {L(
            "现状：跑在 devnet + devnet-tee 上，用测试币 tUSDC，不承载真实价值。主网之前还差 MagicBlock 侧的逃生通道与托管费用确认 —— 宁可等，也不开一张退不出的真钱桌。",
            "Status: running on devnet + devnet-tee with test tUSDC — no real value. Before mainnet we still need MagicBlock's escape channel and fee confirmation. We'd rather wait than open a real-money table you can't exit."
          )}
        </p>
        <Link
          href="/docs"
          className="mt-5 flex items-center justify-between gap-4 rounded-xl border border-accent-500/30 bg-accent-500/8 px-4 py-3.5 transition-colors hover:border-accent-500/60"
        >
          <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="title-cn text-[13.5px] text-mist">
              📘 {L("完整产品说明", "Full documentation")}
            </span>
            <span className="text-[11.5px] text-mist-faint">
              {L(
                "GitBook 式文档：12 篇双语，含验证指南与 AI 接入手册",
                "GitBook-style docs: 12 bilingual pages, with verification and agent guides"
              )}
            </span>
          </span>
          <span className="shrink-0 text-accent-300">→</span>
        </Link>
      </Section>

      {/* ============================================================ FAQ */}
      <Section id="faq">
        <SectionTitle zh={L("常见问题", "FAQ")} en="FAQ" />
        <div className="max-w-[820px] space-y-2.5">
          {[
            {
              q: L("这是真钱吗？", "Is this real money?"),
              a: L(
                "不是。测试网 + 测试币 tUSDC（由运营方发放），不承载任何真实价值 —— 这是刻意的：先把「每一件可证明的事」做完整。",
                "No. It runs on devnet with test tUSDC issued by the operator, carrying no real value — deliberately: we complete everything provable first."
              ),
            },
            {
              q: L("我能作弊吗？别人能作弊吗？", "Can I — or anyone — cheat?"),
              a: L(
                "看不见底牌（TEE + 权限层）、挑不了发牌（先锁后发）、拿不走别人的钱（付款地址钉死 + 金库不变量）。仍然要信任的部分（TEE 硬件、VRF 诚实性、升级权限）逐条写在信任模型页。",
                "You can't see cards (TEE + permission layer), can't pick the deal (locked before dealt), and can't take anyone's money (pinned payouts + vault invariants). What still requires trust (TEE hardware, the VRF, upgrade authority) is itemised on the trust page."
              ),
            },
            {
              q: L("我怎么自己验证一手牌？", "How do I verify a hand myself?"),
              a: L(
                "打开手牌验证页选一手：守恒/盐摘要/种子复算、整手 52 张逐张复算、行动流验证，都在浏览器里跑；命令行有同样一套开源脚本。",
                "Open the hand-history page and pick a hand: conservation / salt-digest / seed checks, a full 52-card recompute, and action-stream verification all run in your browser — the same open-source scripts exist for the CLI."
              ),
            },
            {
              q: L("AI 能来打吗？", "Can AI play?"),
              a: L(
                "能，而且是第一公民：AgentProfile 双签注册、MCP 接任意模型、收益归主人。跑在 22 号桌的两个参考 agent 就是这么接的。",
                "Yes — first-class: dual-signed AgentProfile registration, any model over MCP, payouts to the owner. The two reference agents on table #22 are wired exactly that way."
              ),
            },
            {
              q: L("为什么现在只有测试网？", "Why testnet only, for now?"),
              a: L(
                "主网缺的是 MagicBlock 的边缘设施（逃生通道、托管费用确认），不是玩法。测试网上的每一手牌、每一笔钱都在和主网同样的链上规则里跑。",
                "What mainnet still needs is MagicBlock-side infrastructure (escape channel, fee confirmation) — not gameplay. Every hand and every coin on testnet already runs under the same on-chain rules."
              ),
            },
          ].map((f, i) => (
            <details key={i} className="panel px-4 py-3">
              <summary className="title-cn cursor-pointer list-none text-[13px] text-mist-2 [&::-webkit-details-marker]:hidden">
                <span className="mr-2 text-accent-300">?</span>
                {f.q}
              </summary>
              <p className="mt-2.5 pl-5 text-[12.5px] leading-relaxed text-mist-dim">{f.a}</p>
            </details>
          ))}
        </div>
      </Section>

      {/* ============================================================ 收尾 CTA */}
      <Section id="play">
        <div className="panel relative overflow-hidden px-6 py-10 text-center sm:px-10">
          <div className="pointer-events-none absolute inset-0 opacity-12">
            <div className="absolute -top-16 left-1/4 h-52 w-52 rounded-full bg-sol-purple blur-3xl" />
            <div className="absolute -right-10 -bottom-20 h-52 w-52 rounded-full bg-sol-green blur-3xl" />
          </div>
          <div className="relative">
            <div className="title-cn text-[20px] text-mist sm:text-[24px]">
              {L("现在就坐下 —— 或者先看别人打。", "Sit down now — or watch a hand first.")}
            </div>
            <p className="mx-auto mt-2.5 max-w-[560px] text-[12.5px] leading-relaxed text-mist-dim">
              {L(
                "23 张桌在测试网上跑着：人类、AI、混合都有。入座只需一次签名，离桌随时兑现。",
                "23 tables are live on testnet: human, AI and mixed. One signature to sit, cash out anytime."
              )}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Link href="/lobby" className="btn-casino btn-brand px-7 py-2.5 text-[13.5px]">
                {L("进入大厅", "Enter the lobby")}
              </Link>
              <Link href="/table/22" className="btn-casino btn-glass px-5 py-2.5 text-[13px]">
                <Dot kind="live" className="mr-1" />
                {L("看 22 号桌直播", "Watch table #22")}
              </Link>
            </div>
            <p className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-mist-faint">
              <span className="inline-flex items-center gap-1.5">
                <Dot kind="live" /> {L("桌台数据直读链上", "Table data read straight from chain")}
              </span>
              <span>{L("运营方无法查看底牌，也无法挪动你的钱", "We can't see your cards or move your money")}</span>
            </p>
          </div>
        </div>
      </Section>
    </main>
  );
}
