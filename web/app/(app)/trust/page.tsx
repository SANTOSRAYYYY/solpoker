"use client";

// 信任模型（设计文档 §16 八项）：不写口号，只写「由什么保证 / 你怎么自己验证 /
// 仍然需要信任什么」，每项都链到链上或代码证据。

import Link from "next/link";
import { Badge, Dot, SectionTitle } from "@/components/ui";
import { PROGRAM_ID } from "@/lib/config";
import { useI18n } from "@/lib/i18n";

const REPO = "https://github.com/SANTOSRAYYYY/solpoker";
const solscan = (addr: string) => `https://solscan.io/account/${addr}?cluster=devnet`;

const HARDWARE: { zh: string; en: string; vZh: string; vEn: string }[] = [
  {
    zh: "运行环境",
    en: "Runtime",
    vZh: "MagicBlock TEE（Intel TDX）· devnet-tee",
    vEn: "MagicBlock TEE (Intel TDX) · devnet-tee",
  },
  {
    zh: "attestation",
    en: "attestation",
    vZh: "已验证 ✓　（可证明是真实 TDX 机器）",
    vEn: "verified ✓ (proves a genuine TDX machine)",
  },
  {
    zh: "度量值 MRTD/RTMR",
    en: "Measurements MRTD/RTMR",
    vZh: "MagicBlock 尚未公布（§18.2 已列入待答复）",
    vEn: "Not published by MagicBlock yet (tracked in §18.2)",
  },
  {
    zh: "执行记录保留期",
    en: "Execution-record retention",
    vZh: "约一周（待 MagicBlock 书面确认后写入本页）",
    vEn: "About one week (pending MagicBlock's written confirmation)",
  },
];

interface Item {
  zh: string;
  en: string;
  by: string;
  byEn: string;
  how: string;
  howEn: string;
  links: { label: string; labelEn: string; href: string }[];
  trust: string;
  trustEn: string;
}

