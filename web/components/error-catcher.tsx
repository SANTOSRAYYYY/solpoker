"use client";

// ?debug=1 时显示一个浮动诊断面板：捕获 window 错误 / unhandledrejection /
// console.error，把消息与堆栈直接显示在页面上（dev 与生产都可用——用户报错时不必开控制台）。
// 带 ?debug=1 才渲染，默认完全无副作用。

import { useEffect, useState } from "react";

interface Entry {
  t: string;
  msg: string;
  stack: string;
}

export function ErrorCatcher() {
  const [on, setOn] = useState(false);
  const [items, setItems] = useState<Entry[]>([]);

  useEffect(() => {
    if (!/[?&]debug=1/.test(window.location.search)) return;
    setOn(true);
    const push = (msg: unknown, stack: unknown) =>
      setItems((prev) =>
        [
          ...prev.slice(-4),
          {
            t: new Date().toISOString().slice(11, 19),
            msg: String(msg),
            stack: String(stack ?? "").slice(0, 1200),
          },
        ]
      );
    const onErr = (e: ErrorEvent) => push(e.message, e.error?.stack);
    const onRej = (e: PromiseRejectionEvent) =>
      push(
        `unhandledrejection: ${e.reason?.message ?? e.reason}`,
        e.reason?.stack
      );
    // 错误边界写入的全局错误（渲染期异常不会触发 window.error）
    const timer = setInterval(() => {
      const last = (
        window as unknown as {
          __solpokerLastError?: { message: string; stack?: string; t: string };
        }
      ).__solpokerLastError;
      if (last) {
        setItems((prev) =>
          prev.some((x) => x.msg === last.message)
            ? prev
            : [
                ...prev.slice(-4),
                { t: last.t, msg: `[boundary] ${last.message}`, stack: last.stack ?? "" },
              ]
        );
      }
    }, 1500);
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      const first = args[0] as { message?: string; stack?: string } | undefined;
      push(
        args.map((a) => String((a as { message?: string })?.message ?? a)).join(" "),
        first?.stack
      );
      orig(...args);
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      clearInterval(timer);
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
      console.error = orig;
    };
  }, []);

  if (!on) return null;
  return (
    <div className="fixed right-3 bottom-3 z-[100] max-h-[46vh] w-[min(560px,92vw)] overflow-auto rounded-xl border border-loss/40 bg-black/92 p-3 font-mono text-[11px] text-mist-dim shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-loss">
          诊断面板（?debug=1）· {items.length} 条
        </span>
        <button className="text-mist-faint hover:text-mist" onClick={() => setItems([])}>
          清空
        </button>
      </div>
      {items.length === 0 && <div className="text-mist-faint">暂无错误</div>}
      {items.map((e, i) => (
        <div key={i} className="mb-2 border-b border-mist/10 pb-2 last:border-0">
          <div className="text-warn">
            [{e.t}] {e.msg}
          </div>
          {e.stack && <pre className="mt-1 whitespace-pre-wrap text-[10.5px]">{e.stack}</pre>}
        </div>
      ))}
    </div>
  );
}
