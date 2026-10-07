"use client";

// 直接连接浏览器里的 Solana 钱包（wallet-standard）。
//
// 为什么存在（2026-10-07）：本 Privy 应用的 `solana_wallet_auth`（SIWS）在
// 服务端关闭且无 API 可改（见 CHANGELOG），Phantom/Solflare 走 Privy 弹窗
// 一律失败。而这类钱包自带 wallet-standard 签名能力——TEE 鉴权（签一次
// challenge）与 L1 资金交易（sit_down/cash_out）根本不需要 Privy。Privy 的
// 角色收敛为「给没有钱包的用户提供内嵌钱包 + 邮箱登录」。
//
// 覆盖的钱包：任何注册 wallet-standard 且实现 solana:signMessage 的扩展
// （Phantom、Solflare、Backpack、OKX、Bitget…）。

import { getWallets } from "@wallet-standard/app";

export interface DirectWallet {
  kind: "direct";
  name: string;
  address: string;
  signMessage(bytes: Uint8Array): Promise<Uint8Array>;
  /** 返回完整签名后的交易字节（web3.js Transaction.serialize 可广播）。 */
  signTransaction(txBytes: Uint8Array): Promise<Uint8Array>;
}

interface AnyWallet {
  name: string;
  chains: readonly string[];
  features: Record<string, any>;
}

export function listInstalledSolanaWallets(): { name: string }[] {
  try {
    const wallets = getWallets().get() as unknown as AnyWallet[];
    return wallets
      .filter(
        (w) =>
          w.chains.some((c) => c.startsWith("solana:")) &&
          w.features["solana:signMessage"] &&
          // Privy 自己的钱包对象也注册在标准注册表里，排除掉（它走 Privy 弹窗）
          w.name !== "Privy"
      )
      .map((w) => ({ name: w.name }));
  } catch {
    return [];
  }
}

export async function connectDirectWallet(name?: string): Promise<DirectWallet> {
  const wallets = getWallets().get() as unknown as AnyWallet[];
  const candidates = wallets.filter(
    (w) =>
      w.chains.some((c) => c.startsWith("solana:")) &&
      w.features["solana:signMessage"] &&
      w.name !== "Privy"
  );
  if (candidates.length === 0) {
    throw new Error(
      "未检测到浏览器 Solana 钱包扩展——请安装 Phantom / Solflare / Backpack 后刷新页面"
    );
  }
  const wallet = (name && candidates.find((w) => w.name === name)) || candidates[0];

  const connect = wallet.features["standard:connect"];
  if (!connect) throw new Error(`${wallet.name} 不支持标准连接接口`);
  const { accounts } = await connect.connect();
  if (!accounts || accounts.length === 0) throw new Error(`${wallet.name} 未返回账户`);
  const account = accounts[0];

  const signMessageFeature = wallet.features["solana:signMessage"];
  const signTxFeature = wallet.features["solana:signTransaction"];

  const toBytes = (v: unknown): Uint8Array =>
    v instanceof Uint8Array ? v : new Uint8Array(v as ArrayLike<number>);

  return {
    kind: "direct",
    name: wallet.name,
    address: account.address as string,
    async signMessage(bytes: Uint8Array): Promise<Uint8Array> {
      const results = await signMessageFeature.signMessage({ account, message: bytes });
      const sig = results?.[0]?.signature;
      if (!sig) throw new Error("钱包未返回签名");
      return toBytes(sig);
    },
    async signTransaction(txBytes: Uint8Array): Promise<Uint8Array> {
      if (!signTxFeature) throw new Error(`${wallet.name} 不支持签名交易`);
      const results = await signTxFeature.signTransaction({
        account,
        transaction: txBytes,
        chain: "solana:devnet",
      });
      const signed = results?.[0]?.signedTransaction;
      if (!signed) throw new Error("钱包未返回签名交易");
      const out = toBytes(signed);
      if (out.length < 100) {
        // 部分钱包（sign-only 模式）只回裸签名，需要调用方自行组装交易
        throw new Error(`${wallet.name} 返回的是裸签名（sign-only 模式），暂不支持`);
      }
      return out;
    },
  };
}
