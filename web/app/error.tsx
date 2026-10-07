"use client";

// Next.js 段错误边界：生产构建里任何渲染期异常都在这里显示真实错误信息
// （默认的 "Application error: a client-side exception" 对调试毫无帮助——
// 2026-10-07 用户实测遇到后只能靠猜）。

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("SolPoker page error:", error);
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
        </div>
        <p className="muted">
          如果反复出现，请把上面这行错误信息发给开发（浏览器控制台有完整堆栈）。
        </p>
      </main>
    </div>
  );
}
