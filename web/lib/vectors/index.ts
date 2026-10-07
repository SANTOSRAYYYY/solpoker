// Stage 4 发牌协议测试向量（与仓库根目录 vectors/v1/*.json 同源的一份拷贝）。
// 用途：浏览器里跑「复算引擎自检」——用页面同一套 deal-verify.mjs + WebCrypto
// 复算这些向量，结果应与 Rust/Python 参考实现逐字节一致（三方一致）。
// 若根目录向量更新，请同步拷贝：cp vectors/v1/*.json web/lib/vectors/

import type { DealInputs } from "../deal-verify.mjs";
import p3 from "./3p_sparse.json";
import p9 from "./9p_full.json";
import btn from "./button_rotation.json";
import hu from "./hu_2p.json";
import redo from "./redraw.json";
import run from "./runout.json";

export interface DealVector {
  name: string;
  inputs: DealInputs;
  expected: Record<string, unknown>;
}

const withName = (v: unknown, label: string): DealVector => ({
  ...(v as Omit<DealVector, "name">),
  name: label,
});

export const DEAL_VECTORS: DealVector[] = [
  withName(hu, "hu_2p（单挑 2 人）"),
  withName(p3, "3p_sparse（3 人）"),
  withName(p9, "9p_full（满桌 9 人）"),
  withName(btn, "button_rotation（庄位轮转）"),
  withName(redo, "redraw（拒绝采样重抽）"),
  withName(run, "runout（全下合并跑完）"),
];
