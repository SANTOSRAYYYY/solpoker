// Node 版 crypto 后端（node:crypto）——给 scripts/agent 下的复算工具与自测用。
// 浏览器不引用本文件（deal-verify.mjs 里不能出现 node: 前缀的 import，否则 webpack 报
// UnhandledSchemeError）。
import { createHash, createHmac } from "node:crypto";
import { cat } from "./deal-verify.mjs";

export const nodeCrypto = {
  async sha256(...parts) {
    return new Uint8Array(
      createHash("sha256")
        .update(Buffer.from(cat(...parts)))
        .digest()
    );
  },
  async hmacSha256(key, msg) {
    return new Uint8Array(
      createHmac("sha256", Buffer.from(key))
        .update(Buffer.from(msg))
        .digest()
    );
  },
};
