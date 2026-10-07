"use client";

import Link from "next/link";
import { TRUST_ITEMS } from "../data";
import { Badge, Dot, SectionTitle } from "../ui";

const HARDWARE = [
  ["运行环境", "MagicBlock TEE（Intel TDX）· devnet-tee"],
  ["attestation", "已验证 ✓　（可证明是真实 TDX 机器）"],
  ["度量值 MRTD/RTMR", "MagicBlock 尚未公布（写入 §18.2 待答复）"],
  ["执行记录保留期", "约一周（待 MagicBlock 书面确认后写入本页）"],
];

const LIMITS = [
  ["仍是 devnet", "当前部署在 Solana devnet + devnet-tee，资产为测试网 tUSDC，不承载真实价值。"],
  ["托管式 MCP 例外", "仅 devnet 提供运营方托管的演示 agent；正式使用请在本机自托管（见配套文档一）。"],
  ["逃生通道未上线", "委托程序尚未支持 RequestUndelegation；主网上线的前提是 MagicBlock 升级（§18.1 E7）。"],
  ["升级权限", "主网程序升级权限将交给多签或锁定；在完成之前，升级权限是必须信任的部分。"],
];

export default function TrustMock() {
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
            <div key={k} className="flex items-baseline justify-between gap-4 border-b border-accent-500/12 py-2">
              <span className="shrink-0 text-[12px] text-mist-faint">{k}</span>
              <span className="text-right text-[12.5px] text-mist-2">{v}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-mist-faint">
          注意：attestation 只能证明「运行在真实 TDX 机器上」，无法证明程序逻辑本身；逻辑正确性靠下面的复算验证。
        </p>
      </section>

      {/* §16 八项 */}
      <div className="grid gap-5 md:grid-cols-2">
        {TRUST_ITEMS.map((t) => (
          <article key={t.zh} className="panel flex flex-col p-5">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="title-cn text-[15px] text-mist">{t.zh}</h3>
                <div className="mt-0.5 font-display text-[10px] tracking-[0.24em] text-accent-500/80 uppercase">
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
          程序 <span className="font-mono">6wMs…FRNE</span> · 委托 <span className="font-mono">DELeG…aeSh</span> ·
          权限 <span className="font-mono">ACLse…Xnp1</span> · VRF{" "}
          <span className="font-mono">Vrf1R…QUwGz</span>
        </span>
        <span className="flex items-center gap-4">
          <a href="https://github.com/" className="hover:text-mist-dim">开源代码 ↗</a>
          <a href="https://solscan.io/" className="hover:text-mist-dim">Solscan ↗</a>
          <Link href="/mock/history" className="hover:text-mist-dim">验证器 →</Link>
        </span>
      </footer>
    </main>
  );
}
