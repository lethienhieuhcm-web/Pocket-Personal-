// Stub mcp.js cho test ai_chat (khong cham D1/drizzle).
// Test thay duoc cac ham nay qua globalThis.__GWTEST__.
export async function resolveCaller(){ return { email: "test@x" }; }
export async function chatToolRun(env, name, args){
  const rec = (globalThis.__GWTEST__ || {});
  (rec.toolRuns || (rec.toolRuns = [])).push({ name, args });
  return { data: { close: 12300 }, meta: { tool: name } };
}
