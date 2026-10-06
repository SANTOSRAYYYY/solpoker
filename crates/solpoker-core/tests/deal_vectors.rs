//! `vectors/v1/*.json` 字节级一致性测试（Stage 4 发牌协议，§8）。
//!
//! 向量由 Python 参考实现（`reference/solpoker_deal.py`，`reference/generate_vectors.py`
//! 生成）产出；本测试逐个读取、用 [`solpoker_core::deal`] 重算并逐字节比对。
//! 目录不存在时**跳过**（直接返回），以便向量生成之前 CI 照常通过。
//!
//! 目录定位：优先环境变量 `CARGO_WORKSPACE_DIR`（指向仓库根），
//! 否则取 `CARGO_MANIFEST_DIR/../../`（crates/solpoker-core 的上两级）。
//!
//! ## 向量 JSON 形状（与 reference/README.md 约定一致）
//!
//! ```json
//! {"name": "...",
//!  "inputs": {"program_id": hex, "table": hex, "hand_id": int, "hand_mask": int,
//!    "button_initialized": bool, "prev_button": int|null,
//!    "occupants": [9×hex|null], "occupancy_ids": [9×int], "stacks": [9×int],
//!    "salts": {座位字符串: hex}, "vrf_outputs": {目标字符串"0".."4": hex},
//!    "forced": [{"seat","kind","amount"}],
//!    "script": [{"type":"street","street":int} | {"type":"runout"}],
//!    "force_retry": [draw_no, ...] },
//!  "expected": {"salt_commitments": {座位字符串: hex}, "salt_digest": hex,
//!    "seed_preflop": hex, "seed_flop": hex, "seed_turn": hex,
//!    "seed_river": hex, "seed_runout": hex,
//!    "button": int, "hole": {座位字符串: [c1,c2]}, "board": [int],
//!    "board_src": [int], "transcript_final": hex,
//!    "draws": [{"draw_no","retry","card"}]}}
//! ```
//!
//! 规范细节（对齐 Python 参考实现的定稿）：
//! - 事件顺序：HandStart → SaltCommitted(升序×n) → VrfFulfilled(0) →
//!   ForcedBet×m（按 `forced` 顺序）→ StreetStart(0) → HoleDealt×2n →
//!   每条街 VrfFulfilled(street) → StreetStart(street) → BoardDealt×(3/1/1)；
//!   runout：RunoutStarted → VrfFulfilled(4) → BoardDealt×剩余；
//! - runout 的 BoardDealt：`street` 记实际街序（1/2/3），`vrf_src` 记 4；
//! - 向量中 `VrfFulfilled.attempt` 一律为 0（可用可选 `vrf_attempts` 覆盖）；
//! - `force_retry` 为测试钩子：这些 draw_no 的首个候选被强制拒绝（见
//!   [`solpoker_core::deal::DrawMachine::set_force_retry`]）。

