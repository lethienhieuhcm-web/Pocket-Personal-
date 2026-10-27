// Node module customization hooks for flow-screen tests: redirect the
// heavyweight imports of worker/src/stock.js to lightweight stubs.
const drizzleUrl = new URL("./stubs/drizzle.mjs", import.meta.url).href;
const schemaUrl = new URL("./stubs/schema.mjs", import.meta.url).href;
const authUrl = new URL("./stubs/auth.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve){
  if(specifier === "drizzle-orm" || specifier === "drizzle-orm/d1"){
    return { url: drizzleUrl, shortCircuit: true };
  }
  if(context.parentURL && context.parentURL.endsWith("/worker/src/stock.js")){
    if(specifier === "./schema.js") return { url: schemaUrl, shortCircuit: true };
    if(specifier === "./auth.js") return { url: authUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
