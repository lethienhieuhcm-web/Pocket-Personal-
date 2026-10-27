// Tests for tick_shadow_b / tape_b (universe B shadow run, Chot 22:32
// 27/10): namespaced R2 prefix, no touch on live shadow_tick/tape keys,
// block failure -> 502 + tick_shadow_b error (collector keeps dirty).
// Mock R2 only; no network, no D1, no deploy.
// Run: node tests/shadow-b.test.mjs
import { register } from "node:module";
register("./flow-hooks.mjs", import.meta.url);

const { hStockPublish } = await import("../worker/src/stock.js");

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

// --- 1. tick_shadow_b writes under shadow_tick_b only ----------------------
{
  const store = new Map();
  const env = mockEnv(store);
  const res = await hStockPublish(pubReq({
    _prov: { source: "tick:shadow-b" },
    tick_shadow_b: {
      status: { session_date: "2026-10-28", mode: "multi", matches: 10 },
      intraday: { ACB: [{ t: "2026-10-28T09:15", o: 21000, h: 21100, l: 20900, c: 21050, v: 100 }] },
      foreign: { ACB: { buy: 1 } },
      src_artifacts: { dnse: { snapshot: { by_symbol: { ACB: { last: 21050 } } },
        health: { connected: true },
        buckets_dirty: { ACB: { "2026-10-28T09:15": { o: 21000, c: 21050, v: 100 } } } } },
    },
    tape_b: { ACB: { rows: [] } },
  }), env);
  const body = await res.json();
  check("shadow-b publish 200 ok", res.status === 200 && body.ok === true, { status: res.status, body });
  const keys = [...store.keys()];
  check("status under shadow_tick_b", keys.includes("stock/market/shadow_tick_b/status.json"), keys);
  check("intraday under shadow_tick_b", keys.includes("stock/market/shadow_tick_b/intraday/ACB.json"), keys);
  check("buckets under shadow_tick_b", keys.includes("stock/market/shadow_tick_b/src/dnse/buckets.json"), keys);
  check("tape under shadow_tick_b", keys.includes("stock/market/shadow_tick_b/tape/ACB.json"), keys);
  check("no live shadow_tick writes", !keys.some((k) => k.startsWith("stock/market/shadow_tick/") && !k.startsWith("stock/market/shadow_tick_b")), keys);
  check("no live tape writes", !keys.some((k) => k.startsWith("stock/market/tape/")), keys);
}

// --- 2. tick_shadow_b + tick_shadow in one payload stay separate ----------
{
  const store = new Map();
  const env = mockEnv(store);
  await hStockPublish(pubReq({
    tick_shadow: { status: { session_date: "2026-10-28" } },
    tick_shadow_b: { status: { session_date: "2026-10-28", mode: "multi" } },
  }), env);
  const a = store.get("stock/market/shadow_tick/status.json");
  const b = store.get("stock/market/shadow_tick_b/status.json");
  check("both prefixes coexist", !!a && !!b && b.mode === "multi" && a.mode === undefined, { a, b });
}

// --- 3. tick_shadow_b failure -> 502 + block named -------------------------
{
  const store = new Map();
  const env = {
    DATA: {
      get: async () => null,
      put: async (key) => {
        if(key.includes("shadow_tick_b")) throw new Error("mock R2 put failed: " + key);
        store.set(key, {});
      },
    },
    STOCK_PUBLISH_SECRET: "s3cr3t",
  };
  const res = await hStockPublish(pubReq({
    tick_shadow_b: { status: { session_date: "2026-10-28" } },
  }), env);
  const body = await res.json();
  check("shadow-b block failure 502", res.status === 502 && body.ok !== true, { status: res.status, body });
  check("error names tick_shadow_b", JSON.stringify(body.errors || []).includes("tick_shadow_b"), body);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
