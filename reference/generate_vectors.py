"""solpoker 发牌协议 v1 —— 测试向量生成器（Stage 4）

生成 ``vectors/v1/*.json``，全部输入为硬编码确定性常量（固定 table /
program_id / occupants / salts / VRF 字节），重新生成逐字节可复现。

用法：
    python reference/generate_vectors.py

生成后立即用 solpoker_deal.verify_vector 校验全部向量并报告 OK 数。
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

REFERENCE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(REFERENCE_DIR))

import solpoker_deal as deal  # noqa: E402

VECTORS_DIR = deal.VECTORS_DIR

# ---------------------------------------------------------------------------
# 确定性常量
# ---------------------------------------------------------------------------

PROGRAM_ID = (b"\x22" * 32).hex()

ANTE = 20_000   # 0.1 BB
SB = 100_000    # 0.5 BB
BB = 200_000    # 1 BB
STACK = 20_000_000  # 100 BB

# 每张向量表（table = 单字节重复 32 次）
TABLE_HU = (b"\x11" * 32).hex()
TABLE_3P = (b"\x33" * 32).hex()
TABLE_9P = (b"\x99" * 32).hex()   # button_rotation 与 9p_full 共用
TABLE_RUNOUT = (b"\x55" * 32).hex()
TABLE_REDRAW = (b"\x66" * 32).hex()


def occupant_hex(seat: int) -> str:
    """座位 seat 的占用者钱包：确定性的图案化 32 字节。"""
    return (bytes([0xA0 + seat]) * 32).hex()


def salt_hex(vector_name: str, seat: int) -> str:
    """座位 seat 本手的盐：由向量名 + 座位派生的确定性 32 字节。"""
    return hashlib.sha256(
        f"solpoker-vector-salt/{vector_name}/{seat}".encode("utf-8")
    ).hexdigest()


def vrf_hex(vector_name: str, target: int) -> str:
    """目标 target（0..4）的 VRF 输出：确定性 32 字节。"""
    return hashlib.sha256(
        f"solpoker-vector-vrf/{vector_name}/{target}".encode("utf-8")
    ).hexdigest()


def make_inputs(
    vector_name: str,
    table: str,
    seats: list[int],
    hand_id: int,
    script: list[dict],
    button_initialized: bool = False,
    prev_button: int | None = None,
    force_retry: list[int] | None = None,
) -> dict:
    """构造 inputs 字典（forced 字段随后由 fix_forced_bets 按算出的庄位补齐）。"""
    hand_mask = 0
    for s in seats:
        hand_mask |= 1 << s
    occupants = [occupant_hex(s) if s in seats else None for s in range(9)]
    occupancy_ids = [9000 + s if s in seats else 0 for s in range(9)]
    stacks = [STACK if s in seats else 0 for s in range(9)]
    inputs = {
        "program_id": PROGRAM_ID,
        "table": table,
        "hand_id": hand_id,
        "hand_mask": hand_mask,
        "button_initialized": button_initialized,
        "prev_button": prev_button,
        "occupants": occupants,
        "occupancy_ids": occupancy_ids,
        "stacks": stacks,
        "salts": {str(s): salt_hex(vector_name, s) for s in seats},
        "vrf_outputs": {str(k): vrf_hex(vector_name, k) for k in range(5)},
        # VrfFulfilled.attempt：与链上 caller_seed 的 attempt 约定一致（1 起，
        # 首次请求为 1；重试递增）。写入 inputs，保证 inputs 完整决定 expected。
        "vrf_attempts": {str(k): 1 for k in range(5)},
        "forced": [],
        "script": script,
    }
    if force_retry:
        inputs["force_retry"] = list(force_retry)
    return inputs


def compute_button(inputs: dict) -> int:
    """按规范算出本手庄位（用于构造与庄位一致的 forced bets）。"""
    hand_mask = inputs["hand_mask"]
    if inputs["button_initialized"]:
        return deal.next_clockwise(inputs["prev_button"], hand_mask)
    table = deal.unhex(inputs["table"])
    occupants = [deal.unhex(x) if x is not None else None for x in inputs["occupants"]]
    salts = {int(k): deal.unhex(v) for k, v in inputs["salts"].items()}
    digest = deal.salt_digest(
        table,
        inputs["hand_id"],
        hand_mask,
        occupants,
        inputs["occupancy_ids"],
        salts,
    )
    seed_0 = deal.street_seed(deal.unhex(inputs["vrf_outputs"]["0"]), digest)
    return deal.first_button(seed_0, table, inputs["hand_id"], hand_mask)


def fix_forced_bets(inputs: dict, ante: bool = True) -> None:
    """按算出的庄位填充 forced bets：全员 ante（升序）→ SB → BB。

    heads-up（n=2）特例：庄位下小盲；多人池：庄位左手边下小盲、再下一位大盲。
    """
    seats = deal.set_bits(inputs["hand_mask"])
    n = len(seats)
    button = compute_button(inputs)
    forced = []
    if ante:
        for s in seats:
            forced.append({"seat": s, "kind": 0, "amount": ANTE})
    if n == 2:
        sb_seat = button
        bb_seat = deal.next_clockwise(button, inputs["hand_mask"])
    else:
        sb_seat = deal.next_clockwise(button, inputs["hand_mask"])
        bb_seat = deal.next_clockwise(sb_seat, inputs["hand_mask"])
    forced.append({"seat": sb_seat, "kind": 1, "amount": SB})
    forced.append({"seat": bb_seat, "kind": 2, "amount": BB})
    inputs["forced"] = forced


def build_vector(name: str, inputs: dict) -> dict:
    """跑 deal_hand 生成 expected，组装成向量字典。"""
    expected = deal.deal_hand(inputs)
    return {"name": name, "inputs": inputs, "expected": expected}


def write_vector(vec: dict) -> Path:
    """写向量 JSON（sort_keys 保证字节级可复现）。"""
    path = VECTORS_DIR / f"{vec['name']}.json"
    path.write_text(
        json.dumps(vec, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return path


# ---------------------------------------------------------------------------
# redraw 向量：搜索自然 retry 输入
# ---------------------------------------------------------------------------

REDRAW_SEARCH_MAX_HAND_ID = 50_000


def search_natural_redraw(inputs: dict) -> dict | None:
    """枚举候选 hand_id，寻找至少一次抽牌 retry>0 的输入。

    注意：拒绝条件 v < (2^64 mod n) 的触发概率 ≤ 51/2^64 ≈ 2.8e-18/次，
    本搜索在数学上几乎必然找不到；保留它是为了（a）万一协议参数修改后
    概率变化可以自动捕获自然样本，（b）证明生成过程确实尝试过搜索。
    """
    for hand_id in range(1, REDRAW_SEARCH_MAX_HAND_ID + 1):
        candidate = dict(inputs)
        candidate["hand_id"] = hand_id
        result = deal.deal_hand(candidate)
        if any(d["retry"] > 0 for d in result["draws"]):
            return candidate
    return None


# ---------------------------------------------------------------------------
# 各向量定义
# ---------------------------------------------------------------------------


def build_hu_2p() -> dict:
    """2 人（座位 0,1），第一手（庄位由 HMAC 选出），全部街，不用 runout。"""
    name = "hu_2p"
    inputs = make_inputs(
        name,
        TABLE_HU,
        seats=[0, 1],
        hand_id=1,
        script=[{"type": "street", "street": 1},
                {"type": "street", "street": 2},
                {"type": "street", "street": 3}],
    )
    fix_forced_bets(inputs, ante=True)
    return build_vector(name, inputs)


def build_3p_sparse() -> dict:
    """3 人稀疏座位（0,4,8），第一手，只发 preflop + flop。"""
    name = "3p_sparse"
    inputs = make_inputs(
        name,
        TABLE_3P,
        seats=[0, 4, 8],
        hand_id=1,
        script=[{"type": "street", "street": 1}],
    )
    fix_forced_bets(inputs, ante=True)
    return build_vector(name, inputs)


def build_9p_full() -> dict:
    """9 人满员，第一手，全部街。"""
    name = "9p_full"
    inputs = make_inputs(
        name,
        TABLE_9P,
        seats=list(range(9)),
        hand_id=1,
        script=[{"type": "street", "street": 1},
                {"type": "street", "street": 2},
                {"type": "street", "street": 3}],
    )
    fix_forced_bets(inputs, ante=True)
    return build_vector(name, inputs)


def build_button_rotation(first_hand: dict) -> dict:
    """与 9p_full 同桌的第二手：button_initialized=true，庄位顺时针轮转一格。"""
    name = "button_rotation"
    prev = first_hand["inputs"]
    inputs = make_inputs(
        name,
        prev["table"],
        seats=list(range(9)),
        hand_id=prev["hand_id"] + 1,
        script=[{"type": "street", "street": 1},
                {"type": "street", "street": 2},
                {"type": "street", "street": 3}],
        button_initialized=True,
        prev_button=first_hand["expected"]["button"],
    )
    fix_forced_bets(inputs, ante=True)
    return build_vector(name, inputs)


def build_runout() -> dict:
    """2 人翻前全下：preflop 结束后 RunoutStarted，5 张公共牌全部用
    seed_runout 抽出（draw_no 接续，vrf_src=4）。"""
    name = "runout"
    inputs = make_inputs(
        name,
        TABLE_RUNOUT,
        seats=[0, 1],
        hand_id=1,
        script=[{"type": "runout"}],
    )
    fix_forced_bets(inputs, ante=True)
    return build_vector(name, inputs)


def build_redraw() -> dict:
    """重抽向量：先搜索自然 retry 输入；找不到（概率 ~2.8e-18/次）则使用
    force_retry 测试钩子，强制 draw_no 0（首张底牌）与 draw_no 2n（首张
    翻牌）各重抽一次。找到的 / 使用的输入都记录进向量文件，可逐字节复现。
    """
    name = "redraw"
    base = make_inputs(
        name,
        TABLE_REDRAW,
        seats=[0, 1],
        hand_id=1,
        script=[{"type": "street", "street": 1},
                {"type": "street", "street": 2},
                {"type": "street", "street": 3}],
    )
    fix_forced_bets(base, ante=True)
    print(f"  redraw: 搜索自然 retry 输入（hand_id 1..{REDRAW_SEARCH_MAX_HAND_ID}）...")
    found = search_natural_redraw(base)
    if found is not None:
        print(f"  redraw: 找到自然 retry 输入 hand_id={found['hand_id']}")
        return build_vector(name, found)
    n = deal.popcount(base["hand_mask"])
    print("  redraw: 未找到自然 retry（预期之内），使用 force_retry 测试钩子")
    base["force_retry"] = [0, 2 * n]
    return build_vector(name, base)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def main() -> int:
    VECTORS_DIR.mkdir(parents=True, exist_ok=True)

    print("生成向量...")
    vectors = []
    vectors.append(build_hu_2p())
    vectors.append(build_3p_sparse())
    nine = build_9p_full()
    vectors.append(nine)
    vectors.append(build_button_rotation(nine))
    vectors.append(build_runout())
    vectors.append(build_redraw())

    paths = [write_vector(v) for v in vectors]
    for p in paths:
        print(f"  写入 {p}")

    print("立即校验...")
    ok_count = 0
    for p in paths:
        ok = deal.verify_vector(p)
        print(f"  {'OK  ' if ok else 'FAIL'} {p.name}")
        ok_count += 1 if ok else 0
    print(f"generate+verify: {ok_count}/{len(paths)} OK")
    return 0 if ok_count == len(paths) else 1


if __name__ == "__main__":
    raise SystemExit(main())
