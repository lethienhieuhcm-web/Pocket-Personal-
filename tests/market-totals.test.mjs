// Tests for whole-market totals (Chot 22:23 27/10): publish branch,
// /api/stock/market-totals route (latest + dated + missing + bad date).
// Mock R2 only; no network, no D1, no deploy.
// Run: node tests/market-totals.test.mjs
import { register } from "node:module";
register("./flow-hooks.mjs", import.meta.url);

const { hStockPublish, hStockMarketTotals } =
  await import("../worker/src/stock.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}
function mockEnv(store){
  return {
    DATA: {
      get: async (key) => {
        const v = store.get(key);
        if(v === undefined) return null;
        return { json: async () => JSON.parse(JSON.stringify(v)) };
      },
      put: async (key, val) => { store.set(key, JSON.parse(val)); },
    },
    STOCK_PUBLISH_SECRET: "s3cr3t",
  };
}
const pubReq = (body) => ({
  headers: { get: (k) => (k === "X-Publish-Secret" ? "s3cr3t" : null) },
  json: async () => body,
});
const getReq = (url) => ({ headers: { get: () => null }, url });
const MT = {
  date: "2026-10-27", source: "HSX",
  source_url: "https://www.hsx.vn/en/du-lieu-giao-dich/thong-ke/du-lieu-cuoi-ngay",
  retrieved_at: "2026-10-27T22:07:00+07:00", rows: 766,
  total_volume: 526888500, total_value: 10289380630000,
  breakdown: {
    stock_other: { rows: 407, total_volume_shares: 468242500, total_value_vnd: 10235900170000 },
    covered_warrant: { rows: 335, total_volume_shares: 58277900, total_value_vnd: 43115500000 },
    etf_fund: { rows: 24, total_volume_shares: 368100, total_value_vnd: 10364960000 },
  },
  basis_note: "Co so khop lenh (matched).",
  verification: "Independent re-sum exact.",
};

// --- 1. Publish valid: latest + dated written ------------------------------
{
  const store = new Map();
  const res = await hStockPublish(pubReq({ market_totals: MT }), mockEnv(store));
  const body = await res.json();
  check("publish valid 200 ok written 2", res.status === 200 && body.ok === true && body.written === 2, { status: res.status, body });
  const latest = store.get("stock/market/market_totals_latest.json");
  check("latest stored with totals", latest && latest.total_volume === 526888500 && latest.date === "2026-10-27", latest);
  check("dated file stored", !!store.get("stock/market/market_totals/2026-10-27.json"), [...store.keys()]);
  check("breakdown kept", latest && latest.breakdown && latest.breakdown.covered_warrant.total_volume_shares === 58277900, latest && latest.breakdown);
}

// --- 2. Publish invalid (bad date / missing totals): written 0 ------------
{
  const store = new Map();
  const res = await hStockPublish(pubReq({ market_totals: { date: "27/10/2026", total_volume: 1, total_value: 2 } }), mockEnv(store));
  const body = await res.json();
  check("publish bad date skipped", res.status === 200 && body.ok === true && body.written === 0, { status: res.status, body });
  check("no file written on bad date", store.size === 0, [...store.keys()]);
}

// --- 3. Route: latest + dated + missing + bad date -------------------------
{
  const store = new Map();
  const env = mockEnv(store);
  await hStockPublish(pubReq({ market_totals: MT }), env);
  const r1 = await hStockMarketTotals(getReq("https://x/api/stock/market-totals"), env);
  const b1 = await r1.json();
  check("route latest available with breakdown", r1.status === 200 && b1.available === true && b1.total_value === 10289380630000 && b1.breakdown.etf_fund.rows === 24, b1);
  const r2 = await hStockMarketTotals(getReq("https://x/api/stock/market-totals?date=2026-10-27"), env);
  const b2 = await r2.json();
  check("route dated available", r2.status === 200 && b2.available === true && b2.date === "2026-10-27", b2);
  const r3 = await hStockMarketTotals(getReq("https://x/api/stock/market-totals?date=2026-10-26"), env);
  const b3 = await r3.json();
  check("route missing date available:false", r3.status === 200 && b3.available === false, b3);
  const r4 = await hStockMarketTotals(getReq("https://x/api/stock/market-totals?date=bad"), env);
  check("route bad date 400", r4.status === 400, r4.status);
  const env2 = mockEnv(new Map());
  const r5 = await hStockMarketTotals(getReq("https://x/api/stock/market-totals"), env2);
  const b5 = await r5.json();
  check("route empty store available:false", r5.status === 200 && b5.available === false, b5);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
