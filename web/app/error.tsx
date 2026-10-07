"use client";

// Next.js 段错误边界：生产构建里任何渲染期异常都在这里显示真实错误信息
// （默认的 "Application error: a client-side exception" 对调试毫无帮助——
// 2026-10-07 用户实测遇到后只能靠猜）。
// 2026-10-08：加「显示堆栈」按钮（客户端报错时用户可直接抄给开发）。

import { useEffect, useState } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [showStack, setShowStack] = useState(false);
  useEffect(() => {
    console.error("SolPoker page error:", error);
    // 给 ?debug=1 诊断面板留一份（边界会替换掉页面子树，面板靠全局变量取到堆栈）
    (
      window as unknown as {
        __solpokerLastError?: { message: string; stack?: string; t: string };
      }
    ).__solpokerLastError = {
      message: error.message,
      stack: error.stack,
      t: new Date().toISOString().slice(11, 19),
    };
  }, [error]);

  return (
    <div className="page">
      <main className="main" style={{ paddingTop: 48 }}>
        <h1 className="heading">页面出错了</h1>
        <p className="error-text" style={{ whiteSpace: "pre-wrap" }}>
          {error.message}
        </p>
        {error.digest && <p className="muted">digest: {error.digest}</p>}
        <div className="row">
          <button className="btn btn-primary" onClick={reset}>
            重试
          </button>
          <button className="btn btn-muted" onClick={() => location.reload()}>
            刷新页面
          </button>
          <button className="btn btn-muted" onClick={() => setShowStack((v) => !v)}>
            {showStack ? "隐藏堆栈" : "显示堆栈"}
          </button>
        </div>
        {showStack && (
          <pre
            className="muted"
            style={{ whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 320, overflow: "auto" }}
          >
            {error.stack ?? "(无堆栈)"}
          </pre>
        )}
        <p className="muted">
          如果反复出现，请把上面的错误信息（含堆栈）发给开发。
        </p>
      </main>
    </div>
  );
}