use solpoker_core::deal::{
    first_button, salt_commitment, BoardStreet, DealRecord, DealSession, Event, ForcedBetKind,
    HandInputs,
};
use solpoker_core::seats::{next_clockwise, MAX_SEATS};
use solpoker_core::vrf::VrfTarget;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// 极简 JSON 解析器（仅本测试使用，std-only，覆盖向量文件所需的子集）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum J {
    Null,
    Bool(bool),
    Num(String),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(kv) => kv.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn req(&self, key: &str) -> Result<&J, String> {
        self.get(key).ok_or_else(|| format!("缺少字段 {key}"))
    }

    fn as_str(&self) -> Result<&str, String> {
        match self {
            J::Str(s) => Ok(s),
            other => Err(format!("期望字符串，得到 {other:?}")),
        }
    }

    fn as_u64(&self) -> Result<u64, String> {
        match self {
            J::Num(s) => {
                if let Ok(v) = s.parse::<u64>() {
                    Ok(v)
                } else {
                    s.parse::<f64>()
                        .map(|f| f as u64)
                        .map_err(|_| format!("无法解析为 u64：{s}"))
                }
            }
            other => Err(format!("期望数字，得到 {other:?}")),
        }
    }

    fn as_bool(&self) -> Result<bool, String> {
        match self {
            J::Bool(b) => Ok(*b),
            other => Err(format!("期望布尔，得到 {other:?}")),
        }
    }

    fn as_arr(&self) -> Result<&[J], String> {
        match self {
            J::Arr(a) => Ok(a),
            other => Err(format!("期望数组，得到 {other:?}")),
        }
    }

    fn as_obj(&self) -> Result<&[(String, J)], String> {
        match self {
            J::Obj(kv) => Ok(kv),
            other => Err(format!("期望对象，得到 {other:?}")),
        }
    }
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Result<u8, String> {
        self.b
            .get(self.i)
            .copied()
            .ok_or_else(|| "意外 EOF".to_string())
    }

    fn expect(&mut self, c: u8) -> Result<(), String> {
        self.ws();
        if self.peek()? == c {
            self.i += 1;
            Ok(())
        } else {
            Err(format!(
                "位置 {}：期望 {:?}，得到 {:?}",
                self.i, c as char, self.b[self.i] as char
            ))
        }
    }

    fn lit(&mut self, s: &str) -> Result<(), String> {
        if self.b[self.i..].starts_with(s.as_bytes()) {
            self.i += s.len();
            Ok(())
        } else {
            Err(format!("位置 {}：期望字面量 {s}", self.i))
        }
    }

    fn value(&mut self) -> Result<J, String> {
        self.ws();
        match self.peek()? {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' => Ok(J::Str(self.string()?)),
            b't' => {
                self.lit("true")?;
                Ok(J::Bool(true))
            }
            b'f' => {
                self.lit("false")?;
                Ok(J::Bool(false))
            }
            b'n' => {
                self.lit("null")?;
                Ok(J::Null)
            }
            _ => self.number(),
        }
    }

    fn object(&mut self) -> Result<J, String> {
        self.expect(b'{')?;
        let mut kv = Vec::new();
        self.ws();
        if self.peek()? == b'}' {
            self.i += 1;
            return Ok(J::Obj(kv));
        }
        loop {
            self.ws();
            let k = self.string()?;
            self.expect(b':')?;
            let v = self.value()?;
            kv.push((k, v));
            self.ws();
            match self.peek()? {
                b',' => {
                    self.i += 1;
                }
                b'}' => {
                    self.i += 1;
                    return Ok(J::Obj(kv));
                }
                c => return Err(format!("位置 {}：对象内意外字符 {:?}", self.i, c as char)),
            }
        }
    }

    fn array(&mut self) -> Result<J, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.ws();
        if self.peek()? == b']' {
            self.i += 1;
            return Ok(J::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.ws();
            match self.peek()? {
                b',' => {
                    self.i += 1;
                }
                b']' => {
                    self.i += 1;
                    return Ok(J::Arr(items));
                }
                c => return Err(format!("位置 {}：数组内意外字符 {:?}", self.i, c as char)),
            }
        }
    }

    fn string(&mut self) -> Result<String, String> {
        self.ws();
        if self.peek()? != b'"' {
            return Err(format!("位置 {}：期望字符串", self.i));
        }
        self.i += 1;
        let mut out = String::new();
        loop {
            let c = self.peek()?;
            self.i += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let e = self.peek()?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'n' => out.push('\n'),
                        b't' => out.push('\t'),
                        b'r' => out.push('\r'),
                        b'u' => {
                            let hex = std::str::from_utf8(
                                self.b.get(self.i..self.i + 4).ok_or("\\u 转义中 EOF")?,
                            )
                            .map_err(|_| "\\u 非法".to_string())?;
                            let cp =
                                u32::from_str_radix(hex, 16).map_err(|_| "\\u 非法".to_string())?;
                            out.push(char::from_u32(cp).ok_or("\\u 非法码点")?);
                            self.i += 4;
                        }
                        _ => return Err(format!("非法转义 \\{}", e as char)),
                    }
                }
                _ => {
                    // 直接收集一段不含引号/反斜杠的 UTF-8 字节。
                    let start = self.i - 1;
                    let mut end = self.i;
                    while end < self.b.len() && self.b[end] != b'"' && self.b[end] != b'\\' {
                        end += 1;
                    }
                    out.push_str(
                        std::str::from_utf8(&self.b[start..end])
                            .map_err(|_| "非法 UTF-8".to_string())?,
                    );
                    self.i = end;
                }
            }
        }
    }

    fn number(&mut self) -> Result<J, String> {
        self.ws();
        let start = self.i;
        while self.i < self.b.len()
            && matches!(
                self.b[self.i],
                b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'
            )
        {
            self.i += 1;
        }
        if start == self.i {
            return Err(format!("位置 {}：期望数字", self.i));
        }
        Ok(J::Num(
            std::str::from_utf8(&self.b[start..self.i])
                .map_err(|_| "非法 UTF-8".to_string())?
                .to_string(),
        ))
    }
}

