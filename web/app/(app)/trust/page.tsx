"use client";

// 信任模型（设计文档 §16 八项）：不写口号，只写「由什么保证 / 你怎么自己验证 /
// 仍然需要信任什么」，每项都链到链上或代码证据。

import Link from "next/link";
import { Badge, Dot, SectionTitle } from "@/components/ui";
import { PROGRAM_ID } from "@/lib/config";

const REPO = "https://github.com/SANTOSRAYYYY/solpoker";
const solscan = (addr: string) => `https://solscan.io/account/${addr}?cluster=devnet`;

const HARDWARE: [string, string][] = [
  ["运行环境", "MagicBlock TEE（Intel TDX）· devnet-tee"],
  ["attestation", "已验证 ✓　（可证明是真实 TDX 机器）"],
  ["度量值 MRTD/RTMR", "MagicBlock 尚未公布（§18.2 已列入待答复）"],
  ["执行记录保留期", "约一周（待 MagicBlock 书面确认后写入本页）"],
];

interface Item {
  zh: string;
  en: string;
  by: string;
  how: string;
  links: { label: string; href: string }[];
  trust: string;
}

const ITEMS: Item[] = [
  {
    zh: "钱只能付给本人",
    en: "Payouts are pinned",
    by: "程序钉死了收款地址（入座时固定的 payout ATA：真人为本人，agent 默认为主人）；cash_out 任何人都能触发",
    how: "读开源代码、核对可验证构建、看 L1 上的余额",
    links: [
      { label: "合约源码", href: REPO },
      { label: "程序账户", href: solscan(PROGRAM_ID.toBase58()) },
    ],
    trust: "程序升级权限（主网交给多签或锁定升级）",
  },
  {
    zh: "每张桌全额有担保",
    en: "Fully collateralized",
    by: "I-X 不变量；commit 只在 pot = 0 时发生",
    how: "任何人都可以调用 audit_table 检查桌内筹码与账本",
    links: [{ label: "audit_table 源码", href: `${REPO}/blob/main/programs/solpoker/src/instructions/audit_table.rs` }],
    trust: "同上：升级权限",
  },
  {
    zh: "牌局中底牌保密",
    en: "Hole cards stay private",
    by: "TEE 内解密 + PER 权限层（只有本座玩家与 crank 可读）",
    how: "attestation 证明运行在真实 TDX 机器上；实测无 token 读私有账户返回 null",
    links: [{ label: "TEE 文档", href: "https://docs.magicblock.gg/pages/tools/tee/introduction" }],
    trust: "MagicBlock 的 TEE 实现；度量值尚未公布",
  },
  {
    zh: "发牌无法被操纵",
    en: "Provably fair shuffle",
    by: "VRF 随机数 + 双方各自提交的盐（commit–reveal）",
    how: "按 HandProof + HandReplay 复算每一张牌（逐张比对），并可按链上事件日志复算行动序列",
    links: [{ label: "验证器", href: "/history" }],
    trust: "VRF 诚实，或至少有一名玩家诚实地生成了盐",
  },
  {
    zh: "结算正确",
    en: "Settlement is auditable",
    by: "程序逻辑（7 张选 5 的评估器 + 边池规则）",
    how: "按事件流复算：HandSettled 事件对得上每一枚筹码",
    links: [
      { label: "结算实现", href: `${REPO}/blob/main/crates/solpoker-core/src/settle.rs` },
      { label: "验证器", href: "/history" },
    ],
    trust: "TEE 执行正确",
  },
  {
    zh: "随时可以离桌",
    en: "Always able to leave",
    by: "cash_out 无需许可；预留了逃生通道",
    how: "看 L1 快照：座位账本与桌余额始终一致",
    links: [{ label: "程序账户", href: solscan(PROGRAM_ID.toBase58()) }],
    trust: "委托程序升级之前：依赖 validator 存活",
  },
  {
    zh: "运营方看不到底牌",
    en: "Operator cannot see cards",
    by: "PER 权限层；运营方服务不持有玩家的 token",
    how: "权限账户的内容是公开的，谁在成员列表里一目了然",
    links: [
      {
        label: "权限程序",
        href: solscan("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"),
      },
    ],
    trust: "托管式 MCP 例外（仅 devnet，见配套文档一）",
  },
  {
    zh: "历史可审计",
    en: "History is on L1",
    by: "每手牌 commit Game / HandProof / HandReplay，行动事件 emit 进链上事件日志",
    how: "用验证器复算任意一手牌：52 张逐张重抽 + 行动序列对链上锚点",
    links: [{ label: "验证器", href: "/history" }],
    trust:
      "RPC 节点对历史交易的保留期（约一周）—— 牌面与结果的链上锚点永久保留，但重放行动流所需的交易日志会过期",
  },
];

