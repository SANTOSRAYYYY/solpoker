// 牌桌执行器（设计 §5.1/§5.4/§5.5）：每张桌一个，后台运行。
// - 自动提交/揭示盐（先落盘再发承诺，崩溃可恢复）；
// - 跟踪回合与截止时间；轮到自己时暴露 turn 供决策来源调用；
// - 兜底（§5.5）：截止前 3 秒还没有决定 → 能 check 就 check 否则 fold
//   （按正常动作提交，不计超时；连续 3 次兜底 → 本手结束后建议离桌）。
// 决策来源（LLM via MCP / 本地策略）只调用 submit()，不碰协议细节。
import {
  sleep, pda, tablePda, gamePda, seatPda, handPda, profilePda,
  decodeGame, decodeTable, decodePlayerHand, decodeLedger,
  loadSalts, saveSalt, cryptoRandom32, saltCommitmentOf,
  ixCommitSalt, ixRevealSalt, ixAct, popcount,
} from "./client.mjs";

const FALLBACK_LEAD_S = 3; // §5.5 剩余 3 秒开始兜底
const TICK_MS = 900;

export class TableExecutor {
  constructor({ agent, tableId, seat, log = () => {} }) {
    this.agent = agent;
    this.tableId = tableId;
    this.seat = seat;
    this.log = log;
    this.table = tablePda(tableId);
    this.game = gamePda(this.table);
    this.er = null;
    this.program = null;
    this.gameState = null;
    this.tableState = null;
    this.myHand = null;
    this.ledger = null;
    this.turn = null; // { handId, actionSeq, toCall, minRaiseTo, deadlineS }
    this.handResult = null; // 最近一手结束的结果
    this.curHand = -1n;
    this.lastActedSeq = -1;
    this.fallbacks = 0; // 连续兜底计数（§5.5）
    this._salts = loadSalts(agent.name);
    this._stopped = false;
    this._submitting = false;
    this.registered = true; // 由 MCP/CLI 侧设置
  }

  async start() {
    const { erConnection, programFor } = await import("./client.mjs");
    this.er = await erConnection(this.agent);
    this.program = programFor(this.er, this.agent.keypair);
    this._loop();
    // 等首次快照
    for (let i = 0; i < 20 && !this.gameState; i++) await sleep(300);
  }

  stop() {
    this._stopped = true;
  }

  async _loop() {
    while (!this._stopped) {
      try {
        await this._tick();
      } catch (e) {
        this.log(`tick 错误: ${String(e.message ?? e).slice(0, 120)}`);
        try {
          const { erConnection, programFor } = await import("./client.mjs");
          this.er = await erConnection(this.agent);
          this.program = programFor(this.er, this.agent.keypair);
          this.log("已重新鉴权");
        } catch {}
      }
      await sleep(TICK_MS);
    }
  }

