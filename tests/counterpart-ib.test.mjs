// Tests for counterpart _ib publish branches + universe branch/route
// (Chot 17:37 + lenh 17:40 28/10): _ib keys write separate R2 files,
// universe branch validates loudly (400), GET /api/internal/universe
// serves market/universe.json (absent -> {}).
// Mock R2 only; no network, no D1, no deploy.
// Run: node tests/counterpart-ib.test.mjs
globalThis.caches = {
  default: {
    _m: new Map(),
    async match(req){ const r = this._m.get(req.url); return r ? r.clone() : undefined; },
    async put(req, resp){ this._m.set(req.url, resp.clone()); },
  },
};

import { register } from "node:module";
register("./flow-hooks.mjs", import.meta.url);

const { hStockPublish, hInternalUniverse } =
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
const pubReq = (body, secret) => ({
  headers: { get: (k) => (k === "X-Publish-Secret" ? (secret === undefined ? "s3cr3t" : secret) : null) },
  json: async () => body,
});
const PROV = { source: "instabox:counterpart", retrieved_at: "2026-10-28T10:00:00.000Z" };

async function bodyOf(resp){
  // sJson returns a Response; read it back.
  const t = await resp.text();
  return JSON.parse(t);
}

// 1. indices_ib + sector_indices_ib write separate keys.
{
  const store = new Map();
  const r = await hStockPublish(pubReq({ indices_ib: [{symbol: "VNINDEX", close: 1766.65}], sector_indices_ib: [{symbol: "VNFIN", close: 2111.74}], _prov: PROV }), mockEnv(store));
  const b = await bodyOf(r);
  check("ib indices written=2", b.ok === true && b.written === 2, b);
  check("ib indices file", store.get("stock/market/indices_ib.json")?.rows?.[0]?.close === 1766.65, store.get("stock/market/indices_ib.json"));
  check("ib sector file", store.get("stock/market/sector_indices_ib.json")?.rows?.[0]?.symbol === "VNFIN");
  check("ib prov stamped", store.get("stock/market/indices_ib.json")?._prov?.source === "instabox:counterpart");
  check("prod indices untouched", store.get("stock/market/indices.json") === undefined);
}

// 2. quotes_patch_ib merges into quotes_ib base, wholesale per symbol.
{
  const store = new Map();
  store.set("stock/market/quotes_ib.json", { updated: "old", by_symbol: { AAA: { close: 10, volume: 1, keep: "base" }, BBB: { close: 20 } } });
  const r = await hStockPublish(pubReq({ quotes_patch_ib: { AAA: { close: 11, volume: 5 }, CCC: { close: 30 } }, _prov: PROV }), mockEnv(store));
  const b = await bodyOf(r);
  const q = store.get("stock/market/quotes_ib.json")?.by_symbol || {};
  check("ib quotes written=1", b.written === 1, b);
  check("ib quotes patched wholesale", q.AAA?.close === 11 && q.AAA?.keep === undefined && q.AAA?.volume === 5, q.AAA);
  check("ib quotes base kept", q.BBB?.close === 20);
  check("ib quotes new symbol", q.CCC?.close === 30);
  check("prod quotes untouched", store.get("stock/market/quotes.json") === undefined);
}

// 3. depth_ib + live_overview_ib (valid + invalid skipped).
{
  const store = new Map();
  const ov = { session_date: "2026-10-28", retrieved_at: "2026-10-28T10:00:00Z", source: "instabox:test", n_symbols: 1520, advancers: 245, decliners: 302, unchanged: 973, trin: 0.7893, turnover_total: 5131203427000, by_exchange: { HOSE: { advancers: 100 } } };
  const r = await hStockPublish(pubReq({ depth_ib: { VCB: { bid: [[57300, 5000]], ask: null } }, live_overview_ib: ov, _prov: PROV }), mockEnv(store));
  const b = await bodyOf(r);
  check("ib depth+ov written=2", b.written === 2, b);
  check("ib depth file", store.get("stock/market/depth_ib.json")?.by_symbol?.VCB?.bid?.[0]?.[0] === 57300);
  check("ib ov whitelist", store.get("stock/market/live_overview_ib.json")?.trin === 0.7893 && store.get("stock/market/live_overview_ib.json")?.by_exchange?.HOSE?.advancers === 100);
  const store2 = new Map();
  const r2 = await hStockPublish(pubReq({ live_overview_ib: { session_date: "28/10/2026", by_exchange: {} }, _prov: PROV }), mockEnv(store2));
  const b2 = await bodyOf(r2);
  check("ib ov bad date skipped", b2.written === 0 && store2.get("stock/market/live_overview_ib.json") === undefined, b2);
  const store3 = new Map();
  const r3 = await hStockPublish(pubReq({ live_overview_ib: { session_date: "2026-10-28" }, _prov: PROV }), mockEnv(store3));
  check("ib ov no by_exchange skipped", (await bodyOf(r3)).written === 0 && store3.get("stock/market/live_overview_ib.json") === undefined);
}

// 4. universe branch: valid writes normalized; invalid -> 400, old file kept.
{
  const store = new Map();
  const r = await hStockPublish(pubReq({ universe: { symbols: ["vcb", "aaa"], as_of: "2026-10-27", basis: "B200", source: "seed" }, _prov: PROV }), mockEnv(store));
  const b = await bodyOf(r);
  const u = store.get("stock/market/universe.json");
  check("universe written", b.ok === true && b.written === 1 && u?.symbols?.join(",") === "VCB,AAA" && u?.count === 2 && u?.as_of === "2026-10-27", u);
  for(const [name, bad] of [
    ["empty symbols", { symbols: [], as_of: "2026-10-27" }],
    ["dup symbols", { symbols: ["VCB", "vcb"], as_of: "2026-10-27" }],
    ["bad date", { symbols: ["VCB"], as_of: "27/10/2026" }],
    ["missing date", { symbols: ["VCB"] }],
  ]){
    const st = new Map(store);
    const rb = await hStockPublish(pubReq({ universe: bad }), mockEnv(st));
    check("universe invalid 400: " + name, rb.status === 400, rb.status);
    check("universe old file kept: " + name, st.get("stock/market/universe.json")?.symbols?.join(",") === "VCB,AAA");
  }
}

// 5. Auth: publish without secret -> 403.
{
  const store = new Map();
  const r = await hStockPublish(pubReq({ indices_ib: [] }, ""), mockEnv(store));
  check("publish no secret 403", r.status === 403, r.status);
}

// 6. hInternalUniverse: present -> doc; absent -> {}.
{
  const store = new Map();
  store.set("stock/market/universe.json", { symbols: ["VCB"], count: 1, as_of: "2026-10-27" });
  const d1 = JSON.parse(await (await hInternalUniverse({}, mockEnv(store))).text());
  check("universe GET present", d1.symbols?.[0] === "VCB" && d1.count === 1, d1);
  const d2 = JSON.parse(await (await hInternalUniverse({}, mockEnv(new Map()))).text());
  check("universe GET absent -> {}", JSON.stringify(d2) === "{}", d2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
