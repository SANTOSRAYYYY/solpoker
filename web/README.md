# SolPoker Web (Stage 7 Scaffold)

Next.js App Router + React 19 前端脚手架。深色主题，Solana Purple `#9945FF` 主色，`#14F195` 用于正向操作，暗红用于危险操作（弃牌）。钱包层使用 **Privy**（`@privy-io/react-auth` v3）。

Bilingual 中文/English，中文默认（后续阶段接入 i18n；当前文案以中文硬编码占位）。

## 运行

```bash
cd web
npm install
npm run dev
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy 应用 ID（必填，从 Privy Dashboard 获取）。未配置时脚手架仍可构建并渲染页面框架，但钱包功能不可用（页面顶部会显示配置提示横幅）。 |

创建 `.env.local`：

```
NEXT_PUBLIC_PRIVY_APP_ID=your-privy-app-id
```

## 依赖版本（2026-10-06 核实）

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `@privy-io/react-auth` | `3.47.0` | 精确锁定；Solana hooks 全部从 `@privy-io/react-auth/solana` 子路径导入 |
| `@solana/kit` | `^3.0.3` | Privy v3 的 peer 依赖（3.47.0 起同时兼容 kit v8 的 legacy/v1 交易） |
| `@solana-program/system` / `memo` / `token` | `0.8.0` / `0.8.0` / `0.6.0` | Privy peer 依赖的精确兼容版本 |
| `next` | `15.5.9` | 15.x 最新（15.1.6 有 CVE-2025-66478） |
| `react` / `react-dom` | `19.0.0` | Privy peerDep 支持 `^18 \|\| ^19` |
| `typescript` | `5.7.3` | |

## 目录

- `app/layout.tsx` — 根布局（中文 lang，Providers 包裹）
- `app/providers.tsx` — PrivyProvider（Solana 嵌入式钱包，登录时自动创建；devnet RPC 已配）
- `app/page.tsx` — 落地页：登录按钮、三档示例牌桌（0.1/0.2、0.5/1、1/2 USDC）、页脚「信任页」占位链接
- `app/globals.css` — 深色主题 + Solana 配色 CSS 变量
- `lib/privy-solana.ts` — Privy Solana 钱包辅助函数（`useSolanaWallet` / `useSignChallenge` / `useSignL1Transaction`）

## 已核实的 Privy API（2026-10-06，对照官方文档）

- `useSignMessage()` → `signMessage({ message: Uint8Array, wallet })`：接受**任意原始字节**（不限 UTF-8），满足设计 §13 的 32 字节挑战签名；返回 `{ signature: Uint8Array }`。
- `useSignTransaction()` → `signTransaction({ transaction: Uint8Array, wallet })`：接受序列化交易 bytes，返回 `{ signedTransaction: Uint8Array }`。
- `useWallets()`（`/solana` 子路径）：同时列出嵌入式 + 外部钱包，类型 `ConnectedStandardSolanaWallet`；嵌入式钱包用 `w.standardWallet.name === 'Privy'` 识别。
- Provider 配置：`config.embeddedWallets.solana.createOnLogin: 'users-without-wallets'`（v3 起为 per-chain）；`config.solana.rpcs` 供嵌入式钱包 UI 使用。
- Next.js App Router：PrivyProvider 必须包在 `'use client'` 组件中（本项目已是）。

## 待核实（需真机/真链联调）

1. **web3.js v1 序列化往返**：Anchor 构建的 `VersionedTransaction`/`Transaction` 序列化成 bytes 传给 `signTransaction` 的兼容性——官方 SPL recipe 仍在用 v1 但示例代码有笔误，需用真实 `sit_down` 交易实测。
2. **部分签名/多 signer**：`sit_down` 若需用户之外的 signer，文档未说明，需实测（可能要先部分签名再交 Privy）。
3. **`showWalletUIs: false` 静默签名**：是否需要额外授权策略配置，文档未展开。
4. **嵌入式钱包充值 UX**：`useDepositFunds()` 支持 crypto 充值与 Stripe 法币 onramp，但**法币 onramp 仅支持 mainnet，不支持 devnet**；devnet 测试需外部直接转账。
5. **sign-only 外部钱包兜底**：个别钱包（如 Fireblocks 经 WalletConnect）返回裸 64 字节签名而非完整交易，`useSignL1Transaction` 的返回长度需判别。

## 后续阶段

- 测试（Stage 7 后期补充）
- i18n 正式接入（中/英切换）
- 后端接入后替换示例牌桌数据
- 信任页内容（设计 §16）