  async _tick() {
    const [gAcc, tAcc] = await Promise.all([
      this.er.getAccountInfo(this.game),
      this.er.getAccountInfo(this.table),
    ]);
    if (!gAcc || !tAcc) return;
    const g = decodeGame(gAcc.data);
    this.tableState = decodeTable(tAcc.data);
    this.gameState = g;

    // 手牌切换
    if (g.handId !== this.curHand) {
      if (this.curHand >= 0n) {
        this.handResult = {
          hand_id: Number(this.curHand),
          my_stack: Number(g.seats[this.seat].stack) / 1e6,
        };
        this.fallbacks = 0;
      }
      this.curHand = g.handId;
      this.lastActedSeq = -1;
      this.turn = null;
    }

    const me = g.seats[this.seat];
    const inHand = (g.handMask & (1 << this.seat)) !== 0;
    this.myHand = inHand ? decodePlayerHand((await this.er.getAccountInfo(handPda(this.table, this.seat)))?.data ?? Buffer.alloc(58)) : null;

    // 盐：承诺
    if (inHand && g.phase === 1 && me.saltCommit.every((b) => b === 0)) {
      const key = g.handId.toString();
      const existing = this._salts[key];
      const salt = existing ? Buffer.from(existing, "hex") : cryptoRandom32();
      if (!existing) {
        saveSalt(this.agent.name, g.handId, salt); // 先落盘（§5.7），再发承诺
        this._salts[key] = salt.toString("hex");
      }
      const commitment = await saltCommitmentOf(this.table, g.handId, this.agent.keypair.publicKey, salt);
      const ix = await ixCommitSalt(this.program, this.table, this.seat, g.handId, commitment, this.agent.keypair.publicKey);
      const { sendAndConfirm, ER_CU } = await import("./client.mjs");
      await sendAndConfirm(this.er, [ix], [this.agent.keypair], "commit_salt", ER_CU);
      this.log(`hand#${g.handId} 盐承诺已提交`);
      return;
    }

    // 盐：揭示
    if (inHand && g.phase === 2 && this.myHand && this.myHand.saltHandId !== g.handId) {
      const saltHex = this._salts[g.handId.toString()];
      if (!saltHex) return; // 等待（异常：盐丢失则本手必然作废）
      const ix = await ixRevealSalt(this.program, this.table, this.seat, g.handId, Buffer.from(saltHex, "hex"), this.agent.keypair.publicKey);
      const { sendAndConfirm, ER_CU } = await import("./client.mjs");
      await sendAndConfirm(this.er, [ix], [this.agent.keypair], "reveal_salt", ER_CU);
      this.log(`hand#${g.handId} 盐已揭示`);
      return;
    }

    // 回合跟踪与兜底（§5.5）
    const nowS = Date.now() / 1000;
    const myTurn = (g.phase === 3 || g.phase === 5) && inHand && g.toAct === this.seat
      && g.actionSeq !== this.lastActedSeq;
    if (myTurn) {
      const toCall = g.currentBet - me.streetBet;
      const minRaiseTo = g.currentBet > 0n ? g.currentBet + g.lastFullRaise : g.lastFullRaise;
      this.turn = {
        handId: g.handId,
        actionSeq: g.actionSeq,
        toCall,
        minRaiseTo,
        pot: g.pot,
        board: g.board.slice(0, g.boardLen),
        holeCards: this.myHand?.cards ?? [],
        deadlineS: Math.max(0, Math.round(Number(g.actionDeadline) - nowS)),
      };
      const remaining = Number(g.actionDeadline) - nowS;
      if (remaining <= FALLBACK_LEAD_S && !this._submitting) {
        const action = toCall === 0n ? "check" : "fold";
        try {
          await this.submit(action);
          this.fallbacks++;
          this.log(`§5.5 兜底动作 ${action}（连续 ${this.fallbacks} 次）`);
          if (this.fallbacks >= 3) this.log("⚠ 连续 3 次兜底：本手结束后建议离桌（消费方应处理）");
        } catch (e) {
          this.log(`兜底失败: ${String(e.message ?? e).slice(0, 100)}`);
        }
      }
    } else if (this.turn && (g.actionSeq !== this.turn.actionSeq || g.toAct !== this.seat)) {
      this.turn = null;
    }

    // 账本（座位状态/余额），低频即可
    if (!this.ledger || Math.random() < 0.1) {
      const lAcc = await this.er.getAccountInfo(seatPda(this.table, this.seat));
      if (lAcc) this.ledger = decodeLedger(lAcc.data);
    }
  }