fn parse_json(text: &str) -> Result<J, String> {
    let mut p = Parser {
        b: text.as_bytes(),
        i: 0,
    };
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("位置 {}：JSON 之后还有多余内容", p.i));
    }
    Ok(v)
}

// ---------------------------------------------------------------------------
// hex 工具
// ---------------------------------------------------------------------------

fn hex_bytes(s: &str) -> Result<Vec<u8>, String> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() % 2 != 0 {
        return Err(format!("hex 长度为奇数：{s}"));
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn hex32(s: &str) -> Result<[u8; 32], String> {
    let b = hex_bytes(s)?;
    b.try_into().map_err(|_| format!("期望 32 字节 hex：{s}"))
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------------------------------------------------------------------------
// 向量输入解析
// ---------------------------------------------------------------------------

fn vrf_target_of_key(key: &str) -> Result<VrfTarget, String> {
    match key {
        "0" | "preflop" => Ok(VrfTarget::Preflop),
        "1" | "flop" => Ok(VrfTarget::Flop),
        "2" | "turn" => Ok(VrfTarget::Turn),
        "3" | "river" => Ok(VrfTarget::River),
        "4" | "runout" => Ok(VrfTarget::Runout),
        other => Err(format!("未知 VRF 目标键：{other}")),
    }
}

fn parse_inputs(j: &J) -> Result<HandInputs, String> {
    let mut occupants = [[0u8; 32]; MAX_SEATS as usize];
    for (i, item) in j.req("occupants")?.as_arr()?.iter().enumerate() {
        if i >= MAX_SEATS as usize {
            return Err("occupants 超过 9 项".into());
        }
        if let J::Str(s) = item {
            occupants[i] = hex32(s)?;
        }
    }
    let mut occupancy_ids = [0u64; MAX_SEATS as usize];
    for (i, item) in j.req("occupancy_ids")?.as_arr()?.iter().enumerate() {
        occupancy_ids[i] = item.as_u64()?;
    }
    let mut stacks = [0u64; MAX_SEATS as usize];
    for (i, item) in j.req("stacks")?.as_arr()?.iter().enumerate() {
        stacks[i] = item.as_u64()?;
    }
    let mut salts = [[0u8; 32]; MAX_SEATS as usize];
    for (k, v) in j.req("salts")?.as_obj()? {
        let seat: usize = k
            .parse()
            .map_err(|_| format!("salts 的键应为座位号：{k}"))?;
        if seat >= MAX_SEATS as usize {
            return Err(format!("salts 座位越界：{seat}"));
        }
        salts[seat] = hex32(v.as_str()?)?;
    }
    let mut vrf = [[0u8; 32]; 5];
    for (k, v) in j.req("vrf_outputs")?.as_obj()? {
        vrf[vrf_target_of_key(k)?.to_u8() as usize] = hex32(v.as_str()?)?;
    }
    Ok(HandInputs {
        program_id: hex32(j.req("program_id")?.as_str()?)?,
        table: hex32(j.req("table")?.as_str()?)?,
        hand_id: j.req("hand_id")?.as_u64()?,
        hand_mask: j.req("hand_mask")?.as_u64()? as u16,
        stacks,
        occupancy_ids,
        occupants,
        salts,
        vrf,
    })
}

/// `VrfFulfilled.attempt`：向量规范默认全 0，可用可选 `vrf_attempts` 覆盖。
fn parse_attempts(inputs: &J) -> Result<[u8; 5], String> {
    let mut attempts = [0u8; 5];
    if let Some(m) = inputs.get("vrf_attempts") {
        for (k, v) in m.as_obj()? {
            attempts[vrf_target_of_key(k)?.to_u8() as usize] = v.as_u64()? as u8;
        }
    }
    Ok(attempts)
}

fn parse_forced(inputs: &J) -> Result<Vec<Event>, String> {
    let mut out = Vec::new();
    for f in inputs.req("forced")?.as_arr()? {
        let kind = match f.req("kind")?.as_u64()? {
            0 => ForcedBetKind::Ante,
            1 => ForcedBetKind::SmallBlind,
            2 => ForcedBetKind::BigBlind,
            n => return Err(format!("未知 forced kind：{n}")),
        };
        out.push(Event::ForcedBet {
            seat: f.req("seat")?.as_u64()? as u8,
            kind,
            amount: f.req("amount")?.as_u64()?,
        });
    }
    Ok(out)
}

fn parse_force_retry(inputs: &J) -> Result<Vec<u16>, String> {
    match inputs.get("force_retry") {
        None | Some(J::Null) => Ok(Vec::new()),
        Some(J::Arr(a)) => a.iter().map(|x| x.as_u64().map(|v| v as u16)).collect(),
        Some(other) => Err(format!("force_retry 应为数组：{other:?}")),
    }
}

// ---------------------------------------------------------------------------
// 单条向量的重算与比对
// ---------------------------------------------------------------------------

fn run_vector(path: &Path) -> Result<(), String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读取失败：{e}"))?;
    let root = parse_json(&text)?;
    let name = root
        .get("name")
        .and_then(|j| j.as_str().ok())
        .unwrap_or("<unnamed>")
        .to_string();
    let ctx = |m: String| {
        format!(
            "[{}:{}] {m}",
            path.file_name().unwrap().to_string_lossy(),
            name
        )
    };

    let inputs_j = root.req("inputs").map_err(&ctx)?;
    let expected = root.req("expected").map_err(&ctx)?;
    let inputs = parse_inputs(inputs_j).map_err(&ctx)?;
    let attempts = parse_attempts(inputs_j).map_err(&ctx)?;
    let forced = parse_forced(inputs_j).map_err(&ctx)?;
    let force_retry = parse_force_retry(inputs_j).map_err(&ctx)?;

    // 庄位：首手用 seed_0 抽取；否则由 prev_button 顺时针轮转。
    let button_initialized = inputs_j
        .req("button_initialized")
        .and_then(J::as_bool)
        .map_err(&ctx)?;
    let button = if button_initialized {
        let prev = match inputs_j.req("prev_button").map_err(&ctx)? {
            J::Null => return Err(ctx("button_initialized=true 时必须给出 prev_button".into())),
            j => j.as_u64().map_err(&ctx)? as u8,
        };
        next_clockwise(prev, inputs.hand_mask)
            .ok_or_else(|| ctx("prev_button 轮转失败（空 mask）".into()))?
    } else {
        first_button(&inputs).ok_or_else(|| ctx("first_button 返回 None".into()))?
    };
    assert_eq!(
        button,
        expected.req("button").and_then(J::as_u64).map_err(&ctx)? as u8,
        "{}",
        ctx("button 不一致".into())
    );

    let mut sess = DealSession::new(&inputs, button)
        .map_err(|e| ctx(format!("DealSession::new 失败：{e:?}")))?;
    sess.set_force_retry(&force_retry);

    // 盐承诺（每座位 C_i）。
    if let Some(cm) = expected.get("salt_commitments") {
        for (seat_s, hex_j) in cm.as_obj().map_err(&ctx)? {
            let seat: usize = seat_s
                .parse()
                .map_err(|_| ctx(format!("salt_commitments 座位键非法：{seat_s}")))?;
            let c = salt_commitment(
                &inputs.table,
                inputs.hand_id,
                &inputs.occupants[seat],
                &inputs.salts[seat],
            );
            assert_eq!(
                to_hex(&c),
                hex_j.as_str().map_err(&ctx)?,
                "{}",
                ctx(format!("座位 {seat} 盐承诺不一致"))
            );
        }
    }

    // salt_digest 与逐街种子。
    assert_eq!(
        to_hex(&sess.salt_digest()),
        expected
            .req("salt_digest")
            .and_then(J::as_str)
            .map_err(&ctx)?,
        "{}",
        ctx("salt_digest 不一致".into())
    );
    for (key, target) in [
        ("seed_preflop", VrfTarget::Preflop),
        ("seed_flop", VrfTarget::Flop),
        ("seed_turn", VrfTarget::Turn),
        ("seed_river", VrfTarget::River),
        ("seed_runout", VrfTarget::Runout),
    ] {
        if let Some(exp) = expected.get(key) {
            assert_eq!(
                to_hex(&sess.seed(target)),
                exp.as_str().map_err(&ctx)?,
                "{}",
                ctx(format!("{key} 不一致"))
            );
        }
    }

    // 流水线：VrfFulfilled(0) → ForcedBet×m → StreetStart(0) → 底牌 → script 各街/runout。
    let mut draws: Vec<DealRecord> = Vec::new();
    let mut board: Vec<DealRecord> = Vec::new();

    let hole = sess.deal_hole(attempts[VrfTarget::Preflop.to_u8() as usize], &forced);
    draws.extend(hole.iter().copied());

    for step in inputs_j.req("script").and_then(J::as_arr).map_err(&ctx)? {
        match step.req("type").and_then(J::as_str).map_err(&ctx)? {
            "street" => {
                let s = step.req("street").and_then(J::as_u64).map_err(&ctx)? as u8;
                let street = BoardStreet::from_street_u8(s)
                    .ok_or_else(|| ctx(format!("script street 越界：{s}")))?;
                let recs = sess.deal_street(street, attempts[s as usize]);
                draws.extend(recs.iter().copied());
                board.extend(recs);
            }
            "runout" => {
                let recs = sess.deal_runout(attempts[VrfTarget::Runout.to_u8() as usize]);
                draws.extend(recs.iter().copied());
                board.extend(recs);
            }
            other => return Err(ctx(format!("未知 script 步骤：{other}"))),
        }
    }

    // 底牌：按座位比对（每座两张，按到手顺序）。
    for (seat_s, cards_j) in expected.req("hole").and_then(J::as_obj).map_err(&ctx)? {
        let seat: u8 = seat_s
            .parse()
            .map_err(|_| ctx(format!("hole 座位键非法：{seat_s}")))?;
        let exp_cards: Vec<u8> = cards_j
            .as_arr()
            .map_err(&ctx)?
            .iter()
            .map(|c| c.as_u64().map(|v| v as u8))
            .collect::<Result<Vec<_>, _>>()
            .map_err(&ctx)?;
        let got: Vec<u8> = hole
            .iter()
            .filter(|r| r.seat == Some(seat))
            .map(|r| r.card)
            .collect();
        assert_eq!(got, exp_cards, "{}", ctx(format!("座位 {seat} 底牌不一致")));
    }

    // 公共牌与来源。
    let exp_board: Vec<u8> = expected
        .req("board")
        .and_then(J::as_arr)
        .map_err(&ctx)?
        .iter()
        .map(|c| c.as_u64().map(|v| v as u8))
        .collect::<Result<Vec<_>, _>>()
        .map_err(&ctx)?;
    let got_board: Vec<u8> = board.iter().map(|r| r.card).collect();
    assert_eq!(got_board, exp_board, "{}", ctx("board 不一致".into()));
    let board_src: Vec<u8> = expected
        .req("board_src")
        .and_then(J::as_arr)
        .map_err(&ctx)?
        .iter()
        .map(|x| x.as_u64().map(|v| v as u8))
        .collect::<Result<Vec<_>, _>>()
        .map_err(&ctx)?;
    for (i, rec) in board.iter().enumerate() {
        assert_eq!(
            rec.vrf_src.map(|t| t.to_u8()),
            Some(board_src[i]),
            "{}",
            ctx(format!("board_src[{i}] 不一致"))
        );
    }

    // 抽牌日志（draw_no / retry / card 全量比对）。
    let exp_draws = expected.req("draws").and_then(J::as_arr).map_err(&ctx)?;
    assert_eq!(
        draws.len(),
        exp_draws.len(),
        "{}",
        ctx("draws 数量不一致".into())
    );
    for (i, (got, exp)) in draws.iter().zip(exp_draws.iter()).enumerate() {
        assert_eq!(
            got.draw_no,
            exp.req("draw_no")?.as_u64().map_err(&ctx)? as u16,
            "{}",
            ctx(format!("draws[{i}].draw_no"))
        );
        assert_eq!(
            got.retry,
            exp.req("retry")?.as_u64().map_err(&ctx)? as u16,
            "{}",
            ctx(format!("draws[{i}].retry"))
        );
        assert_eq!(
            got.card,
            exp.req("card")?.as_u64().map_err(&ctx)? as u8,
            "{}",
            ctx(format!("draws[{i}].card"))
        );
    }

    // 最终 transcript。
    assert_eq!(
        to_hex(&sess.transcript_digest()),
        expected
            .req("transcript_final")
            .and_then(J::as_str)
            .map_err(&ctx)?,
        "{}",
        ctx("transcript_final 不一致".into())
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// 入口：目录不存在则跳过
// ---------------------------------------------------------------------------

#[test]
fn vectors_v1_byte_parity() {
    let root = std::env::var("CARGO_WORKSPACE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    let dir = root.join("vectors").join("v1");
    if !dir.is_dir() {
        eprintln!(
            "vectors/v1 不存在（{}），跳过字节一致性测试；待 Python 参考实现生成后自动启用。",
            dir.display()
        );
        return;
    }
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("读取 vectors/v1 失败")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map_or(false, |e| e == "json"))
        .collect();
    files.sort();
    assert!(
        !files.is_empty(),
        "vectors/v1 存在但没有任何 .json 向量文件"
    );
    for f in &files {
        run_vector(f).unwrap_or_else(|e| panic!("向量 {} 失败：{e}", f.display()));
    }
    eprintln!("vectors/v1：{} 条向量全部逐字节一致。", files.len());
}
