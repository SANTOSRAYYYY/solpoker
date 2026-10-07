"use client";

/* 视觉稿共享组件：Solana 品牌标记、筹码、扑克牌、徽章、小部件。
   拟物结构收在 mock.css 的 .chip / .pcard / .holo 等基元里。 */

import type { CSSProperties, ReactNode } from "react";

/* ---------------------------------------------------------------- 品牌 */
/** 官方 Solana Logomark（三斜杠，品牌渐变），取自 Solana Brand Assets。 */
export function SolMark({
  size = 26,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size * 0.897}
      viewBox="0 0 313 281"
      fill="none"
      className={className}
      aria-label="Solana"
      role="img"
    >
      <path
        d="M311.318 221.057L259.66 276.558C258.537 277.764 257.178 278.725 255.669 279.382C254.159 280.039 252.53 280.378 250.884 280.377H5.99719C4.8287 280.377 3.68568 280.035 2.70855 279.393C1.73143 278.751 0.962771 277.837 0.49702 276.764C0.0312691 275.69 -0.111286 274.504 0.0868712 273.35C0.285028 272.196 0.815265 271.126 1.61243 270.27L53.3099 214.769C54.4299 213.566 55.7843 212.607 57.2893 211.95C58.7943 211.293 60.4178 210.953 62.0595 210.95H306.933C308.101 210.95 309.244 211.292 310.221 211.934C311.199 212.576 311.967 213.49 312.433 214.564C312.899 215.637 313.041 216.824 312.843 217.977C312.645 219.131 312.115 220.201 311.318 221.057ZM259.66 109.294C258.537 108.088 257.178 107.127 255.669 106.47C254.159 105.813 252.53 105.474 250.884 105.475H5.99719C4.8287 105.475 3.68568 105.817 2.70855 106.459C1.73143 107.101 0.962771 108.015 0.49702 109.088C0.0312691 110.162 -0.111286 111.348 0.0868712 112.502C0.285028 113.656 0.815265 114.726 1.61243 115.582L53.3099 171.083C54.4299 172.286 55.7843 173.245 57.2893 173.902C58.7943 174.559 60.4178 174.899 62.0595 174.902H306.933C308.101 174.902 309.244 174.56 310.221 173.918C311.199 173.276 311.967 172.362 312.433 171.288C312.899 170.215 313.041 169.028 312.843 167.875C312.645 166.721 312.115 165.651 311.318 164.795L259.66 109.294ZM5.99719 69.4267H250.884C252.53 69.4275 254.159 69.089 255.669 68.432C257.178 67.7751 258.537 66.8139 259.66 65.6082L311.318 10.1069C312.115 9.25107 312.645 8.18056 312.843 7.02695C313.041 5.87334 312.899 4.68686 312.433 3.6133C311.967 2.53974 311.199 1.62586 310.221 0.983941C309.244 0.342026 308.101 3.95314e-05 306.933 0L62.0595 0C60.4178 0.00279866 58.7943 0.34314 57.2893 0.999953C55.7843 1.65677 54.4299 2.61607 53.3099 3.81847L1.62576 59.3197C0.829361 60.1748 0.299359 61.244 0.100752 62.3964C-0.0978539 63.5488 0.0435698 64.7342 0.507679 65.8073C0.971789 66.8803 1.73841 67.7943 2.71352 68.4372C3.68863 69.0802 4.82984 69.424 5.99719 69.4267Z"
        fill="url(#sp_sol_grad)"
      />
      <defs>
        <linearGradient
          id="sp_sol_grad"
          x1="26.415"
          y1="287.059"
          x2="283.735"
          y2="-2.49574"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.08" stopColor="#9945FF" />
          <stop offset="0.3" stopColor="#8752F3" />
          <stop offset="0.5" stopColor="#5497D5" />
          <stop offset="0.6" stopColor="#43B4CA" />
          <stop offset="0.72" stopColor="#28E0B9" />
          <stop offset="0.97" stopColor="#19FB9B" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/* ---------------------------------------------------------------- 筹码 */
export type ChipColor = "white" | "purple" | "green" | "cyan" | "black";

const CHIP_COLORS: Record<ChipColor, string> = {
  white: "chip-white",
  purple: "chip-purple",
  green: "chip-green",
  cyan: "chip-cyan",
  black: "chip-black",
};

export function Chip({
  v,
  color = "purple",
  size = 40,
  className = "",
  style,
}: {
  v?: ReactNode;
  color?: ChipColor;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`chip ${CHIP_COLORS[color]} ${className}`}
      style={{ ["--chip-size" as string]: `${size}px`, ...style }}
    >
      {v !== undefined && <span className="chip-v">{v}</span>}
    </span>
  );
}

