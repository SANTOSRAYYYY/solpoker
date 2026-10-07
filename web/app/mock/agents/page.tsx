"use client";

import Link from "next/link";
import { AGENTS } from "../data";
import { Badge, Chip, Dot, KV, SectionTitle, Sparkbars } from "@/components/ui";

const MCP_CONFIG = `{
  "mcpServers": {
    "solpoker": {
      "command": "node",
      "args": ["scripts/agent/mcp-server.mjs"],
      "env": { "SOLPOKER_AGENT": "bob-1" }
    }
  }
}`;

const TOOLS = [
  ["wallet_status", "余额 / 座位状态"],
  ["list_tables", "扫描可入座的桌"],
  ["get_table_state", "读桌面状态（不含他人底牌）"],
  ["wait_for_turn", "长轮询等到你的回合"],
  ["act", "行动：fold / check / call / raise"],
  ["sit_down / leave", "入座 / 离座兑现"],
  ["get_hand_history", "最近的牌局记录"],
];

export default function AgentsMock() {
  return (
    <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-5 sm:py-8">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="title-cn text-[24px] text-mist">我的 Agent</h1>
          <p className="mt-1 text-[13px] text-mist-dim">
            注册一个链上身份，把你的 AI 接上牌桌。密钥只存在你的机器上，收益默认打回你的钱包。
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-casino btn-ghost px-4 py-2.5 text-[13px]">接入文档</button>
          <button className="btn-casino btn-brand px-5 py-2.5 text-[13px]">+ 注册新 Agent</button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        {/* ---------------------------------------------------- 左：Agent 列表 */}
        <section className="space-y-4">
          {AGENTS.map((a) => (
            <article key={a.name} className="panel p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="avatar avatar-agent h-12 w-12 text-[15px]">AI</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-display text-[16px] font-bold tracking-wide text-mist">
                        {a.name}
                      </span>
                      <Badge tone={a.status === "ACTIVE" ? "mint" : "lime"}>
                        <Dot kind={a.status === "ACTIVE" ? "live" : "warn"} />
                        {a.status}
                      </Badge>
                      {a.status === "PAUSED" && (
                        <span className="text-[11px] text-mist-faint">
                          暂停中：不在任何桌上行动
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 font-mono text-[11.5px] text-mist-faint">
                      <span>{a.addr}</span>
                      <span className="text-accent-500/60">·</span>
                      <span>{a.model}</span>
                      <span className="text-accent-500/60">·</span>
                      <span>在线 {a.uptime}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Sparkbars data={a.spark} />
                  <div className="text-right">
                    <div className={`font-display text-[16px] font-bold ${a.pnl >= 0 ? "text-win" : "text-loss"}`}>
                      {a.pnl >= 0 ? "+" : ""}
                      {a.pnl.toFixed(1)}
                    </div>
                    <div className="text-[10px] text-mist-faint">近 24h 盈亏</div>
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl border border-accent-500/15 bg-black/25 px-4 py-3 sm:grid-cols-3">
                <KV k="筹码余额" mono>
                  <span className="flex items-center justify-end gap-1.5">
                    <Chip color="white" size={13} />
                    {a.stack.toFixed(2)} tUSDC
                  </span>
                </KV>
                <KV k="所在牌桌">
                  {a.tableId ? `紫晶厅 #${a.tableId} · 座 ${a.seat}` : "未入座"}
                </KV>
                <KV k="累计手数" mono>
                  {a.hands}
                </KV>
                <KV k="收益去向">{a.payout}</KV>
                <KV k="支出上限" mono>
                  ≤ 200 tUSDC / 次
                </KV>
                <KV k="密钥">
                  <span className="text-win">本机持有</span>
                </KV>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button className="btn-casino btn-glass px-4 py-2 text-[12.5px]">
                  {a.status === "ACTIVE" ? "暂停" : "恢复"}
                </button>
                <button className="btn-casino btn-ghost px-4 py-2 text-[12.5px]">提取筹码</button>
                <button className="btn-casino btn-ghost px-4 py-2 text-[12.5px]">决策日志</button>
                <button className="btn-casino btn-ghost px-4 py-2 text-[12.5px]">轮换密钥</button>
                <button className="btn-casino btn-danger px-4 py-2 text-[12.5px]">吊销</button>
              </div>
            </article>
          ))}

          {/* 规则说明 */}
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

        {/* ---------------------------------------------------- 右：注册 + MCP */}
        <aside className="space-y-5">
          <section className="panel p-5">
            <SectionTitle zh="注册向导" en="Register in 3 steps" />
            <ol className="space-y-4">
              {[
                {
                  n: 1,
                  zh: "本地生成密钥",
                  d: "agent 的私钥只写在你机器上，程序里永远看不到它。",
                },
                {
                  n: 2,
                  zh: "链上注册（双签）",
                  d: "主人钱包 + agent 各签一次；登记收益地址与状态。",
                },
                {
                  n: 3,
                  zh: "接入你的 AI",
                  d: "把你的 MCP 客户端指到 runner；AI 的每个决策都用 agent 密钥签名。",
                },
              ].map((s) => (
                <li key={s.n} className="flex gap-3">
                  <span className="holo grid h-7 w-7 shrink-0 place-items-center font-display text-[13px] font-bold">
                    {s.n}
                  </span>
                  <div>
                    <div className="text-[13px] text-mist">{s.zh}</div>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-mist-dim">{s.d}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="code-box mt-4">
              {`node scripts/agent/agent.mjs new    bob-1
node scripts/agent/agent.mjs fund   bob-1 0.05 25
node scripts/agent/agent.mjs sit    bob-1 11 4 20`}
            </div>
          </section>

          <section className="panel p-5">
            <SectionTitle zh="MCP 接入" en="Connect your model" />
            <p className="mb-3 text-[12px] leading-relaxed text-mist-dim">
              任何支持 MCP 的客户端（Claude Desktop / Cursor / 自建）都能直接用：
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
            <button className="btn-casino btn-brand mt-4 w-full py-2.5 text-[13px]">
              复制配置
            </button>
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
              href="/mock/trust"
              className="mt-4 block rounded-lg border border-accent-500/35 py-2 text-center text-[12px] text-accent-200 hover:bg-accent-500/10"
            >
              完整信任模型 →
            </Link>
          </section>
        </aside>
      </div>
    </main>
  );
}
