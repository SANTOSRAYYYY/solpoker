"""solpoker 发牌协议 v1 —— Python 参考实现（Stage 4）

纯标准库实现（hashlib / hmac / json / secrets），与链上 Rust 实现、
``vectors/v1/*.json`` 测试向量三者逐字节一致（三方 parity CI）。

字节级约定（与设计文档 §8 一致）：
- 所有整数一律**大端**编码；``‖`` 表示字节拼接；字符串常量按 UTF-8 编码，
  不带结尾 NUL。
- 牌编号 = ``rank * 4 + suit``；rank 从 2 到 A 对应 0..12；suit 按
  ♣♦♥♠ 对应 0..3。牌堆是按牌编号升序排列的有序列表 ``[0..52)``。

本模块定稿的规范细节（设计文档留白处，Rust 实现必须逐项对齐）：

1. “顺时针” = 物理座位号**升序**方向（8 之后回到 0）。
2. 一手的规范事件顺序：
   ``HandStart`` → 按座位升序 ``SaltCommitted``×n → ``VrfFulfilled(0)``
   → ``ForcedBet``×m（按 inputs 给定顺序）→ ``StreetStart(0)``
   → 底牌 ``HoleDealt``×2n（每张牌抽出后立即追加）
   → 每条街：``VrfFulfilled(street)`` → ``StreetStart(street)``
   → ``BoardDealt``×(3/1/1)；runout：``RunoutStarted``
   → ``VrfFulfilled(4)`` → 剩余公共牌的 ``BoardDealt``。
3. runout 期间发出的 ``BoardDealt``：``street`` 字段记**实际街序**
   （1=flop / 2=turn / 3=river），``vrf_src`` 记 4（seed_runout）。
4. ``VrfFulfilled.attempt`` 在测试向量中一律为 0。
5. 发牌测试向量不含 ``Action`` / ``HandEnd`` 等结算事件；
   ``transcript_final`` 为最后一个发牌相关事件之后的链式哈希。
6. 拒绝采样触发概率约 (2^64 mod n)/2^64 ≤ 51/2^64 ≈ 2.8e-18/次，
   无法暴力搜索出自然 retry 输入；``redraw.json`` 通过 inputs 的可选
   ``force_retry``（draw_no 列表）测试钩子强制走一遍重抽路径，
   Rust 测试读取器需实现同一钩子（见 README.md）。

用法：
    python reference/solpoker_deal.py verify [vector.json ...]
    python reference/solpoker_deal.py generate
"""

from __future__ import annotations

import hashlib
import hmac
import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# 路径常量
# ---------------------------------------------------------------------------

REFERENCE_DIR = Path(__file__).resolve().parent
VECTORS_DIR = REFERENCE_DIR.parent / "vectors" / "v1"

# ---------------------------------------------------------------------------
# 基本编码助手（全部大端）
# ---------------------------------------------------------------------------


def u8(x: int) -> bytes:
    """无符号 8 位大端编码。"""
    return x.to_bytes(1, "big")


def u16(x: int) -> bytes:
    """无符号 16 位大端编码。"""
    return x.to_bytes(2, "big")


def u64(x: int) -> bytes:
    """无符号 64 位大端编码。"""
    return x.to_bytes(8, "big")


def i64(x: int) -> bytes:
    """有符号 64 位大端编码（补码）。"""
    return x.to_bytes(8, "big", signed=True)


def unhex(s: str) -> bytes:
    """解析小写十六进制字符串（无 0x 前缀）。"""
    return bytes.fromhex(s)


# ---------------------------------------------------------------------------
# 牌与牌堆
# ---------------------------------------------------------------------------


def card_id(rank: int, suit: int) -> int:
    """牌编号 = rank*4 + suit；rank 2..A 对应 0..12；suit ♣♦♥♠ 对应 0..3。"""
    if not (0 <= rank <= 12 and 0 <= suit <= 3):
        raise ValueError("rank/suit 越界")
    return rank * 4 + suit


def new_deck() -> list[int]:
    """新牌堆：按牌编号升序的有序列表 [0..52)。"""
    return list(range(52))


# ---------------------------------------------------------------------------
# 位掩码助手
# ---------------------------------------------------------------------------


def popcount(mask: int) -> int:
    """置位个数。"""
    return bin(mask).count("1")