const ITEMS: Item[] = [
  {
    zh: "钱只能付给本人",
    en: "Payouts are pinned",
    by: "程序钉死了收款地址（入座时固定的 payout ATA：真人为本人，agent 默认为主人）；cash_out 任何人都能触发",
    byEn:
      "Payout addresses are pinned in the program (the seat's payout ATA is fixed at sit-down: the player themself, or the owner for agents); anyone can trigger cash_out",
    how: "读开源代码、核对可验证构建、看 L1 上的余额",
    howEn: "Read the open-source code, check the verifiable build, inspect balances on L1",
    links: [
      { label: "合约源码", labelEn: "Source", href: REPO },
      { label: "程序账户", labelEn: "Program account", href: solscan(PROGRAM_ID.toBase58()) },
    ],
    trust: "程序升级权限（主网交给多签或锁定升级）",
    trustEn: "the program's upgrade authority (to be handed to a multisig or locked before mainnet)",
  },
  {
    zh: "每张桌全额有担保",
    en: "Fully collateralized",
    by: "I-X 不变量；commit 只在 pot = 0 时发生",
    byEn: "The I-X invariants; state commits only happen while pot = 0",
    how: "任何人都可以调用 audit_table 检查桌内筹码与账本",
    howEn: "Anyone can call audit_table to reconcile in-table chips against the ledger",
    links: [
      {
        label: "audit_table 源码",
        labelEn: "audit_table source",
        href: `${REPO}/blob/main/programs/solpoker/src/instructions/audit_table.rs`,
      },
    ],
    trust: "同上：升级权限",
    trustEn: "same: the upgrade authority",
  },
  {
    zh: "牌局中底牌保密",
    en: "Hole cards stay private",
    by: "TEE 内解密 + PER 权限层（只有本座玩家与 crank 可读）",
    byEn: "Decryption inside the TEE + the PER permission layer (only the seat's player and the crank can read)",
    how: "attestation 证明运行在真实 TDX 机器上；实测无 token 读私有账户返回 null",
    howEn: "Attestation proves it runs on a genuine TDX machine; reading a private account without a token returns null (measured)",
    links: [
      {
        label: "TEE 文档",
        labelEn: "TEE docs",
        href: "https://docs.magicblock.gg/pages/tools/tee/introduction",
      },
    ],
    trust: "MagicBlock 的 TEE 实现；度量值尚未公布",
    trustEn: "MagicBlock's TEE implementation; measurements not published yet",
  },
  {
    zh: "发牌无法被操纵",
    en: "Provably fair shuffle",
    by: "VRF 随机数 + 双方各自提交的盐（commit–reveal）",
    byEn: "VRF randomness plus each side's own committed salt (commit–reveal)",
    how: "按 HandProof + HandReplay 复算每一张牌（逐张比对），并可按链上事件日志复算行动序列",
    howEn: "Recompute every card from HandProof + HandReplay (card by card), and replay the action sequence from the on-chain event log",
    links: [{ label: "验证器", labelEn: "Verifier", href: "/history" }],
    trust: "VRF 诚实，或至少有一名玩家诚实地生成了盐",
    trustEn: "the VRF being honest, or at least one player genuinely generating their salt",
  },
  {
    zh: "结算正确",
    en: "Settlement is auditable",
    by: "程序逻辑（7 张选 5 的评估器 + 边池规则）",
    byEn: "Program logic (best-5-of-7 evaluator and side-pot rules)",
    how: "按事件流复算：HandSettled 事件对得上每一枚筹码",
    howEn: "Recompute from the event stream: the HandSettled event accounts for every chip",
    links: [
      { label: "结算实现", labelEn: "Settlement code", href: `${REPO}/blob/main/crates/solpoker-core/src/settle.rs` },
      { label: "验证器", labelEn: "Verifier", href: "/history" },
    ],
    trust: "TEE 执行正确",
    trustEn: "the TEE executing correctly",
  },
  {
    zh: "随时可以离桌",
    en: "Always able to leave",
    by: "cash_out 无需许可；预留了逃生通道",
    byEn: "Permissionless cash_out; an escape channel is reserved",
    how: "看 L1 快照：座位账本与桌余额始终一致",
    howEn: "Inspect the L1 snapshot: seat ledgers and the table balance always agree",
    links: [{ label: "程序账户", labelEn: "Program account", href: solscan(PROGRAM_ID.toBase58()) }],
    trust: "委托程序升级之前：依赖 validator 存活",
    trustEn: "until the delegation program is upgraded: the validator staying alive",
  },
  {
    zh: "运营方看不到底牌",
    en: "Operator cannot see cards",
    by: "PER 权限层；运营方服务不持有玩家的 token",
    byEn: "The PER permission layer; operator services never hold a player's token",
    how: "权限账户的内容是公开的，谁在成员列表里一目了然",
    howEn: "Permission accounts are public — the member list shows exactly who can read what",
    links: [
      {
        label: "权限程序",
        labelEn: "Permission program",
        href: solscan("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"),
      },
    ],
    trust: "托管式 MCP 例外（仅 devnet，见配套文档一）",
    trustEn: "the hosted-MCP exception (devnet only; see companion doc 1)",
  },
  {
    zh: "历史可审计",
    en: "History is on L1",
    by: "每手牌 commit Game / HandProof / HandReplay，行动事件 emit 进链上事件日志",
    byEn: "Every hand commits Game / HandProof / HandReplay, and action events are emitted to the on-chain log",
    how: "用验证器复算任意一手牌：52 张逐张重抽 + 行动序列对链上锚点",
    howEn: "Use the verifier on any hand: 52 cards re-drawn one by one, plus the action sequence matched against on-chain anchors",
    links: [{ label: "验证器", labelEn: "Verifier", href: "/history" }],
    trust:
      "RPC 节点对历史交易的保留期（约一周）—— 牌面与结果的链上锚点永久保留，但重放行动流所需的交易日志会过期",
    trustEn:
      "RPC nodes' history retention (about one week) — card/result anchors stay on L1 forever, but the transaction logs needed to replay the action stream expire",
  },
];

