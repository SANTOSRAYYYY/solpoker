/**
 * probe-vrf-latency.ts — Stage 2 取证脚本：测量 TEE ER 内逐街 VRF 延迟（p50/p95/p99）
 *
 * 用途
 *   对照设计文档 §17 S2「延迟 p50/p95」验收项，在本地 MagicBlock 栈和
 *   devnet-tee 上逐街测量「request_vrf 交易确认 → vrf_callback 落地」的往返延迟，
 *   为 Table.vrf_timeout_s（默认 10 秒）和 vrf_max_attempts（默认 3）提供实测依据。
 *
 * 前置条件（重要：本脚本不能脱离已部署程序独立运行）
 *   1. solpoker 程序已完成 Stage 2 的 V1 拆分实现：act/advance 只把 VrfSlot
 *      置 Ready，permissionless `request_vrf` 在 ER 内向队列
 *      5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc 发 CPI；
 *      `vrf_callback`（#[vrf_callback]，校验 scoped_vrf_identity(&crate::ID)）
 *      把 randomness 写进 Deck。见设计文档 §9、§17 S2。
 *   2. 已建桌并委托到 TEE ER（13 个常驻账户），Game/Deck 账户已存在。
 *   3. 签名密钥（探测钱包）在 ER 端点已鉴权，且有能力支付请求交易的手续费。
 *      ER 队列 5hBR… 的请求当前免费（设计 §9「费用」），但外层交易手续费
 *      付款人仍需满足 Agave 免租规则。
 *
 * 运行
 *   node scripts/probe-vrf-latency.ts [--n <count>] [--priority normal|high]
 *                                     [--out <file>] [--street-cycle]
 *
 * 环境变量
 *   ER_ENDPOINT        TEE ER RPC 端点。默认 https://devnet-tee.magicblock.app。
 *                      注意：TEE 端点要求在 URL 上带 ?token=（见下方 getAuthToken）。
 *                      本地栈用 http://127.0.0.1:7799（ER RPC，也要 token；QFS 6699 同理）。
 *   ER_AUTH_TOKEN      TEE 鉴权 token。获取流程见下方注释。
 *   ER_KEYPAIR         签名密钥的 JSON 文件路径（solana-keygen 格式）。
 *                      只用于 devnet；不得是主网/真实资金密钥。
 *   SOLPOKER_PROGRAM_ID  solpoker 程序 ID（devnet 部署后填入，或传 --program-id）。
 *   SOLPOKER_TABLE       Table 账户地址（用于推导 Game/Deck PDA）。
 *
 * 输出
 *   每个 draw 一行 JSON 记录到 stdout；结束后输出汇总（整体与分街的 p50/p95/p99），
 *   并写入 --out 指定的文件（默认 probe-vrf-latency-<ts>.json）。
 *
 * getAuthToken 流程（设计 §13.2，动手前先做一次，结果缓存在内存/环境变量里）
 *   1. 前端/脚本用钱包 signMessage 对 challenge 签名——challenge 必须用
 *      crypto.getRandomValues 生成，不要用 Math.random()；
 *   2. 调 TEE 端点的 getAuthToken 换得 token（SDK 0.17.3 提供该 helper，
 *      以 SDK 源码为准，不要凭记忆编函数签名）；
 *   3. 之后所有 ER RPC 连接的 URL 都带 ?token=…；token 只放内存，
 *      并提供「重新鉴权」入口；
 *   4. 在 MagicBlock 公布 TDX 度量值之前，这层门控只能证明「对面是 TDX 机器」。
 *
 * 发送纪律（设计 §13.3）
 *   本脚本一律 sendRawTransaction + 轮询确认，不用 Anchor .rpc() 的默认确认
 *   （Stage 0 实测 .rpc() 要 1.8–9.3 秒，直接发送约 2 个往返）。
 *
 * 注意
 *   - 本脚本测量的是「探测程序」路径的延迟，即 request_vrf 的完整往返；
 *     真实牌局里 act（结束本街）→ VRF 回调 → advance（发牌）的关键路径还要
 *     加上两条 act/advance 往返（设计 §6.4），评估预算时别忘了这两笔。
 *   - 队列拥堵时重试参数（10 秒 × 3 次）的效果不在本脚本范围，由链上
 *     retry_vrf 指令的测试覆盖（设计 §17 S2「10 秒超时重试」「3 次耗尽」）。
 *   - 官方示例停留在 SDK 0.16.2，只借鉴思路；API 以 0.17.3 源码为准。
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// 常量（钉死地址，见 context-block-v5 【关键地址】）
// ---------------------------------------------------------------------------

/** devnet 与主网共用的 ER VRF 队列（已核实委托给「任意 validator」，TEE ER 可直接用）。 */
const ER_VRF_QUEUE = new PublicKey(
  "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc"
);
/** 本地栈 ER 队列（scripts/mb-stack.sh 会把 53 条陈旧请求清成 clean queue 后使用）。 */
const LOCAL_ER_VRF_QUEUE = new PublicKey(
  "Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT"
);

