// Test-only stub for worker/src/auth.js (MCP gating tests): session +
// plan are test-controlled via globalThis. PLANS limits copied from
// worker/src/auth.js (2026-11-01) — agent_calls: free 5, hocsinh 20,
// sinhvien 30, dilam 60, nhadautu 150. If real limits change, update here.
export const PLANS = {
  free: { id: "free", limits: { agent_calls: 5 } },
  hocsinh: { id: "hocsinh", limits: { agent_calls: 20 } },
  sinhvien: { id: "sinhvien", limits: { agent_calls: 30 } },
  dilam: { id: "dilam", limits: { agent_calls: 60 } },
  nhadautu: { id: "nhadautu", limits: { agent_calls: 150 } },
  admin: { id: "admin", limits: { agent_calls: 0 } },
};
export async function getSession(){
  if (globalThis.__MCP_TEST_ANON === true) return null;
  return { email: globalThis.__MCP_TEST_EMAIL || "free@local.test" };
}
export async function getUser(env, email){
  return { email, plan: globalThis.__MCP_TEST_PLAN || "free" };
}
export function getActivePlan(u){
  const plan = (u && u.plan) || "free";
  return { plan, expires: null };
}