/** 一手牌的旅程：方框流程（sealed = 只存在于 TDX 硬件内，其余公开可查）。 */
const FLOW: { zh: string; en: string; dZh: string; dEn: string; sealed?: boolean }[] = [
  {
    zh: "你与对手 · 座位（浏览器）",
    en: "You & opponents · seats (browser)",
    dZh: "钱包在浏览器里签名；入座把 tUSDC 转进这张桌自己的链上金库，座位账本永远在 L1 上。",
    dEn: "The wallet signs in the browser; sitting down moves tUSDC into that table's own on-chain vault, and seat ledgers live on L1 forever.",
  },
  {
    zh: "Solana VRF 队列",
    en: "Solana VRF queue",
    dZh: "洗牌种子的来源：公开随机数，谁都能事后核对它的输出与请求次序。",
    dEn: "The source of the shuffle seed: public randomness whose output and request order anyone can check afterwards.",
  },
  {
    zh: "TDX 内的私有牌桌 · PER 权限层",
    en: "Private table inside TDX · PER permission layer",
    dZh: "整手牌在这里运行，底牌只在这里解密；权限层把可读成员限定为「本座玩家」—— 连运营方也读不到。",
    dEn: "The hand runs here and hole cards decrypt only here; the permission layer limits readers to the seat's own player — even the operator can't read them.",
    sealed: true,
  },
  {
    zh: "Solana L1 · 每桌金库与结算凭据",
    en: "Solana L1 · per-table vault & settlement anchors",
    dZh: "每手结束把 HandProof / HandSecrets / HandReplay 写回；入账、退款、兑现在链上逐笔可见。",
    dEn: "Each hand commits HandProof / HandSecrets / HandReplay back to L1; deposits, refunds and cash-outs are visible per transaction.",
  },
  {
    zh: "你的浏览器 · 开源验证器",
    en: "Your browser · open-source verifier",
    dZh: "用链上数据把整手牌从 VRF + 双方盐逐张复算，与链上字节对照 —— 不信的话，自己算。",
    dEn: "Recompute the whole hand from the VRF and both salts, card by card, against on-chain bytes — if you don't trust it, run it.",
  },
];

/** 方框之间的编号说明（比 FLOW 少一条）。 */
const FLOW_STEPS: { zh: string; en: string }[] = [
  {
    zh: "盐承诺 → 揭示：双方先交哈希，最后才亮盐，谁都挑不了牌",
    en: "Salt commit → reveal: hashes first, salts last — nobody picks their cards",
  },
  {
    zh: "洗牌种子：VRF 产出公开随机数，先锁后发，牌序在此定格",
    en: "Shuffle seed: the VRF emits public randomness; locked before dealt",
  },
  {
    zh: "结算凭据：HandProof / HandSecrets / HandReplay 写回 L1",
    en: "Settlement anchors: HandProof / HandSecrets / HandReplay to L1",
  },
  {
    zh: "复算：52 张逐张重抽，与链上字节比对",
    en: "Recompute: 52 cards re-drawn one by one, matched byte-for-byte",
  },
];

