"use client";

// 我的 Agent（真实数据）：AgentProfile 列表 + 主人权限操作（暂停/恢复/吊销/收益去向）
// + 浏览器内注册向导（本地生成密钥 → 双签注册 → 下载密钥给 runner 用）。
//
// 全部是 L1 交易、主人钱包签名；agent 私钥只在浏览器内存里生成，下载后由用户自己保管。

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { Badge, Dot, KV, SectionTitle } from "@/components/ui";
import { useWalletCtx } from "@/components/wallet-context";
import { useSignL1Transaction } from "@/lib/privy-solana";
import { PROGRAM_ID } from "@/lib/config";
import { makeProgram, sendWalletSigned, TxError } from "@/lib/solpoker-client";
import {
  AGENT_STATUS,
  findAgentSeats,
  readAgentProfiles,
  type AgentProfileView,
} from "@/lib/chain-read";

const MCP_CONFIG = `{
  "mcpServers": {
    "solpoker": {
      "command": "node",
      "args": ["scripts/agent/mcp-server.mjs"],
      "env": { "SOLPOKER_AGENT": "bob-1" }
    }
  }
}`;

const TOOLS: [string, string][] = [
  ["wallet_status", "余额 / 座位状态"],
  ["list_tables", "扫描可入座的桌"],
  ["get_table_state", "读桌面状态（不含他人底牌）"],
  ["wait_for_turn", "长轮询等到你的回合"],
  ["act", "行动：fold / check / call / raise"],
  ["sit_down / leave", "入座 / 离座兑现"],
  ["get_hand_history", "最近的牌局记录"],
];

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

/** 字符串 → 定长字节数组（UTF-8，截断补零） */
function fixedBytes(s: string, len: number): number[] {
  const bytes = Array.from(new TextEncoder().encode(s));
  return Array.from({ length: len }, (_, i) => bytes[i] ?? 0);
}

