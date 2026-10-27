// Tests for the money-flow view (Chot F1-F4 27/10/2026): publish branch,
// /api/stock/flow-screen join + staleness rule, sorting. Mock R2 only;
// no network, no D1, no deploy.
// Run: node --import 'node:module' ... (see run line below) or simply:
//   node tests/flow-screen.test.mjs
// The file self-registers the resolve hooks via module.register().
import { register } from "node:module";
register("./flow-hooks.mjs", import.meta.url);

const { hStockPublish, hStockFlowScreen, flowJoinRow } =
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
        const snap = JSON.parse(JSON.stringify(v));
        return { json: async () => snap };
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
const getReq = (url) => ({
  headers: { get: () => null },
  url,
});
const dstr = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
// 25 consecutive trading-ish dates ending 2026-10-26 (ascending).
function dateSeq(n, endY, endM, endD){
  const out = [];
  const dt = new Date(Date.UTC(endY, endM - 1, endD));
  for(let i = n - 1; i >= 0; i--){
    const t = new Date(dt.getTime() - i * 86400000);
    out.push(dstr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()));
  }
  return out;
}

// --- 1. Publish: overwrite + invalid-row skip -------------------------------
{
  const store = new Map();
  const env = mockEnv(store);
  const cands = [
    { symbol: "ORS", close: 10000, cmf20: 0.504, obv20: 8.71, mfi14: 80.9, mf20_val: 560173450424 },
    { symbol: "vgr", close: 128000, cmf20: -0.002, obv20: 17.34, mfi14: 87.7 },
    { symbol: "HT1", close: 13400, cmf20: 0.168, obv20: 10.04, mfi14: 80.4 },
    { symbol: "BAD!!", close: 1, cmf20: 0.9, obv20: 1, mfi14: 50 },
    { symbol: "", close: 1, cmf20: 0.9, obv20: 1, mfi14: 50 },
  ];
  const r1 = await hStockPublish(pubReq({ flow_screen: { for_date: "2026-10-27", screen_date: "2026-10-26", candidates: cands } }), env);
  const b1 = await r1.json();
  check("publish: written counts latest+dated", b1.ok === true && b1.written === 2, b1);
  const latest = store.get("stock/flow/flow_screen_latest.json");
  const dated = store.get("stock/flow/flow_screen/2026-10-27.json");
  check("publish: invalid symbols skipped, lowercase uppercased",
    latest && latest.candidates.length === 3 &&
    latest.candidates[0].symbol === "ORS" && latest.candidates[0].mf20_val === 560173450424 && latest.candidates[1].symbol === "VGR" && latest.candidates[2].symbol === "HT1", latest);
  check("publish: dated copy identical", JSON.stringify(dated.candidates) === JSON.stringify(latest.candidates));
  check("publish: doc wrapper has updated", typeof latest.updated === "string" && latest.updated.length > 0);
  // Overwrite (not merge): republish with one candidate only.
  const r2 = await hStockPublish(pubReq({ flow_screen: { for_date: "2026-10-27", screen_date: "2026-10-26", candidates: [{ symbol: "NKG", cmf20: 0.387 }] } }), env);
  const b2 = await r2.json();
  const latest2 = store.get("stock/flow/flow_screen_latest.json");
  check("publish: overwrite replaces candidates", b2.written === 2 && latest2.candidates.length === 1 && latest2.candidates[0].symbol === "NKG", latest2);
  // Wrong secret -> 403, nothing written.
  const store3 = new Map();
  const r3 = await hStockPublish({ headers: { get: () => "nope" }, json: async () => ({ flow_screen: { for_date: "2026-10-27", candidates: [] } }) }, mockEnv(store3));
  check("publish: wrong secret 403", r3.status === 403 && store3.size === 0, r3.status);
}

// --- 2. Route: sorting by cmf20 desc ----------------------------------------
{
  const store = new Map();
  const env = mockEnv(store);
  const cands = [
    { symbol: "VGR", close: 128000, cmf20: -0.002, obv20: 17.34, mfi14: 87.7 },
    { symbol: "ORS", close: 10000, cmf20: 0.504, obv20: 8.71, mfi14: 80.9, mf20_val: 560173450424 },
    { symbol: "NKG", close: 9000, cmf20: 0.387, obv20: 8.84, mfi14: 92.5 },
  ];
  store.set("stock/flow/flow_screen_latest.json", { for_date: "2026-10-27", screen_date: "2026-10-26", candidates: cands, updated: "t" });
  for(const sym of ["VGR", "ORS", "NKG"]){
    store.set(`stock/market/foreign_flow_history/${sym}.json`, { rows: [{ trade_date: "2026-10-26", net_volume: 10, net_value_est: 100 }] });
    store.set(`stock/market/proprietary_flow_history/${sym}.json`, { rows: [{ trade_date: "2026-10-26", net_value_vnd: 200 }] });
  }
  const res = await hStockFlowScreen(getReq("https://w/api/stock/flow-screen"), env);
  const j = await res.json();
  check("route: sorted cmf20 desc, ORS first",
    j.available === true && j.rows.map((r) => r.symbol).join(",") === "ORS,NKG,VGR" &&
    j.rows[0].rank === 1 && j.rows[2].rank === 3 && j.trial === true, j.rows);
  check("route: fields carried through",
    j.rows[0].cmf20 === 0.504 && j.rows[0].obv20 === 8.71 && j.rows[0].mfi14 === 80.9 && j.rows[0].close === 10000, j.rows[0]);
}

