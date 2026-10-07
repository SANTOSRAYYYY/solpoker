// 抓 Privy 文档原文，检索「Solana 登录开关 / Could not log in with wallet /
// SIWS」相关的确切描述。输出命中片段供诊断。
const urls = [
  "https://docs.privy.io/llms.txt",
];
const res = await fetch(urls[0]);
const t = await res.text();
console.log("llms.txt len:", t.length);
const hits = t
  .split("\n")
  .filter((l) => /solana|siws|sign in with solana|wallet login|log in with wallet|troubleshoot/i.test(l));
console.log("--- relevant index lines ---");
console.log(hits.slice(0, 50).join("\n"));
