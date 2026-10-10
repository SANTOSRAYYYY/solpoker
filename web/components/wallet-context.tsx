"use client";

// 全局钱包上下文（真实页面用）：Privy 登录态 + Solana 钱包选择 + L1 余额轮询。
// 单通道：只走 Privy（2026-10-07 用户决定移除直连钱包路径）。
// TEE 会话不在这里——它属于对局页（只有需要读 ER 私有状态时才建立）。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { usePrivy } from "@privy-io/react-auth";
import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";
import { L1_RPC, TUSDC_MINT } from "@/lib/config";
import { PRIVY_CONFIGURED } from "@/app/providers";
import { useWalletOptions, defaultWalletAddress } from "@/lib/privy-solana";

export interface WalletCtx {
  privyConfigured: boolean;
  ready: boolean;
  authenticated: boolean;
  login: () => void;
  logout: () => void;
  /** 可选 Solana 钱包（内嵌 / 外部扩展） */
  options: ReturnType<typeof useWalletOptions>;
  address: string | null;
  wallet: ConnectedStandardSolanaWallet | null;
  me: PublicKey | null;
  pick: (address: string) => void;
  solBal: number | null;
  usdcBal: number | null;
  l1: Connection;
}

const Ctx = createContext<WalletCtx | null>(null);

export function useWalletCtx(): WalletCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWalletCtx 必须在 <WalletProvider> 内使用");
  return c;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const options = useWalletOptions();
  const l1 = useMemo(() => new Connection(L1_RPC, "confirmed"), []);

  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    if (address && options.some((o) => o.address === address)) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("solpoker:wallet");
    } catch {
      /* ignore */
    }
    const valid = saved && options.some((o) => o.address === saved);
    setAddress(valid ? saved : defaultWalletAddress(options));
  }, [options, address]);

  const pick = useCallback((addr: string) => {
    setAddress(addr);
    try {
      localStorage.setItem("solpoker:wallet", addr);
    } catch {
      /* ignore */
    }
  }, []);

  // 半登录态自动恢复（2026-10-10）：Privy 会话在、但钱包列表持续为空超过 2 秒 →
  // 自动重跑一次连接流程（外部钱包扩展在页面重开后不总能静默挂回会话，此时
  // ctx.me 为空、大部分功能不可用）。刻意只自动尝试一次：呈现给用户的是
  // Privy 的连接弹窗；曾成功挂上过则复位，下次断连还能再自动恢复一次；
  // 仍失败就交给手动的「重新连接钱包」按钮。
  const autoTried = useRef(false);
  const optionsLen = options.length;
  useEffect(() => {
    if (!ready) return;
    if (optionsLen > 0) {
      autoTried.current = false;
      return;
    }
    if (!authenticated || autoTried.current) return;
    const h = window.setTimeout(() => {
      autoTried.current = true;
      try {
        login();
      } catch {
        /* ignore */
      }
    }, 2000);
    return () => window.clearTimeout(h);
  }, [ready, authenticated, optionsLen, login]);

  const wallet = useMemo(
    () => options.find((o) => o.address === address)?.wallet ?? null,
    [options, address]
  );
  const me = useMemo(
    () => (address ? new PublicKey(address) : null),
    [address]
  );

  const [solBal, setSolBal] = useState<number | null>(null);
  const [usdcBal, setUsdcBal] = useState<number | null>(null);
  useEffect(() => {
    if (!me) {
      setSolBal(null);
      setUsdcBal(null);
      return;
    }
    let stop = false;
    (async () => {
      for (;;) {
        if (stop) return;
        try {
          setSolBal((await l1.getBalance(me)) / 1e9);
          const ata = getAssociatedTokenAddressSync(TUSDC_MINT, me);
          const acc = await l1.getTokenAccountBalance(ata).catch(() => null);
          setUsdcBal(acc?.value.uiAmount ?? 0);
        } catch {
          /* 下一轮重试 */
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    })();
    return () => {
      stop = true;
    };
  }, [me, l1]);

  const value: WalletCtx = {
    privyConfigured: PRIVY_CONFIGURED,
    ready,
    authenticated,
    login,
    logout,
    options,
    address,
    wallet,
    me,
    pick,
    solBal,
    usdcBal,
    l1,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
