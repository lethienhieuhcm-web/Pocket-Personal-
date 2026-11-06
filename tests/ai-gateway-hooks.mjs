// Resolve hooks cho tests/ai-gateway.test.mjs: stub ./mcp.js khi test
// duong chay tron cua worker/src/ai_chat.js (mcp.js that can drizzle/D1
// — khong can cho test routing).
const mcpStubUrl = new URL("./stubs/ai-gateway-mcp.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve){
  if(context.parentURL && context.parentURL.endsWith("/worker/src/ai_chat.js")){
    if(specifier === "./mcp.js") return { url: mcpStubUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
