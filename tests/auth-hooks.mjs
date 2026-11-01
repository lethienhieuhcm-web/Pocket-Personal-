// Node module customization hooks for auth test-mode tests: load the REAL
// worker/src/auth.js (patched getSession) with its heavy imports stubbed,
// and the REAL worker/src/mcp.js (resolveCaller/hMcp) with billing stubbed.
// Same pattern as tests/mcp-hooks.mjs (MCP gating) and tests/flow-hooks.mjs.
// The real auth.js is NEVER redirected: every parent that imports ./auth.js
// gets the patched file, so resolveCaller/hMcp exercise the test-mode guard.
const drizzleUrl = new URL("./stubs/drizzle.mjs", import.meta.url).href;
const schemaUrl = new URL("./stubs/schema.mjs", import.meta.url).href;
const authDbUrl = new URL("./stubs/auth-db.mjs", import.meta.url).href;
const billingUrl = new URL("./stubs/billing.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve){
  if (specifier === "drizzle-orm" || specifier === "drizzle-orm/d1") {
    return { url: drizzleUrl, shortCircuit: true };
  }
  const parent = context.parentURL || "";
  if (parent.endsWith("/worker/src/auth.js")) {
    if (specifier === "./db.js") return { url: authDbUrl, shortCircuit: true };
    if (specifier === "./schema.js") return { url: schemaUrl, shortCircuit: true };
  }
  if (parent.endsWith("/worker/src/mcp.js")) {
    if (specifier === "./billing.js") return { url: billingUrl, shortCircuit: true };
  }
  if (parent.endsWith("/worker/src/stock.js")) {
    if (specifier === "./schema.js") return { url: schemaUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
