# solpoker 发牌协议 v1 —— Python 参考实现与测试向量（Stage 4）

本目录是发牌协议的 Python 参考实现。CI 的 parity 约定：**链上 Rust 实现、
本 Python 参考实现、`vectors/v1/*.json` 测试向量，三者必须逐字节一致**。

## 文件

- `solpoker_deal.py` —— 参考实现（纯标准库：hashlib / hmac / json / secrets，
  无第三方依赖）。暴露牌/盐/种子/庄位/transcript/事件编码/抽牌等函数，
  以及 `deal_hand(inputs) -> dict` 和 `verify_vector(path) -> bool`。
- `generate_vectors.py` —— 测试向量生成器，输入全部为硬编码确定性常量，
  重新生成逐字节可复现。
- `../vectors/v1/*.json` —— 生成的测试向量（Rust 测试读取器消费）。

## 重新生成向量

```bash
python reference/generate_vectors.py
```

（本机 `python` 若为 Microsoft Store 占位符，请用 `py -3`。）
生成器会立即用 `solpoker_deal.verify_vector` 校验刚写出的全部向量并报告
`generate+verify: N/N OK`。

## 校验向量

```bash
python reference/solpoker_deal.py verify            # 校验 vectors/v1 下全部
python reference/solpoker_deal.py verify vectors/v1/hu_2p.json   # 校验指定文件
```

全部一致时退出码为 0，否则为 1 并打印不一致字段。

## 向量覆盖

| 文件 | 场景 |
|---|---|
| `hu_2p.json` | 2 人（座位 0,1），第一手（HMAC 选庄），全部街，ante/SB/BB 强制注 |
| `3p_sparse.json` | 3 人稀疏座位（0,4,8），第一手，只发 preflop+flop |
| `9p_full.json` | 9 人满员，第一手，全部街 |
| `button_rotation.json` | 与 9p_full 同桌的第二手，`button_initialized=true`，庄位顺时针轮转 |
| `runout.json` | 2 人翻前全下，`RunoutStarted` 后 5 张公共牌全用 `seed_runout`（vrf_src=4，draw_no 接续） |
| `redraw.json` | 重抽路径：见下方说明 |

## 向量 JSON 形状

```json
{"name": "...",
 "inputs": {"program_id": hex, "table": hex, "hand_id": int, "hand_mask": int,
   "button_initialized": bool, "prev_button": int|null,
   "occupants": [9×hex|null], "occupancy_ids": [9×int], "stacks": [9×int],
   "salts": {座位字符串: hex}, "vrf_outputs": {目标字符串"0".."4": hex},
   "forced": [{"seat","kind","amount"}],
   "script": [{"type":"street","street":int} | {"type":"runout"}],
   "force_retry": [draw_no, ...]   // 可选，测试钩子，见下
 },
 "expected": {"salt_commitments": {座位字符串: hex}, "salt_digest": hex,
   "seed_preflop": hex, "seed_flop": hex, "seed_turn": hex,
   "seed_river": hex, "seed_runout": hex,
   "button": int, "hole": {座位字符串: [c1,c2]}, "board": [int],
   "board_src": [int], "transcript_final": hex,
   "draws": [{"draw_no","retry","card"}]}}
```

hex 一律为小写、无 `0x` 前缀、32 字节 64 字符。`vrf_outputs` 目标：
0=翻前（兼庄位与底牌），1=flop，2=turn，3=river，4=runout。

## 规范定稿细节（设计文档 §8 留白处，Rust 必须逐项对齐）

1. **顺时针** = 物理座位号升序方向（8 之后回到 0）。底牌从庄位左手边
   （hand_mask 中庄位的下一个成员）开始，顺时针两轮；heads-up 时庄位下小盲。
2. **规范事件顺序**：`HandStart` → 座位升序 `SaltCommitted`×n →
   `VrfFulfilled(0)` → `ForcedBet`×m → `StreetStart(0)` →
   `HoleDealt`×2n（每张抽出后立即追加）→ 每条街 `VrfFulfilled(street)` →
   `StreetStart(street)` → `BoardDealt`×(3/1/1)；runout 为
   `RunoutStarted` → `VrfFulfilled(4)` → 剩余公共牌的 `BoardDealt`。
3. **runout 期间的 BoardDealt**：`street` 记实际街序（1=flop/2=turn/3=river），
   `vrf_src` 记 4。`board_src` 数组逐张记录来源（正常街为 1/2/3，runout 为 4）。
4. 向量中 `VrfFulfilled.attempt` 一律为 1（与链上 caller_seed 的 attempt
   约定一致：首次请求为 1，重试递增；各 target 的取值写入 inputs 的
   `vrf_attempts`，保证 inputs 完整决定 expected）。
5. 发牌向量不含 `Action`/`HandEnd` 等结算事件；`transcript_final` 是最后
   一个发牌相关事件之后的链式哈希。结算事件由 §7 资金流测试另行覆盖。
6. 抽牌拒绝条件为 `v < (2^64 mod n)`（v 为 HMAC 前 8 字节大端），触发概率
   ≤ 51/2^64 ≈ 2.8e-18/次，**无法暴力搜索出自然 retry 输入**。`redraw.json`
   的生成器先枚举 hand_id 1..50000 尝试自然搜索（预期失败并打印说明），
   然后使用 inputs 的可选字段 `force_retry`（draw_no 列表）测试钩子：
   对这些 draw_no，第一次候选被视为拒绝、以 retry=1 重算，从而确定性
   地覆盖重抽路径（msg 中 retry 字段编码、transcript 绑定均真实走一遍）。
   **Rust 测试读取器需实现同一钩子**：当 inputs 含 `force_retry` 时，
   对应 draw_no 跳过首个候选。
