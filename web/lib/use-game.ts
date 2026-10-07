"use client";

// The game driver hook: polls Game + own PlayerHand + SeatLedger, derives the
// player's seat, and auto-plays the salt commit/reveal protocol with the
// session key. Polling instead of websockets: the dev network path relays
// HTTP only (no WS) — documented deviation from design §13 step 5.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";
import {
  decodeGame,
  decodePlayerHand,
  type GameView,
  type HandView,
  isZero32,
} from "./game-state";
import {
  ER_RPC,
  L1_RPC,
  ER_CU,
  EPHEMERAL_VAULT,
} from "./config";
import {
  pdasFor,
  makeProgram,
  sendAndConfirm,
  ixCommitSalt,
  ixRevealSalt,
  ixAct,
  ixStandUp,
  sleep,
  type ActKind,
} from "./solpoker-client";
import { loadOrCreateSessionKey, loadOrCreateSalt, saltCommitment } from "./session-key";

export interface GameDriver {
  game: GameView | null;
  myHand: HandView | null;
  mySeat: number | null;
  sessionKey: Keypair | null;
  error: string | null;
  busy: string | null;
  act: (kind: ActKind, amount?: bigint) => Promise<void>;
  standUp: () => Promise<void>;
}

export function useGame(
  wallet: ConnectedStandardSolanaWallet | null,
  teeToken: string | null,
  tableId: number
): GameDriver {
  const [game, setGame] = useState<GameView | null>(null);
  const [myHand, setMyHand] = useState<HandView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const pdas = useMemo(() => pdasFor(tableId), [tableId]);
  const er = useMemo(
    () =>
      new Connection(teeToken ? `${ER_RPC}?token=${teeToken}` : ER_RPC, "confirmed"),
    [teeToken]
  );
  const program = useMemo(() => makeProgram(er), [er]);

  // 换桌时清空旧状态
  useEffect(() => {
    setGame(null);
    setMyHand(null);
    setError(null);
  }, [tableId]);

  const walletAddr = wallet?.address ?? null;
  const walletPk = useMemo(
    () => (walletAddr ? new PublicKey(walletAddr) : null),
    [walletAddr]
  );

  const mySeat = useMemo(() => {
    if (!game || !walletAddr) return null;
    for (let i = 0; i < game.seats.length; i++) {
      if (game.seats[i].occupant.toBase58() === walletAddr && game.seats[i].status === 1) {
        return i;
      }
    }
    return null;
  }, [game, walletAddr]);

  const sessionKey = useMemo(
    () =>
      mySeat !== null && walletAddr
        ? loadOrCreateSessionKey(tableId, mySeat, walletAddr)
        : null,
    [mySeat, walletAddr]
  );

  // ---- polling: game always; own hand when seated ----
  useEffect(() => {
    let stop = false;
    (async () => {
      for (;;) {
        if (stop) return;
        try {
          const gAcc = await er.getAccountInfo(pdas.game);
          if (gAcc) setGame(decodeGame(gAcc.data));
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
        await sleep(1500);
        if (stop) return;
      }
    })();
    return () => {
      stop = true;
    };
  }, [er]);

  useEffect(() => {
    if (mySeat === null) {
      setMyHand(null);
      return;
    }
    let stop = false;
    (async () => {
      for (;;) {
        if (stop) return;
        try {
          const hAcc = await er.getAccountInfo(pdas.hand(mySeat));
          if (hAcc) setMyHand(decodePlayerHand(hAcc.data));
        } catch {
          // PER 成员未生效或网络抖动：下一轮重试，不打断 game 轮询
        }
        await sleep(1500);
      }
    })();
    return () => {
      stop = true;
    };
  }, [er, mySeat]);

  // ---- auto salt commit/reveal ----
  const saltBusy = useRef(false);
  useEffect(() => {
    if (!game || mySeat === null || !sessionKey || !walletPk) return;
    if (saltBusy.current) return;
    const seat = game.seats[mySeat];
    const inHand = (game.handMask & (1 << mySeat)) !== 0;

    (async () => {
      // Commit: phase Commit, I'm in the hand, no commitment stored yet.
      if (game.phase === 1 && inHand && isZero32(seat.saltCommit)) {
        saltBusy.current = true;
        try {
          const salt = loadOrCreateSalt(tableId, game.handId, mySeat, walletAddr!);
          const commitment = await saltCommitment(
            pdas.table.toBytes(),
            game.handId,
            walletPk.toBytes(),
            salt
          );
          const ix = await ixCommitSalt(pdas, 
            program,
            mySeat,
            game.handId,
            commitment,
            sessionKey.publicKey
          );
          await sendAndConfirm(er, [ix], [sessionKey], "commit_salt", ER_CU);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          saltBusy.current = false;
        }
        return;
      }
      // Reveal: phase AwaitSeed, my hand's salt is not for this hand yet.
      if (
        game.phase === 2 &&
        inHand &&
        myHand &&
        myHand.saltHandId !== game.handId
      ) {
        saltBusy.current = true;
        try {
          const salt = loadOrCreateSalt(tableId, game.handId, mySeat, walletAddr!);
          const ix = await ixRevealSalt(pdas, 
            program,
            mySeat,
            game.handId,
            salt,
            sessionKey.publicKey
          );
          await sendAndConfirm(er, [ix], [sessionKey], "reveal_salt", ER_CU);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          saltBusy.current = false;
        }
      }
    })();
  }, [game, myHand, mySeat, sessionKey, walletPk, walletAddr, er, program]);

  // ---- actions ----
  // 金额解析必须安全：非数字输入得到 null 而不是 BigInt(NaN) 崩溃
  // （2026-10-07 用户实测：事件处理器里未捕获的 RangeError 会直接命中
  // Next.js 错误边界 = "Application error: a client-side exception"）。
  const act = useCallback(
    async (kind: ActKind, amount?: bigint) => {
      if (!game || mySeat === null || !sessionKey) return;
      setBusy(kind);
      setError(null);
      try {
        const ix = await ixAct(pdas, 
          program,
          mySeat,
          game.handId,
          game.actionSeq,
          kind,
          amount ?? null,
          sessionKey.publicKey
        );
        await sendAndConfirm(er, [ix], [sessionKey], `act ${kind}`, ER_CU);
      } catch (e) {
        // 错误已经通过 setError 上屏；绝不再向外抛——事件处理器里的
        // unhandled rejection 在 Next 生产构建里会顶出整页错误边界。
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [game, mySeat, sessionKey, er, program]
  );

  const standUp = useCallback(async () => {
    if (mySeat === null || !sessionKey) return;
    setBusy("standUp");
    setError(null);
    try {
      const ix = await ixStandUp(pdas, program, mySeat, sessionKey.publicKey, {
        permission: pdas.permission(pdas.hand(mySeat)),
        commitPayer: pdas.commitPayer,
        vault: EPHEMERAL_VAULT,
      });
      await sendAndConfirm(er, [ix], [sessionKey], "stand_up", ER_CU);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [mySeat, sessionKey, er, program]);

  return { game, myHand, mySeat, sessionKey, error, busy, act, standUp };
}

export { L1_RPC };
