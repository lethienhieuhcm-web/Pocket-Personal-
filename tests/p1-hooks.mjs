// Node module customization hooks cho test P1: market-room.js can
// `cloudflare:workers` + `./db.js` gia; stock.js can drizzle/schema/auth
// gia ( nhu flow-hooks.mjs). Chi test P1 dang ky hooks nay.
const cfUrl = new URL("./stubs/cloudflare-workers.mjs", import.meta.url).href;
const dbUrl = new URL("./stubs/db.mjs", import.meta.url).href;
const drizzleUrl = new URL("./stubs/drizzle.mjs", import.meta.url).href;
const schemaUrl = new URL("./stubs/schema.mjs", import.meta.url).href;
const authUrl = new URL("./stubs/auth.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve){
  if(specifier === "cloudflare:workers"){
    return { url: cfUrl, shortCircuit: true };
  }
  if(specifier === "drizzle-orm" || specifier === "drizzle-orm/d1"){
    return { url: drizzleUrl, shortCircuit: true };
  }
  const parent = (context.parentURL || "").replace(/^file:\/\//, "");
  if(parent.endsWith("/worker/src/market-room.js") && specifier === "./db.js"){
    return { url: dbUrl, shortCircuit: true };
  }
  if(parent.endsWith("/worker/src/stock.js")){
    if(specifier === "./schema.js") return { url: schemaUrl, shortCircuit: true };
    if(specifier === "./auth.js") return { url: authUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