/** 按端点选队列：本地栈（ER RPC 7799）用 Sc9M…，devnet-tee / mainnet-tee 用 5hBR…。 */
function resolveVrfQueue(endpoint: string): PublicKey {
  return /127\.0\.0\.1:7799|localhost:7799/.test(endpoint)
    ? LOCAL_ER_VRF_QUEUE
    : ER_VRF_QUEUE;
}

/** VRF 程序（回调签名校验用，context-block-v5 【关键地址】）。 */
const VRF_PROGRAM_ID = new PublicKey(
  "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"
);

const DEFAULT_ER_ENDPOINT = "https://devnet-tee.magicblock.app";

/** 逐街目标（对应 Game.vrf.target：街或 runout，见设计 §3.2 VrfSlot）。 */
const STREETS = ["Preflop", "Flop", "Turn", "River", "Runout"] as const;
type Street = (typeof STREETS)[number];

/** 轮询确认与回调落地的间隔/上限。 */
const CONFIRM_POLL_INTERVAL_MS = 250;
const CONFIRM_TIMEOUT_MS = 15_000;
const CALLBACK_POLL_INTERVAL_MS = 250;
/** 单次 draw 的上限：超过即记为 timeout（对照 10 秒重试预算看分布尾部）。 */
const CALLBACK_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

type CliArgs = {
  n: number;
  priority: "normal" | "high";
  out: string;
  programId: PublicKey | null;
  table: PublicKey | null;
};

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    n: 20,
    priority: "normal",
    out: `probe-vrf-latency-${Date.now()}.json`,
    programId: null,
    table: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--n":
        args.n = parseInt(argv[++i], 10);
        break;
      case "--priority":
        args.priority = argv[++i] as "normal" | "high";
        if (args.priority !== "normal" && args.priority !== "high") {
          fail("--priority 只能是 normal 或 high");
        }
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--program-id":
        args.programId = new PublicKey(argv[++i]);
        break;
      case "--table":
        args.table = new PublicKey(argv[++i]);
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        fail(`未知参数: ${argv[i]}（--help 查看用法）`);
    }
  }
  if (!Number.isFinite(args.n) || args.n < 1) fail("--n 必须是正整数");
  return args;
}

function printUsage(): void {
  console.log(
    "用法: node scripts/probe-vrf-latency.ts [--n <count>] [--priority normal|high] " +
      "[--out <file>] [--program-id <addr>] [--table <addr>]\n\n" +
      "环境变量: ER_ENDPOINT, ER_AUTH_TOKEN, ER_KEYPAIR, SOLPOKER_PROGRAM_ID, SOLPOKER_TABLE"
  );
}

