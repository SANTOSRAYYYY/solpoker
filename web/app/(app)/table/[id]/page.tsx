"use client";

// 对局页 /table/[id]：真实链上数据 + 已批准的视觉稿设计。
//
// 数据来源分两层：
//   1) L1 快照（chain-read，无需 token）——首屏就能看到桌子、座位、底池；
//   2) ER 实时（use-game，需要 TEE token）——行动、自己的底牌、盐协议。
// 交易纪律沿用 Stage 6/7 的踩坑结论：ER 交易必带 CU 预算 + skipPreflight；
// 入座/兑现走钱包签名（L1，一笔交易内含 ATA + session key 预充 + 买入）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
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
import BN from "bn.js";
import { Badge, Chip, ChipStack, Dot, KV, PlayingCard, SectionTitle, SolMark, type Suit } from "@/components/ui";
import { useWalletCtx } from "@/components/wallet-context";
import { useSignChallenge, useSignL1Transaction } from "@/lib/privy-solana";
import { establishTeeSession, type TeeSession } from "@/lib/tee-auth";
import { useGame } from "@/lib/use-game";
import {
  L1_RPC,
  ER_RPC,
  TUSDC_MINT,
  SESSION_KEY_LAMPORTS,
  SESSION_TTL_S,
} from "@/lib/config";
import {
  pdasFor,
  makeProgram,
  sendWalletSigned,
  TxError,
} from "@/lib/solpoker-client";
import { fmtUsdc, phaseName, type GameView } from "@/lib/game-state";
import { readGameLive, readSeatLedgers, type SeatLedgerView } from "@/lib/chain-read";
import { scanTables, type TableInfo } from "@/lib/tables";
import { loadOrCreateSessionKey } from "@/lib/session-key";
import { parseUsdcInput } from "@/lib/amount";

const KIND_ZH: Record<number, { zh: string; tone: "plain" | "grad" | "cyan" }> = {
  0: { zh: "真人桌", tone: "plain" },
  1: { zh: "AI 桌", tone: "cyan" },
  2: { zh: "混合桌", tone: "grad" },
};

// ---------------------------------------------------------------------------
// 牌面映射（链上 card = rank*4 + suit；0..12 = 2..A；0xFF/≥52 = 无牌）
// ---------------------------------------------------------------------------
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS: Suit[] = ["♠", "♥", "♦", "♣"];
function cardParts(card: number): { rank: string; suit: Suit } | null {
  if (card >= 52) return null;
  return { rank: RANKS[card >> 2], suit: SUITS[card & 3] };
}

// ---------------------------------------------------------------------------
// 座位排布：9 座 × 40°，我的座位恒在正下方
// ---------------------------------------------------------------------------
function seatPos(i: number, mySeat: number | null, n = 9) {
  const base = 90 + i * (360 / n);
  const shift = mySeat !== null ? 90 - (90 + mySeat * (360 / n)) : 0;
  const rad = ((base + shift) * Math.PI) / 180;
  return { x: 50 + 43 * Math.cos(rad), y: 50 + 37 * Math.sin(rad) };
}

