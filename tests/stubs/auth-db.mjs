// Test-only stub for worker/src/db.js (auth test-mode tests): in-memory
// users/sessions. Only the exports worker/src/auth.js imports are provided,
// with the same signatures as the real db.js (dbPutSession takes a single
// session object). Tests seed via __seedSession/__seedUser and clear with
// __reset. No D1, no R2, no network.
const _users = new Map();     // email -> user
const _sessions = new Map();  // token -> {email, exp}

export function __seedUser(email, user){ _users.set(String(email), user); }
export function __seedSession(token, email, exp){ _sessions.set(token, { email, exp }); }
export function __reset(){ _users.clear(); _sessions.clear(); }

export async function dbGetUser(env, email){ return _users.get(String(email)) || null; }
export async function dbPutUser(env, u){ _users.set(String(u.email), u); return u; }
export async function dbDeleteUser(env, email){ _users.delete(String(email)); }
export async function dbCountUsers(env){ return _users.size; }
export async function dbGetUserByGoogleSub(env, sub){
  for(const u of _users.values()) if(u && u.googleSub === sub) return u;
  return null;
}
export async function dbGetSession(env, token){
  const s = _sessions.get(token);
  if(!s) return null;
  if(s.exp && s.exp < Date.now()) return null;
  return { email: s.email, exp: s.exp, token };
}
export async function dbPutSession(env, sess){
  _sessions.set(sess.token, { email: sess.email, exp: sess.exp });
  return sess;
}
export async function dbDeleteSession(env, token){ _sessions.delete(token); }
