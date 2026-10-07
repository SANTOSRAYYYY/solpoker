"use client";

// 全局错误边界：覆盖根布局层面的异常（app/error.tsx 只管页面子树——Privy
// 签名弹窗等布局层组件崩溃时，默认只有一句毫无信息的
// "Application error: a client-side exception"，2026-10-07 用户实测）。
// 注意：global-error 会替换整个根布局，必须自己渲染 <html>/<body>。

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          background: "#0b0b10",
          color: "#e8e8e8",
          fontFamily: "system-ui, sans-serif",
          padding: "48px 24px",
          maxWidth: 720,
          margin: "0 auto",
        }}
      >
        <h1 style={{ fontSize: 22, marginBottom: 16 }}>页面出错了</h1>
        <p style={{ color: "#ff8080", whiteSpace: "pre-wrap", marginBottom: 16 }}>
          {error.message}
        </p>
        {error.digest && (
          <p style={{ color: "#888", fontSize: 13 }}>digest: {error.digest}</p>
        )}
        <button
          onClick={reset}
          style={{
            padding: "10px 18px",
            background: "#9945FF",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            fontSize: 15,
            cursor: "pointer",
            marginRight: 10,
          }}
        >
          重试
        </button>
        <button
          onClick={() => location.reload()}
          style={{
            padding: "10px 18px",
            background: "transparent",
            color: "#aaa",
            border: "1px solid #444",
            borderRadius: 8,
            fontSize: 15,
            cursor: "pointer",
          }}
        >
          刷新页面
        </button>
        <p style={{ color: "#888", fontSize: 13, marginTop: 16 }}>
          如果反复出现，请把上面这行错误信息发给开发（浏览器控制台有完整堆栈）。
        </p>
      </body>
    </html>
  );
}
