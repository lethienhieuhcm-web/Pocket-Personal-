// Test-only stub for worker/src/auth.js: getSession only. Tests toggle
// globalThis.__FLOW_TEST_AUTH=false to simulate an anonymous request.
export async function getSession(){
  if(globalThis.__FLOW_TEST_AUTH === false) return null;
  return { email: "test@local.test" };
}
