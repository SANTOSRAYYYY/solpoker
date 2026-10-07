"use client";

// SolPoker 牌桌页（Stage 7）：Privy 钱包 → TEE attestation 门控 → 入座 →
// 对局（session key 自动打盐/行动）→ 站起兑现。
// 排版：椭圆绿毡牌桌 + 环绕座位（自己恒在正下方）+ 中央底池/公共牌 +
// 底部行动坞。金额输入一律经 parseUsdcInput（非法输入禁按钮，不再崩溃）。

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
import { fmtUsdc, phaseName } from "@/lib/game-state";
import { loadOrCreateSessionKey } from "@/lib/session-key";
import { parseUsdcInput } from "@/lib/amount";
import type { GameView } from "@/lib/game-state";

// ?demo=1：用假数据渲染牌桌（免登录的排版走查；不产生任何链上行为）。
const DEMO_GAME: GameView = {
  table: PublicKey.default,
  transcript: new Uint8Array(32),
  handId: 7n,
  pot: 340_000n,
  currentBet: 100_000n,
  lastFullRaise: 100_000n,
  actionDeadline: 0n,
  rakeTotal: 10_000n,
  vrfState: 0,
  vrfTarget: 0,
  vrfAttempt: 0,
  seats: [
    { occupant: PublicKey.default, saltCommit: new Uint8Array(32), occupancyId: 1n, stack: 19_780_000n, inHand: 100_000n, streetBet: 100_000n, kind: 0, status: 1, folded: false, allIn: false, acted: true, strikes: 0, leaveRequested: false },
    { occupant: PublicKey.default, saltCommit: new Uint8Array(32), occupancyId: 1n, stack: 20_210_000n, inHand: 50_000n, streetBet: 50_000n, kind: 0, status: 1, folded: false, allIn: false, acted: false, strikes: 0, leaveRequested: false },
    { occupant: PublicKey.default, saltCommit: new Uint8Array(32), occupancyId: 2n, stack: 14_000_000n, inHand: 0n, streetBet: 0n, kind: 0, status: 1, folded: true, allIn: false, acted: true, strikes: 0, leaveRequested: false },
    ...Array.from({ length: 6 }, () => ({ occupant: PublicKey.default, saltCommit: new Uint8Array(32), occupancyId: 0n, stack: 0n, inHand: 0n, streetBet: 0n, kind: 0, status: 0, folded: false, allIn: false, acted: false, strikes: 0, leaveRequested: false })),
  ],
  actionSeq: 3,
  occupiedMask: 0b111,
  handMask: 0b011,
  liveMask: 0b011,
  actionableMask: 0b001,
  pendingMask: 0b001,
  board: [4 * 4 + 1, 9 * 4 + 2, 11 * 4 + 0],
  boardSrc: [0, 0, 0],
  phase: 5,
  street: 1,
  button: 1,
  boardLen: 3,
  toAct: 0,
};
const DEMO_HAND = { handId: 7n, cards: [12 * 4 + 1, 12 * 4 + 1], saltHandId: 7n };

// ---------------------------------------------------------------------------
// pieces
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

const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const SUITS = ["♠","♥","♦","♣"];

function Card({ card, hidden, large }: { card: number; hidden?: boolean; large?: boolean }) {
  const cls = `card${large ? " card-lg" : ""}`;
  if (hidden || card >= 52) return <span className={`${cls} card-back`} />;
  const red = (card & 3) === 1 || (card & 3) === 2;
  return (
    <span className={`${cls} ${red ? "red" : "black"}`}>
      <span className="r">{RANKS[card >> 2]}</span>
      <span className="s">{SUITS[card & 3]}</span>
    </span>
  );
}