function fail(msg: string): never {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 连接与鉴权
// ---------------------------------------------------------------------------

/**
 * 组装 ER 连接。TEE 端点要求 URL 带 ?token=（设计 §13.1）；
 * token 来自 getAuthToken 流程（文件头注释），通过 ER_AUTH_TOKEN 传入。
 */
function makeConnection(): Connection {
  const base = (process.env.ER_ENDPOINT ?? DEFAULT_ER_ENDPOINT).replace(
    /\/+$/,
    ""
  );
  const token = process.env.ER_AUTH_TOKEN;
  if (!token && base.includes("magicblock.app")) {
    fail(
      "缺少 ER_AUTH_TOKEN。TEE 端点必须带 ?token=：先用钱包 signMessage " +
        "（challenge 用 crypto.getRandomValues）调 getAuthToken 换取，详见文件头注释与设计 §13.2。"
    );
  }
  const url = token ? `${base}?token=${encodeURIComponent(token)}` : base;
  return new Connection(url, {
    commitment: "confirmed",
    // 设计 §13.3：直接发送 + 轮询；confirmTransaction 用 ws 订阅，
    // 需要双端点（ws 端口）时由 ER_ENDPOINT 的部署环境保证。
  });
}

function loadSigner(): Keypair {
  const path = process.env.ER_KEYPAIR;
  if (!path) {
    fail(
      "缺少 ER_KEYPAIR（solana-keygen 格式 JSON 路径）。只用于 devnet/本地。"
    );
  }
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(path, "utf-8")))
  );
}

// ---------------------------------------------------------------------------
// request_vrf 交易构造 —— TODO(Stage 2 链上实现落地后填实)
// ---------------------------------------------------------------------------

// 以下为探测程序的账户推导。程序 ID 与 Table 地址在部署后从环境变量传入。
// PDA 种子以链上实现为准（设计 §3.1）：Game = ["game", table]，Deck = ["deck", table, epoch]。

function deriveGamePda(programId: PublicKey, table: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), table.toBuffer()],
    programId
  );
  return pda;
}

function deriveDeckPda(
  programId: PublicKey,
  table: PublicKey,
  epoch: number
): PublicKey {
  // epoch 来自 Table 账户（逃生后 +1，见设计 §5.3）；探测脚本固定传当前 epoch。
  const epochBuf = Buffer.alloc(2);
  epochBuf.writeUInt16LE(epoch, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("deck"), table.toBuffer(), epochBuf],
    programId
  );
  return pda;
}

/**
 * 构造一条 request_vrf 交易（V1 拆分后的 permissionless 指令，设计 §6.2/§14.2）。
 *
 * TODO(Stage 2): 此处依赖尚未定稿的字节级编码，落地后填实：
 *   1. 指令 discriminator：request_vrf 在 IDL 中的 sighash；
 *   2. 指令参数：target（Street|Runout）、attempt、caller_seed。
 *      caller_seed = sha256("solpoker/vrf/v1" ‖ table ‖ hand_id_be ‖ target ‖ attempt)，
 *      保证每次请求都不同（设计 §9）；attempt 从 0 开始，重试 +1；
 *   3. --priority high 如何表达：对照 SDK 0.17.3 的 create_request_randomness_ix
 *      是否暴露优先级/费用参数（L1 队列 normal 0.0005 / high 0.0008 SOL；
 *      ER 队列 5hBR… 当前免费，见设计 §9），以 SDK 源码为准填实；
 *   4. accounts 列表：Game（可写，VrfSlot Ready→Pending）、Deck（回调写 randomness）、
 *      队列账户（ER 队列 5hBR…，本地 Sc9M…）、VRF 程序、回调账户 PDA、系统程序、
 *      以及 invoke_signed_vrf 要求的 scoped identity 相关账户。
 */