/** 试着作弊：每条攻击 + 程序/硬件层面的拦截（全部有实测或代码依据）。 */
const ATTACKS: { zh: string; en: string; dZh: string; dEn: string }[] = [
  {
    zh: "偷看底牌",
    en: "Peek at hole cards",
    dZh: "底牌只在 TEE 内解密；PER 权限层把可读成员限定为本座玩家。无 token 读私有账户的实测结果是 null。",
    dEn: "Hole cards decrypt only inside the TEE; the PER permission layer limits readers to the seat's player. Reading a private account without a token returns null (measured).",
  },
  {
    zh: "操纵发牌",
    en: "Rig the deal",
    dZh: "你先交盐的哈希承诺，VRF 才产出洗牌种子，最后才揭示。先锁后发 —— 任何人的盐晚到一步都无效。",
    dEn: "Your salt's hash commitment goes in first, the VRF produces the seed second, reveals come last. Locked before dealt — a late salt is simply void.",
  },
  {
    zh: "改派付款",
    en: "Redirect a payout",
    dZh: "兑现地址在你入座那一刻钉死（payout ATA）；cash_out 谁都能触发，但钱只会打到这个地址。",
    dEn: "The payout ATA is pinned at sit-down; anyone can trigger cash_out, but it can only pay that address.",
  },
  {
    zh: "偷 session key / 断线卡桌",
    en: "Steal a session key / stall by disconnecting",
    dZh: "session key 只能替你的座位行动、7 天过期，且钱仍然只付给你；掉线后行动与揭示超时会自动推进，没人能靠挂机拖住整桌。",
    dEn: "A session key can only act for your seat, expires in 7 days, and money still only goes to you; on disconnect, action/reveal timeouts advance the table — nobody can stall it by idling.",
  },
];

const LIMITS: { zh: string; en: string; dZh: string; dEn: string }[] = [
  {
    zh: "仍是 devnet",
    en: "Still devnet",
    dZh: "当前部署在 Solana devnet + devnet-tee，资产为测试网 tUSDC，不承载真实价值。",
    dEn: "Currently deployed on Solana devnet + devnet-tee with test tUSDC; it carries no real value.",
  },
  {
    zh: "托管式 MCP 例外",
    en: "Hosted-MCP exception",
    dZh: "仅 devnet 提供运营方托管的演示 agent；正式使用请在本机自托管（见配套文档一）。",
    dEn: "A demo agent is hosted by the operator on devnet only; for real use, self-host it (see companion doc 1).",
  },
  {
    zh: "逃生通道未上线",
    en: "Escape channel not live",
    dZh: "委托程序尚未支持 RequestUndelegation；主网上线的前提是 MagicBlock 升级（§18.1 E7）。",
    dEn: "The delegation program does not support RequestUndelegation yet; mainnet is gated on MagicBlock shipping it (§18.1 E7).",
  },
  {
    zh: "升级权限",
    en: "Upgrade authority",
    dZh: "主网程序升级权限将交给多签或锁定；在完成之前，升级权限是必须信任的部分。",
    dEn: "Before mainnet the upgrade authority will go to a multisig or be locked; until then it is a part we must trust.",
  },
];

