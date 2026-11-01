// Test-only stub for worker/src/billing.js (MCP gating tests): in-memory
// daily agent_calls counter. Tests preset usage via
// globalThis.__MCP_TEST_USAGE = { "email": count }; incrUsage adds 1.
const _usage = new Map();
export function __resetUsage(){ _usage.clear(); }
export function __getUsageMap(){ return _usage; }
export async function getUsage(env, email){
  const preset = globalThis.__MCP_TEST_USAGE || {};
  const n = (preset[email] != null) ? preset[email] : (_usage.get(email) || 0);
  return { email, date: "2026-11-01", agent_calls: n,
    dict_lookups: 0, tts_chars: 0, english_scans: 0, english_uploads: 0,
    backtest_count: 0, ai_calls: 0, browse_pages: 0 };
}
export async function incrUsage(env, email, field, amount){
  if (field !== "agent_calls") throw new Error("Invalid usage field: " + field);
  const preset = globalThis.__MCP_TEST_USAGE || {};
  const base = (preset[email] != null) ? preset[email] : (_usage.get(email) || 0);
  const next = base + (amount || 1);
  _usage.set(email, next);
  if (preset[email] != null) preset[email] = next;
  return next;
}
