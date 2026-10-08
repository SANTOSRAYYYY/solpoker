// Install the IDL that `anchor idl build` prints to stdout (idl-build.log)
// as target/idl/solpoker.json. Needed because anchor 1.0.2's `idl build`
// writes to stdout, not the file. Usage:
//   anchor idl build -p solpoker > idl-build.log && node scripts/install-idl.mjs
import fs from "node:fs";
const text = fs.readFileSync("idl-build.log", "utf8");
// 首个「行首 {」即 JSON 起点（兼容 \n 与 \r\n —— Windows 的 cmd 重定向给的是 \r\n）。
const m = /^(?:\uFEFF)?\{/m.exec(text);
if (!m) {
  console.error("JSON start not found");
  process.exit(1);
}
const json = text.slice(m.index);
const parsed = JSON.parse(json);
fs.writeFileSync("target/idl/solpoker.json", Buffer.from(json, "utf8"));
console.log("installed:", parsed.instructions.length, "instructions,", fs.statSync("target/idl/solpoker.json").size, "bytes");
