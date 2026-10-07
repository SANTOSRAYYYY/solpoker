"use client";

// SolPoker 牌桌页（Stage 7）：Privy 钱包 → TEE attestation 门控 → 入座 →
// 对局（session key 自动打盐/行动）→ 站起兑现。盲注档位与买入规则全部读
// 链上 Table 账户；Game/手牌状态走 devnet-tee（PER）。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { usePrivy } from "@privy-io/react-auth";
import BN from "bn.js";
import "./table.css";
import { PRIVY_CONFIGURED } from "./providers";
import {
  useSolanaWallet,
  useSignChallenge,
  useSignL1Transaction,
} from "@/lib/privy-solana";
import { establishTeeSession, type TeeSession } from "@/lib/tee-auth";
import { useGame } from "@/lib/use-game";
import {
  L1_RPC,
  TABLE_ID,
  TUSDC_MINT,
  SESSION_KEY_LAMPORTS,
  SESSION_TTL_S,
  PHASES,
} from "@/lib/config";
import {
  pdas,
  makeProgram,
  sendWalletSigned,
  TxError,
} from "@/lib/solpoker-client";
import { cardText, cardColor, fmtUsdc, phaseName } from "@/lib/game-state";
import { loadOrCreateSessionKey } from "@/lib/session-key";

// ---------------------------------------------------------------------------
// small pieces
// ---------------------------------------------------------------------------

function LoginButton() {
  const { ready, authenticated, login, logout } = usePrivy();
  if (!ready) return <button className="btn btn-muted" disabled>加载中…</button>;
  if (authenticated)
    return (
      <button className="btn btn-muted" onClick={logout}>
        退出
      </button>
    );
  return (
    <button className="btn btn-primary" onClick={login}>
      连接钱包
    </button>
  );
}

