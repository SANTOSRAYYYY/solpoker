"use client";

// 实时更新钩子：订阅本地 Helius webhook 中继的 SSE，收到 L1 活动就触发立即刷新。
//
// 设计要点（2026-10-08）：
// - Helius 只推 **L1** 事件（入座/兑现/commit/委托/注册）——它是 L1 索引器，
//   看不到 ER（devnet-tee）上的牌局交易；牌局内状态仍由页面轮询 ER。
// - 未配置 NEXT_PUBLIC_SSE_URL 或连接失败时**自动回落轮询**，功能不受影响。
// - 返回一个自增的 tick：把它放进轮询 effect 的依赖即可"立刻重拉"。

import { useEffect, useRef, useState } from "react";

export interface LiveUpdate {
  /** 每收到一次 L1 活动就 +1（用于触发立即刷新） */
  tick: number;
  /** 连接状态（调试/展示用） */
  state: "off" | "connecting" | "live" | "error";
  /** 最近一条事件的签名（调试用） */
  lastSignature: string | null;
}

export function useLiveUpdates(): LiveUpdate {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<LiveUpdate["state"]>("off");
  const [lastSignature, setLastSignature] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // 合并窗口：L1 事件常成批到达（如批量委托），250ms 内的多条只触发一次重拉。
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SSE_URL;
    if (!url || typeof window === "undefined") {
      setState("off");
      return;
    }
    // 生产守卫：SSE 地址指向本机（127.0.0.1/localhost）而页面并非本机打开，
    // 说明本地开发配置被带到了线上 —— 直接回落轮询，不做无谓重连。
    const isLocalSse = /^https?:\/\/(127\.0\.0\.1|localhost)(?::|\/|$)/.test(url);
    const onLocalPage = /^(127\.0\.0\.1|localhost)$/.test(window.location.hostname);
    if (isLocalSse && !onLocalPage) {
      setState("off");
      return;
    }
    setState("connecting");
    const es = new EventSource(url);
    esRef.current = es;
    es.onopen = () => setState("live");
    const scheduleTick = () => {
      pendingRef.current = true;
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (pendingRef.current) {
          pendingRef.current = false;
          setTick((t) => t + 1); // 触发重拉（合并窗口内只一次）
        }
      }, 250);
    };
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as {
          type?: string;
          txs?: { signature?: string | null }[];
        };
        if (data.type === "hello") return; // 握手不算活动
        setLastSignature(data.txs?.[0]?.signature ?? null);
        scheduleTick();
      } catch {
        scheduleTick();
      }
    };
    es.onerror = () => setState("error"); // EventSource 会自动重连
    return () => {
      es.close();
      esRef.current = null;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return { tick, state, lastSignature };
}
