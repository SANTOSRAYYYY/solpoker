import type { NextConfig } from "next";

// 2026-10-10（审计 L3）：安全响应头（仅生产）。CSP 采用「宽但封闭外联」：
// script 允许内联（Next hydration 需要），connect/frame 只放行 Privy、
// MagicBlock RPC、Helius、Phala PCCS 与同源 SSE；frame-ancestors 'none' 禁嵌套。
// 本地 dev 不加（React 开发模式需要 eval，加了会坏 HMR）。
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://auth.privy.io https://*.privy.io https://rpc.magicblock.app https://*.magicblock.app https://api.devnet.solana.com wss://api.devnet.solana.com https://*.helius-rpc.com https://pccs.phala.network",
  "frame-src 'self' https://auth.privy.io https://*.privy.io",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
  env: {
    // 版本标识（2026-10-08 加）：排查"你看得到我看不到"时先比这个。
    // 部署脚本会通过 --build-env NEXT_PUBLIC_BUILD=<提交号> 传入（我们的部署不带 git 集成，
    // Vercel 自己拿不到 SHA）；没传时退回 VERCEL_GIT_COMMIT_SHA，本地开发显示 dev。
    NEXT_PUBLIC_BUILD:
      process.env.NEXT_PUBLIC_BUILD ??
      (process.env.VERCEL_GIT_COMMIT_SHA ?? "dev").slice(0, 7),
  },
};

export default nextConfig;