def set_bits(mask: int) -> list[int]:
    """mask 中所有置位的下标，升序。"""
    return [i for i in range(9) if mask >> i & 1]


def next_clockwise(seat: int, mask: int) -> int:
    """seat 之后（不含自身）hand_mask 中顺时针（升序、回绕）的下一个成员。"""
    seats = set_bits(mask)
    for s in seats:
        if s > seat:
            return s
    return seats[0]


# ---------------------------------------------------------------------------
# 盐承诺 / 盐摘要 / 逐街种子
# ---------------------------------------------------------------------------


def salt_commitment(table: bytes, hand_id: int, player: bytes, salt: bytes) -> bytes:
    """C_i = sha256("solpoker/salt/v1" ‖ table(32) ‖ hand_id(u64) ‖ player(32) ‖ salt(32))"""
    assert len(table) == 32 and len(player) == 32 and len(salt) == 32
    return hashlib.sha256(
        b"solpoker/salt/v1" + table + u64(hand_id) + player + salt
    ).digest()


def salt_digest(
    table: bytes,
    hand_id: int,
    hand_mask: int,
    occupants: list[bytes | None],
    occupancy_ids: list[int],
    salts: dict[int, bytes],
) -> bytes:
    """salt_digest = sha256("solpoker/salts/v1" ‖ table ‖ hand_id(u64) ‖ hand_mask(u16)
    ‖ 按座位升序、仅 hand_mask 置位座位: seat(u8) ‖ occupancy_id(u64)
      ‖ occupant(32) ‖ salt(32))
    """
    assert len(table) == 32
    buf = b"solpoker/salts/v1" + table + u64(hand_id) + u16(hand_mask)
    for seat in set_bits(hand_mask):
        occupant = occupants[seat]
        if occupant is None:
            raise ValueError(f"座位 {seat} 在 hand_mask 中但 occupant 为空")
        buf += u8(seat) + u64(occupancy_ids[seat]) + occupant + salts[seat]
    return hashlib.sha256(buf).digest()


def street_seed(vrf_k: bytes, digest: bytes) -> bytes:
    """seed_k = sha256("solpoker/seed/v1" ‖ VRF_k(32) ‖ salt_digest(32))"""
    assert len(vrf_k) == 32 and len(digest) == 32
    return hashlib.sha256(b"solpoker/seed/v1" + vrf_k + digest).digest()


# ---------------------------------------------------------------------------
# 庄位
# ---------------------------------------------------------------------------


def first_button(seed_0: bytes, table: bytes, hand_id: int, hand_mask: int) -> int:
    """第一手庄位：
    button_pick = BE_u64(HMAC-SHA256(key=seed_0,
        msg="solpoker-v1/button" ‖ table ‖ hand_id(u64))[0..8]) mod popcount(hand_mask)
    button = hand_mask 升序置位列表中的第 button_pick 个（0 起）。
    """
    digest = hmac.new(
        seed_0, b"solpoker-v1/button" + table + u64(hand_id), hashlib.sha256
    ).digest()
    pick = int.from_bytes(digest[:8], "big") % popcount(hand_mask)
    return set_bits(hand_mask)[pick]


# ---------------------------------------------------------------------------
# 事件规范编码（tag(u8) ‖ 固定宽度大端字段）
# ---------------------------------------------------------------------------

# 下注类型
FORCED_KIND_NAMES = {0: "ante", 1: "sb", 2: "bb"}
# 动作类型
ACTION_KIND_NAMES = {0: "fold", 1: "check", 2: "call", 3: "bet", 4: "raise", 5: "allin"}


