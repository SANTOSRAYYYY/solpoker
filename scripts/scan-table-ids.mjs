// 扫描 0..64 所有可能桌号：是否存在、kind、mint、blind、delegated。
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";

const L1_URL = process.env.L1_URL ?? "http://127.0.0.1:8898/devnet";
const idl = JSON.parse(fs.readFileSync("target/idl/solpoker.json", "utf8"));
const programId = new PublicKey(idl.address);
const TUSDC = "9WUwFXpRsFbZa8yxMXciKaiXGXw4TxWekS7JJGtqG6uH";
const DLP = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const l1 = new Connection(L1_URL, "confirmed");
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

const addrs = [];
for (let id = 0; id <= 64; id++) {
  addrs.push([id, PublicKey.findProgramAddressSync([Buffer.from("table"), u32le(id)], programId)[0]]);
}
const infos = await l1.getMultipleAccountsInfo(addrs.map(([, a]) => a));
for (let i = 0; i < addrs.length; i++) {
  const [id, pk] = addrs[i];
  const acc = infos[i];
  if (!acc) continue;
  const owner = acc.owner.toBase58();
  const kind = acc.data.length >= 145 ? acc.data[44] : "?";
  const mint = acc.data.length >= 79 ? new PublicKey(acc.data.slice(47, 79)).toBase58() : "?";
  const sb = acc.data.length >= 87 ? Number(acc.data.readBigUInt64LE(79)) / 1e6 : "?";
  const bb = acc.data.length >= 95 ? Number(acc.data.readBigUInt64LE(87)) / 1e6 : "?";
  console.log(
    `#${id.toString().padStart(2)} ${pk.toBase58().slice(0, 8)}… owner=${owner === DLP ? "DLP(已委托)" : owner.slice(0, 8)} kind=${kind} mint=${mint === TUSDC ? "tUSDC" : mint.slice(0, 8)} blinds=${sb}/${bb}`
  );
}
