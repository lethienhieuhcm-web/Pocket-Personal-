// Dummy chain: bat ky thuoc tinh/phuong thuc nao cung tra ve chinh no,
// tru 'then' (de await khong treo) va toPrimitive (de so sanh so ve 0).
const chain = new Proxy(function(){}, {
  get(_t, prop){
    if(prop === 'then') return undefined;
    if(prop === Symbol.toPrimitive) return () => 0;
    return chain;
  },
  apply(){ return chain; },
});
export const drizzle = () => chain;
export const eq = () => chain;
export const and = () => chain;
export const asc = () => chain;
export const desc = () => chain;
export const gt = () => chain;
export const ne = () => chain;
export const lt = () => chain;
export const sql = chain;
export const sqliteTable = () => ({});
export const text = () => chain;
export const integer = () => chain;
export const real = () => chain;
export const primaryKey = () => chain;
