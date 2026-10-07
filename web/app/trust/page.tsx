// 信任页（stage1-design.md §13/§16）：每一项信任假设给出可核验的证据链接。
// 静态内容，所有链接指向 devnet 浏览器/仓库，玩家可逐项自查。

const PROGRAM_ID = "EZ5bMNxbtiTpSqdmRaGC4vYt6yWLUDC4WUNGqyvM6CSf";
const TABLE_ID = Number(process.env.NEXT_PUBLIC_TABLE_ID ?? 9);
const REPO = "https://github.com/SANTOSRAYYYY/solpoker";

const solscan = (path: string) => `https://solscan.io${path}?cluster=devnet`;

const ITEMS: { title: string; body: React.ReactNode }[] = [
  {
    title: "程序代码开源、地址固定",
    body: (
      <>
        链上程序 <code>{PROGRAM_ID}</code>（
        <a href={solscan(`/account/${PROGRAM_ID}`)}>solscan</a>
        ）对应仓库 <a href={REPO}>{REPO}</a>
        。升级权限属于 deployer（多签改造在主网前完成，见 CHANGELOG 遗留问题）。
      </>
    ),
  },
  {
    title: "牌由 MagicBlock VRF + 双方盐决定，任何人可复算",
    body: (
      <>
        每手牌的种子 = VRF 输出 ⊕ 两名玩家的盐（先承诺后揭示）。字节级规范见仓库{" "}
        <a href={`${REPO}/blob/main/docs/dealing-protocol.zh.md`}>dealing-protocol</a>
        ；Rust 链上实现、Python 参考实现、测试向量三方逐字节一致（CI）。
        每手结束后盐与 VRF 输出公开在 HandSecrets 环里，可用{" "}
        <a href={`${REPO}/tree/main/reference`}>reference/solpoker_deal.py</a>{" "}
        离线复算整手牌序。
      </>
    ),
  },
  {
    title: "底牌只存在 TEE 里，只有本人能读",
    body: (
      <>
        PlayerHand / Deck 是 PER 私有账户（members 只有 crank 与占用者本人），
        非成员通过 RPC 读取会被拒绝（端到端测试的最后一步就是「陌生人读
        PlayerHand 被拒」）。验证：程序对 deck/hand 创建的权限账户可在{" "}
        <a href={solscan(`/account/${PROGRAM_ID}`)}>程序账户页</a> 追踪。
      </>
    ),
  },
  {
    title: "TEE attestation 入场必做",
    body: (
      <>
        打开页面时前端会用 <code>crypto.getRandomValues</code> 生成挑战，校验
        TDX quote 的 collateral 并确认 reportData 回显挑战（Phala dcap-qvl）。
        在 MagicBlock 公布 TDX 度量值之前，这一步只能证明「对面确实是 TDX
        机器」，不能证明「跑的就是这份代码」——我们如实标注这一层。
      </>
    ),
  },
  {
    title: "资金不进平台账户",
    body: (
      <>
        买入进入每桌独立的 TableVault（PDA 托管），离桌经 L1 快照兑付到
        入座时固定的 payout 地址。每张桌的金库余额随时可在链上核对；守恒断言
        （I-L1 / I-B / I-ER / I-X）由指令在链上强制执行。
      </>
    ),
  },
  {
    title: "公平性兜底：超时与逃生",
    body: (
      <>
        行动超时：能 check 就 check，否则 fold 并记 strikes，连续超时自动站起
        （规则引擎 proptest 覆盖）。ER 不可用时走 escape 流程在 L1 结算
        （Stage 6 收尾项，见 CHANGELOG）。
      </>
    ),
  },
];

export default function TrustPage() {
  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          SolPoker <span className="brand-sub">信任页</span>
        </div>
        <a className="footer-link" href="/">
          ← 回牌桌
        </a>
      </header>
      <main className="main">
        <h1 className="heading">为什么可以相信这副牌</h1>
        <p className="muted">
          当前为 devnet 演示（桌 #{TABLE_ID}，测试代币 tUSDC）。以下每一项都可以
          独立核验；做不到的那一层，我们直接写出来。
        </p>
        {ITEMS.map((it) => (
          <section key={it.title} className="tee-panel">
            <h3 className="tier-title">{it.title}</h3>
            <p className="muted">{it.body}</p>
          </section>
        ))}
      </main>
    </div>
  );
}
