// 用 app secret（Basic id:secret）试调 dashboard API：
// 目标：把 solana_wallet_auth 打开。若鉴权通过就是成功；否则看错误类型
// （401=仅会话可用；404=路径错；405=方法错）。
// secret 只从环境变量读取，不落盘。
const APP_ID = "cmuvtu41j006t0cl3tas12mvp";
const SECRET = process.env.PRIVY_APP_SECRET;
if (!SECRET) {
  console.error("PRIVY_APP_SECRET not set");
  process.exit(1);
}
const basic = "Basic " + Buffer.from(`${APP_ID}:${SECRET}`).toString("base64");

async function call(label, method, url, body, authHeader) {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "privy-app-id": APP_ID,
        ...(authHeader ?? {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    console.log(`${label} -> HTTP ${res.status} | ${text.slice(0, 220)}`);
    return { status: res.status, text };
  } catch (e) {
    console.log(`${label} -> ERR ${e.message}`);
    return { status: 0, text: "" };
  }
}

// 1) GET dashboard api 看鉴权要求
await call("GET  dashboard/api/dashboard/apps/:id (basic)", "GET",
  `https://dashboard.privy.io/api/dashboard/apps/${APP_ID}`, null, { Authorization: basic });
await call("GET  dashboard/api/dashboard/apps/:id (privy-app-id only)", "GET",
  `https://dashboard.privy.io/api/dashboard/apps/${APP_ID}`, null, null);

// 2) PATCH 尝试开启
await call("PATCH dashboard/api/dashboard/apps/:id (basic, siws=true)", "PATCH",
  `https://dashboard.privy.io/api/dashboard/apps/${APP_ID}`, { solana_wallet_auth: true }, { Authorization: basic });
await call("POST  dashboard/api/dashboard/apps/:id (basic, siws=true)", "POST",
  `https://dashboard.privy.io/api/dashboard/apps/${APP_ID}`, { solana_wallet_auth: true }, { Authorization: basic });

// 3) auth.privy.io 上的其他形态
await call("PATCH auth/api/v1/apps/:id (basic, siws=true)", "PATCH",
  `https://auth.privy.io/api/v1/apps/${APP_ID}`, { solana_wallet_auth: true }, { Authorization: basic });
await call("POST  auth/api/v1/apps/:id/update", "POST",
  `https://auth.privy.io/api/v1/apps/${APP_ID}/update`, { solana_wallet_auth: true }, { Authorization: basic });