function buildRequestVrfTx(opts: {
  programId: PublicKey;
  table: PublicKey;
  street: Street;
  attempt: number;
  priority: "normal" | "high";
  signer: Keypair;
  recentBlockhash: string;
  queue: PublicKey;
}): Transaction {
  const {
    programId,
    table,
    street,
    attempt,
    priority,
    signer,
    recentBlockhash,
    queue,
  } = opts;

  // TODO(Stage 2): 用 IDL sighash + Borsh 编码替换这里的占位 discriminator。
  const discriminator = Buffer.from("0000000000000000", "hex");
  // TODO(Stage 2): Borsh 编码 target/attempt/caller_seed（caller_seed 按 §9 公式）。
  const payload = Buffer.alloc(0);

  // TODO(Stage 2): 账户元组以链上 #[derive(Accounts)] 为准。此处先放探测必需项。
  const ix = new TransactionInstruction({
    programId,
    keys: [
      {
        pubkey: deriveGamePda(programId, table),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: deriveDeckPda(programId, table, /* epoch */ 0),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: queue, isSigner: false, isWritable: true },
      { pubkey: VRF_PROGRAM_ID, isSigner: false, isWritable: false },
      // { pubkey: callbackPda, ... }, { pubkey: SystemProgram.programId, ... }, ...
    ],
    data: Buffer.concat([discriminator, payload]),
  });
  void priority; // TODO(Stage 2): 按 SDK 源码填实优先级/费用参数。

  const tx = new Transaction({
    recentBlockhash,
    feePayer: signer.publicKey,
  }).add(ix);
  tx.sign(signer);
  return tx;
}

// ---------------------------------------------------------------------------
// 回调落地检测 —— TODO(Stage 2): 取决于 Game/Deck 布局定稿
// ---------------------------------------------------------------------------

type VrfStatus = "pending" | "fulfilled";

/**
 * 读取 Game 的 VrfSlot，判断是否已 fulfilled。
 *
 * TODO(Stage 2): Game 布局在 Stage 5–6 才定稿字节级结构，这里先按设计 §3.2
 * 的语义占位：Game.vrf = { target, attempt, requested_at, pending }。
 * 落地后替换为对 Game 账户数据的实际反序列化（前 8 字节 discriminator 校验 +
 * 按结构偏移读取 vrf.pending 与 vrf.attempt），并要求：
 *   - pending == false 且 attempt 匹配本次请求 → fulfilled；
 *   - 旧 attempt 的迟到回调已由链上逻辑返回 Ok 并忽略（设计 §9），
 *     探测侧只认当前 attempt，天然把迟到回调计为「被忽略」，正好复现
 *     §17 S2「旧回调 Ok+忽略」的观测口径。
 * 备选口径：直接轮询 Deck.vrf_out[target] 是否从全零变为非零。
 */
