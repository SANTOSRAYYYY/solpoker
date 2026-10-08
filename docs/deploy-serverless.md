# Serverless 部署前检查（2026-10-08 实测）

目标平台：Vercel（Next.js 15 原生支持）。本文是 **当前代码状态** 下的检查结论与改动清单。

## ✅ 已就绪（实测）

| 检查项 | 结论 |
|---|---|
| 生产构建 | `npm run build` **通过**（唯一警告：Privy 可选依赖 `@farcaster/mini-app-solana` 缺失，无害） |
| 生产模式运行 | `next start -p 3101` 实测：`/`、`/lobby`、`/docs`、`/faucet` 均 200；`/api/l1-audit?table=22` 返回真实 `helius-parsed` 数据；`/api/faucet` 地址校验正常 |
| 敏感文件 | `web/.env.local`、`keys/` 均被 gitignore ✓，工作区无未跟踪密钥 ✓ |
| 路由运行时 | 两个 API 路由都声明 `runtime = "nodejs"`（不用 Edge）✓ |
| 静态/动态划分 | 落地页/信任页/文档/水龙头为静态（○），API 与对局页为按需（ƒ）—— Vercel 上恰好省钱 |
| 无硬编码本地地址 | 代码里没有 `127.0.0.1`；本地地址只在 `NEXT_PUBLIC_SSE_URL` 环境变量里（见下） |
| Node 兼容 | 未设 `engines`，Vercel 默认 Node 22；本机 Node 24 开发通过（bigint-buffer 退化为纯 JS，无害） |

## ⚠️ 上线前必须改（阻塞项）

1. **`NEXT_PUBLIC_L1_RPC` 带密钥**（当前值形如 `https://emylee-…-fast-devnet.helius-rpc.com`，
   **主机名本身就是 Helius 专用节点的密钥**）→ 会随浏览器 bundle 公开 ✗✗。
   - 修：Helius 控制台为该账号创建 **Secure / 域名白名单 URL**（只允许部署域名），用它当 `NEXT_PUBLIC_L1_RPC`；
     或临时换公共端点 `https://api.devnet.solana.com`（有速率限制，仅演示够用）。
   - **并轮换当前 key**（已可能外泄）。
2. **`NEXT_PUBLIC_SSE_URL=http://127.0.0.1:8787/…`** → 生产必须**置空**（前端自动回退 8s 轮询 ✓），
   或把 SSE 中继托管到有状态主机后再配公网地址。
3. **水龙头读本地私钥文件**（`web/app/api/faucet/route.ts` 读 `../keys/deployer.json`）→ serverless 上没有这个文件 ✗。
   - 修：改为从 `SOLPOKER_DEPLOYER_KEYPAIR` 环境变量读 key 材料（JSON 数组或 base58，需要小改代码——两种都支持最好）。
4. **函数超时**：水龙头现在最长轮询 45s、l1-audit 多地址抓取也可能 >10s。
   - 修：两个路由都加 `export const maxDuration = 60`（Hobby 上限）；更稳的是水龙头发送后**立即返回签名**，
     由前端轮询确认（顺带改善体验）。
5. **留在有状态主机上的组件**（不能上 serverless）：
   - **crank**（1.2s 长循环驱动 24 桌）✗、**agent runner** ✗、**x402 网关**（持 gateway 密钥）✗
   - （可选）**SSE 中继** ✗ —— 不做就靠轮询
   - Helius **webhook 接收器可以**改成 Vercel 函数（无状态 POST ✓，但需要把 webhook 地址改成公网域名）

## 📋 平台侧手动步骤（部署前）

1. **Helius**：轮换 API key；建受限/白名单 URL；`HELIUS_RPC`（服务端，`?api-key=` 形式，l1-audit 解析历史用）保持只在服务端环境变量。
2. **Privy 控制台**：把部署域名加入 allowed origins（否则登录弹窗被拒）；顺手确认 `solana_wallet_auth` / 内嵌钱包开关（老坑）。
3. **Vercel 环境变量**：
   - 公开：`NEXT_PUBLIC_PRIVY_APP_ID`、`NEXT_PUBLIC_TABLE_IDS`、`NEXT_PUBLIC_L1_RPC`（无密钥/受限版）
   - 服务端：`HELIUS_RPC`、`SOLPOKER_DEPLOYER_KEYPAIR`
   - **不要**设置 `NEXT_PUBLIC_SSE_URL`
4. **构建注意**：本机 `next dev` 与 `next build` 共用 `.next`，二者不能同时跑（本次检查即停机构建后恢复）。

## 🔎 可选优化（不阻塞）

- `/docs/[[...slug]]` 加 `generateStaticParams` 可静态化（省函数调用）。
- First Load JS 偏大（`/table/[id]` ≈ 1.09 MB，主要是 web3.js + Privy）→ 后续可按需动态导入。
- 落地页/水龙头的 OG 图与 sitemap（可选）。
