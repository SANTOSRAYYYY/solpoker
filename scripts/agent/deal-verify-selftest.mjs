// 自测：用仓库的 Stage 4 测试向量（vectors/v1/*.json）校验 JS 移植版发牌复算器。
// 用法：node scripts/agent/deal-verify-selftest.mjs
// 期望输出：每个向量 PASS，末尾 DEAL_VERIFY_SELFTEST_OK
import fs from "node:fs";
import path from "node:path";
import { verifyVector } from "../../web/lib/deal-verify.mjs";
import { nodeCrypto } from "../../web/lib/deal-verify-node.mjs";

const dir = "vectors/v1";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
  console.error("没有找到向量文件（vectors/v1/*.json）");
  process.exit(1);
}

const crypto = nodeCrypto;
let failed = 0;
for (const f of files) {
  const vector = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  try {
    const { diffs } = await verifyVector(crypto, vector);
    if (diffs.length === 0) {
      console.log(`PASS  ${f}  (board=${JSON.stringify(vector.expected.board)} button=${vector.expected.button})`);
    } else {
      failed++;
      console.log(`FAIL  ${f}`);
      for (const d of diffs.slice(0, 6)) console.log(`      ${d}`);
    }
  } catch (e) {
    failed++;
    console.log(`ERROR ${f}: ${e.message}`);
  }
}

if (failed === 0) {
  console.log(`DEAL_VERIFY_SELFTEST_OK（${files.length}/${files.length} 向量与 Python/Rust 参考实现逐字节一致）`);
} else {
  console.log(`DEAL_VERIFY_SELFTEST_FAILED（${failed}/${files.length} 不一致）`);
  process.exit(1);
}