def encode_event(ev: dict) -> bytes:
    """把事件字典编码为规范字节串（tag(u8) ‖ 固定宽度大端字段）。"""
    t = ev["type"]
    if t == "HandStart":
        stacks = ev["stacks"]
        occupancy_ids = ev["occupancy_ids"]
        assert len(stacks) == 9 and len(occupancy_ids) == 9
        return (
            b"\x01"
            + u64(ev["hand_id"])
            + u8(ev["button"])
            + u16(ev["hand_mask"])
            + b"".join(u64(x) for x in stacks)
            + b"".join(u64(x) for x in occupancy_ids)
        )
    if t == "SaltCommitted":
        assert len(ev["commitment"]) == 32
        return b"\x02" + u8(ev["seat"]) + ev["commitment"]
    if t == "VrfFulfilled":
        return b"\x03" + u8(ev["target"]) + u8(ev["attempt"])
    if t == "ForcedBet":
        return b"\x04" + u8(ev["seat"]) + u8(ev["kind"]) + u64(ev["amount"])
    if t == "HoleDealt":
        return b"\x05" + u8(ev["seat"]) + u16(ev["draw_no"])
    if t == "StreetStart":
        return b"\x06" + u8(ev["street"])
    if t == "Action":
        return b"\x07" + u8(ev["seat"]) + u8(ev["kind"]) + u64(ev["amount"])
    if t == "Timeout":
        return b"\x08" + u8(ev["seat"]) + u8(ev["auto_kind"])
    if t == "BoardDealt":
        return (
            b"\x09"
            + u8(ev["street"])
            + u8(ev["card"])
            + u16(ev["draw_no"])
            + u8(ev["vrf_src"])
        )
    if t == "RunoutStarted":
        return b"\x0a"
    if t == "StreetSkipped":
        return b"\x0b" + u8(ev["street"])
    if t == "HandEnd":
        deltas = ev["deltas"]
        assert len(deltas) == 9
        return (
            b"\x0c"
            + u8(ev["result"])
            + b"".join(i64(x) for x in deltas)
            + u64(ev["rake"])
        )
    if t == "HandVoid":
        return b"\x0d" + u8(ev["reason"])
    raise ValueError(f"未知事件类型: {t!r}")


# ---------------------------------------------------------------------------
# 事件流 transcript
# ---------------------------------------------------------------------------


def transcript_init(program_id: bytes, table: bytes, hand_id: int) -> bytes:
    """transcript_0 = sha256("solpoker/transcript/v1" ‖ program_id(32) ‖ table(32) ‖ hand_id(u64))"""
    assert len(program_id) == 32 and len(table) == 32
    return hashlib.sha256(
        b"solpoker/transcript/v1" + program_id + table + u64(hand_id)
    ).digest()


def transcript_append(transcript: bytes, event_bytes: bytes) -> bytes:
    """transcript_{n+1} = sha256(transcript_n ‖ encode(event_n))"""
    assert len(transcript) == 32
    return hashlib.sha256(transcript + event_bytes).digest()


# ---------------------------------------------------------------------------
# 抽牌（拒绝采样消除取模偏差）
# ---------------------------------------------------------------------------


def draw_card(
    seed_k: bytes,
    table: bytes,
    hand_id: int,
    draw_no: int,
    transcript_digest: bytes,
    deck: list[int],
    force_rejections: int = 0,
) -> tuple[int, int]:
    """从有序牌堆 deck 中抽一张牌（就地删除）。

    msg = "solpoker-v1" ‖ table ‖ hand_id(u64) ‖ draw_no(u16) ‖ retry(u16)
          ‖ transcript_digest(32)
    v   = BE_u64(HMAC-SHA256(key=seed_k, msg)[0..8])
    n   = 当前剩余张数
    若 v < (2^64 mod n)：retry += 1 重算；否则取 deck[v mod n]。

    transcript_digest 必须是**本张牌事件追加之前**的 transcript。

    force_rejections：测试钩子，强制前 force_rejections 次候选被视为拒绝
    （用于 redraw 向量；自然触发概率 ~2.8e-18/次，无法搜索）。
    返回 (card, retry)。
    """
    retry = 0
    while True:
        msg = (
            b"solpoker-v1"
            + table
            + u64(hand_id)
            + u16(draw_no)
            + u16(retry)
            + transcript_digest
        )
        v = int.from_bytes(
            hmac.new(seed_k, msg, hashlib.sha256).digest()[:8], "big"
        )
        n = len(deck)
        reject = v < ((1 << 64) % n)
        if retry < force_rejections:
            reject = True
        if reject:
            retry += 1
            continue
        return deck.pop(v % n), retry


# ---------------------------------------------------------------------------
# 整手发牌
# ---------------------------------------------------------------------------


