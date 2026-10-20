// worker/src/db.js — PHASE 2: single data-access layer.
//
// All R2 (AUTHDB/DATA buckets) and D1 access goes through here.
// Handlers must not touch env.AUTHDB / env.DATA / env.DB directly for
// user-scoped data — use these functions so cascade rules stay in one place.
//
// R2 layout (bucket english-lab-auth, binding AUTHDB):
//   users/<email>.json     account: {email, salt, hash, role, plan, ...}
//   sessions/<token>.json  session: {email, exp, token}
//   bank/<email>.json      encrypted sentence bank blob (opaque to server)
// R2 layout (bucket english-lab-data, binding DATA):
//   analytics/corpus.json, stock/..., books/<email>/<bookId>.json, shared/...
// D1 (pocket-personal): 9 email-keyed tables — see D1_USER_TABLES.

export const D1_USER_TABLES = [
  'watchlist', 'portfolio_txns', 'alerts', 'targets',
  'usage_daily', 'subscriptions', 'drive_tokens', 'spotify_tokens',
];

import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import { users, sessions } from "./schema.js";

// ---------- R2 helpers ----------
function bucket(env, name){
  const b = name === 'DATA' ? env.DATA : env.AUTHDB;
  if(!b) throw new Error('R2 bucket missing: '+name);
  return b;
}
export async function r2get(env, bucketName, key){
  const obj = await bucket(env, bucketName).get(key);
  return obj ? await obj.text() : null;
}
export async function r2getJson(env, bucketName, key){
  const t = await r2get(env, bucketName, key);
  if(t == null) return null;
  try{ return JSON.parse(t); }catch(e){ return null; }
}
export async function r2put(env, bucketName, key, text, contentType){
  await bucket(env, bucketName).put(key, text,
    contentType ? {httpMetadata:{contentType}} : undefined);
}
export async function r2del(env, bucketName, key){
  await bucket(env, bucketName).delete(key);
}
export async function r2list(env, bucketName, prefix){
  const out = [];
  let cursor;
  do{
    const r = await bucket(env, bucketName).list({prefix, cursor});
    for(const o of (r.objects||[])) out.push(o.key);
    cursor = r.truncated ? r.cursor : null;
  }while(cursor);
  return out;
}

// ---------- users (PHASE 3: D1 primary, R2 fallback + read-through backfill) ----------
const ukey = email => 'users/'+email.toLowerCase()+'.json';
async function d1GetUser(env, email){
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({ data: users.data }).from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    const row = rows[0];
    return row ? JSON.parse(row.data) : null;
  }catch(e){ return null; }
}
export async function dbGetUser(env, email){
  const el = email.toLowerCase();
  const u = await d1GetUser(env, el);
  if(u) return u;
  // fallback: R2 (pre-migration) + backfill to D1
  const r2u = await r2getJson(env, 'AUTHDB', ukey(el));
  if(r2u){
    try{ await d1PutUser(env, r2u); }catch(e){}
    return r2u;
  }
  return null;
}
// 2.4: lookup độc lập theo google_sub — `sub` là định danh ổn định của Google,
// xử lý trường hợp user đổi email Google (tìm theo email sẽ miss).
export async function dbGetUserByGoogleSub(env, sub){
  if(!sub) return null;
  try{
    const all = await dbListUsers(env); // union D1 + R2, user ít nên scan memory OK
    return all.find(u => u && u.google_sub === sub) || null;
  }catch(e){ return null; }
}
async function d1PutUser(env, user){
  const el = user.email.toLowerCase();
  const db = drizzle(env.DB);
  await db.insert(users).values({ email: el, data: JSON.stringify(user), updatedAt: Date.now() })
    .onConflictDoUpdate({ target: users.email, set: { data: JSON.stringify(user), updatedAt: Date.now() } });
}
export async function dbPutUser(env, user){
  await d1PutUser(env, user);                    // primary
  await r2put(env, 'AUTHDB', ukey(user.email), JSON.stringify(user), 'application/json'); // dual-write (rollback safety)
}
export async function dbDeleteUser(env, email){
  const el = email.toLowerCase();
  try{
    const db = drizzle(env.DB);
    await db.delete(users).where(eq(users.email, el));
  }catch(e){}
  await r2del(env, 'AUTHDB', ukey(el));
}
export async function dbCountUsers(env){
  // D1 empty + R2 non-empty = pre-migration state → count R2 to avoid
  // wrongly granting admin to the next registrant.
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({ c: sql`COUNT(*)` }).from(users);
    const c = rows[0]?.c ?? 0;
    if(c > 0) return c;
  }catch(e){}
  const keys = await r2list(env, 'AUTHDB', 'users/');
  return keys.length;
}
export async function dbListUsers(env){
  // Union D1 + R2 (self-healing: backfills stragglers on the way).
  const seen = new Map();
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({ data: users.data }).from(users);
    for(const row of rows){
      try{ const u = JSON.parse(row.data); if(u?.email) seen.set(u.email.toLowerCase(), u); }catch(e){}
    }
  }catch(e){}
  try{
    const keys = await r2list(env, 'AUTHDB', 'users/');
    for(const k of keys){
      const u = await r2getJson(env, 'AUTHDB', k);
      if(u?.email && !seen.has(u.email.toLowerCase())){
        seen.set(u.email.toLowerCase(), u);
        try{ await d1PutUser(env, u); }catch(e){}
      }
    }
  }catch(e){}
  return [...seen.values()];
}