function readVrfStatus(
  _connection: Connection,
  _game: PublicKey,
  _attempt: number
): Promise<VrfStatus> {
  throw new Error(
    "TODO(Stage 2): Game/Deck 布局定稿后实现 readVrfStatus；见函数注释。"
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

type DrawRecord = {
  draw: number;
  street: Street;
  target: number;
  attempt: number;
  priority: "normal" | "high";
  requestSignature: string | null;
  sentAtMs: number;
  confirmedAtMs: number | null;
  fulfilledAtMs: number | null;
  /** sentAt → fulfilledAt 的总往返，是本脚本的延迟口径。 */
  rttMs: number | null;
  status: "ok" | "confirm-timeout" | "callback-timeout" | "error";
  error: string | null;
};

async function waitForConfirmation(
  connection: Connection,
  signature: string,
  deadlineMs: number
): Promise<void> {
  for (;;) {
    const { value } = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (
      value &&
      (value.confirmationStatus === "confirmed" ||
        value.confirmationStatus === "finalized")
    ) {
      if (value.err)
        throw new Error(`交易执行失败: ${JSON.stringify(value.err)}`);
      return;
    }
    if (Date.now() > deadlineMs) throw new Error("确认超时");
    await sleep(CONFIRM_POLL_INTERVAL_MS);
  }
}

async function waitForCallback(
  connection: Connection,
  game: PublicKey,
  attempt: number,
  deadlineMs: number
): Promise<number> {
  for (;;) {
    const status = await readVrfStatus(connection, game, attempt);
    if (status === "fulfilled") return Date.now();
    if (Date.now() > deadlineMs) throw new Error("回调超时");
    await sleep(CALLBACK_POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 最近秩百分位（nearest-rank），与设计 §17 S2 的 p50/p95 口径一致。 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

function summarize(records: DrawRecord[]): Record<string, unknown> {
  const ok = records.filter((r) => r.status === "ok");
  const rtts = ok.map((r) => r.rttMs as number).sort((a, b) => a - b);
  const endpoint = process.env.ER_ENDPOINT ?? DEFAULT_ER_ENDPOINT;
  const byStreet: Record<string, unknown> = {};
  for (const street of STREETS) {
    const sub = ok
      .filter((r) => r.street === street)
      .map((r) => r.rttMs as number)
      .sort((a, b) => a - b);
    byStreet[street] = {
      n: sub.length,
      p50: percentile(sub, 50),
      p95: percentile(sub, 95),
      p99: percentile(sub, 99),
    };
  }
  return {
    total: records.length,
    ok: ok.length,
    failed: records.length - ok.length,
    endpoint,
    queue: resolveVrfQueue(endpoint).toBase58(),
    overall: {
      n: rtts.length,
      p50: percentile(rtts, 50),
      p95: percentile(rtts, 95),
      p99: percentile(rtts, 99),
    },
    byStreet,
    records,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  const programId =
    args.programId ??
    (process.env.SOLPOKER_PROGRAM_ID
      ? new PublicKey(process.env.SOLPOKER_PROGRAM_ID)
      : null);
  const table =
    args.table ??
    (process.env.SOLPOKER_TABLE
      ? new PublicKey(process.env.SOLPOKER_TABLE)
      : null);
  if (!programId) fail("缺少程序 ID：--program-id 或 SOLPOKER_PROGRAM_ID");
  if (!table) fail("缺少桌地址：--table 或 SOLPOKER_TABLE");

  const connection = makeConnection();
  const signer = loadSigner();
  const game = deriveGamePda(programId, table);
  const queue = resolveVrfQueue(process.env.ER_ENDPOINT ?? DEFAULT_ER_ENDPOINT);

  console.error(
    `probe-vrf-latency: n=${args.n} priority=${
      args.priority
    } queue=${queue.toBase58()}`
  );

  const records: DrawRecord[] = [];
  for (let i = 0; i < args.n; i++) {
    // 逐街循环：一次探测跑遍 Preflop/Flop/Turn/River/Runout，再从头循环，
    // 这样分街 p50/p95 与整体分布可同时得到（对照设计 §6.1 状态机的逐街请求）。
    const street = STREETS[i % STREETS.length];
    const target = i % STREETS.length;
    const attempt = 0; // 探测单次请求；重试路径由链上 retry_vrf 测试覆盖。

    const record: DrawRecord = {
      draw: i,
      street,
      target,
      attempt,
      priority: args.priority,
      requestSignature: null,
      sentAtMs: Date.now(),
      confirmedAtMs: null,
      fulfilledAtMs: null,
      rttMs: null,
      status: "error",
      error: null,
    };

    try {
      const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const tx = buildRequestVrfTx({
        programId,
        table,
        street,
        attempt,
        priority: args.priority,
        signer,
        recentBlockhash,
        queue,
      });

      // 设计 §13.3：sendRawTransaction + 轮询确认，不用 Anchor .rpc()。
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
      });
      record.requestSignature = signature;

      const confirmDeadline = Date.now() + CONFIRM_TIMEOUT_MS;
      await waitForConfirmation(connection, signature, confirmDeadline);
      record.confirmedAtMs = Date.now();

      record.fulfilledAtMs = await waitForCallback(
        connection,
        game,
        attempt,
        Date.now() + CALLBACK_TIMEOUT_MS
      );
      record.rttMs = record.fulfilledAtMs - record.sentAtMs;
      record.status = "ok";
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err);
      record.status =
        record.confirmedAtMs === null ? "confirm-timeout" : "callback-timeout";
      if (!/超时/.test(record.error)) record.status = "error";
    }

    records.push(record);
    // 每行一条 JSON，方便长跑时 tail -f 观察分布。
    console.log(JSON.stringify(record));
  }

  const summary = summarize(records);
  console.log(JSON.stringify({ summary }, null, 2));
  writeFileSync(args.out, JSON.stringify(summary, null, 2));
  console.error(`汇总已写入 ${args.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