def deal_hand(inputs: dict) -> dict:
    """按规范对一手牌完整发牌，返回与测试向量 ``expected`` 完全同形的字典。

    inputs 字段（与向量 JSON 的 ``inputs`` 一致）：
        program_id / table          : 32 字节小写 hex
        hand_id                     : int
        hand_mask                   : int（置位数 2..9）
        button_initialized          : bool
        prev_button                 : int | None
        occupants                   : 9 项，hex 或 None
        occupancy_ids               : 9 项 int
        stacks                      : 9 项 int
        salts                       : {座位号字符串: 32 字节 hex}
        vrf_outputs                 : {目标字符串 "0".."4": 32 字节 hex}
        forced                      : [{"seat","kind","amount"}]
        script                      : [{"type":"street","street":int} | {"type":"runout"}]
        force_retry（可选，测试钩子）: [draw_no, ...]
    """
    program_id = unhex(inputs["program_id"])
    table = unhex(inputs["table"])
    hand_id = int(inputs["hand_id"])
    hand_mask = int(inputs["hand_mask"])
    occupants = [unhex(x) if x is not None else None for x in inputs["occupants"]]
    occupancy_ids = [int(x) for x in inputs["occupancy_ids"]]
    stacks = [int(x) for x in inputs["stacks"]]
    salts = {int(k): unhex(v) for k, v in inputs["salts"].items()}
    vrf_outputs = {int(k): unhex(v) for k, v in inputs["vrf_outputs"].items()}
    force_retry = set(int(x) for x in inputs.get("force_retry", []))

    assert len(occupants) == 9 and len(occupancy_ids) == 9 and len(stacks) == 9
    seats = set_bits(hand_mask)
    n = len(seats)
    if not (2 <= n <= 9):
        raise ValueError("hand_mask 置位数必须为 2..9")
    for s in seats:
        if s not in salts:
            raise ValueError(f"缺少座位 {s} 的盐")
        if occupants[s] is None:
            raise ValueError(f"座位 {s} 在 hand_mask 中但 occupant 为空")

    # --- 盐承诺 / 盐摘要 / 逐街种子 -------------------------------------
    commitments = {
        s: salt_commitment(table, hand_id, occupants[s], salts[s]) for s in seats
    }
    digest = salt_digest(table, hand_id, hand_mask, occupants, occupancy_ids, salts)
    seeds = {k: street_seed(vrf_outputs[k], digest) for k in range(5)}

    # --- 庄位 -----------------------------------------------------------
    if inputs["button_initialized"]:
        prev = inputs["prev_button"]
        if prev is None:
            raise ValueError("button_initialized=true 时必须给出 prev_button")
        button = next_clockwise(int(prev), hand_mask)
    else:
        button = first_button(seeds[0], table, hand_id, hand_mask)

    # --- 事件流 ---------------------------------------------------------
    transcript = transcript_init(program_id, table, hand_id)

    def emit(ev: dict) -> None:
        nonlocal transcript
        transcript = transcript_append(transcript, encode_event(ev))

    emit(
        {
            "type": "HandStart",
            "hand_id": hand_id,
            "button": button,
            "hand_mask": hand_mask,
            "stacks": stacks,
            "occupancy_ids": occupancy_ids,
        }
    )
    for s in seats:
        emit({"type": "SaltCommitted", "seat": s, "commitment": commitments[s]})
    emit({"type": "VrfFulfilled", "target": 0, "attempt": 1})
    for f in inputs["forced"]:
        emit(
            {
                "type": "ForcedBet",
                "seat": int(f["seat"]),
                "kind": int(f["kind"]),
                "amount": int(f["amount"]),
            }
        )
    emit({"type": "StreetStart", "street": 0})

    # --- 抽牌 -----------------------------------------------------------
    deck = new_deck()
    draws: list[dict] = []
    draw_no = 0

    def do_draw(seed_k: bytes) -> tuple[int, int, int]:
        """抽一张牌，返回 (card, retry, 本次 draw_no)；事件由调用方追加。"""
        nonlocal transcript, draw_no
        fr = 1 if draw_no in force_retry else 0
        card, retry = draw_card(
            seed_k, table, hand_id, draw_no, transcript, deck, fr
        )
        this_draw_no = draw_no
        draws.append({"draw_no": this_draw_no, "retry": retry, "card": card})
        draw_no += 1
        return card, retry, this_draw_no

    # 底牌：从 button 左侧第一位开始，顺时针发两轮，draw_no 0..2n-1
    start = (seats.index(button) + 1) % n
    order = seats[start:] + seats[:start]
    hole: dict[int, list[int]] = {s: [] for s in seats}
    for _round in range(2):
        for s in order:
            card, _, dn = do_draw(seeds[0])
            hole[s].append(card)
            emit({"type": "HoleDealt", "seat": s, "draw_no": dn})

    # 公共牌：按 script 逐街 / runout
    board: list[int] = []
    board_src: list[int] = []

    def deal_board(seed_k: bytes, street: int, count: int, vrf_src: int) -> None:
        for _ in range(count):
            card, _, dn = do_draw(seed_k)
            emit(
                {
                    "type": "BoardDealt",
                    "street": street,
                    "card": card,
                    "draw_no": dn,
                    "vrf_src": vrf_src,
                }
            )
            board.append(card)
            board_src.append(vrf_src)

    for step in inputs["script"]:
        if step["type"] == "street":
            s = int(step["street"])
            if s not in (1, 2, 3):
                raise ValueError("street 必须为 1..3")
            emit({"type": "VrfFulfilled", "target": s, "attempt": 1})
            emit({"type": "StreetStart", "street": s})
            deal_board(seeds[s], s, 3 if s == 1 else 1, vrf_src=s)
        elif step["type"] == "runout":
            # all-in 合并：只请求一次 VRF_r，用 seed_runout 抽完剩余公共牌；
            # draw_no 接续编号，BoardDealt.street 记实际街序，vrf_src=4。
            emit({"type": "RunoutStarted"})
            emit({"type": "VrfFulfilled", "target": 4, "attempt": 1})
            while len(board) < 5:
                if len(board) < 3:
                    deal_board(seeds[4], 1, 3 - len(board), vrf_src=4)
                elif len(board) == 3:
                    deal_board(seeds[4], 2, 1, vrf_src=4)
                else:
                    deal_board(seeds[4], 3, 1, vrf_src=4)
        else:
            raise ValueError(f"未知 script 步骤: {step!r}")

    # --- 汇总 expected ---------------------------------------------------
    return {
        "salt_commitments": {str(s): commitments[s].hex() for s in seats},
        "salt_digest": digest.hex(),
        "seed_preflop": seeds[0].hex(),
        "seed_flop": seeds[1].hex(),
        "seed_turn": seeds[2].hex(),
        "seed_river": seeds[3].hex(),
        "seed_runout": seeds[4].hex(),
        "button": button,
        "hole": {str(s): hole[s] for s in seats},
        "board": board,
        "board_src": board_src,
        "transcript_final": transcript.hex(),
        "draws": draws,
    }


