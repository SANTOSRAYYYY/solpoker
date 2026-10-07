// 探测 Privy 是否有「更新应用配置」的 API（决定能否用 app secret 直接开
// solana_wallet_auth）。只发送会被拒绝的探测请求，不改任何东西：
// - GET   已确认存在（200）
// - PATCH 未带凭证探测：401/403 = 端点存在需要认证；404/405 = 不存在
// 注意：探测体里的字段值保持与当前一致的 false，即使万一被接受也不改行为。
const APP_ID = process.env.PRIVY_APP_ID ?? "cmuvtu41j006t0cl3tas12mvp";
const url = `https://auth.privy.io/api/v1/apps/${APP_ID}`;

async function probe(method, headers, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: { accept: "application/json", "content-type": "application/json", "privy-app-id": APP_ID, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    console.log(`${method} -> HTTP ${res.status} ${text.slice(0, 200)}`);
  } catch (e) {
    console.log(`${method} -> ERR ${e.message}`);
  }
}

await probe("PATCH", {}, { solana_wallet_auth: false });
await probe("PUT", {}, { solana_wallet_auth: false });
// 带空 Basic（错误凭证）看错误是否不同
const basic = "Basic " + Buffer.from(`${APP_ID}:`).toString("base64");
await probe("PATCH", { Authorization: basic }, { solana_wallet_auth: false });