  /** 决策来源提交动作。校验 hand_id/action_seq（X8），过期即拒。 */
  async submit(action, amount) {
    const t = this.turn;
    if (!t) throw new Error("当前不是你的回合（先 wait_for_turn）");
    const g = this.gameState;
    if (g.handId !== t.handId || g.actionSeq !== t.actionSeq) throw new Error("动作已过期（stale），重取局面");
    this._submitting = true;
    try {
      if (action === "bet" || action === "raiseTo") {
        const amt = BigInt(amount ?? 0);
        const maxTo = this.gameState.seats[this.seat].streetBet + this.gameState.seats[this.seat].stack;
        if (amt <= 0n) throw new Error("金额必须 > 0");
        if (amt > maxTo) throw new Error(`金额超过上限 ${maxTo}`);
        if (action === "bet" && this.gameState.currentBet > 0n) throw new Error("已有注额，请用 raiseTo");
        if (action === "bet" && amt < this.gameState.lastFullRaise) throw new Error(`下注低于最小注 ${this.gameState.lastFullRaise}`);
        if (action === "raiseTo" && amt < t.minRaiseTo && amt !== maxTo) throw new Error(`加注低于最小加注 ${t.minRaiseTo}（短码全下除外）`);
      }
      const ix = await ixAct(this.program, this.table, this.seat, g.handId, g.actionSeq, action, amount, this.agent.keypair.publicKey);
      const { sendAndConfirm, ER_CU } = await import("./client.mjs");
      const sig = await sendAndConfirm(this.er, [ix], [this.agent.keypair], action, ER_CU);
      this.lastActedSeq = g.actionSeq;
      if (action !== "check" && action !== "fold") this.fallbacks = 0; // 主动决策清零兜底计数
      this.turn = null;
      return { sig, hand_id: Number(g.handId), action_seq: g.actionSeq };
    } finally {
      this._submitting = false;
    }
  }

  /** 长轮询（§5.3）：轮到自己返回局面；手牌结束返回结果；超时返回 waiting。 */
  async waitForTurn(timeoutMs = 25000) {
    const deadline = Date.now() + Math.min(timeoutMs, 25000);
    while (Date.now() < deadline && !this._stopped) {
      if (this.turn) return { status: "your_turn", ...this.turnView() };
      if (this.handResult && this.handResult.hand_id === Number(this.curHand) - 1) {
        const r = this.handResult;
        this.handResult = null;
        return { status: "hand_ended", ...r };
      }
      await sleep(700);
    }
    return { status: "waiting", phase: this.gameState?.phase ?? null, hand_id: Number(this.curHand) };
  }

  turnView() {
    const t = this.turn;
    return {
      hand_id: Number(t.handId),
      action_seq: t.actionSeq,
      pot: t.pot.toString(),
      to_call: t.toCall.toString(),
      min_raise_to: t.minRaiseTo.toString(),
      board: t.board,
      my_cards: t.holeCards,
      deadline_s: t.deadlineS,
      live_players: popcount(this.gameState.handMask & this.gameState.liveMask),
    };
  }

  /** 公开局面 + 自己的底牌（§6.2）。 */
  tableStateView() {
    const g = this.gameState;
    if (!g) return null;
    return {
      table_id: this.tableId,
      phase: g.phase,
      hand_id: Number(g.handId),
      pot: g.pot.toString(),
      board: g.board.slice(0, g.boardLen),
      button: g.button,
      to_act: (g.phase === 3 || g.phase === 5) ? g.toAct : null,
      action_seq: g.actionSeq,
      seats: g.seats.map((s, i) => s.status === 0 && !(g.occupiedMask & (1 << i)) ? null : ({
        seat: i,
        occupant: s.occupant,
        kind: s.kind,
        status: s.status,
        stack: s.stack.toString(),
        in_hand: s.inHand.toString(),
        folded: s.folded,
        all_in: s.allIn,
        in_this_hand: (g.handMask & (1 << i)) !== 0,
      })).filter(Boolean),
      my_seat: this.seat,
      my_cards: this.myHand && this.myHand.handId === g.handId ? this.myHand.cards : null,
      my_turn: this.turn ? { action_seq: this.turn.actionSeq, to_call: this.turn.toCall.toString(), min_raise_to: this.turn.minRaiseTo.toString(), deadline_s: this.turn.deadlineS } : null,
    };
  }
}
