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

> **代码侧已全部完成（2026-10-08）**：第 3、4 项已改好并实测；第 2 项只剩"不设环境变量"这一件事；
> 第 1、5 项是控制台操作或部署拓扑，无代码改动。

1. **`NEXT_PUBLIC_L1_RPC` 带密钥**（当前值形如 `https://emylee-…-fast-devnet.helius-rpc.com`，
   **主机名本身就是 Helius 专用节点的密钥**）→ 会随浏览器 bundle 公开 ✗✗。
   - 修：Helius 控制台为该账号创建 **Secure / 域名白名单 URL**（只允许部署域名），用它当 `NEXT_PUBLIC_L1_RPC`；
     或临时换公共端点 `https://api.devnet.solana.com`（有速率限制，仅演示够用）。
   - **并轮换当前 key**（已可能外泄）。
2. **`NEXT_PUBLIC_SSE_URL=http://127.0.0.1:8787/…`** → 生产**不要设置**这个变量（前端自动回退 8s 轮询 ✓）；
   **已加代码守卫**：SSE 地址指向本机而页面不是本机打开时，直接回落轮询（防止本地配置被带上线）。
3. ✅ **水龙头私钥来源已支持环境变量**（`web/lib/faucet-key.ts` + 路由）：优先
   `SOLPOKER_DEPLOYER_KEYPAIR`（JSON 数组或 base58 材料），否则读本地文件（`SOLPOKER_DEPLOYER_KEYPAIR_PATH` 可覆盖）。
   已自证：两种材料都还原出同一把部署者公钥 `541kpQWN…` ✓。
4. ✅ **函数超时**：两个路由都已加 `export const maxDuration = 60`；水龙头确认等待 45s → **20s**，
   超时返回 `pending:true`（前端显示"已提交（等待链上确认）"），不再有 504 分支 ✓。
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