# ---------------------------------------------------------------------------
# 向量校验
# ---------------------------------------------------------------------------


def verify_vector(path) -> bool:
    """加载向量 JSON，重算 deal_hand 并逐字段比对 expected。返回是否一致。"""
    path = Path(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    name = data.get("name", path.name)
    computed = deal_hand(data["inputs"])
    expected = data["expected"]

    ok = True
    keys = list(expected.keys())
    extra = [k for k in computed if k not in expected]
    if extra:
        print(f"  [{name}] FAIL: computed 多出字段 {extra}")
        ok = False
    for key in keys:
        want = expected[key]
        got = computed.get(key)
        if got != want:
            print(f"  [{name}] FAIL: 字段 {key} 不一致")
            print(f"    expected: {json.dumps(want, sort_keys=True)[:400]}")
            print(f"    computed: {json.dumps(got, sort_keys=True)[:400]}")
            ok = False
    return ok


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """命令行入口：

    ``verify [paths...]``  校验指定向量；缺省校验 vectors/v1 下全部。
    ``generate``           调用 generate_vectors 重新生成并立即校验全部向量。
    """
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else "verify"

    if cmd == "generate":
        sys.path.insert(0, str(REFERENCE_DIR))
        import generate_vectors  # noqa: PLC0415

        return generate_vectors.main()

    if cmd == "verify":
        paths = [Path(p) for p in argv[1:]] if len(argv) > 1 else sorted(
            VECTORS_DIR.glob("*.json")
        )
        if not paths:
            print(f"未找到向量文件: {VECTORS_DIR}")
            return 1
        ok_count = 0
        for p in paths:
            ok = verify_vector(p)
            print(f"{'OK  ' if ok else 'FAIL'} {p.name}")
            ok_count += 1 if ok else 0
        print(f"verify: {ok_count}/{len(paths)} OK")
        return 0 if ok_count == len(paths) else 1

    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