/** 筹码柱：把 n 枚筹码向上错位叠放，用于底池/下注额的可视化。 */
export function ChipStack({
  count = 3,
  color = "purple",
  size = 34,
  v,
}: {
  count?: number;
  color?: ChipColor;
  size?: number;
  v?: ReactNode;
}) {
  const step = Math.max(4, Math.round(size * 0.16));
  return (
    <span
      className="relative inline-block"
      style={{ width: size, height: size + (count - 1) * step }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <Chip
          key={i}
          color={i === count - 1 ? color : i % 2 ? "white" : color}
          size={size}
          v={i === count - 1 ? v : undefined}
          style={{ position: "absolute", bottom: i * step, left: 0 }}
        />
      ))}
    </span>
  );
}

/* ---------------------------------------------------------------- 扑克牌 */
export type Suit = "♠" | "♥" | "♦" | "♣";

export function PlayingCard({
  rank,
  suit,
  w = 56,
  faceDown = false,
  dim = false,
  empty = false,
  className = "",
  style,
}: {
  rank?: string;
  suit?: Suit;
  w?: number;
  faceDown?: boolean;
  dim?: boolean;
  empty?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const styleWithW = { ["--pc-w" as string]: `${w}px`, ...style };
  if (empty) {
    return (
      <span className={`pcard-slot block ${className}`} style={styleWithW} />
    );
  }
  if (faceDown) {
    return (
      <span
        className={`pcard pcard-back block ${className}`}
        style={styleWithW}
      />
    );
  }
  const red = suit === "♥" || suit === "♦";
  return (
    <span
      className={`pcard block ${red ? "red" : ""} ${dim ? "opacity-45 saturate-50" : ""} ${className}`}
      style={styleWithW}
    >
      <span className="pc-r">{rank}</span>
      <span className="pc-s">{suit}</span>
      <span className="pc-pip">{suit}</span>
      <span className="pc-r2">
        {rank}
        {suit}
      </span>
    </span>
  );
}

export function Dot({
  kind = "live",
  className = "",
}: {
  kind?: "live" | "idle" | "warn" | "dead";
  className?: string;
}) {
  return <span className={`dot dot-${kind} ${className}`} />;
}

export function Badge({
  tone = "plain",
  children,
  className = "",
}: {
  tone?: "brand" | "mint" | "danger" | "cyan" | "lime" | "grad" | "plain";
  children: ReactNode;
  className?: string;
}) {
  return <span className={`badge badge-${tone} ${className}`}>{children}</span>;
}

/* ---------------------------------------------------------------- 排版 */
/** 中英混排小节标题：中文为主 + 大写拉丁副标。 */
export function SectionTitle({
  zh,
  en,
  right,
}: {
  zh: string;
  en: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="title-cn text-[17px] text-mist">{zh}</h2>
        <div className="mt-0.5 text-[10px] tracking-[0.32em] text-accent-400/80 uppercase">
          {en}
        </div>
      </div>
      {right}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  en,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  en?: string;
}) {
  return (
    <div className="holo min-w-[104px] !rounded-2xl px-5 py-2 text-center">
      <div className="text-[10px] font-semibold tracking-[0.2em] text-mist-dim uppercase">
        {en ?? label}
      </div>
      <div className="text-brand text-[20px] leading-tight font-extrabold">
        {value}
      </div>
      {sub && <div className="text-[10px] text-mist-faint">{sub}</div>}
    </div>
  );
}

/** 迷你柱状图（P&L / 胜率走势），纯 CSS。 */
export function Sparkbars({
  data,
  className = "",
}: {
  data: number[];
  className?: string;
}) {
  const max = Math.max(...data.map(Math.abs), 1);
  return (
    <span className={`inline-flex h-8 items-end gap-[3px] ${className}`}>
      {data.map((d, i) => (
        <span
          key={i}
          className="w-[5px] rounded-sm"
          style={{
            height: `${Math.max(12, (Math.abs(d) / max) * 100)}%`,
            background:
              d >= 0
                ? "linear-gradient(180deg,#19fb9b,#0cbf74)"
                : "linear-gradient(180deg,#ff7a52,#c93a17)",
            opacity: 0.9,
          }}
        />
      ))}
    </span>
  );
}

/** 键值行（地址、哈希等） */
export function KV({
  k,
  children,
  mono = false,
}: {
  k: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="shrink-0 text-[11px] tracking-wide text-mist-faint">
        {k}
      </span>
      <span
        className={`text-right text-[12px] break-all text-mist-2 ${mono ? "font-mono" : ""}`}
      >
        {children}
      </span>
    </div>
  );
}
