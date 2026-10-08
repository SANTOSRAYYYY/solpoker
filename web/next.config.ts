import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
