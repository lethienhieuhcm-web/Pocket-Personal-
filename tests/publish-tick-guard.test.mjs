// Tests for the publish guard package (Chot 21:58 27/10): per-block
// errors return non-2xx instead of silent ok; the raw>0-but-empty
// buckets/intraday invariant alerts on the 2nd consecutive cycle.
// Mock R2 only; no network, no D1, no deploy.
// Run: node tests/publish-tick-guard.test.mjs
import { register } from "node:module";
register("./flow-hooks.mjs", import.meta.url);

const { hStockPublish } = await import("../worker/src/stock.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}
function mockEnv(store, failOn){
  return {
    DATA: {
      get: async (key) => {
        const v = store.get(key);
        if(v === undefined) return null;
        return { json: async () => JSON.parse(JSON.stringify(v)) };
      },
      put: async (key, val) => {
        if(failOn && failOn(key)) throw new Error("mock R2 put failed: " + key);
        store.set(key, typeof val === "string" ? JSON.parse(val) : val);
      },
    },
    STOCK_PUBLISH_SECRET: "s3cr3t",
  };
}
const pubReq = (body, secret) => ({
  headers: { get: (k) => (k === "X-Publish-Secret" ? (secret || "s3cr3t") : null) },
  json: async () => body,
});
const b64 = Buffer.from("e30K").toString("base64");
const shadowBody = (buckets, intraday) => ({
  _prov: { source: "tick:multi", fetched_at: "2026-10-27T07:30:00.000Z" },
  tick_shadow: {
    status: { session_date: "2026-10-27", mode: "multi", live: true },
    foreign: { ACB: { buy_volume: 100, sell_volume: 50 } },
    raw_chunks: { dnse: { "07": b64 } },
    src_artifacts: {
      dnse: {
        snapshot: { by_symbol: { ACB: { last: 21300 } } },
        health: { connected: true },
        buckets_dirty: buckets,
        buckets_pt_dirty: {},
      },
    },
    ...(intraday ? { intraday } : {}),
  },
});

// --- 1. Normal publish: 200, buckets written, no alerts ------------------
{
  const store = new Map();
  const buckets = { ACB: { "2026-10-27T14:20": [21300, 21300, 21300, 21300, 1000, 1, 1] } };
  const res = await hStockPublish(pubReq(shadowBody(buckets, { ACB_1m: [{ t: "2026-10-27T14:20", o: 21300, h: 21300, l: 21300, c: 21300, v: 1000 }] })), mockEnv(store));
  const body = await res.json();
  check("normal publish 200 ok", res.status === 200 && body.ok === true, { status: res.status, body });
  check("normal publish writes buckets", !!store.get("stock/market/shadow_tick/src/dnse/buckets.json"), [...store.keys()]);
  check("normal publish no alerts", !body.alerts, body);
}

// --- 2. Freeze signature x2: 1st silent, 2nd alerts ----------------------
{
  const store = new Map();
  const env = mockEnv(store);
  const frozen = shadowBody({}, null);
  const r1 = await hStockPublish(pubReq(frozen), env);
  const b1 = await r1.json();
  const r2 = await hStockPublish(pubReq(frozen), env);
  const b2 = await r2.json();
  check("freeze cycle 1: 200 ok, no alert", r1.status === 200 && b1.ok === true && !b1.alerts, b1);
  check("freeze cycle 2: 200 ok with invariant alert", r2.status === 200 && b2.ok === true && Array.isArray(b2.alerts) && b2.alerts.length === 1 && /invariant/.test(b2.alerts[0]), b2);
  check("freeze: no buckets file written", !store.get("stock/market/shadow_tick/src/dnse/buckets.json"), [...store.keys()]);
  check("freeze: status still written", !!store.get("stock/market/shadow_tick/status.json"), [...store.keys()]);
}

// --- 3. Buckets write fails: 502, block named, earlier writes kept ------
{
  const store = new Map();
  const env = mockEnv(store, (k) => k.includes("buckets.json"));
  const buckets = { ACB: { "2026-10-27T14:20": [21300, 21300, 21300, 21300, 1000, 1, 1] } };
  const res = await hStockPublish(pubReq(shadowBody(buckets, null)), env);
  const body = await res.json();
  check("buckets failure returns 502", res.status === 502 && !!body.error, { status: res.status, body });
  check("buckets failure names tick_shadow", Array.isArray(body.errors) && body.errors[0] && body.errors[0].block === "tick_shadow", body);
  check("buckets failure keeps status write", !!store.get("stock/market/shadow_tick/status.json"), [...store.keys()]);
}

// --- 4. tick_live block fails: 502, block named --------------------------
{
  const store = new Map();
  const env = mockEnv(store, (k) => k.startsWith("stock/market/intraday/"));
  const res = await hStockPublish(pubReq({ tick_live: { intraday: { ACB_1m: [{ t: "2026-10-27T14:20", v: 1 }] }, foreign: { ACB: { buy_volume: 1, sell_volume: 0 } } } }), env);
  const body = await res.json();
  check("tick_live failure returns 502 named tick_live", res.status === 502 && !!body.error && body.errors && body.errors[0].block === "tick_live", { status: res.status, body });
}

// --- 5. Auth unchanged: wrong secret still 403 ---------------------------
{
  const store = new Map();
  const res = await hStockPublish(pubReq(shadowBody({}, null), "wrong"), mockEnv(store));
  check("wrong secret still 403", res.status === 403, res.status);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