// ---------------------------------------------------------------------------
// ?demo=1：免登录排版走查（假数据，不触链）
// ---------------------------------------------------------------------------
const DEMO_GAME: GameView = {
  table: PublicKey.default,
  transcript: new Uint8Array(32),
  handId: 8n,
  pot: 33_200_000n,
  currentBet: 22_400_000n,
  lastFullRaise: 2_000_000n,
  actionDeadline: 0n,
  rakeTotal: 10_000n,
  vrfState: 3,
  vrfTarget: 2,
  vrfAttempt: 1,
  seats: Array.from({ length: 9 }, (_, i) => ({
    occupant:
      i < 6
        ? new PublicKey(
            Uint8Array.from({ length: 32 }, (_, k) => ((i * 37 + k) % 251) + 1)
          )
        : PublicKey.default,
    saltCommit: new Uint8Array(32),
    occupancyId: 1n,
    stack: [38_200_000n, 22_400_000n, 0n, 12_800_000n, 41_200_000n, 30_100_000n][i] ?? 0n,
    inHand: [0n, 2_000_000n, 22_400_000n, 0n, 6_400_000n, 2_000_000n][i] ?? 0n,
    streetBet: 0n,
    kind: i === 2 ? 1 : 0,
    status: i < 6 ? 1 : 0,
    folded: [true, true, false, true, false, true][i] ?? false,
    allIn: i === 2,
    acted: true,
    strikes: 0,
    leaveRequested: false,
  })),
  actionSeq: 9,
  occupiedMask: 0b0111111,
  handMask: 0b0101101,
  liveMask: 0b0001101,
  actionableMask: 0b0001000,
  pendingMask: 0b0001000,
  board: [4 * 4 + 1, 11 * 4 + 0, 1 * 4 + 2, 4 * 4 + 3, 0],
  boardSrc: [0, 0, 0, 0, 0],
  phase: 5,
  street: 3,
  button: 5,
  boardLen: 4,
  toAct: 4,
};
const DEMO_HAND = { handId: 8n, cards: [12 * 4 + 0, 12 * 4 + 2], saltHandId: 8n };

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------
function SeatView({
  idx,
  game,
  ledger,
  mySeat,
  actionTimeoutS,
}: {
  idx: number;
  game: GameView;
  ledger: SeatLedgerView | null;
  mySeat: number | null;
  actionTimeoutS: number;
}) {
  const s = game.seats[idx];
  const p = seatPos(idx, mySeat);
  const isMe = mySeat === idx;
  const acting = game.toAct === idx && (game.phase === 3 || game.phase === 5);
  const left = s.status === 2; // 2=Left：已离座，账本可能还没兑现（僵尸态）
  if (s.status === 0 && !ledger?.occupant) {
    return (
      <div
        className="absolute z-[5] w-[132px] -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${p.x}%`, top: `${p.y}%` }}
      >
        <div className="rounded-xl border border-dashed border-mist/15 px-3 py-2 text-center text-[11px] text-mist-faint">
          空座 {idx}
        </div>
      </div>
    );
  }
  const who =
    isMe
      ? "我"
      : ledger?.kind === 1
        ? "AI"
        : s.occupant.equals(PublicKey.default)
          ? "—"
          : `${s.occupant.toBase58().slice(0, 4)}…${s.occupant.toBase58().slice(-4)}`;
  const remain =
    acting && game.actionDeadline > 0n
      ? Math.max(0, Number(game.actionDeadline) - Math.floor(Date.now() / 1000))
      : null;
  return (
    <div
      className="absolute z-10 w-[148px] -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${p.x}%`, top: `${p.y}%` }}
    >
      <div
        className={`seat-plate flex items-center gap-2 px-2.5 py-2 ${acting ? "seat-acting" : ""} ${
          isMe ? "seat-me" : ""
        } ${s.folded || left ? "seat-folded" : ""}`}
      >
        <span
          className={`avatar h-9 w-9 shrink-0 text-[12px] ${ledger?.kind === 1 ? "avatar-agent" : ""}`}
        >
          {ledger?.kind === 1 ? "AI" : who.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-bold tracking-wide text-mist">
              {who}
            </span>
            {isMe && (
              <Badge tone="grad" className="!px-1.5 !text-[9px]">
                我
              </Badge>
            )}
            {left && (
              <Badge tone="plain" className="!px-1.5 !text-[9px]">
                已离座
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1 font-mono text-[11px] leading-tight">
            <Chip color={s.allIn ? "purple" : "white"} size={13} />
            <span className={s.allIn ? "text-loss" : "text-accent-200"}>
              {s.allIn ? "全下" : fmtUsdc(s.stack)}
            </span>
          </div>
        </div>
        {acting && remain !== null && (
          <span
            className="timer-ring shrink-0"
            style={{
              ["--p" as string]: Math.min(1, remain / Math.max(1, actionTimeoutS)),
              ["--tr-size" as string]: "38px",
            }}
          >
            <span>{remain}</span>
          </span>
        )}
      </div>
      <div className="mt-1 text-center font-mono text-[10.5px]">
        {left && <span className="text-warn">待兑现</span>}
        {!left && s.folded && <span className="text-mist-faint">弃牌</span>}
        {!left && !s.folded && s.leaveRequested && <span className="text-warn">待离座</span>}
      </div>
    </div>
  );
}

function BetChips({
  idx,
  game,
  mySeat,
}: {
  idx: number;
  game: GameView;
  mySeat: number | null;
}) {
  const s = game.seats[idx];
  if (s.status === 0 || s.inHand === 0n) return null;
  const p = seatPos(idx, mySeat);
  const bx = p.x + (50 - p.x) * 0.36;
  const by = p.y + (50 - p.y) * 0.36;
  return (
    <div
      className="absolute z-[8] -translate-x-1/2 -translate-y-1/2 animate-chip-pop"
      style={{ left: `${bx}%`, top: `${by}%` }}
    >
      <Chip
        v={Number(s.inHand) / 1e6 >= 10 ? (Number(s.inHand) / 1e6).toFixed(0) : (Number(s.inHand) / 1e6).toFixed(1)}
        color={s.allIn ? "purple" : Number(s.inHand) >= 2_000_000 ? "cyan" : "green"}
        size={28}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主页面
// ---------------------------------------------------------------------------
type TeeState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "ok"; session: TeeSession }
  | { phase: "error"; message: string };

interface FeedItem {
  t: string;
  who: string;
  what: string;
  tone?: "gold" | "red" | "mint" | "plain" | "brand";
}

export default function TablePage() {
  const params = useParams<{ id: string }>();
  const tableId = Number(params?.id ?? 0);
  const ctx = useWalletCtx();
  const signChallenge = useSignChallenge();
  const signL1 = useSignL1Transaction();

  const l1 = useMemo(() => new Connection(L1_RPC, "confirmed"), []);
  const erRead = useMemo(() => new Connection(ER_RPC, "confirmed"), []);
  const pdas = useMemo(() => pdasFor(tableId), [tableId]);

  // ?demo=1 只在客户端 effect 里打开：首屏渲染必须与 SSR 一致，否则 hydration 报错
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    if (/[?&]demo=1/.test(window.location.search)) setDemo(true);
  }, []);
  const [tee, setTee] = useState<TeeState>({ phase: "idle" });
  const [info, setInfo] = useState<TableInfo | null>(null);
  const [snap, setSnap] = useState<GameView | null>(null);
  const [ledgers, setLedgers] = useState<(SeatLedgerView | null)[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [raiseTo, setRaiseTo] = useState("");
  const [buyIn, setBuyIn] = useState("20");
  const [seatPick, setSeatPick] = useState<number | null>(null);
  const [mixedOk, setMixedOk] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [sitBusy, setSitBusy] = useState(false);

  // ---- 桌参数（盲注/类型/超时） ----
  useEffect(() => {
    let stop = false;
    (async () => {
      for (;;) {
        if (stop) return;
        try {
          const all = await scanTables(l1);
          const hit = all.find((t) => t.id === tableId) ?? null;
          setInfo(hit);
        } catch {
          /* 下一轮 */
        }
        await new Promise((r) => setTimeout(r, 30000));
      }
    })();
    return () => {
      stop = true;
    };
  }, [l1, tableId]);

  // ---- 牌面状态：Game 公开账户走 ER 实时（不需要 token，观战也能看），
  //      账本走 L1；连上 TEE 后 driver.game（ER + 我的私有一致视图）优先 ----
  const [source, setSource] = useState<"er" | "l1" | null>(null);
  useEffect(() => {
    let stop = false;
    (async () => {
      for (;;) {
        if (stop) return;
        try {
          const live = await readGameLive(erRead, l1, tableId);
          setSnap(live?.game ?? null);
          setSource(live?.source ?? null);
          setLedgers(await readSeatLedgers(l1, tableId));
        } catch {
          /* 下一轮 */
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
    })();
    return () => {
      stop = true;
    };
  }, [erRead, l1, tableId]);

  // ---- ER 实时（需要 TEE token） ----
  const teeToken = tee.phase === "ok" ? tee.session.token : null;
  const walletLike = useMemo(
    () =>
      demo
        ? { address: PublicKey.default.toBase58() }
        : teeToken && ctx.address
          ? { address: ctx.address }
          : null,
    [demo, teeToken, ctx.address]
  );
  const driver = useGame(walletLike, teeToken, tableId);
  const game = demo ? DEMO_GAME : (driver.game ?? snap);
  const myHand = demo ? DEMO_HAND : driver.myHand;
  const mySeat = demo ? 4 : driver.mySeat;

  // ---- TEE 会话 ----
  const connectTee = useCallback(async () => {
    if (!ctx.address || !ctx.wallet) return;
    try {
      setTee({ phase: "working" });
      const session = await establishTeeSession(ctx.address, (b) =>
        signChallenge(ctx.wallet!, b)
      );
      setTee({ phase: "ok", session });
    } catch (e) {
      setTee({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [ctx.address, ctx.wallet, signChallenge]);

  // ---- 行动记录（从观测到的状态变化生成，不做假） ----
  const prevRef = useRef<GameView | null>(null);
  useEffect(() => {
    if (!game) return;
    const prev = prevRef.current;
    const now = new Date();
    const t = `${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    const push = (who: string, what: string, tone?: FeedItem["tone"]) =>
      setFeed((f) => [...f.slice(-60), { t, who, what, tone }]);
    if (prev) {
      if (game.handId !== prev.handId) push("系统", `手牌 #${game.handId} 开始`, "brand");
      if (game.boardLen > prev.boardLen) {
        const street = ["", "翻牌", "转牌", "河牌"][game.boardLen === 3 ? 1 : game.boardLen === 4 ? 2 : 3] ?? "公共牌";
        push("系统", `${street} 已揭示（${game.boardLen} 张）`, "brand");
      }
      if (game.phase !== prev.phase) {
        if (game.phase === 0) push("系统", "本手结束", "plain");
        else if (game.phase === 1) push("系统", "提交盐阶段", "brand");
        else if (game.phase === 2) push("系统", "揭示盐阶段", "brand");
        else if (game.phase === 7) push("系统", "结算中", "plain");
      }
      if (game.pot !== prev.pot) {
        push("桌面", `底池 ${fmtUsdc(game.pot)}`, "mint");
      }
      if (game.toAct !== prev.toAct && (game.phase === 3 || game.phase === 5)) {
        push("系统", `轮到座位 ${game.toAct} 行动`, "gold");
      }
    } else {
      push("系统", `牌桌已加载 · 手 #${game.handId}`, "brand");
    }
    prevRef.current = game;
  }, [game]);

  // ---- 入座（L1，钱包签名：ATA + session key 预充 + sit_down） ----
  const buyInAmount = parseUsdcInput(buyIn);
  const sitDown = useCallback(async () => {
    if (!ctx.address || !ctx.wallet || seatPick === null || buyInAmount === null) return;
    setSitBusy(true);
    setNotice(null);
    try {
      const pk = new PublicKey(ctx.address);
      const sessionKey = loadOrCreateSessionKey(tableId, seatPick, ctx.address);
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
            seatPick,
            new BN(buyInAmount.toString()),
            sessionKey.publicKey,
            new BN(Math.floor(Date.now() / 1000) + SESSION_TTL_S)
          )
          .accounts({
            table: pdas.table,
            seat: pdas.seat(seatPick),
            ...Object.fromEntries(
              Array.from({ length: 9 }, (_, k) => k)
                .filter((k) => k !== seatPick)
                .map((k, n) => [`other${n}`, pdas.seat(k)])
            ),
            agentProfile: null,
            vaultAuth: pdas.vaultAuth,
            vault: getAssociatedTokenAddressSync(TUSDC_MINT, pdas.vaultAuth, true),
            mint: TUSDC_MINT,
            playerAta,
            payer: pk,
            // anchor-ts 对 optional 账户（Option<Account<>>）的生成类型有缺陷
          } as never)
          .instruction()
      );
      tx.feePayer = pk;
      tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
      const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const signed = await signL1(ctx.wallet, unsigned);
      const sig = await sendWalletSigned(l1, signed, "sit_down");
      setNotice(`入座已提交：${sig.slice(0, 16)}…（crank 正在计入筹码，几秒后出现在桌上）`);
      setSeatPick(null);
    } catch (e) {
      setNotice(
        `入座失败：${e instanceof TxError ? e.message : e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setSitBusy(false);
    }
  }, [ctx.address, ctx.wallet, seatPick, buyInAmount, tableId, l1, pdas, signL1]);

  // ---- 兑现（L1，permissionless，钱包签名） ----
  const cashOut = useCallback(async () => {
    if (!ctx.address || !ctx.wallet) return;
    setNotice(null);
    try {
      const pk = new PublicKey(ctx.address);
      const program = makeProgram(l1);
      let idx = mySeat;
      if (idx === null && game) {
        for (let i = 0; i < game.seats.length; i++) {
          if (game.seats[i].occupant.toBase58() === ctx.address) idx = i;
        }
      }
      if (idx === null) {
        // 没入座但账本有钱（僵尸态）也能兑现
        idx = ledgers.findIndex((s) => s?.occupant?.toBase58() === ctx.address);
      }
      if (idx === null || idx < 0) throw new Error("没有找到你的座位");
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
      const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const signed = await signL1(ctx.wallet, unsigned);
      const sig = await sendWalletSigned(l1, signed, "cash_out");
      setNotice(`兑现完成：${sig.slice(0, 16)}…`);
    } catch (e) {
      setNotice(
        `兑现失败：${e instanceof TxError ? e.message : e instanceof Error ? e.message : String(e)}`
      );
    }
  }, [ctx.address, ctx.wallet, mySeat, game, ledgers, l1, pdas, signL1]);

  // ---- 行动参数 ----
  const myTurn =
    game !== null &&
    mySeat !== null &&
    (game.phase === 3 || game.phase === 5) &&
    game.toAct === mySeat;
  const toCall = game && mySeat !== null ? game.currentBet - game.seats[mySeat].streetBet : 0n;
  const minRaiseTo =
    game && mySeat !== null
      ? game.currentBet > 0n
        ? game.currentBet + game.lastFullRaise
        : game.lastFullRaise
      : 0n;
  const maxRaiseTo =
    game && mySeat !== null
      ? game.seats[mySeat].streetBet + game.seats[mySeat].stack
      : 0n;
  const raiseAmount = parseUsdcInput(raiseTo);
  // 未手动输入时用最小加注额（滑杆/按钮都会写回 raiseTo）
  const effectiveRaiseBase = raiseTo === "" ? minRaiseTo : raiseAmount;
  const timeLeft =
    game && game.actionDeadline > 0n
      ? Math.max(0, Number(game.actionDeadline) - Math.floor(Date.now() / 1000))
      : null;
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setNowTick((v) => v + 1), 1000);
    return () => clearInterval(h);
  }, []);
  void nowTick;

  const kind = info?.kind ?? 0;
  const kindMeta = KIND_ZH[kind];
  const actionTimeoutS = info?.actionTimeoutS ?? 30;

  // 轮到我时把加注输入重置为最小加注额（换手/换街也重置）
  useEffect(() => {
    if (myTurn) setRaiseTo("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTurn, game?.handId.toString(), game?.street]);

  // ---- 未入座：空座可选 ----
  const emptySeats = useMemo(() => {
    if (!game) return [];
    return game.seats
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => s.status === 0 && !ledgers[i]?.occupant)
      .map(({ i }) => i);
  }, [game, ledgers]);

  const meLedger = mySeat !== null && !demo ? ledgers[mySeat] : null;
  const myStack = game && mySeat !== null ? game.seats[mySeat].stack : null;

  // =========================================================================
  return (
    <div className="min-h-screen">
      {/* ------------------------------------------------------------ 顶栏 */}
      <div className="border-b border-mist/8 bg-black/25">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:px-5">
          <div className="flex items-center gap-2 sm:gap-3">
            <Link href="/" className="shrink-0 text-[12px] text-mist-dim hover:text-mist">
              ← <span className="hidden sm:inline">大厅</span>
            </Link>
            <span className="hidden h-4 w-px bg-mist/15 sm:block" />
            <span className="title-cn shrink-0 text-[15px] whitespace-nowrap text-mist">
              桌 #{tableId}
            </span>
            <Badge tone={kindMeta?.tone ?? "plain"}>{kindMeta?.zh ?? "—"}</Badge>
            {info && (
              <>
                <span className="hidden font-mono text-[11px] whitespace-nowrap text-mist-dim md:inline">
                  盲注 {info.blindsText}
                </span>
                <span className="hidden font-mono text-[11px] whitespace-nowrap text-mist-faint lg:inline">
                  买入 {fmtUsdc(BigInt(info.minBuyBb) * info.bb)}–{fmtUsdc(BigInt(info.maxBuyBb) * info.bb)}
                </span>
                {game && game.handId > 0n && (
                  <Badge tone="lime" className="hidden md:inline-flex">
                    手 #{game.handId.toString()}
                  </Badge>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            {!demo &&
              (tee.phase === "ok" ? (
                <Badge tone="mint" className="hidden lg:inline-flex">
                  <Dot kind="live" /> TEE 已验证
                </Badge>
              ) : (
                <button
                  className="btn-casino btn-glass px-2.5 py-1.5 text-[12px] whitespace-nowrap"
                  onClick={connectTee}
                  disabled={tee.phase === "working" || !ctx.me}
                >
                  {tee.phase === "working" ? "校验 TEE…" : "连接 TEE"}
                </button>
              ))}
            {myStack !== null && (
              <span className="rounded-lg border border-accent-500/30 bg-black/40 px-2.5 py-1.5 font-mono text-[11.5px] whitespace-nowrap text-mist-2">
                我的筹码 <span className="text-accent-200">{fmtUsdc(myStack)}</span>
              </span>
            )}
            {ctx.me && (
              <>
                <button
                  className="btn-casino btn-glass px-2.5 py-1.5 text-[12px] whitespace-nowrap"
                  onClick={cashOut}
                >
                  兑现
                </button>
                {mySeat !== null && !demo && (
                  <button
                    className="btn-casino btn-ghost px-2.5 py-1.5 text-[12px] whitespace-nowrap"
                    onClick={() => setConfirmLeave(true)}
                    disabled={!!driver.busy}
                  >
                    离座
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-[1400px] gap-5 px-3 py-4 sm:px-5 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="no-bar overflow-x-auto">
          <div className="min-w-[680px]">
            {/* --------------------------------------------------- 毡桌 */}
            <div className="relative mx-auto aspect-[1.9/1] w-full max-w-[1020px] select-none">
              <div className="rail absolute inset-0 rounded-[50%] p-[3.1%]">
                <div className="felt relative h-full w-full rounded-[50%]">
                  {/* HUD */}
                  {game && (
                    <>
                      <div className="absolute top-[13%] left-[13%] flex flex-col items-start gap-1.5">
                        <Badge tone="brand">
                          {phaseName(game.phase)}
                          {game.phase !== 0 && game.street > 0 ? ` · 第 ${game.street} 街` : ""}
                        </Badge>
                        <Badge tone="plain">手 #{game.handId.toString()}</Badge>
                      </div>
                      <div className="absolute top-[13%] right-[13%] flex flex-col items-end gap-1.5">
                        <Badge tone="grad">
                          <Dot kind={game.vrfState >= 3 ? "live" : "idle"} />
                          {game.vrfState >= 3 ? "VRF 已揭示" : `VRF ${["待命", "已请求", "等待中", "已就绪"][game.vrfState] ?? ""}`}
                        </Badge>
                        <Badge tone="plain">
                          {game.seats.filter((s) => s.status === 1).length} 人在座
                        </Badge>
                      </div>
                    </>
                  )}

                  {/* 桌心 */}
                  {game && (
                    <div className="absolute top-[44%] left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2.5">
                      <div className="flex items-center gap-3">
                        <span className="holo px-3 py-1 text-[12px] font-bold tracking-wide">
                          底池 POT
                        </span>
                        <span className="font-display text-[22px] font-bold text-white drop-shadow-[0_2px_4px_rgba(0,0,0,.7)]">
                          {fmtUsdc(game.pot)}
                        </span>
                        <ChipStack count={2} color="cyan" size={24} />
                      </div>
                      <div className="flex gap-1.5">
                        {Array.from({ length: 5 }).map((_, i) => {
                          const c = i < game.boardLen ? cardParts(game.board[i]) : null;
                          return c ? (
                            <PlayingCard
                              key={i}
                              rank={c.rank}
                              suit={c.suit}
                              w={62}
                              className="animate-card-deal"
                              style={{ animationDelay: `${i * 80}ms` }}
                            />
                          ) : (
                            <PlayingCard key={i} empty w={62} className="opacity-70" />
                          );
                        })}
                      </div>
                      {myTurn && timeLeft !== null && (
                        <Badge tone="mint">
                          <Dot kind="live" /> 轮到我了 · 剩 {timeLeft}s
                        </Badge>
                      )}
                    </div>
                  )}

                  {/* 庄家按钮 */}
                  {game && game.seats[game.button]?.status !== 0 && (
                    <span
                      className="holo absolute grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center text-[12px] font-bold"
                      style={(() => {
                        const p = seatPos(game.button, mySeat);
                        return {
                          left: `${p.x + (50 - p.x) * 0.3}%`,
                          top: `${p.y + (50 - p.y) * 0.3}%`,
                        };
                      })()}
                    >
                      D
                    </span>
                  )}

                  {game &&
                    Array.from({ length: 9 }).map((_, i) => (
                      <BetChips key={`b${i}`} idx={i} game={game} mySeat={mySeat} />
                    ))}
                  {game &&
                    Array.from({ length: 9 }).map((_, i) => (
                      <SeatView
                        key={i}
                        idx={i}
                        game={game}
                        ledger={ledgers[i] ?? null}
                        mySeat={mySeat}
                        actionTimeoutS={actionTimeoutS}
                      />
                    ))}

                  {/* 我的底牌 */}
                  {mySeat !== null && !demo && (
                    <div
                      className="absolute left-1/2 top-[62%] flex -translate-x-1/2 gap-1.5"
                      style={{ transform: "translateX(-50%) rotate(-2deg)" }}
                    >
                      {myHand && myHand.handId === (game?.handId ?? -1n) ? (
                        myHand.cards.map((c, i) => {
                          const p = cardParts(c);
                          return p ? (
                            <PlayingCard
                              key={i}
                              rank={p.rank}
                              suit={p.suit}
                              w={52}
                              className="animate-card-deal shadow-[0_10px_22px_rgba(0,0,0,.6)]"
                              style={{ rotate: i ? "5deg" : "-5deg" }}
                            />
                          ) : (
                            <PlayingCard key={i} faceDown w={52} />
                          );
                        })
                      ) : (
                        <>
                          <PlayingCard faceDown w={52} />
                          <PlayingCard faceDown w={52} />
                        </>
                      )}
                      <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] whitespace-nowrap text-sol-green/90">
                        仅本机解密
                      </span>
                    </div>
                  )}
                  {demo && mySeat !== null && (
                    <div
                      className="absolute left-1/2 top-[62%] flex -translate-x-1/2 gap-1.5"
                      style={{ transform: "translateX(-50%) rotate(-2deg)" }}
                    >
                      {DEMO_HAND.cards.map((c, i) => {
                        const p = cardParts(c)!;
                        return (
                          <PlayingCard key={i} rank={p.rank} suit={p.suit} w={52} style={{ rotate: i ? "5deg" : "-5deg" }} />
                        );
                      })}
                      <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] whitespace-nowrap text-sol-green/90">
                        demo 数据
                      </span>
                    </div>
                  )}

                  {/* 桌心水印 */}
                  <span className="pointer-events-none absolute top-[22%] left-1/2 flex -translate-x-1/2 items-center gap-2.5 opacity-45">
                    <SolMark size={20} />
                    <span className="text-[11px] tracking-[0.5em] text-white/60">
                      SOLPOKER · PRIVATE
                    </span>
                  </span>
                </div>
              </div>
            </div>

            {/* --------------------------------------------------- 行动坞 */}
            <div className="panel mx-auto mt-5 flex w-full max-w-[1020px] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
              {game && (
                <span className="timer-ring" style={{ ["--p" as string]: Math.min(1, (timeLeft ?? 0) / Math.max(1, actionTimeoutS)) }}>
                  <span>{timeLeft ?? "—"}</span>
                </span>
              )}
              {demo || (tee.phase === "ok" && mySeat !== null) ? (
                myTurn ? (
                  <>
                    <div className="flex gap-2">
                      <button
                        className="btn-casino btn-danger px-5 py-2.5 text-[13px]"
                        onClick={() => driver.act("fold")}
                        disabled={!!driver.busy || demo}
                      >
                        弃牌
                      </button>
                      {toCall === 0n ? (
                        <button
                          className="btn-casino btn-glass px-5 py-2.5 text-[13px]"
                          onClick={() => driver.act("check")}
                          disabled={!!driver.busy || demo}
                        >
                          过牌
                        </button>
                      ) : (
                        <button
                          className="btn-casino btn-mint px-5 py-2.5 text-[13px]"
                          onClick={() => driver.act("call")}
                          disabled={!!driver.busy || demo}
                        >
                          跟注 {fmtUsdc(toCall)}
                        </button>
                      )}
                    </div>
                    <div className="min-w-[300px] flex-1">
                      <div className="mb-1.5 flex items-baseline justify-between">
                        <span className="text-[11px] text-mist-faint">
                          {game.currentBet > 0n ? "加注到" : "下注"}{" "}
                          <span className="font-mono text-accent-200">
                            {raiseTo || fmtUsdc(minRaiseTo)}
                          </span>{" "}
                          tUSDC
                        </span>
                        <span className="font-mono text-[10.5px] text-mist-faint">
                          最小 {fmtUsdc(minRaiseTo)} · 你的筹码 {fmtUsdc(maxRaiseTo)}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={Number(minRaiseTo) / 1e6}
                        max={Number(maxRaiseTo) / 1e6}
                        step={0.01}
                        value={raiseTo === "" ? Number(minRaiseTo) / 1e6 : Number(raiseTo)}
                        onChange={(e) => setRaiseTo(e.target.value)}
                        className="h-1.5 w-full cursor-pointer accent-sol-purple"
                      />
                      <div className="mt-2 flex items-center gap-1.5">
                        <button
                          className="btn-casino btn-ghost px-2.5 py-1 !text-[11px]"
                          onClick={() => setRaiseTo((Number(minRaiseTo) / 1e6).toFixed(2))}
                        >
                          最小
                        </button>
                        {[
                          { label: "½ 底池", f: 0.5 },
                          { label: "¾ 底池", f: 0.75 },
                          { label: "底池", f: 1 },
                        ].map((x) => (
                          <button
                            key={x.label}
                            className="btn-casino btn-ghost px-2.5 py-1 !text-[11px]"
                            onClick={() => {
                              const potRaise = (game.pot + toCall) * BigInt(Math.round(x.f * 100)) / 100n;
                              const target = game.currentBet + (potRaise > game.lastFullRaise ? potRaise : game.lastFullRaise);
                              const clamped = target > maxRaiseTo ? maxRaiseTo : target;
                              setRaiseTo((Number(clamped) / 1e6).toFixed(2));
                            }}
                          >
                            {x.label}
                          </button>
                        ))}
                        <button
                          className="btn-casino btn-ghost px-2.5 py-1 !text-[11px]"
                          onClick={() => setRaiseTo((Number(maxRaiseTo) / 1e6).toFixed(2))}
                        >
                          全下
                        </button>
                      </div>
                    </div>
                    <button
                      className="btn-casino btn-brand px-6 py-3 text-[14px]"
                      disabled={!!driver.busy || effectiveRaiseBase === null || demo}
                      onClick={() =>
                        effectiveRaiseBase !== null &&
                        driver.act(game.currentBet > 0n ? "raiseTo" : "bet", effectiveRaiseBase)
                      }
                    >
                      确认{effectiveRaiseBase !== null ? ` ${fmtUsdc(effectiveRaiseBase)}` : ""}
                    </button>
                  </>
                ) : (
                  <span className="text-[12.5px] text-mist-dim">
                    {mySeat === null || !game
                      ? "你还没入座 —— 在右侧选择空座并入座"
                      : game.phase === 3 || game.phase === 5
                        ? `等待座位 ${game.toAct} 行动…`
                        : game.phase === 0
                          ? "本手结束，等待 crank 开下一手…"
                          : `阶段「${phaseName(game.phase)}」推进中（crank 自动）…`}
                  </span>
                )
              ) : (
                <span className="text-[12.5px] text-mist-dim">
                  {ctx.me
                    ? "点右上「连接 TEE」后即可行动（读 ER 私有状态需要 TEE token）"
                    : "连接钱包后即可入座"}
                </span>
              )}
            </div>

            {notice && (
              <p className="mx-auto mt-3 max-w-[1020px] text-[12px] leading-relaxed text-mist-2">
                {notice}
              </p>
            )}
            {driver.error && (
              <p className="mx-auto mt-2 max-w-[1020px] text-[12px] leading-relaxed text-loss">
                {driver.error}
              </p>
            )}
            {tee.phase === "error" && (
              <p className="mx-auto mt-2 max-w-[1020px] text-[12px] text-loss">
                TEE 连接失败：{tee.message}
              </p>
            )}
          </div>
        </div>

        {/* --------------------------------------------------------- 侧栏 */}
        <aside className="space-y-4">
          <section className="panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="title-cn text-[13px] text-mist">我的手牌</span>
              <Badge tone="mint">仅本机可见</Badge>
            </div>
            <div className="flex items-center gap-3">
              {myHand && game && myHand.handId === game.handId && !demo ? (
                myHand.cards.map((c, i) => {
                  const p = cardParts(c);
                  return p ? (
                    <PlayingCard key={i} rank={p.rank} suit={p.suit} w={64} />
                  ) : (
                    <PlayingCard key={i} faceDown w={64} />
                  );
                })
              ) : demo ? (
                DEMO_HAND.cards.map((c, i) => {
                  const p = cardParts(c)!;
                  return <PlayingCard key={i} rank={p.rank} suit={p.suit} w={64} />;
                })
              ) : (
                <>
                  <PlayingCard faceDown w={64} />
                  <PlayingCard faceDown w={64} />
                </>
              )}
              <div className="text-[12px] leading-relaxed text-mist-dim">
                {mySeat === null ? (
                  <span className="text-mist-faint">未入座</span>
                ) : myHand && game && myHand.handId === game.handId ? (
                  <span className="text-accent-200">已解密</span>
                ) : (
                  <span className="text-mist-faint">等发牌…</span>
                )}
              </div>
            </div>
          </section>

          {game && (
            <section className="panel p-4">
              <SectionTitle zh="本手信息" en="Hand info" />
              <KV k="手牌编号" mono>
                #{game.handId.toString()}
              </KV>
              <KV k="阶段">{phaseName(game.phase)}</KV>
              <KV k="盲注 / 前注">
                <span className="font-mono">{info?.blindsText ?? "…"}</span>
              </KV>
              <KV k="底池" mono>
                {fmtUsdc(game.pot)} tUSDC
              </KV>
              {mySeat !== null && (
                <>
                  <KV k="我的投入" mono>
                    {fmtUsdc(game.seats[mySeat].inHand)} tUSDC
                  </KV>
                  <KV k="我的位置">
                    {game.button === mySeat ? "BTN（按钮）" : `座位 ${mySeat}`}
                  </KV>
                </>
              )}
              <KV k="行动剩余">
                <span className="text-accent-200">
                  {timeLeft === null ? "—" : `${timeLeft}s / ${actionTimeoutS}s`}
                </span>
              </KV>
            </section>
          )}

          {game && mySeat !== null && (
            <section className="panel p-4">
              <SectionTitle zh="发牌证明" en="Provably fair" />
              <KV k="事件链" mono>
                {Buffer.from(game.transcript.slice(0, 4)).toString("hex")}…
              </KV>
              <KV k="VRF">
                {["待命", "已请求", "等待中", "已就绪"][game.vrfState] ?? game.vrfState}
              </KV>
              <KV k="盐 提交 / 揭示">
                <span className={game.seats[mySeat].saltCommit.some((b) => b) ? "text-win" : "text-mist-faint"}>
                  {game.seats[mySeat].saltCommit.some((b) => b) ? "✓ 已提交" : "— 未提交"}
                </span>{" "}
                ·{" "}
                <span className={myHand && myHand.saltHandId === game.handId ? "text-win" : "text-mist-faint"}>
                  {myHand && myHand.saltHandId === game.handId ? "✓ 已揭示" : "— 未揭示"}
                </span>
              </KV>
              <Link
                href={`/history?table=${tableId}`}
                className="mt-3 block rounded-lg border border-accent-500/35 py-2 text-center text-[12px] text-accent-200 hover:bg-accent-500/10"
              >
                在验证器中打开 →
              </Link>
            </section>
          )}

          {/* 入座面板 */}
          {ctx.me && mySeat === null && game && !demo && (
            <section className="panel p-4">
              <SectionTitle zh="入座" en="Take a seat" />
              <div className="mb-2 flex flex-wrap gap-1.5">
                {emptySeats.map((i) => (
                  <button
                    key={i}
                    onClick={() => setSeatPick(i)}
                    className={`rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${
                      seatPick === i
                        ? "border-accent-400 bg-accent-500/20 text-accent-200"
                        : "border-mist/15 text-mist-dim hover:border-accent-500/45"
                    }`}
                  >
                    座 {i}
                  </button>
                ))}
                {emptySeats.length === 0 && (
                  <span className="text-[12px] text-mist-faint">没有空座</span>
                )}
              </div>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[12px] text-mist-dim">买入</span>
                <input
                  value={buyIn}
                  onChange={(e) => setBuyIn(e.target.value)}
                  className="w-24 rounded-md border border-accent-500/30 bg-black/40 px-2 py-1.5 text-right font-mono text-[12px] text-accent-200 outline-none"
                />
                <span className="text-[11px] text-mist-faint">
                  tUSDC（{info ? `${fmtUsdc(BigInt(info.minBuyBb) * info.bb)}–${fmtUsdc(BigInt(info.maxBuyBb) * info.bb)}` : "…"}）
                </span>
              </div>
              {kind === 2 && (
                <label className="mb-3 flex items-start gap-2 rounded-lg border border-accent-500/25 bg-accent-500/8 p-2.5 text-[11.5px] text-mist-dim">
                  <input
                    type="checkbox"
                    checked={mixedOk}
                    onChange={(e) => setMixedOk(e.target.checked)}
                    className="mt-0.5 accent-sol-purple"
                  />
                  <span>
                    混合桌确认：本桌可能有 AI 对手；同一主人的 agent 不会与我同桌（§2.3），座位不固定。
                  </span>
                </label>
              )}
              <button
                className="btn-casino btn-brand w-full py-2.5 text-[13px]"
                onClick={sitDown}
                disabled={
                  sitBusy ||
                  seatPick === null ||
                  buyInAmount === null ||
                  (kind === 2 && !mixedOk)
                }
              >
                {sitBusy ? "签名并发送…" : seatPick === null ? "先选一个座位" : `入座 · 座 ${seatPick}`}
              </button>
              <p className="mt-2 text-[11px] leading-relaxed text-mist-faint">
                一笔签名完成：建 ATA（如需）+ 预充 session key + 买入。此后对局动作由 session key
                自动签名，不再弹窗。
              </p>
            </section>
          )}

          {/* 行动记录 */}
          <section className="panel flex max-h-[420px] flex-col p-4">
            <SectionTitle zh="行动记录" en="Action feed" />
            <div className="scroll-thin -mr-2 space-y-1.5 overflow-y-auto pr-2">
              {[...feed].reverse().map((f, i) => (
                <div key={i} className="flex items-baseline gap-2 text-[11.5px] leading-relaxed">
                  <span className="font-mono text-[10px] text-mist-faint">{f.t}</span>
                  <span className="shrink-0 text-mist-faint">{f.who}</span>
                  <span
                    className={
                      f.tone === "gold"
                        ? "text-accent-200"
                        : f.tone === "red"
                          ? "text-loss"
                          : f.tone === "mint"
                            ? "text-win"
                            : f.tone === "brand"
                              ? "text-sol-purple"
                              : "text-mist-dim"
                    }
                  >
                    {f.what}
                  </span>
                </div>
              ))}
              {feed.length === 0 && (
                <span className="text-[11.5px] text-mist-faint">等待牌桌数据…</span>
              )}
            </div>
          </section>

          {meLedger && (
            <section className="panel p-4">
              <SectionTitle zh="我的账本" en="My ledger" />
              <KV k="累计入座" mono>
                {fmtUsdc(meLedger.depositedTotal)} tUSDC
              </KV>
              <KV k="累计兑现" mono>
                {fmtUsdc(meLedger.paidTotal)} tUSDC
              </KV>
              <KV k="收益地址" mono>
                {meLedger.payout ? `${meLedger.payout.toBase58().slice(0, 6)}…` : "—"}
              </KV>
            </section>
          )}
        </aside>
      </div>

      {/* ------------------------------------------------------ 离座确认（E3） */}
      {confirmLeave && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4">
          <div className="panel w-full max-w-[420px] p-5">
            <div className="mb-3 flex items-center gap-2">
              <Badge tone="danger">E3 · 手牌进行中</Badge>
            </div>
            <h4 className="title-cn mb-2 text-[15px] text-mist">确认离座？</h4>
            <p className="text-[12px] leading-relaxed text-mist-dim">
              手牌进行中离座将<span className="text-loss">立即弃牌</span>。
              本手结束后，你的全部筹码将自动兑现到钱包（也可随时点「兑现」直接取回）。
            </p>
            <div className="mt-4 flex gap-2">
              <button
                className="btn-casino btn-danger flex-1 py-2.5 text-[13px]"
                onClick={async () => {
                  setConfirmLeave(false);
                  await driver.standUp();
                }}
                disabled={!!driver.busy}
              >
                弃牌并离座
              </button>
              <button
                className="btn-casino btn-glass px-4 py-2.5 text-[12px]"
                onClick={() => setConfirmLeave(false)}
              >
                继续打
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------- 页脚 */}
      <footer className="hairline mt-8 flex flex-wrap items-center justify-between gap-3 px-3 py-6 text-[11px] text-mist-faint sm:px-5">
        <span>
          桌 <span className="font-mono">#{tableId}</span> · program{" "}
          <span className="font-mono">
            {pdas.table.toBase58().slice(0, 6)}…
          </span>{" "}
          · 数据：{tee.phase === "ok" ? "ER 实时（已授权）" : source === "er" ? "ER 实时（公开）" : "L1 快照"}
        </span>
        <span className="flex items-center gap-4">
          <Link href="/trust" className="hover:text-mist-dim">
            信任与验证
          </Link>
          <Link href="/history" className="hover:text-mist-dim">
            手牌验证器
          </Link>
        </span>
      </footer>
    </div>
  );
}
