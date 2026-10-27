// Loader stub cho test shelf: worker/src/stock.js import drizzle-orm (chi dung
// cho D1, khong lien quan toi 3 handler moi). Stub tra ve chain dummy — moi
// goi D1 deu roi ve null va r2 fallback trong db.js xu ly tiep.
const stubUrl = new URL('./drizzle-stub.mjs', import.meta.url).href;
export async function resolve(specifier, context, nextResolve){
  if(specifier === 'drizzle-orm' || specifier === 'drizzle-orm/d1' ||
     specifier === 'drizzle-orm/sqlite-core'){
    return {url: stubUrl, shortCircuit: true};
  }
  return nextResolve(specifier, context);
}