export default function TrustPage() {
  const { lang } = useI18n();
  const zh = lang === "zh";
  return (
    <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-5 sm:py-8">
      <div className="mb-7">
        <h1 className="title-cn text-[24px] text-mist">{zh ? "信任模型" : "Trust model"}</h1>
        <p className="mt-1 max-w-[820px] text-[13px] leading-relaxed text-mist-dim">
          {zh
            ? "「别信我们」不是修辞：这一页把每一条主张拆成「由什么保证 / 你怎么自己验证 / 仍然需要信任什么」，每一项都能点开链上或代码证据。"
            : "\"Don't trust us\" is not a slogan here: every claim is broken into what guarantees it, how you verify it yourself, and what you still have to trust — each with a link to on-chain or code evidence."}
        </p>
      </div>

      {/* 一手牌的旅程：方框流程 + 公开/保密图例 */}
      <section className="panel mb-8 p-5">
        <SectionTitle
          zh={zh ? "一手牌的旅程" : "The life of one hand"}
          en="THE LIFE OF ONE HAND"
          right={
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-mist-faint">
              <span className="inline-flex items-center gap-1.5">
                <Dot kind="live" /> {zh ? "公开可查" : "Checkable from public data"}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Dot kind="warn" /> {zh ? "只存在于硬件内" : "Sealed in hardware"}
              </span>
            </div>
          }
        />
        <p className="mb-5 max-w-[820px] text-[12.5px] leading-relaxed text-mist-dim">
          {zh
            ? "顺着箭头走一遍：一手牌经过谁的手、哪些环节全程公开、哪些只存在于 TDX 硬件里，以及你最后在哪一步能自己复算。"
            : "Follow the arrows: whose hands a hand passes through, which steps are public end-to-end, which exist only inside TDX hardware, and where you can recompute it all yourself."}
        </p>
        <div className="mx-auto max-w-[760px]">
          {FLOW.map((b, i) => (
            <div key={b.zh}>
              <div
                className={`rail-quiet p-4 ${
                  b.sealed ? "border-accent-500/40 bg-accent-500/6" : ""
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="title-cn text-[13.5px] text-mist">
                    {zh ? b.zh : b.en}
                  </div>
                  {b.sealed ? (
                    <Badge tone="brand">{zh ? "硬件内保密" : "SEALED IN HW"}</Badge>
                  ) : (
                    <Badge tone="cyan">{zh ? "公开可查" : "PUBLIC"}</Badge>
                  )}
                </div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-mist-dim">
                  {zh ? b.dZh : b.dEn}
                </p>
              </div>
              {i < FLOW.length - 1 && (
                <div className="flex items-start gap-2.5 py-2.5 pl-4">
                  <span className="font-mono text-[13px] leading-none text-accent-300">
                    ↓
                  </span>
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11.5px] text-mist-dim">
                    <span className="font-mono text-[10.5px] text-accent-300">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {zh ? FLOW_STEPS[i].zh : FLOW_STEPS[i].en}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 试着作弊：攻击 → 拦截 */}
      <section className="mb-8">
        <SectionTitle
          zh={zh ? "试着作弊" : "Try to cheat it"}
          en="TRY TO CHEAT IT"
          right={
            <span className="text-[11px] text-mist-faint">
              {zh ? "四条最诱人的路，全部被拦住" : "Four tempting paths — all blocked"}
            </span>
          }
        />
        <div className="grid gap-4 md:grid-cols-2">
          {ATTACKS.map((a, i) => (
            <div key={a.zh} className="panel flex flex-col p-4">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="flex items-baseline gap-2.5">
                  <span className="font-mono text-[11px] text-loss/80">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="title-cn text-[14px] text-mist">{zh ? a.zh : a.en}</h3>
                </div>
                <Badge tone="mint" className="shrink-0">
                  {zh ? "拦住了" : "BLOCKED"}
                </Badge>
              </div>
              <p className="text-[12.5px] leading-relaxed text-mist-dim">
                {zh ? a.dZh : a.dEn}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* 硬件与运行环境 */}
      <section className="panel mb-8 p-5">
        <SectionTitle
          zh={zh ? "运行环境与硬件证明" : "Runtime & hardware attestation"}
          en="HARDWARE ATTESTATION"
          right={
            <Badge tone="mint">
              <Dot kind="live" /> {zh ? "attestation 有效" : "attestation valid"}
            </Badge>
          }
        />
        <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
          {HARDWARE.map((h) => (
            <div
              key={h.zh}
              className="flex items-baseline justify-between gap-4 border-b border-accent-500/12 py-2"
            >
              <span className="shrink-0 text-[12px] text-mist-faint">{zh ? h.zh : h.en}</span>
              <span className="text-right text-[12.5px] text-mist-2">{zh ? h.vZh : h.vEn}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-mist-faint">
          {zh
            ? "注意：attestation 只能证明「运行在真实 TDX 机器上」，无法证明程序逻辑本身；逻辑正确性靠下面的复算验证。"
            : "Note: attestation only proves the code runs on a genuine TDX machine — it says nothing about the logic itself. Logical correctness rests on the recomputation checks below."}
        </p>
      </section>

      {/* §16 八项 */}
      <SectionTitle
        zh={zh ? "逐项主张与证据" : "Claims, evidence, and what's still trusted"}
        en="CLAIMS & EVIDENCE"
        right={
          <span className="text-[11px] text-mist-faint">
            {zh ? "八项主张，逐项可点开证据" : "Eight claims, each linking to its evidence"}
          </span>
        }
      />
      <div className="grid gap-5 md:grid-cols-2">
        {ITEMS.map((t) => (
          <article key={t.zh} className="panel flex flex-col p-5">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="title-cn text-[15px] text-mist">{zh ? t.zh : t.en}</h3>
                {zh && (
                  <div className="mt-0.5 text-[10px] tracking-[0.24em] text-accent-400/80 uppercase">
                    {t.en}
                  </div>
                )}
              </div>
              <Badge tone="mint" className="mt-0.5 shrink-0">
                ✓
              </Badge>
            </div>

            <div className="mb-3">
              <div className="mb-1 text-[10.5px] tracking-widest text-mist-faint">{zh ? "由什么保证" : "Guaranteed by"}</div>
              <p className="text-[12.5px] leading-relaxed text-mist-2">{zh ? t.by : t.byEn}</p>
            </div>

            <div className="mb-3">
              <div className="mb-1 text-[10.5px] tracking-widest text-mist-faint">{zh ? "你怎么验证" : "How you verify"}</div>
              <p className="text-[12.5px] leading-relaxed text-mist-dim">{zh ? t.how : t.howEn}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {t.links.map((l) =>
                  l.href.startsWith("/") ? (
                    <Link
                      key={l.label}
                      href={l.href}
                      className="rounded-md border border-accent-500/35 px-2.5 py-1 text-[11px] text-accent-200 hover:bg-accent-500/10"
                    >
                      {zh ? l.label : l.labelEn} →
                    </Link>
                  ) : (
                    <a
                      key={l.label}
                      href={l.href}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border border-accent-500/35 px-2.5 py-1 text-[11px] text-accent-200 hover:bg-accent-500/10"
                    >
                      {zh ? l.label : l.labelEn} ↗
                    </a>
                  ),
                )}
              </div>
            </div>

            <div className="mt-auto rounded-lg border border-warn/25 bg-warn/8 px-3 py-2">
              <span className="text-[10.5px] tracking-widest text-warn/90">{zh ? "仍然需要信任" : "Still trusted"}</span>
              <p className="mt-0.5 text-[12px] leading-relaxed text-mist-dim">{zh ? t.trust : t.trustEn}</p>
            </div>
          </article>
        ))}
      </div>

      {/* 风险与边界 */}
      <section className="mt-10">
        <SectionTitle zh={zh ? "风险与边界（不隐瞒）" : "Risks & limits (no omissions)"} en="HONEST LIMITS" />
        <div className="grid gap-4 md:grid-cols-2">
          {LIMITS.map((l) => (
            <div key={l.zh} className="panel flex gap-3 p-4">
              <Badge tone="lime" className="mt-0.5 h-fit shrink-0">
                {zh ? l.zh : l.en}
              </Badge>
              <p className="text-[12.5px] leading-relaxed text-mist-dim">{zh ? l.dZh : l.dEn}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="hairline mt-10 flex flex-wrap items-center justify-between gap-3 py-6 text-[11px] text-mist-faint">
        <span>
          {zh ? "程序" : "Program"} <span className="font-mono">{PROGRAM_ID.toBase58().slice(0, 8)}…</span> · {zh ? "委托" : "delegation"}{" "}
          <span className="font-mono">DELeG…aeSh</span> · {zh ? "权限" : "permission"}{" "}
          <span className="font-mono">ACLse…Xnp1</span> · VRF{" "}
          <span className="font-mono">Vrf1R…QUwGz</span>
        </span>
        <span className="flex items-center gap-4">
          <a href={REPO} target="_blank" rel="noreferrer" className="hover:text-mist-dim">
            {zh ? "开源代码 ↗" : "Source ↗"}
          </a>
          <a
            href={solscan(PROGRAM_ID.toBase58())}
            target="_blank"
            rel="noreferrer"
            className="hover:text-mist-dim"
          >
            Solscan ↗
          </a>
          <Link href="/history" className="hover:text-mist-dim">
            {zh ? "验证器 →" : "Verifier →"}
          </Link>
        </span>
      </footer>
    </main>
  );
}
