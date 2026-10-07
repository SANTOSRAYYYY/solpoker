// 第七轮：在 dashboard 全部 chunk 里找「登录方式」设置页的 UI 与更新调用：
// - 含 wallet_auth / solana 的设置控件文案
// - 更新应用的 mutation（PATCH/PUT + /apps/ 路径）
const base = "https://dashboard.privy.io";
const html = await fetch(`${base}/`).then((r) => r.text());
const scripts = [...html.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]);

const findContexts = (js, needle, before, after, limit) => {
  const out = [];
  let from = 0;
  while (out.length < limit) {
    const i = js.indexOf(needle, from);
    if (i === -1) break;
    out.push(js.slice(Math.max(0, i - before), i + after).replace(/\s+/g, " "));
    from = i + 1;
  }
  return out;
};

for (const src of scripts) {
  const url = src.startsWith("http") ? src : new URL(src, base).href;
  let js;
  try {
    js = await fetch(url).then((r) => r.text());
  } catch {
    continue;
  }
  const name = url.split("/").pop().split("?")[0];

  // 1) 更新调用：PATCH/PUT 附近的 apps/ 路径
  for (const ctx of findContexts(js, 'method:"PATCH"', 300, 300, 3)) {
    if (ctx.includes("apps") || ctx.includes("/api/")) console.log(`\n[PATCH] ${name}\n${ctx}`);
  }
  for (const ctx of findContexts(js, '"PATCH"', 200, 200, 3)) {
    if (ctx.includes("/api/")) console.log(`\n[PATCH2] ${name}\n${ctx}`);
  }

  // 2) 设置文案：与 wallet_auth 相邻的 UI 字符串
  for (const ctx of findContexts(js, "wallet_auth", 220, 220, 6)) {
    if (/label|title|description|toggle|checkbox|Tooltip|text/i.test(ctx) && !ctx.includes("zM()")) {
      console.log(`\n[UI] ${name}\n${ctx}`);
    }
  }
}
console.log("\nDONE");