// --- 3. Foreign 20-session sum: exactly the last 20 rows --------------------
{
  const dates = dateSeq(25, 2026, 10, 26);
  const rows = dates.map((d) => ({ trade_date: d, net_volume: 100, net_value_est: 1e9 }));
  const out = flowJoinRow(rows, [], "2026-10-26");
  check("join: 20-session sum uses exactly last 20",
    out.foreign_net20_val === 20e9 && out.foreign_net20_vol === 2000, out);
  check("join: 1-session = latest row",
    out.foreign_net1_val === 1e9 && out.foreign_net1_vol === 100, out);
  check("join: asof = screen date", out.foreign_asof === "2026-10-26" && out.prop_asof === null, out);
}

// --- 4. Stale foreign -> nulls; prop stays independent -----------------------
{
  const frows = [{ trade_date: "2026-10-21", net_volume: 5, net_value_est: 50 }];
  const prows = [{ trade_date: "2026-10-26", net_value_vnd: 700 }];
  const out = flowJoinRow(frows, prows, "2026-10-26");
  check("join: stale foreign nulls (never stale-as-current)",
    out.foreign_net20_val === null && out.foreign_net20_vol === null &&
    out.foreign_net1_val === null && out.foreign_net1_vol === null && out.foreign_asof === null, out);
  check("join: fresh prop intact alongside stale foreign",
    out.prop_net_val === 700 && out.prop_asof === "2026-10-26", out);
}

// --- 5. Missing prop file -> null prop, foreign intact (route level) ---------
{
  const store = new Map();
  const env = mockEnv(store);
  store.set("stock/flow/flow_screen_latest.json", { for_date: "2026-10-27", screen_date: "2026-10-26",
    candidates: [{ symbol: "ACB", close: 21200, cmf20: 0.1, obv20: 1, mfi14: 60 }], updated: "t" });
  store.set("stock/market/foreign_flow_history/ACB.json", { rows: [{ trade_date: "2026-10-26", net_volume: 7, net_value_est: 70 }] });
  // No proprietary file at all.
  const j = await (await hStockFlowScreen(getReq("https://w/api/stock/flow-screen"), env)).json();
  check("route: missing prop -> null prop, foreign intact",
    j.rows[0].prop_net_val === null && j.rows[0].prop_asof === null &&
    j.rows[0].foreign_net1_val === 70 && j.rows[0].foreign_net20_val === 70, j.rows[0]);
}

// --- 6. Missing dataset -> available:false, HTTP 200 -------------------------
{
  const env = mockEnv(new Map());
  const res = await hStockFlowScreen(getReq("https://w/api/stock/flow-screen"), env);
  const j = await res.json();
  check("route: no dataset -> available:false rows:[] status 200",
    res.status === 200 && j.available === false && Array.isArray(j.rows) && j.rows.length === 0, { status: res.status, j });
}

// --- 7. Pure helper: all-null values -> null, not 0; empty -> nulls ----------
{
  const out = flowJoinRow(
    [{ trade_date: "2026-10-26", net_volume: null, net_value_est: null }],
    [{ trade_date: "2026-10-26", net_value_vnd: null }], "2026-10-26");
  check("join: all-null values -> null (not 0-filled)",
    out.foreign_net20_val === null && out.foreign_net1_vol === null && out.prop_net_val === null, out);
  const out2 = flowJoinRow([], [], "2026-10-26");
  check("join: empty histories -> all null",
    out2.foreign_net20_val === null && out2.foreign_net1_val === null && out2.prop_net_val === null &&
    out2.foreign_asof === null && out2.prop_asof === null, out2);
}

// --- 8. ?date= reads dated file; invalid date -> 400 -------------------------
{
  const store = new Map();
  const env = mockEnv(store);
  store.set("stock/flow/flow_screen_latest.json", { for_date: "2026-10-27", screen_date: "2026-10-26", candidates: [{ symbol: "AAA", cmf20: 0.1 }], updated: "t" });
  store.set("stock/flow/flow_screen/2026-10-28.json", { for_date: "2026-10-28", screen_date: "2026-10-27", candidates: [{ symbol: "BBB", cmf20: 0.2 }], updated: "t" });
  const j = await (await hStockFlowScreen(getReq("https://w/api/stock/flow-screen?date=2026-10-28"), env)).json();
  check("route: ?date= reads dated file",
    j.for_date === "2026-10-28" && j.rows[0].symbol === "BBB", j);
  const bad = await hStockFlowScreen(getReq("https://w/api/stock/flow-screen?date=../x"), env);
  check("route: invalid date -> 400", bad.status === 400, bad.status);
}

// --- 9. Anonymous -> 401 ------------------------------------------------------
{
  globalThis.__FLOW_TEST_AUTH = false;
  try{
    const res = await hStockFlowScreen(getReq("https://w/api/stock/flow-screen"), mockEnv(new Map()));
    check("route: anonymous -> 401", res.status === 401, res.status);
  }finally{ globalThis.__FLOW_TEST_AUTH = true; }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
