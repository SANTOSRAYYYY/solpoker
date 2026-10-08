import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    // 版本标识（2026-10-08 加）：排查"你看得到我看不到"时先比这个 —— Vercel 构建注入
    // 提交 SHA 前 7 位，本地开发显示 dev；对局页页脚会展示。
    NEXT_PUBLIC_BUILD: (process.env.VERCEL_GIT_COMMIT_SHA ?? "dev").slice(0, 7),
  },
};

export default nextConfig;
