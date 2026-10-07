// 直接拉取 Privy 应用配置：GET https://auth.privy.io/api/v1/apps/:app_id
// 看服务端为这个应用启用了哪些登录方式/链（Solana 是否开启）。
// 认证方式尝试：无 auth / Basic(app_id:) / Basic(app_id:app_secret)。
const APP_ID = process.env.PRIVY_APP_ID ?? "cmuvtu41j006t0cl3tas12mvp";
const APP_SECRET = process.env.PRIVY_APP_SECRET ?? "";
const url = `https://auth.privy.io/api/v1/apps/${APP_ID}`;

const variants = [
  ["no-auth", {}],
  ["basic-id-only", { Authorization: "Basic " + Buffer.from(`${APP_ID}:`).toString("base64") }],
];
if (APP_SECRET) {
  variants.push([
    "basic-id-secret",
    { Authorization: "Basic " + Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64") },
  ]);
}

for (const [name, headers] of variants) {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "privy-app-id": APP_ID, ...headers },
    });
    const text = await res.text();
    console.log(`--- ${name}: HTTP ${res.status} (${text.length}B)`);
    if (res.ok) {
      const cfg = JSON.parse(text);
      console.log(
        JSON.stringify(
          {
            id: cfg.id,
            name: cfg.name,
            login_methods: cfg.login_methods,
            embedded_wallet_config: cfg.embedded_wallet_config,
            allowed_domains: cfg.allowed_domains,
            wallet_auth: cfg.wallet_auth,
            solana: cfg.solana,
            chains: cfg.chains,
          },
          null,
          1
        )
      );
      break;
    } else {
      console.log(text.slice(0, 300));
    }
  } catch (e) {
    console.log(`--- ${name}: ERROR ${e.message}`);
  }
}
