// 测试币水龙头（devnet）：补足 SOL（手续费）+ tUSDC（买入）。
//
// 安全边界：
// - 部署者私钥只在服务端读取：优先 SOLPOKER_DEPLOYER_KEYPAIR 环境变量（JSON 数组或 base58，
//   serverless 用），否则读本地文件（默认 ../keys/deployer.json，可用 SOLPOKER_DEPLOYER_KEYPAIR_PATH 覆盖）。
//   绝不进浏览器；
// - 只在 devnet 生效（L1 RPC 不是 devnet 直接拒绝），避免误配主网被当提款机；
// - 余额式补足：只有余额低于阈值才发（tUSDC < 5 或 SOL < 0.01），一次补到目标额；
// - 同一 IP 10 分钟冷却（内存态，重启清零——devnet 够用）。
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { parseKeypairMaterial } from "@/lib/faucet-key";
import { L1_RPC, TUSDC_MINT } from "@/lib/config";

export const runtime = "nodejs";
/** serverless（Vercel）上给足时间；本机无影响 */
export const maxDuration = 60;

const SOL_TARGET = 0.1; // SOL
const SOL_THRESHOLD = 0.01;
const USDC_TARGET = 100; // tUSDC（6 位小数）
const USDC_THRESHOLD = 5;
const IP_COOLDOWN_MS = 10 * 60 * 1000;

const lastByIp = new Map<string, number>();

function loadDeployer(): Keypair {
  const env = process.env.SOLPOKER_DEPLOYER_KEYPAIR;
  if (env && env.trim()) {
    return Keypair.fromSecretKey(parseKeypairMaterial(env));
  }
  const p =
    process.env.SOLPOKER_DEPLOYER_KEYPAIR_PATH ??
    path.resolve(process.cwd(), "../keys/deployer.json");
  return Keypair.fromSecretKey(parseKeypairMaterial(fs.readFileSync(p, "utf8")));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "local";

  if (!/devnet/i.test(L1_RPC)) {
    return Response.json(
      { ok: false, error: "faucet is devnet-only（当前 RPC 不是 devnet，已拒绝）" },
      { status: 400 }
    );
  }

  let address = "";
  try {
    ({ address } = (await req.json()) as { address: string });
  } catch {
    /* fallthrough */
  }

  let wallet: PublicKey;
  try {
    wallet = new PublicKey(address);
    if (!PublicKey.isOnCurve(wallet.toBytes())) {
      // 链上 PDA 不能签名：直接退回，避免把币打给一个拿不出来的地址
      throw new Error("off-curve");
    }
  } catch {
    return Response.json({ ok: false, error: "invalid wallet address" }, { status: 400 });
  }

  const last = lastByIp.get(ip) ?? 0;
  if (Date.now() - last < IP_COOLDOWN_MS) {
    const retryAfterS = Math.ceil((IP_COOLDOWN_MS - (Date.now() - last)) / 1000);
    return Response.json(
      { ok: false, error: "cooldown", retryAfterS },
      { status: 429, headers: { "retry-after": String(retryAfterS) } }
    );
  }

  try {
    const l1 = new Connection(L1_RPC, "confirmed");
    const deployer = loadDeployer();

    // 当前余额（SOL 用 lamports 精度，tUSDC 用 6 位小数）
    const [solLamports, usdcBal] = await Promise.all([
      l1.getBalance(wallet),
      (async () => {
        const ata = getAssociatedTokenAddressSync(TUSDC_MINT, wallet);
        const acc = await l1.getTokenAccountBalance(ata).catch(() => null);
        return acc ? Number(acc.value.uiAmount ?? 0) : 0;
      })(),
    ]);
    const sol = solLamports / 1e9;

    const solNeed = sol < SOL_THRESHOLD ? SOL_TARGET - sol : 0;
    const usdcNeed = usdcBal < USDC_THRESHOLD ? USDC_TARGET - usdcBal : 0;

    if (solNeed <= 0 && usdcNeed <= 0) {
      return Response.json({
        ok: true,
        already: true,
        balances: { sol, usdc: usdcBal },
        targets: { sol: SOL_TARGET, usdc: USDC_TARGET },
      });
    }

    const ixs = [];
    if (solNeed > 0) {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: deployer.publicKey,
          toPubkey: wallet,
          lamports: Math.round(solNeed * 1e9),
        })
      );
    }
    if (usdcNeed > 0) {
      const ata = getAssociatedTokenAddressSync(TUSDC_MINT, wallet);
      if (!(await l1.getAccountInfo(ata))) {
        ixs.push(
          createAssociatedTokenAccountInstruction(deployer.publicKey, ata, wallet, TUSDC_MINT)
        );
      }
      ixs.push(
        createMintToInstruction(
          TUSDC_MINT,
          ata,
          deployer.publicKey,
          BigInt(Math.round(usdcNeed * 1e6))
        )
      );
    }

    const tx = new Transaction().add(...ixs);
    tx.feePayer = deployer.publicKey;
    tx.recentBlockhash = (await l1.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(deployer);
    const sig = await l1.sendRawTransaction(tx.serialize());

    // 轮询到 confirmed：本机 ~1-2s 就能确认；serverless 上传入时间可能不够，
    // 到点就先把已提交的签名返回（pending=true），前端提示"已提交，等待确认"。
    const t0 = Date.now();
    let confirmed = false;
    for (;;) {
      const st = await l1.getSignatureStatuses([sig]);
      const s = st.value[0];
      if (s?.err) {
        return Response.json(
          { ok: false, error: `transaction failed: ${JSON.stringify(s.err)}`, sig },
          { status: 500 }
        );
      }
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
        confirmed = true;
        break;
      }
      if (Date.now() - t0 > 20_000) break;
      await sleep(700);
    }

    lastByIp.set(ip, Date.now());
    return Response.json({
      ok: true,
      sig,
      pending: !confirmed,
      sent: { sol: Math.max(0, solNeed), usdc: Math.max(0, usdcNeed) },
      targets: { sol: SOL_TARGET, usdc: USDC_TARGET },
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
