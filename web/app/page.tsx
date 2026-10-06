"use client";

import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { PRIVY_CONFIGURED } from "./providers";
import { useSolanaWallet, useSignChallenge } from "@/lib/privy-solana";
import { establishTeeSession, type TeeSession } from "@/lib/tee-auth";

// Sample tables — placeholders only, no backend yet (Stage 7 scaffold).
// Blinds are in USDC. Table IDs are sample constants per design docs.
const TIERS = [
  {
    blinds: "0.1 / 0.2 USDC",
    tables: ["T-L1-001", "T-L1-002"],
  },
  {
    blinds: "0.5 / 1 USDC",
    tables: ["T-M1-001", "T-M1-002"],
  },
  {
    blinds: "1 / 2 USDC",
    tables: ["T-H1-001"],
  },
] as const;

function LoginButton() {
  const { ready, authenticated, login, logout, user } = usePrivy();

  if (!ready) {
    return (
      <button className="btn btn-muted" disabled>
        加载中…
      </button>
    );
  }

  if (authenticated) {
    return (
      <button className="btn btn-muted" onClick={logout}>
        退出 {user?.id ? `(${user.id.slice(0, 6)}…)` : ""}
      </button>
    );
  }

  return (
    <button className="btn btn-primary" onClick={login}>
      登录
    </button>
  );
}

type TeeStatus =
  | { phase: "idle" }
  | { phase: "working"; step: string }
  | { phase: "ok"; session: TeeSession }
  | { phase: "error"; message: string };

function TeeConnect() {
  const { authenticated } = usePrivy();
  const wallet = useSolanaWallet();
  const signChallenge = useSignChallenge();
  const [status, setStatus] = useState<TeeStatus>({ phase: "idle" });

  if (!authenticated || !wallet) return null;

  const connect = async () => {
    try {
      setStatus({ phase: "working", step: "校验 TEE attestation…" });
      // establishTeeSession does both steps; surface progress via status text.
      const session = await establishTeeSession(wallet.address, (bytes) =>
        signChallenge(wallet, bytes)
      );
      setStatus({ phase: "ok", session });
    } catch (e) {
      setStatus({
        phase: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <section className="tee-panel">
      <p className="muted">
        钱包 <code>{wallet.address.slice(0, 4)}…{wallet.address.slice(-4)}</code>
      </p>
      {status.phase === "idle" && (
        <button className="btn btn-positive" onClick={connect}>
          连接 TEE（校验 + 鉴权）
        </button>
      )}
      {status.phase === "working" && (
        <button className="btn btn-muted" disabled>
          {status.step}
        </button>
      )}
      {status.phase === "ok" && (
        <p className="ok-text">
          TEE 已连接（token 有效期至{" "}
          {new Date(status.session.expiresAt * 1000).toLocaleString()}）
        </p>
      )}
      {status.phase === "error" && (
        <>
          <p className="error-text">连接失败：{status.message}</p>
          <button className="btn btn-primary" onClick={connect}>
            重试
          </button>
        </>
      )}
    </section>
  );
}

export default function Home() {
  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          SolPoker <span className="brand-sub">隐私扑克</span>
        </div>
        {/* Only mount the Privy-dependent button when the app ID is set;
            otherwise render an inert placeholder so the scaffold builds. */}
        {PRIVY_CONFIGURED ? (
          <LoginButton />
        ) : (
          <button className="btn btn-muted" disabled>
            登录
          </button>
        )}
      </header>

      <main className="main">
        <h1 className="heading">牌桌列表</h1>
        <p className="muted">示例数据,后端未接入。</p>

        {PRIVY_CONFIGURED && <TeeConnect />}

        {TIERS.map((tier) => (
          <section key={tier.blinds} className="tier">
            <h2 className="tier-title">{tier.blinds}</h2>
            <ul className="table-list">
              {tier.tables.map((id) => (
                <li key={id} className="table-row">
                  <span className="table-id">{id}</span>
                  <button className="btn btn-positive" disabled>
                    加入(即将开放)
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>

      <footer className="footer">
        {/* 信任页 (trust page) placeholder — content defined in later stage */}
        <a href="/trust" className="footer-link">
          信任页
        </a>
      </footer>
    </div>
  );
}