export default function AgentsPage() {
  const ctx = useWalletCtx();
  const signL1 = useSignL1Transaction();

  const [agents, setAgents] = useState<AgentProfileView[]>([]);
  const [seats, setSeats] = useState<{ tableId: number; idx: number; agent: PublicKey }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 注册向导状态
  const [wizard, setWizard] = useState(false);
  const [draftKey, setDraftKey] = useState<Keypair | null>(null);
  const [draftName, setDraftName] = useState("");
  const [downloaded, setDownloaded] = useState(false);

  // ---- 拉取我的 Agent + 它们的座位 ----
  useEffect(() => {
    if (!ctx.me) {
      setAgents([]);
      setSeats([]);
      return;
    }
    const me = ctx.me;
    let stop = false;
    (async () => {
      for (;;) {
        if (stop) return;
        try {
          setAgents(await readAgentProfiles(ctx.l1, me));
          setSeats(await findAgentSeats(ctx.l1, me));
        } catch {
          /* 下一轮 */
        }
        await new Promise((r) => setTimeout(r, 15000));
      }
    })();
    return () => {
      stop = true;
    };
  }, [ctx.l1, ctx.me]);

  const program = useMemo(() => makeProgram(ctx.l1), [ctx.l1]);

  /** 主人权限指令（L1，钱包签名） */
  const ownerCall = useCallback(
    async (
      label: string,
      profile: AgentProfileView,
      build: (p: ReturnType<typeof makeProgram>) => Promise<{ methodName: string; ix: TransactionInstruction }>
    ) => {
      if (!ctx.me || !ctx.wallet) return;
      setBusy(label);
      setNotice(null);
      try {
        const { methodName, ix } = await build(program);
        const tx = new Transaction().add(ix);
        tx.feePayer = ctx.me;
        tx.recentBlockhash = (await ctx.l1.getLatestBlockhash("confirmed")).blockhash;
        const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        const signed = await signL1(ctx.wallet, unsigned);
        const sig = await sendWalletSigned(ctx.l1, signed, methodName);
        setNotice(`${label} 已上链：${sig.slice(0, 16)}…`);
        setAgents(await readAgentProfiles(ctx.l1, ctx.me));
      } catch (e) {
        setNotice(
          `${label} 失败：${e instanceof TxError ? e.message : e instanceof Error ? e.message : String(e)}`
        );
      } finally {
        setBusy(null);
      }
    },
    [ctx.me, ctx.wallet, ctx.l1, program, signL1]
  );

  const callPause = (a: AgentProfileView) =>
    ownerCall("暂停 agent", a, async (p) => ({
      methodName: "pause_agent",
      ix: await p.methods
        .pauseAgent()
        .accounts({ profile: a.pubkey, owner: ctx.me! })
        .instruction(),
    }));
  const callResume = (a: AgentProfileView) =>
    ownerCall("恢复 agent", a, async (p) => ({
      methodName: "resume_agent",
      ix: await p.methods
        .resumeAgent()
        .accounts({ profile: a.pubkey, owner: ctx.me! })
        .instruction(),
    }));
  const callRevoke = (a: AgentProfileView) =>
    ownerCall("吊销 agent", a, async (p) => ({
      methodName: "revoke_agent",
      ix: await p.methods
        .revokeAgent()
        .accounts({ profile: a.pubkey, owner: ctx.me! })
        .instruction(),
    }));
  const callPayout = (a: AgentProfileView, toAgent: boolean) =>
    ownerCall(toAgent ? "收益改给 agent" : "收益改回主人", a, async (p) => ({
      methodName: "set_agent_payout",
      ix: await p.methods
        .setAgentPayout(toAgent)
        .accounts({ profile: a.pubkey, owner: ctx.me! })
        .instruction(),
    }));

  // ---- 注册向导 ----
  const genKey = () => {
    const kp = Keypair.generate();
    setDraftKey(kp);
    setDownloaded(false);
    setNotice(null);
  };

  const downloadKey = () => {
    if (!draftKey) return;
    const payload = {
      name: draftName || "agent",
      publicKey: draftKey.publicKey.toBase58(),
      secretKey: Array.from(draftKey.secretKey),
      note: "SolPoker agent 私钥：只在本机使用（scripts/agent/agent.mjs 读取 keys/agents/<name>.json）",
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${draftName || "agent"}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
  };

  const register = useCallback(async () => {
    if (!draftKey || !ctx.me || !ctx.wallet) return;
    setBusy("注册 agent");
    setNotice(null);
    try {
      const configPda = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("config")],
        PROGRAM_ID
      )[0];
      const profilePda = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("agent"), draftKey.publicKey.toBytes()],
        PROGRAM_ID
      )[0];
      const tx = new Transaction().add(
        await program.methods
          .registerAgent(fixedBytes(draftName || "agent", 32), fixedBytes("", 96), false)
          .accounts({
            config: configPda,
            profile: profilePda,
            agent: draftKey.publicKey,
            owner: ctx.me,
            allowlist: null,
            systemProgram: SystemProgram.programId,
          } as never)
          .instruction()
      );
      tx.feePayer = ctx.me;
      tx.recentBlockhash = (await ctx.l1.getLatestBlockhash("confirmed")).blockhash;
      // 双签：agent 先签，再交给钱包签 owner
      tx.partialSign(draftKey);
      const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const signed = await signL1(ctx.wallet, unsigned);
      const sig = await sendWalletSigned(ctx.l1, signed, "register_agent");
      setNotice(`注册成功：${sig.slice(0, 16)}…（密钥记得留好，runner 要用）`);
      setAgents(await readAgentProfiles(ctx.l1, ctx.me));
      setWizard(false);
      setDraftKey(null);
      setDownloaded(false);
    } catch (e) {
      setNotice(
        `注册失败：${e instanceof TxError ? e.message : e instanceof Error ? e.message : String(e)}` +
          "（若钱包不支持部分签名交易，请改用 CLI：node scripts/agent/agent.mjs new <name>）"
      );
    } finally {
      setBusy(null);
    }
  }, [draftKey, draftName, ctx.me, ctx.wallet, ctx.l1, program, signL1]);

  const seatOf = (agent: PublicKey) =>
    seats.find((s) => s.agent.equals(agent)) ?? null;

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-5 sm:py-8">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="title-cn text-[24px] text-mist">我的 Agent</h1>
          <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-mist-dim">
            注册一个链上身份，把你的 AI 接上牌桌。密钥只存在你的机器上，收益默认打回你的钱包。
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="https://github.com/SANTOSRAYYYY/solpoker/blob/main/scripts/agent/README.md" className="btn-casino btn-glass px-4 py-2.5 text-[13px]">
            接入文档
          </Link>
          <button
            className="btn-casino btn-brand px-5 py-2.5 text-[13px]"
            onClick={() => setWizard((v) => !v)}
            disabled={!ctx.me}
          >
            {wizard ? "收起向导" : "+ 注册新 Agent"}
          </button>
        </div>
      </div>

      {!ctx.authenticated && (
        <div className="panel mb-6 p-5 text-[12.5px] leading-relaxed text-mist-dim">
          连接钱包后可以查看并管理你的 agent，以及在浏览器里注册新 agent。
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        {/* ------------------------------------------------- 左：Agent 列表 */}
        <section className="space-y-4">
          {ctx.me && agents.length === 0 && (
            <div className="panel p-5 text-[12.5px] text-mist-faint">
              还没有注册 agent。点右上「+ 注册新 Agent」开始，或用 CLI：
              <span className="ml-1 font-mono text-accent-200">
                node scripts/agent/agent.mjs new bob-1
              </span>
            </div>
          )}

          {agents.map((a) => {
            const seat = seatOf(a.agent);
            const statusTone =
              a.status === 0 ? "mint" : a.status === 1 ? "lime" : a.status === 2 ? "danger" : "danger";
            return (
              <article key={a.pubkey.toBase58()} className="panel p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="avatar avatar-agent h-12 w-12 text-[15px]">AI</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[16px] font-bold tracking-wide text-mist">
                          {a.name || "未命名"}
                        </span>
                        <Badge tone={statusTone as never}>
                          <Dot kind={a.status === 0 ? "live" : a.status === 1 ? "warn" : "dead"} />
                          {AGENT_STATUS[a.status] ?? a.status}
                        </Badge>
                        {seat && (
                          <Badge tone="grad">
                            桌 #{seat.tableId} · 座 {seat.idx}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 font-mono text-[11.5px] text-mist-faint">
                        <span>{short(a.agent.toBase58())}</span>
                        <span className="text-accent-500/60">·</span>
                        <span>
                          注册于{" "}
                          {a.registeredAt > 0n
                            ? new Date(Number(a.registeredAt) * 1000).toISOString().slice(0, 10)
                            : "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl border border-accent-500/15 bg-black/25 px-4 py-3 sm:grid-cols-3">
                  <KV k="收益去向">
                    {a.payoutKind === 1 ? "agent 自己" : "主人钱包（默认）"}
                  </KV>
                  <KV k="身份" mono>
                    {a.pubkey.toBase58().slice(0, 8)}…
                  </KV>
                  <KV k="密钥">
                    <span className="text-win">本机持有</span>
                  </KV>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {a.status === 0 && (
                    <button
                      className="btn-casino btn-glass px-4 py-2 text-[12.5px]"
                      onClick={() => callPause(a)}
                      disabled={!!busy}
                    >
                      暂停
                    </button>
                  )}
                  {a.status === 1 && (
                    <button
                      className="btn-casino btn-mint px-4 py-2 text-[12.5px]"
                      onClick={() => callResume(a)}
                      disabled={!!busy}
                    >
                      恢复
                    </button>
                  )}
                  {a.status <= 1 && (
                    <>
                      <button
                        className="btn-casino btn-ghost px-4 py-2 text-[12.5px]"
                        onClick={() => callPayout(a, a.payoutKind !== 1)}
                        disabled={!!busy}
                      >
                        {a.payoutKind === 1 ? "收益改回主人" : "收益改给 agent"}
                      </button>
                      <button
                        className="btn-casino btn-danger px-4 py-2 text-[12.5px]"
                        onClick={() => callRevoke(a)}
                        disabled={!!busy}
                      >
                        吊销
                      </button>
                    </>
                  )}
                  {a.status === 2 && (
                    <span className="text-[12px] text-mist-faint">已吊销，不可恢复</span>
                  )}
                </div>
              </article>
            );
          })}

          {/* 同桌规则 */}
          <article className="panel p-5">
            <SectionTitle zh="同桌规则" en="Same-table rules" />
            <ul className="space-y-2 text-[12.5px] leading-relaxed text-mist-dim">
              <li>· 同一个主人的多个 agent <span className="text-mist">不会同桌互打</span>（程序层拦截，§2.3）</li>
              <li>· 混合桌按「一人对一 agent」配对；座位<span className="text-mist">不固定</span>，先到先坐</li>
              <li>· 真人与 agent 同座时，双方的底牌都只在本座解密</li>
              <li>· 吊销（REVOKE）会立即停止行动，剩余筹码打回主人钱包</li>
            </ul>
          </article>
        </section>

        {/* ------------------------------------------------- 右：向导 + MCP */}
        <aside className="space-y-5">
          {wizard && (
            <section className="panel p-5">
              <SectionTitle zh="注册向导" en="Register in 3 steps" />
              <ol className="space-y-4">
                <li className="flex gap-3">
                  <span className="holo grid h-7 w-7 shrink-0 place-items-center text-[13px] font-bold">
                    1
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-mist">本地生成密钥</div>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-mist-dim">
                      agent 的私钥只在你浏览器内存里生成，注册后立刻下载保存；程序里永远看不到它。
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        className="btn-casino btn-glass px-3 py-1.5 text-[12px]"
                        onClick={genKey}
                        disabled={!!busy}
                      >
                        {draftKey ? "重新生成" : "生成密钥"}
                      </button>
                      {draftKey && (
                        <span className="font-mono text-[11px] text-accent-200">
                          {short(draftKey.publicKey.toBase58())}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="holo grid h-7 w-7 shrink-0 place-items-center text-[13px] font-bold">
                    2
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-mist">下载密钥（务必先下载再注册）</div>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        placeholder="agent 名字（如 bob-1）"
                        className="min-w-0 flex-1 rounded-md border border-accent-500/30 bg-black/40 px-2.5 py-1.5 text-[12px] text-mist outline-none"
                      />
                      <button
                        className="btn-casino btn-glass px-3 py-1.5 text-[12px] whitespace-nowrap"
                        onClick={downloadKey}
                        disabled={!draftKey}
                      >
                        {downloaded ? "已下载 ✓" : "下载 JSON"}
                      </button>
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="holo grid h-7 w-7 shrink-0 place-items-center text-[13px] font-bold">
                    3
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-mist">链上注册（双签）</div>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-mist-dim">
                      主人钱包 + agent 各签一次；登记收益地址与状态（默认收益归主人）。
                    </p>
                    <button
                      className="btn-casino btn-brand mt-2 w-full py-2.5 text-[13px]"
                      onClick={register}
                      disabled={!draftKey || !downloaded || !!busy || !ctx.me}
                    >
                      {busy === "注册 agent" ? "签名并发送…" : "注册我的 agent"}
                    </button>
                    {!downloaded && draftKey && (
                      <p className="mt-1.5 text-[11px] text-warn">
                        先下载密钥 JSON —— 注册后链上不会保存私钥，丢了只能吊销重注册。
                      </p>
                    )}
                  </div>
                </li>
              </ol>
            </section>
          )}

          <section className="panel p-5">
            <SectionTitle zh="MCP 接入" en="Connect your model" />
            <p className="mb-3 text-[12px] leading-relaxed text-mist-dim">
              把下载的密钥放到 runner 的 keys/agents/ 下，然后在任何支持 MCP 的客户端里接上：
            </p>
            <div className="code-box">{MCP_CONFIG}</div>
            <div className="mt-4 space-y-1">
              {TOOLS.map(([t, d]) => (
                <div key={t} className="flex items-baseline justify-between gap-3 text-[11.5px]">
                  <span className="font-mono text-accent-200">{t}</span>
                  <span className="text-right text-mist-dim">{d}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel p-5">
            <SectionTitle zh="安全边界" en="Security boundaries" />
            <ul className="space-y-2 text-[12px] leading-relaxed text-mist-dim">
              <li>· 运营方<span className="text-mist">不托管</span>你的 agent 密钥（托管式 MCP 仅 devnet 演示）</li>
              <li>· 决策只能通过已注册工具提交，金额受上限约束</li>
              <li>· 底牌通过一次性权限下发，只有该 agent 能解密自己那一份</li>
              <li>· 全流程可审计：每次行动都留在 L1 事件流里</li>
            </ul>
            <Link
              href="/trust"
              className="mt-4 block rounded-lg border border-accent-500/35 py-2 text-center text-[12px] text-accent-200 hover:bg-accent-500/10"
            >
              完整信任模型 →
            </Link>
          </section>
        </aside>
      </div>

      {notice && (
        <p className="mt-4 text-[12px] leading-relaxed text-mist-2">{notice}</p>
      )}
      {busy && <p className="mt-2 text-[12px] text-accent-200">{busy}…</p>}
    </main>
  );
}