const LIMITS: [string, string][] = [
  ["仍是 devnet", "当前部署在 Solana devnet + devnet-tee，资产为测试网 tUSDC，不承载真实价值。"],
  ["托管式 MCP 例外", "仅 devnet 提供运营方托管的演示 agent；正式使用请在本机自托管（见配套文档一）。"],
  ["逃生通道未上线", "委托程序尚未支持 RequestUndelegation；主网上线的前提是 MagicBlock 升级（§18.1 E7）。"],
  ["升级权限", "主网程序升级权限将交给多签或锁定；在完成之前，升级权限是必须信任的部分。"],
];

export default function TrustPage() {
  return (
    <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-5 sm:py-8">
      <div className="mb-7">
        <h1 className="title-cn text-[24px] text-mist">信任模型</h1>
        <p className="mt-1 max-w-[760px] text-[13px] leading-relaxed text-mist-dim">
          这一页不写口号，只写「由什么保证 / 你怎么自己验证 / 仍然需要信任什么」。
          每一项都可以点开链上或代码证据。
        </p>
      </div>

      {/* 硬件与运行环境 */}
      <section className="panel mb-8 p-5">
        <SectionTitle
          zh="运行环境与硬件证明"
          en="Hardware attestation"
          right={
            <Badge tone="mint">
              <Dot kind="live" /> attestation 有效
            </Badge>
          }
        />
        <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
          {HARDWARE.map(([k, v]) => (
            <div
              key={k}
              className="flex items-baseline justify-between gap-4 border-b border-accent-500/12 py-2"
            >
              <span className="shrink-0 text-[12px] text-mist-faint">{k}</span>
              <span className="text-right text-[12.5px] text-mist-2">{v}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-mist-faint">
          注意：attestation 只能证明「运行在真实 TDX 机器上」，无法证明程序逻辑本身；
          逻辑正确性靠下面的复算验证。
        </p>
      </section>

      {/* §16 八项 */}
      <div className="grid gap-5 md:grid-cols-2">
        {ITEMS.map((t) => (
          <article key={t.zh} className="panel flex flex-col p-5">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="title-cn text-[15px] text-mist">{t.zh}</h3>
                <div className="mt-0.5 text-[10px] tracking-[0.24em] text-accent-400/80 uppercase">
                  {t.en}
                </div>
              </div>
              <Badge tone="mint" className="mt-0.5 shrink-0">
                ✓
              </Badge>
            </div>

            <div className="mb-3">
              <div className="mb-1 text-[10.5px] tracking-widest text-mist-faint">由什么保证</div>
              <p className="text-[12.5px] leading-relaxed text-mist-2">{t.by}</p>
            </div>

            <div className="mb-3">
              <div className="mb-1 text-[10.5px] tracking-widest text-mist-faint">你怎么验证</div>
              <p className="text-[12.5px] leading-relaxed text-mist-dim">{t.how}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {t.links.map((l) =>
                  l.href.startsWith("/") ? (
                    <Link
                      key={l.label}
                      href={l.href}
                      className="rounded-md border border-accent-500/35 px-2.5 py-1 text-[11px] text-accent-200 hover:bg-accent-500/10"
                    >
                      {l.label} →
                    </Link>
                  ) : (
                    <a
                      key={l.label}
                      href={l.href}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border border-accent-500/35 px-2.5 py-1 text-[11px] text-accent-200 hover:bg-accent-500/10"
                    >
                      {l.label} ↗
                    </a>
                  ),
                )}
              </div>
            </div>

            <div className="mt-auto rounded-lg border border-warn/25 bg-warn/8 px-3 py-2">
              <span className="text-[10.5px] tracking-widest text-warn/90">仍然需要信任</span>
              <p className="mt-0.5 text-[12px] leading-relaxed text-mist-dim">{t.trust}</p>
            </div>
          </article>
        ))}
      </div>

      {/* 风险与边界 */}
      <section className="mt-10">
        <SectionTitle zh="风险与边界（不隐瞒）" en="Honest limits" />
        <div className="grid gap-4 md:grid-cols-2">
          {LIMITS.map(([k, v]) => (
            <div key={k} className="panel flex gap-3 p-4">
              <Badge tone="lime" className="mt-0.5 h-fit shrink-0">
                {k}
              </Badge>
              <p className="text-[12.5px] leading-relaxed text-mist-dim">{v}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="hairline mt-10 flex flex-wrap items-center justify-between gap-3 py-6 text-[11px] text-mist-faint">
        <span>
          程序 <span className="font-mono">{PROGRAM_ID.toBase58().slice(0, 8)}…</span> · 委托{" "}
          <span className="font-mono">DELeG…aeSh</span> · 权限{" "}
          <span className="font-mono">ACLse…Xnp1</span> · VRF{" "}
          <span className="font-mono">Vrf1R…QUwGz</span>
        </span>
        <span className="flex items-center gap-4">
          <a href={REPO} target="_blank" rel="noreferrer" className="hover:text-mist-dim">
            开源代码 ↗
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
            验证器 →
          </Link>
        </span>
      </footer>
    </main>
  );
}
