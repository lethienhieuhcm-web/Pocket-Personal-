// Node module customization hooks for MCP gating tests: redirect the
// heavyweight imports of worker/src/mcp.js to lightweight stubs.
// Same pattern as tests/flow-hooks.mjs (stock.js tests).
const drizzleUrl = new URL("./stubs/drizzle.mjs", import.meta.url).href;
const schemaUrl = new URL("./stubs/schema.mjs", import.meta.url).href;
const authUrl = new URL("./stubs/mcp-auth.mjs", import.meta.url).href;
const billingUrl = new URL("./stubs/billing.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve){
  if (specifier === "drizzle-orm" || specifier === "drizzle-orm/d1") {
    return { url: drizzleUrl, shortCircuit: true };
  }
  const parent = context.parentURL || "";
  if (parent.endsWith("/worker/src/mcp.js")) {
    if (specifier === "./auth.js") return { url: authUrl, shortCircuit: true };
    if (specifier === "./billing.js") return { url: billingUrl, shortCircuit: true };
  }
  if (parent.endsWith("/worker/src/stock.js")) {
    if (specifier === "./schema.js") return { url: schemaUrl, shortCircuit: true };
    if (specifier === "./auth.js") return { url: authUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