// 座位在椭圆上的角度（度）：座位 i 基准角 = 90 + i*40（从正下方起逆时针），
// 入座后整体旋转，让「我」恒在正下方（90°）。
function seatPos(i: number, mySeat: number | null, occupied: number[]): { left: string; top: string } {
  const base = 90 + i * 40;
  const shift = mySeat !== null ? 90 - (90 + mySeat * 40) : 0;
  const rad = ((base + shift) * Math.PI) / 180;
  const x = 50 + 44 * Math.cos(rad);
  const y = 50 + 46 * Math.sin(rad);
  return { left: `${x}%`, top: `${y}%` };
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
  const buyInAmount = parseUsdcInput(buyIn);

  const sitDown = useCallback(async () => {
    if (!wallet || !game || buyInAmount === null) return;
    setSitBusy(true);
    setNotice(null);
    try {
      const pk = new PublicKey(wallet.address);
      const sessionKey = loadOrCreateSessionKey(TABLE_ID, seatIdx, wallet.address);
      const program = makeProgram(l1);
      const playerAta = getAssociatedTokenAddressSync(TUSDC_MINT, pk);

      const tx = new Transaction();
      if (!(await l1.getAccountInfo(playerAta))) {
        tx.add(createAssociatedTokenAccountInstruction(pk, playerAta, pk, TUSDC_MINT));
      }
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
            new BN(buyInAmount.toString()),
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
      setNotice(`入座已提交：${sig.slice(0, 16)}…（crank 正在计入筹码，几秒后出现在桌上）`);
    } catch (e) {
      setNotice(
        `入座失败：${e instanceof TxError ? e.message : e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setSitBusy(false);
    }
  }, [wallet, game, buyInAmount, seatIdx, l1, signL1]);

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

  // ---- 行动区派生 ----
  const [raiseTo, setRaiseTo] = useState("");
  const raiseAmount = parseUsdcInput(raiseTo);

  // ---- demo 模式（?demo=1）：只看排版，不触链 ----
  const [demo] = useState(
    () => typeof window !== "undefined" && /[?&]demo=1/.test(window.location.search)
  );
  const viewGame = demo ? DEMO_GAME : game;
  const viewSeat = demo ? 0 : mySeat;
  const viewHand = demo ? DEMO_HAND : myHand;
  const viewOccupied = useMemo(
    () =>
      viewGame
        ? viewGame.seats.map((s, i) => (s.status !== 0 ? i : -1)).filter((i) => i >= 0)
        : [],
    [viewGame]
  );
  const viewMyTurn =
    viewGame !== null &&
    viewSeat !== null &&
    (viewGame.phase === 3 || viewGame.phase === 5) &&
    viewGame.toAct === viewSeat;
  const viewToCall =
    viewGame && viewSeat !== null ? viewGame.currentBet - viewGame.seats[viewSeat].streetBet : 0n;
  const viewMinRaise =
    viewGame && viewSeat !== null
      ? viewGame.currentBet > 0n
        ? viewGame.currentBet + viewGame.lastFullRaise
        : viewGame.lastFullRaise
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

        {!demo && !authenticated && PRIVY_CONFIGURED && (
          <div className="panel">
            <h3>隐私德州扑克 · Solana devnet-tee</h3>
            <p className="muted">
              底牌只存在 TEE 里，只有你的钱包能读；牌序由 MagicBlock VRF + 双方盐决定，赛后可复算。
              连接钱包开始（测试代币 tUSDC 由运营方发放）。
            </p>
          </div>
        )}

        {(demo || (authenticated && wallet)) && (
          <>
            {/* ---- 状态条（demo 模式不显示） ---- */}
            {!demo && (
              <>
                <div className="statusbar">
                  <span>
                    <code>{wallet!.address.slice(0, 4)}…{wallet!.address.slice(-4)}</code>
                  </span>
                  <span>
                    SOL <span className="bal">{solBal === null ? "…" : solBal.toFixed(3)}</span>
                  </span>
                  <span>
                    tUSDC <span className="bal">{usdcBal === null ? "…" : usdcBal.toFixed(2)}</span>
                  </span>
                  <span className="grow" />
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
              </>
            )}
            {demo && (
              <p className="muted">demo 排版走查模式（假数据，不触链）。</p>
            )}

            {(demo || (tee.phase === "ok" && game)) && viewGame && (
              <>
                {/* ---- 椭圆牌桌 ---- */}
                <div className="felt-wrap">
                  <div className="felt">
                    <div className="felt-center">
                      <div className="pot-badge">底池 {fmtUsdc(viewGame.pot)}</div>
                      <div className="board">
                        {viewGame.boardLen > 0 ? (
                          viewGame.board.slice(0, viewGame.boardLen).map((c, i) => <Card key={i} card={c} />)
                        ) : (
                          <span className="muted">
                            {phaseName(viewGame.phase)} · 手 #{viewGame.handId.toString()}
                          </span>
                        )}
                      </div>
                    </div>
                    {viewOccupied.map((i) => {
                      const s = viewGame.seats[i];
                      const isMe = viewSeat === i;
                      const isActor =
                        viewGame.toAct === i && (viewGame.phase === 3 || viewGame.phase === 5);
                      return (
                        <div
                          key={i}
                          className={`seat${isMe ? " me" : ""}${isActor ? " actor" : ""}${s.folded ? " folded" : ""}`}
                          style={seatPos(i, viewSeat, viewOccupied)}
                        >
                          {i === viewGame.button && <span className="dealer-btn">D</span>}
                          <div className="seat-name">
                            {isMe ? "你" : `${s.occupant.toBase58().slice(0, 4)}…${s.occupant.toBase58().slice(-4)}`}
                          </div>
                          <div className="seat-stack">{fmtUsdc(s.stack)}</div>
                          {s.folded && <div className="seat-flags">FOLD</div>}
                          {s.allIn && <div className="seat-flags">ALL-IN</div>}
                          {s.inHand > 0n && <div className="seat-bet">{fmtUsdc(s.inHand)}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ---- 我的手牌 ---- */}
                {viewSeat !== null && (
                  <div className="myhand">
                    <span className="label">你的手牌（仅你可见）</span>
                    <span className="cards">
                      {viewHand && viewHand.handId === viewGame.handId ? (
                        viewHand.cards.map((c, i) => <Card key={i} card={c} large />)
                      ) : (
                        <>
                          <Card card={0xff} hidden large />
                          <Card card={0xff} hidden large />
                        </>
                      )}
                    </span>
                  </div>
                )}

                {/* ---- 行动坞 ---- */}
                {viewSeat !== null && (
                  <div className="action-dock">
                    {viewMyTurn ? (
                      <>
                        <button
                          className="btn btn-danger"
                          onClick={() => driver.act("fold")}
                          disabled={!!driver.busy}
                        >
                          弃牌
                        </button>
                        {viewToCall === 0n ? (
                          <button
                            className="btn btn-primary"
                            onClick={() => driver.act("check")}
                            disabled={!!driver.busy}
                          >
                            过牌
                          </button>
                        ) : (
                          <button
                            className="btn btn-primary"
                            onClick={() => driver.act("call")}
                            disabled={!!driver.busy}
                          >
                            跟注 {fmtUsdc(viewToCall)}
                          </button>
                        )}
                        <input
                          className="raise-input"
                          placeholder={`≥ ${fmtUsdc(viewMinRaise)}`}
                          value={raiseTo}
                          onChange={(e) => setRaiseTo(e.target.value)}
                        />
                        <button
                          className="btn btn-positive"
                          disabled={!!driver.busy || raiseAmount === null}
                          onClick={() =>
                            raiseAmount !== null &&
                            driver.act(viewGame.currentBet > 0n ? "raiseTo" : "bet", raiseAmount)
                          }
                        >
                          {viewGame.currentBet > 0n ? "加注到" : "下注"}
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
                      <span className="hint">
                        {viewGame.phase === 3 || viewGame.phase === 5
                          ? `等待座位 ${viewGame.toAct} 行动…`
                          : viewGame.phase === 0
                            ? "手牌结束，crank 正在开下一手…"
                            : `阶段 ${phaseName(viewGame.phase)} 推进中（crank 自动）…`}
                      </span>
                    )}
                    <span className="grow" />
                    <button
                      className="btn btn-muted"
                      onClick={driver.standUp}
                      disabled={!!driver.busy}
                    >
                      站起
                    </button>
                  </div>
                )}

                {/* ---- 入座面板 ---- */}
                {viewSeat === null && (
                  <div className="panel">
                    <h3>入座（买入 tUSDC）</h3>
                    <div className="row">
                      <label>
                        座位{" "}
                        <select
                          value={seatIdx}
                          onChange={(e) => setSeatIdx(Number(e.target.value))}
                        >
                          {viewGame.seats.map((s, i) =>
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
                      <button
                        className="btn btn-positive"
                        onClick={sitDown}
                        disabled={sitBusy || buyInAmount === null}
                      >
                        {sitBusy ? "签名并发送…" : "坐下"}
                      </button>
                    </div>
                    <p className="muted">
                      一笔钱包签名完成：建 ATA（如需）+ 预充 session key + 买入。此后对局动作由
                      session key 自动签名，不再弹窗。
                    </p>
                  </div>
                )}

                <div className="row">
                  <button className="btn btn-primary" onClick={cashOut}>
                    兑现（cash_out）
                  </button>
                  <span className="grow" />
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
          桌 #{TABLE_ID} · 阶段机 {PHASES.join(" → ")} · crank 驱动 advance/VRF/commit
        </span>
      </footer>
    </div>
  );
}
