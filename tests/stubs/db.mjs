// Test-only stub cho worker/src/db.js: DO auth duoc dieu khien tung lan
// goi trong test (khong cham D1/R2, khong cham that).
export const stubState = { session: null };
export async function dbGetSession(env, token){
  const s = stubState.session;
  if(typeof s === "function") return s(token);
  return s;
}
