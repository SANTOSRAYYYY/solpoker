// 探针：ER（devnet-tee）是否提供交易历史（getSignaturesForAddress / getTransaction）
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";

const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);
const L1 = new Connection("https://rpc.magicblock.app/devnet", "confirmed");
const ER = new Connection("https://devnet-tee.magicblock.app", "confirmed");

const u32le = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const enc = (s) => new TextEncoder().encode(s);
const table = pda([enc("table"), u32le(11)]);
const game = pda([enc("game"), table.toBytes()]);

for (const [name, conn] of [["ER", ER], ["L1", L1]]) {
  try {
    const sigs = await conn.getSignaturesForAddress(game, { limit: 5 });
    console.log(`${name} getSignaturesForAddress(game#11): ${sigs.length} 条`);
    for (const s of sigs.slice(0, 3)) {
      console.log(`   ${s.signature.slice(0, 24)}… slot=${s.slot} err=${!!s.err} t=${s.blockTime ?? "?"}`);
    }
    if (sigs.length > 0) {
      try {
        const tx = await conn.getTransaction(sigs[0].signature, {
          maxSupportedTransactionVersion: 0,
        });
        const keys = tx?.transaction.message.staticAccountKeys?.length ?? 0;
        const logs = tx?.meta?.logMessages?.length ?? 0;
        console.log(`   getTransaction ok? keys=${keys} logs=${logs} accountKeys在不在? ${tx ? "有" : "无"}`);
      } catch (e) {
        console.log(`   getTransaction 失败: ${String(e.message ?? e).slice(0, 120)}`);
      }
    }
  } catch (e) {
    console.log(`${name} getSignaturesForAddress 失败: ${String(e.message ?? e).slice(0, 160)}`);
  }
}