function Card({ card, hidden }: { card: number; hidden?: boolean }) {
  if (hidden) return <span className="card card-back">🂠</span>;
  return (
    <span className="card" style={{ color: cardColor(card) }}>
      {cardText(card)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// main page
// ---------------------------------------------------------------------------

type TeeState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "ok"; session: TeeSession }
  | { phase: "error"; message: string };

export default function Home() {
  const { authenticated } = usePrivy();
  const wallet = useSolanaWallet();
  const signChallenge = useSignChallenge();
  const signL1 = useSignL1Transaction();

  const [tee, setTee] = useState<TeeState>({ phase: "idle" });
  const [notice, setNotice] = useState<string | null>(null);

  const l1 = useMemo(() => new Connection(L1_RPC, "confirmed"), []);
  const teeToken = tee.phase === "ok" ? tee.session.token : null;
  const driver = useGame(teeToken ? wallet : null, teeToken);
  const { game, myHand, mySeat } = driver;

  const connectTee = useCallback(async () => {
    if (!wallet) return;
    try {
      setTee({ phase: "working" });
      const session = await establishTeeSession(wallet.address, (b) =>
        signChallenge(wallet, b)
      );
      setTee({ phase: "ok", session });
    } catch (e) {
      setTee({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [wallet, signChallenge]);

  // ---- wallet balances (L1) ----
  const [solBal, setSolBal] = useState<number | null>(null);
  const [usdcBal, setUsdcBal] = useState<number | null>(null);
  useEffect(() => {
    if (!wallet) return;
    let stop = false;
    (async () => {
      for (;;) {
        if (stop) return;
        try {
          const pk = new PublicKey(wallet.address);
          setSolBal((await l1.getBalance(pk)) / 1e9);
          const ata = getAssociatedTokenAddressSync(TUSDC_MINT, pk);
          const acc = await l1.getTokenAccountBalance(ata).catch(() => null);
          setUsdcBal(acc?.value.uiAmount ?? 0);
        } catch {
          // 下一轮重试
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
    })();
    return () => {
      stop = true;
    };
  }, [wallet, l1]);

  // ---- sit down (L1, wallet-signed) ----
  const [buyIn, setBuyIn] = useState("20");
  const [seatIdx, setSeatIdx] = useState(0);
  const [sitBusy, setSitBusy] = useState(false);

  const sitDown = useCallback(async () => {
    if (!wallet || !game) return;
    setSitBusy(true);
    setNotice(null);
    try {
      const pk = new PublicKey(wallet.address);
      const sessionKey = loadOrCreateSessionKey(TABLE_ID, seatIdx, wallet.address);
      const amount = BigInt(Math.round(parseFloat(buyIn) * 1e6));
      const program = makeProgram(l1);
      const playerAta = getAssociatedTokenAddressSync(TUSDC_MINT, pk);

      const tx = new Transaction();
      if (!(await l1.getAccountInfo(playerAta))) {
        tx.add(createAssociatedTokenAccountInstruction(pk, playerAta, pk, TUSDC_MINT));
      }
      // X10: session key 预充手续费（L1）。
      tx.add(
        SystemProgram.transfer({
          fromPubkey: pk,
          toPubkey: sessionKey.publicKey,
          lamports: SESSION_KEY_LAMPORTS,
        })
      );
      tx.add(
        await program.methods
          .sitDown(
            seatIdx,
            new BN(amount.toString()),
            sessionKey.publicKey,
            new BN(Math.floor(Date.now() / 1000) + SESSION_TTL_S)
          )
          .accounts({
            table: pdas.table,
            seat: pdas.seat(seatIdx),
            vaultAuth: pdas.vaultAuth,
            vault: getAssociatedTokenAddressSync(TUSDC_MINT, pdas.vaultAuth, true),
            mint: TUSDC_MINT,
            playerAta,
            payer: pk,
          })
          .instruction()
      );
      tx.feePayer = pk;
      tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
      const signed = await signL1(
        wallet,
        tx.serialize({ requireAllSignatures: false, verifySignatures: false })
      );
      const sig = await sendWalletSigned(l1, signed, "sit_down");
      setNotice(`入座已提交：${sig.slice(0, 16)}…（crank 会计入筹码，约几秒）`);
    } catch (e) {
      setNotice(
        `入座失败：${e instanceof TxError ? e.message : e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setSitBusy(false);
    }
  }, [wallet, game, buyIn, seatIdx, l1, signL1]);

  // ---- cash out (L1, permissionless, wallet-signed) ----
  const cashOut = useCallback(async () => {
    if (!wallet) return;
    setNotice(null);
    try {
      const pk = new PublicKey(wallet.address);
      const program = makeProgram(l1);
      let idx = mySeat;
      if (idx === null && game) {
        for (let i = 0; i < game.seats.length; i++) {
          if (game.seats[i].occupant.toBase58() === wallet.address) idx = i;
        }
      }
      if (idx === null) throw new Error("没有找到你的座位");
      const playerAta = getAssociatedTokenAddressSync(TUSDC_MINT, pk);
      const tx = new Transaction();
      if (!(await l1.getAccountInfo(playerAta))) {
        tx.add(createAssociatedTokenAccountInstruction(pk, playerAta, pk, TUSDC_MINT));
      }
      tx.add(
        await program.methods
          .cashOut(idx)
          .accounts({
            table: pdas.table,
            game: pdas.game,
            seat: pdas.seat(idx),
            vaultAuth: pdas.vaultAuth,
            vault: getAssociatedTokenAddressSync(TUSDC_MINT, pdas.vaultAuth, true),
            mint: TUSDC_MINT,
            payoutAta: playerAta,
            caller: pk,
          })
          .instruction()
      );
      tx.feePayer = pk;
      tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
      const signed = await signL1(
        wallet,
        tx.serialize({ requireAllSignatures: false, verifySignatures: false })
      );
      const sig = await sendWalletSigned(l1, signed, "cash_out");
      setNotice(`兑现完成：${sig.slice(0, 16)}…`);
    } catch (e) {
      setNotice(
        `兑现失败：${e instanceof TxError ? e.message : e instanceof Error ? e.message : String(e)}`
      );
    }
  }, [wallet, mySeat, game, l1, signL1]);

  // ---- raise input ----
  const [raiseTo, setRaiseTo] = useState("");
  const myTurn =
    game !== null &&
    mySeat !== null &&
    (game.phase === 3 || game.phase === 5) &&
    game.toAct === mySeat;
  const toCall =
    game && mySeat !== null ? game.currentBet - game.seats[mySeat].streetBet : 0n;
  const minRaiseTo =
    game && mySeat !== null
      ? game.currentBet > 0n
        ? game.currentBet + game.lastFullRaise
        : game.lastFullRaise
      : 0n;

  // -------------------------------------------------------------------------
  // render
  // -------------------------------------------------------------------------
  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          SolPoker <span className="brand-sub">隐私扑克 · devnet-tee</span>
        </div>
        {PRIVY_CONFIGURED ? (
          <LoginButton />
        ) : (
          <button className="btn btn-muted" disabled>
            登录
          </button>
        )}
      </header>

      <main className="main">
        {!PRIVY_CONFIGURED && (
          <p className="error-text">未配置 NEXT_PUBLIC_PRIVY_APP_ID（见 web/README.md）</p>
        )}
        {!authenticated && PRIVY_CONFIGURED && (
          <p className="muted">连接钱包开始。测试网代币：tUSDC 由运营方发放。</p>
        )}

        {authenticated && wallet && (
          <>
            <section className="tee-panel">
              <div className="row spread">
                <span className="muted">
                  钱包 <code>{wallet.address.slice(0, 4)}…{wallet.address.slice(-4)}</code>
                  　SOL {solBal === null ? "…" : solBal.toFixed(3)}　tUSDC{" "}
                  {usdcBal === null ? "…" : usdcBal.toFixed(2)}
                </span>
                {tee.phase !== "ok" ? (
                  <button
                    className="btn btn-positive"
                    onClick={connectTee}
                    disabled={tee.phase === "working"}
                  >
                    {tee.phase === "working" ? "校验 TEE…" : "连接 TEE"}
                  </button>
                ) : (
                  <span className="ok-text">TEE 已验证 ✓</span>
                )}
              </div>
              {tee.phase === "error" && (
                <p className="error-text">TEE 连接失败：{tee.message}（点按钮重试）</p>
              )}
            </section>

            {tee.phase === "ok" && game && (
              <>
                {/* ---- 桌面 ---- */}
                <section className="table-area">
                  <div className="row spread">
                    <h2 className="tier-title">
                      桌 #{TABLE_ID}　阶段：{phaseName(game.phase)}　手 #{game.handId.toString()}
                    </h2>
                    <span className="pot">底池 {fmtUsdc(game.pot)}</span>
                  </div>

                  <div className="board">
                    {game.board.slice(0, game.boardLen).map((c, i) => (
                      <Card key={i} card={c} />
                    ))}
                    {game.boardLen === 0 && <span className="muted">（未发公共牌）</span>}
                  </div>

                  <div className="seats">
                    {game.seats.map((s, i) => {
                      if (s.status === 0) return null;
                      const isMe = mySeat === i;
                      const isActor =
                        game.toAct === i && (game.phase === 3 || game.phase === 5);
                      return (
                        <div
                          key={i}
                          className={`seat${isMe ? " me" : ""}${isActor ? " actor" : ""}`}
                        >
                          <div className="seat-addr">
                            {i === game.button && <span className="dealer">D </span>}
                            {isMe ? "你" : `${s.occupant.toBase58().slice(0, 4)}…`}
                            {s.folded && <span className="muted">（fold）</span>}
                            {s.allIn && <span className="allin"> ALL-IN</span>}
                          </div>
                          <div className="seat-stack">{fmtUsdc(s.stack)}</div>
                          {s.inHand > 0n && <div className="seat-bet">注 {fmtUsdc(s.inHand)}</div>}
                        </div>
                      );
                    })}
                  </div>

                  {/* ---- 我的手牌 ---- */}
                  {mySeat !== null && (
                    <div className="myhand">
                      <span className="muted">你的手牌（仅你可见）：</span>
                      {myHand && myHand.handId === game.handId ? (
                        myHand.cards.map((c, i) => <Card key={i} card={c} />)
                      ) : (
                        <>
                          <Card card={0xff} hidden />
                          <Card card={0xff} hidden />
                        </>
                      )}
                    </div>
                  )}
                </section>

                {/* ---- 行动区 ---- */}
                {mySeat !== null && (
                  <section className="actions">
                    {myTurn ? (
                      <>
                        <button
                          className="btn btn-danger"
                          onClick={() => driver.act("fold")}
                          disabled={!!driver.busy}
                        >
                          Fold
                        </button>
                        {toCall === 0n ? (
                          <button
                            className="btn btn-primary"
                            onClick={() => driver.act("check")}
                            disabled={!!driver.busy}
                          >
                            Check
                          </button>
                        ) : (
                          <button
                            className="btn btn-primary"
                            onClick={() => driver.act("call")}
                            disabled={!!driver.busy}
                          >
                            Call {fmtUsdc(toCall)}
                          </button>
                        )}
                        <input
                          className="raise-input"
                          placeholder={`≥ ${fmtUsdc(minRaiseTo)}`}
                          value={raiseTo}
                          onChange={(e) => setRaiseTo(e.target.value)}
                        />
                        <button
                          className="btn btn-positive"
                          disabled={!!driver.busy || !raiseTo}
                          onClick={() =>
                            driver.act(
                              game.currentBet > 0n ? "raiseTo" : "bet",
                              BigInt(Math.round(parseFloat(raiseTo) * 1e6))
                            )
                          }
                        >
                          {game.currentBet > 0n ? "Raise to" : "Bet"}
                        </button>
                        <button
                          className="btn btn-muted"
                          onClick={() => driver.act("allIn")}
                          disabled={!!driver.busy}
                        >
                          All-in
                        </button>
                      </>
                    ) : (
                      <span className="muted">
                        {game.phase === 3 || game.phase === 5
                          ? `等待座位 ${game.toAct} 行动…`
                          : game.phase === 0
                            ? "等待 crank 开下一手…"
                            : `阶段 ${phaseName(game.phase)} 推进中（crank 自动）…`}
                      </span>
                    )}
                    <button
                      className="btn btn-muted"
                      onClick={driver.standUp}
                      disabled={!!driver.busy}
                    >
                      站起
                    </button>
                  </section>
                )}

                {/* ---- 入座区 ---- */}
                {mySeat === null && (
                  <section className="tee-panel">
                    <h3 className="tier-title">入座（买入 tUSDC）</h3>
                    <div className="row">
                      <label>
                        座位{" "}
                        <select
                          value={seatIdx}
                          onChange={(e) => setSeatIdx(Number(e.target.value))}
                        >
                          {game.seats.map((s, i) =>
                            s.status === 0 ? (
                              <option key={i} value={i}>
                                {i}
                              </option>
                            ) : null
                          )}
                        </select>
                      </label>
                      <label>
                        买入{" "}
                        <input
                          className="raise-input"
                          value={buyIn}
                          onChange={(e) => setBuyIn(e.target.value)}
                        />
                      </label>
                      <button className="btn btn-positive" onClick={sitDown} disabled={sitBusy}>
                        {sitBusy ? "签名并发送…" : "坐下"}
                      </button>
                    </div>
                    <p className="muted">
                      一笔钱包签名完成：建 ATA（如需）+ 预充 session key + 买入。此后对局动作由
                      session key 自动签名，不再弹窗。
                    </p>
                  </section>
                )}

                <div className="row">
                  <button className="btn btn-primary" onClick={cashOut}>
                    兑现（cash_out）
                  </button>
                  <a className="footer-link" href="/trust">
                    信任页 →
                  </a>
                </div>
              </>
            )}

            {tee.phase === "ok" && !game && <p className="muted">加载牌桌状态…</p>}
          </>
        )}

        {notice && <p className="muted">{notice}</p>}
        {driver.error && <p className="error-text">{driver.error}</p>}
      </main>

      <footer className="footer">
        <span className="muted">
          阶段机：{PHASES.join(" → ")}　|　crank 负责 advance/VRF/commit
        </span>
      </footer>
    </div>
  );
}
