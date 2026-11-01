// Tests for MCP tier gating + quota (Chot C2 01/11/2026: MCP_DEV_OPEN=false).
// Covers POST /api/mcp (hMcp): tools/list tier filter, tools/call
// plan_restricted / quota_exceeded / unknown_tool, usage counting, and
// the chatToolRun bypass AI Chat relies on (no tier check by design).
// Mock R2 + mock DB + stub auth/billing only; no network, no D1, no deploy.
// Run: node tests/mcp-gating.test.mjs
import { register } from "node:module";
register("./mcp-hooks.mjs", import.meta.url);

const { hMcp, hMcpGet, chatToolRun } =
  await import("../worker/src/mcp.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if (cond) { passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

const QUOTES = {
  updated: "2026-10-30T15:00:00+07:00",
  _prov: { source: "test" },
  by_symbol: { FPT: { close: 100000, pct_change: 1.5, volume: 1000000,
    value_vnd: 100000000000, bid: [[99000, 100]], ask: [[101000, 100]] } },
};
const MACRO = {
  updated: "2026-10-30T15:00:00+07:00",
  _prov: { source: "test" },
  series: { omo: { value: 1000 }, fx_center: { value: 25000 } },
};

function mockEnv(store, logRows){
  return {
    DATA: {
      get: async (key) => {
        const v = store.get(key);
        if (v === undefined) return null;
        return { json: async () => JSON.parse(JSON.stringify(v)) };
      },
      put: async (key, val) => { store.set(key, JSON.parse(val)); },
    },
    DB: {
      prepare: (sql) => {
        const run = async () => { logRows.push({ sql, args: [] }); return {}; };
        return { run,
          bind: (...args) => ({
            run: async () => { logRows.push({ sql, args }); return {}; },
            first: async () => null,
            all: async () => ({ results: [] }),
          }) };
      },
    },
  };
}

const store = new Map();
store.set("stock/market/quotes.json", QUOTES);
store.set("stock/market/macro/overview.json", MACRO);
const logRows = [];
const env = mockEnv(store, logRows);

const req = (body) => ({
  headers: { get: () => null },
  json: async () => JSON.parse(JSON.stringify(body)),
});
async function callMcp(body){
  const res = await hMcp(req(body), env);
  return { status: res.status, json: await res.json() };
}
function asCaller(plan, email){
  globalThis.__MCP_TEST_ANON = false;
  globalThis.__MCP_TEST_PLAN = plan;
  globalThis.__MCP_TEST_EMAIL = email || (plan + "@local.test");
  globalThis.__MCP_TEST_USAGE = {};
}
function toolNames(listJson){
  return (listJson.result.tools || []).map((t) => t.name).sort();
}

// 1. initialize + ping
{
  const init = await callMcp({ jsonrpc: "2.0", id: 1, method: "initialize" });
  check("initialize returns protocolVersion + serverInfo",
    init.json.result.protocolVersion === "2025-03-26" &&
    init.json.result.serverInfo.name === "pocket-personal-stock-mcp", init.json);
  const ping = await callMcp({ jsonrpc: "2.0", id: 2, method: "ping" });
  check("ping returns {}", JSON.stringify(ping.json.result) === "{}", ping.json);
  const get = await hMcpGet();
  check("GET /api/mcp returns 405", get.status === 405);
}

// 2. tools/list: anonymous -> 401
{
  globalThis.__MCP_TEST_ANON = true;
  const r = await callMcp({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  check("tools/list anonymous -> 401 Not logged in",
    r.json.error && r.json.error.code === -32001, r.json);
}

// 3. tools/list per tier (DEV_OPEN=false)
{
  asCaller("free");
  const r = await callMcp({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  check("tools/list free -> 4 tier-0 tools",
    JSON.stringify(toolNames(r.json)) === JSON.stringify(
      ["get_company_profile", "get_indices", "get_ohlcv", "get_quote"]), toolNames(r.json));
  asCaller("hocsinh");
  const h = await callMcp({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  check("tools/list hocsinh -> 9 tools",
    toolNames(h.json).length === 9 &&
    toolNames(h.json).includes("analyze_sector") &&
    toolNames(h.json).includes("get_analysis_catalog"), toolNames(h.json));
  asCaller("sinhvien");
  const s = await callMcp({ jsonrpc: "2.0", id: 6, method: "tools/list" });
  check("tools/list sinhvien -> 16 tools",
    toolNames(s.json).length === 16 &&
    toolNames(s.json).includes("get_flow") &&
    toolNames(s.json).includes("analyze_holders") &&
    !toolNames(s.json).includes("get_screener"), toolNames(s.json));
  asCaller("dilam");
  const d = await callMcp({ jsonrpc: "2.0", id: 7, method: "tools/list" });
  check("tools/list dilam -> 23 tools (all)",
    toolNames(d.json).length === 23, toolNames(d.json).length);
}

// 4. tools/call: plan_restricted for free calling a tier-2 tool
{
  asCaller("free");
  const before = logRows.length;
  const r = await callMcp({ jsonrpc: "2.0", id: 8, method: "tools/call",
    params: { name: "get_flow", arguments: {} } });
  const content = r.json.result.content[0].text;
  const payload = JSON.parse(content);
  check("free tools/call get_flow -> plan_restricted",
    payload.error && payload.error.code === "plan_restricted" &&
    payload.error.required_plan === "sinhvien" &&
    payload.error.current_plan === "free", payload.error);
  check("plan_restricted writes one mcp_log refused row",
    logRows.slice(before).filter((x) => x.sql.startsWith("INSERT INTO mcp_log")).length === 1,
    logRows.slice(before).length);
}

// 5. tools/call: free get_quote succeeds + usage +1 + mcp_log ok
{
  asCaller("free");
  const before = logRows.length;
  const r = await callMcp({ jsonrpc: "2.0", id: 9, method: "tools/call",
    params: { name: "get_quote", arguments: { symbol: "FPT" } } });
  const payload = JSON.parse(r.json.result.content[0].text);
  check("free tools/call get_quote FPT -> ok data",
    r.json.result.isError === false && payload.data &&
    payload.data.symbol === "FPT" && payload.data.close === 100000, payload.data);
  const inserts = logRows.slice(before).filter((x) => x.sql.startsWith("INSERT INTO mcp_log"));
  check("get_quote writes mcp_log status ok",
    inserts.length === 1 && inserts[0].args[5] === "ok", inserts.map((x) => x.args[5]));
  const again = await callMcp({ jsonrpc: "2.0", id: 10, method: "tools/call",
    params: { name: "get_quote", arguments: { symbol: "FPT" } } });
  check("second get_quote still ok (usage 1 < limit 5)",
    again.json.result.isError === false, again.json.result);
}

// 6. tools/call: quota_exceeded at limit (free limit 5)
{
  asCaller("free");
  globalThis.__MCP_TEST_USAGE = { "free@local.test": 5 };
  const r = await callMcp({ jsonrpc: "2.0", id: 11, method: "tools/call",
    params: { name: "get_quote", arguments: { symbol: "FPT" } } });
  const payload = JSON.parse(r.json.result.content[0].text);
  check("free at quota 5/5 -> quota_exceeded",
    payload.error && payload.error.code === "quota_exceeded" &&
    payload.error.used === 5 && payload.error.limit === 5, payload.error);
}

// 7. tools/call: unknown tool
{
  asCaller("free");
  const r = await callMcp({ jsonrpc: "2.0", id: 12, method: "tools/call",
    params: { name: "no_such_tool", arguments: {} } });
  const payload = JSON.parse(r.json.result.content[0].text);
  check("unknown tool -> refused unknown_tool",
    payload.error && payload.error.code === "unknown_tool", payload.error);
}

// 8. chatToolRun bypass: minTier-1 tool runs with no caller (AI Chat path)
{
  globalThis.__MCP_TEST_USAGE = {};
  const out = await chatToolRun(env, "get_macro", {});
  check("chatToolRun get_macro (minTier 1) succeeds without caller",
    out && out.data && out.data.series && out.data.series.omo != null, out && out.data);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