// ---------- sessions (PHASE 3: D1 primary, R2 fallback) ----------
const skey = token => 'sessions/'+token+'.json';
async function d1GetSession(env, token){
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({ data: sessions.data, exp: sessions.exp }).from(sessions).where(eq(sessions.token, token)).limit(1);
    const row = rows[0];
    if(!row) return null;
    if(row.exp < Date.now()){ try{ await d1DelSession(env, token); }catch(e){} return null; }
    return JSON.parse(row.data);
  }catch(e){ return null; }
}
async function d1PutSession(env, sess){
  const db = drizzle(env.DB);
  await db.insert(sessions).values({
    token: sess.token, email: sess.email.toLowerCase(), exp: sess.exp,
    data: JSON.stringify(sess), updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: sessions.token,
    set: { email: sess.email.toLowerCase(), exp: sess.exp, data: JSON.stringify(sess), updatedAt: Date.now() },
  });
}
async function d1DelSession(env, token){
  const db = drizzle(env.DB);
  await db.delete(sessions).where(eq(sessions.token, token));
}
export async function dbGetSession(env, token){
  const s = await d1GetSession(env, token);
  if(s) return s;
  const r2s = await r2getJson(env, 'AUTHDB', skey(token));
  if(r2s){
    if(r2s.exp < Date.now()){ try{ await r2del(env, 'AUTHDB', skey(token)); }catch(e){} return null; }
    try{ await d1PutSession(env, r2s); }catch(e){}
    return r2s;
  }
  return null;
}
export async function dbPutSession(env, sess){
  await d1PutSession(env, sess);
  await r2put(env, 'AUTHDB', skey(sess.token), JSON.stringify(sess), 'application/json');
}
export async function dbDeleteSession(env, token){
  try{ await d1DelSession(env, token); }catch(e){}
  await r2del(env, 'AUTHDB', skey(token));
}
export async function dbDeleteSessionsForEmail(env, email){
  const el = email.toLowerCase();
  let n = 0;
  try{
    const db = drizzle(env.DB);
    // Drizzle D1 delete doesn't return changes count reliably; count first
    const rows = await db.select({ token: sessions.token }).from(sessions).where(eq(sessions.email, el));
    n += rows.length;
    await db.delete(sessions).where(eq(sessions.email, el));
  }catch(e){}
  const keys = await r2list(env, 'AUTHDB', 'sessions/');
  for(const k of keys){
    try{
      const s = await r2getJson(env, 'AUTHDB', k);
      if(s && String(s.email||'').toLowerCase() === el){ await r2del(env, 'AUTHDB', k); n++; }
    }catch(e){}
  }
  return n;
}

// ---------- bank blob (opaque) ----------
const bkey = email => 'bank/'+email.toLowerCase()+'.json';
export async function dbGetBankRaw(env, email){
  return r2get(env, 'AUTHDB', bkey(email));
}
export async function dbPutBankRaw(env, email, text){
  await r2put(env, 'AUTHDB', bkey(email), text, 'application/json');
}
export async function dbDeleteBank(env, email){
  await r2del(env, 'AUTHDB', bkey(email));
}

// ---------- D1 ----------
export async function dbRun(env, sql, params){
  if(!env.DB) throw new Error('D1 not bound');
  const ps = env.DB.prepare(sql);
  const bound = params && params.length ? ps.bind(...params) : ps;
  return bound.run();
}
// Delete every D1 row belonging to an email. Returns {table: deletedCount}.
export async function dbDeleteUserRows(env, email){
  const el = email.toLowerCase();
  const out = {};
  for(const t of D1_USER_TABLES){
    try{
      const r = await dbRun(env, `DELETE FROM ${t} WHERE email = ?`, [el]);
      out[t] = (r && r.changes) || 0;
    }catch(e){ out[t] = 'error:'+String(e.message||e).slice(0,60); }
  }
  return out;
}

// ---------- cascade ----------
// Deletes a user EVERYWHERE: R2 (user, bank, sessions) + D1 (all email rows).
// Returns a report; never throws on a single-store failure (collects errors).
export async function deleteUserCascade(env, email){
  const el = email.toLowerCase();
  const report = {email: el, r2: {}, d1: {}};
  try{ await dbDeleteUser(env, el); report.r2.user = true; }
  catch(e){ report.r2.user = 'error:'+String(e.message||e).slice(0,60); }
  try{ await dbDeleteBank(env, el); report.r2.bank = true; }
  catch(e){ report.r2.bank = 'error:'+String(e.message||e).slice(0,60); }
  try{ report.r2.sessions = await dbDeleteSessionsForEmail(env, el); }
  catch(e){ report.r2.sessions = 'error:'+String(e.message||e).slice(0,60); }
  try{ report.d1 = await dbDeleteUserRows(env, el); }
  catch(e){ report.d1 = {error: String(e.message||e).slice(0,60)}; }
  return report;
}
