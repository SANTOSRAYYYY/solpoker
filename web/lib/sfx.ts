// 牌桌音效 —— 全部用 Web Audio 合成（零素材文件、离线可用、音量克制）。
// 自动播放策略：AudioContext 需在用户手势后 resume —— primeSfx() 在首次点击时唤醒。
// 静音开关持久化到 localStorage。SSR 安全（所有 window 访问都有守卫）。

export type SfxName = "deal" | "chip" | "knock" | "fold" | "turn" | "win" | "lose";

let ctx: AudioContext | null = null;
let primed = false;
let muted = false;
let loaded = false;

function loadMuted() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    muted = window.localStorage.getItem("solpoker.sfx") === "off";
  } catch {
    /* 隐私模式等：默认开 */
  }
}

export function isSfxMuted(): boolean {
  loadMuted();
  return muted;
}

export function setSfxMuted(m: boolean) {
  loadMuted();
  muted = m;
  try {
    window.localStorage.setItem("solpoker.sfx", m ? "off" : "on");
  } catch {
    /* ignore */
  }
}

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** 在首次用户手势时唤醒音频（幂等；挂 pointerdown 一次性监听）。 */
export function primeSfx() {
  if (primed || typeof window === "undefined") return;
  primed = true;
  const wake = () => ensureCtx();
  window.addEventListener("pointerdown", wake, { once: true, capture: true });
}

// ---- 合成原语 --------------------------------------------------------------

function tone(
  ac: AudioContext,
  freq: number,
  t0: number,
  dur: number,
  peak: number,
  type: OscillatorType = "sine",
  easeDown = true
) {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
  if (easeDown) g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noiseBurst(ac: AudioContext, t0: number, dur: number, peak: number, hp = 1800) {
  const n = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = hp;
  const g = ac.createGain();
  g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(ac.destination);
  src.start(t0);
}

// ---- 播放 ------------------------------------------------------------------

export function sfx(name: SfxName) {
  loadMuted();
  if (muted) return;
  const ac = ensureCtx();
  if (!ac) return;
  const t0 = ac.currentTime + 0.01;
  switch (name) {
    case "deal": // 两张牌的轻"刷"声 + 落桌轻点
      noiseBurst(ac, t0, 0.09, 0.05, 2400);
      noiseBurst(ac, t0 + 0.11, 0.08, 0.045, 2200);
      tone(ac, 640, t0 + 0.05, 0.05, 0.02, "triangle");
      break;
    case "chip": // 筹码碰撞：两三声短促高频
      tone(ac, 2200, t0, 0.045, 0.06, "square");
      tone(ac, 2600, t0 + 0.05, 0.04, 0.05, "square");
      tone(ac, 1900, t0 + 0.1, 0.05, 0.045, "triangle");
      break;
    case "knock": // 敲桌（过牌）：两声闷响
      tone(ac, 190, t0, 0.07, 0.12, "triangle");
      tone(ac, 175, t0 + 0.12, 0.07, 0.1, "triangle");
      break;
    case "fold": // 弃牌：一声轻扫
      noiseBurst(ac, t0, 0.12, 0.03, 1200);
      break;
    case "turn": // 轮到你了：两声上行提示
      tone(ac, 660, t0, 0.09, 0.09, "sine");
      tone(ac, 990, t0 + 0.11, 0.12, 0.09, "sine");
      break;
    case "win": // 赢池：三声上行琶音
      tone(ac, 523.25, t0, 0.12, 0.1, "sine");
      tone(ac, 659.25, t0 + 0.1, 0.12, 0.1, "sine");
      tone(ac, 783.99, t0 + 0.2, 0.22, 0.11, "sine");
      break;
    case "lose": // 输池：两声下行，音量更低（不刺耳）
      tone(ac, 392, t0, 0.14, 0.06, "sine");
      tone(ac, 311.13, t0 + 0.13, 0.22, 0.06, "sine");
      break;
  }
}
