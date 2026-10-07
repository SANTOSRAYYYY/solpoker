// Dump the FULL Privy app config (verbatim) for diagnosis.
const APP_ID = "cmuvtu41j006t0cl3tas12mvp";
const res = await fetch(`https://auth.privy.io/api/v1/apps/${APP_ID}`, {
  headers: { accept: "application/json", "privy-app-id": APP_ID },
});
const text = await res.text();
console.log(`HTTP ${res.status}, ${text.length}B`);
console.log(text);
