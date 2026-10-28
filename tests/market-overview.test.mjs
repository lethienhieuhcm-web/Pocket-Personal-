// Tests for market overview block (Chot 11:12 28/10): publish branch
// live_overview, /api/stock/divergence + /api/stock/live-overview routes
// (auth-gated, missing file -> empty shape, frontend shows "—").
// Mock R2 only; no network, no D1, no deploy.
// Run: node tests/market-overview.test.mjs
// Minimal Cache API stub (Workers `caches.default` does not exist in Node).
globalThis.caches = {
  default: {
    _m: new Map(),
    async match(req){ const r = this._m.get(req.url); return r ? r.clone() : undefined; },
    async put(req, resp){ this._m.set(req.url, resp.clone()); },
  },
};

import { register } from "node:module";
register("./flow-hooks.mjs", import.meta.url);

const { hStockPublish, hStockDivergence, hStockLiveOverview } =
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
const OV = {
  session_date: "2026-10-28",
  retrieved_at: "2026-10-28T04:15:00.000Z",
  source: "direct:kbs-board-full",
  n_symbols: 1520,
  advancers: 700, decliners: 700, unchanged: 120,
  trin: 1.2345, turnover_total: 12345678900000,
  by_exchange: {
    HOSE: { advancers: 200, decliners: 190, unchanged: 16, adv_volume: 1000, dec_volume: 900 },
    HNX: { advancers: 100, decliners: 110, unchanged: 20, adv_volume: 100, dec_volume: 120 },
  },
};

// --- 1. Publish valid: live_overview written, counted -----------------------
{
  const store = new Map();
  const res = await hStockPublish(pubReq({ live_overview: OV }), mockEnv(store));
  const body = await res.json();
  check("publish valid 200 ok written 1", res.status === 200 && body.ok === true && body.written === 1, { status: res.status, body });
  const d = store.get("stock/market/live_overview.json");
  check("stored with trin + by_exchange", d && d.trin === 1.2345 && d.by_exchange && d.by_exchange.HOSE.advancers === 200, d);
  check("stored with session_date + updated, no prov", d && d.session_date === "2026-10-28" && !!d.updated && !d._prov, d);
}

// --- 2. Publish invalid (bad date / no by_exchange): written 0 --------------
{
  const store = new Map();
  const res = await hStockPublish(pubReq({ live_overview: { session_date: "28/10/2026", by_exchange: {} } }), mockEnv(store));
  const body = await res.json();
  check("publish bad date skipped", res.status === 200 && body.ok === true && body.written === 0, { status: res.status, body });
  check("no file written on bad date", store.size === 0, [...store.keys()]);
  const res2 = await hStockPublish(pubReq({ live_overview: { session_date: "2026-10-28" } }), mockEnv(store));
  const body2 = await res2.json();
  check("publish missing by_exchange skipped", body2.ok === true && body2.written === 0, body2);
}

// --- 3. Routes: stored doc served; missing -> empty shape; anon -> 401 -----
{
  const store = new Map();
  const env = mockEnv(store);
  await hStockPublish(pubReq({ live_overview: OV }), env);
  store.set("stock/market/divergence.json", { updated: "2026-10-28T01:32:00Z", universe: "HOSE", sessions: [{ date: "2026-10-27", cw_ew_spread_pp: 0.09 }] });
  const r1 = await hStockLiveOverview(getReq("https://x/api/stock/live-overview"), env);
  const b1 = await r1.json();
  check("live-overview route serves stored doc", r1.status === 200 && b1.trin === 1.2345 && b1.session_date === "2026-10-28", b1);
  const r2 = await hStockDivergence(getReq("https://x/api/stock/divergence"), env);
  const b2 = await r2.json();
  check("divergence route serves sessions", r2.status === 200 && Array.isArray(b2.sessions) && b2.sessions[0].date === "2026-10-27", b2);
  const r3 = await hStockLiveOverview(getReq("https://x/api/stock/live-overview?fresh=1"), mockEnv(new Map()));
  const b3 = await r3.json();
  check("live-overview missing -> empty shape", r3.status === 200 && b3.updated === null && Array.isArray(b3.rows), b3);
  globalThis.__FLOW_TEST_AUTH = false;
  const r4 = await hStockLiveOverview(getReq("https://x/api/stock/live-overview"), env);
  check("live-overview anon 401", r4.status === 401, r4.status);
  const r5 = await hStockDivergence(getReq("https://x/api/stock/divergence"), env);
  check("divergence anon 401", r5.status === 401, r5.status);
  globalThis.__FLOW_TEST_AUTH = true;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
