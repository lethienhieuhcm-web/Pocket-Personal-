// worker/src/billing.js — subscription plans, usage tracking, limits.
import { getUser, getSession, requireAdmin, getActivePlan, canUseFeature, PLAN_DURATIONS, PLAN_IDS } from './auth.js';
import { dbPutUser, dbGetSession } from './db.js';

function jerr(msg, code){ return new Response(JSON.stringify({error: msg}), {status: code||400, headers:{"Content-Type":"application/json"}}); }
function jok(d){ return new Response(JSON.stringify(d), {headers:{"Content-Type":"application/json"}}); }

function todayStr(){
  const n = new Date(Date.now() + 7*3600000); // VN time
  return n.toISOString().slice(0,10);
}

// Get or create today's usage row for a user
export async function getUsage(env, email){
  const today = todayStr();
  const row = await env.DB.prepare("SELECT * FROM usage_daily WHERE email=? AND date=?").bind(email, today).first();
  if(row) return row;
  await env.DB.prepare("INSERT INTO usage_daily (email, date) VALUES (?, ?)").bind(email, today).run();
  return {email, date: today, dict_lookups: 0, tts_chars: 0, ai_calls: 0, agent_calls: 0};
}

export async function incrUsage(env, email, field, amount){
  const today = todayStr();
  amount = amount || 1;
  await env.DB.prepare(`INSERT INTO usage_daily (email, date, ${field}) VALUES (?, ?, ?)
    ON CONFLICT(email, date) DO UPDATE SET ${field} = ${field} + ?`)
    .bind(email, today, amount, amount).run();
}

// Middleware: check if user can use a feature. Returns {ok} or Response (error).
// opts: {value} for per-request limits (e.g. char count), {usage} to merge extra counters.
export async function checkFeature(request, env, feature, opts){
  opts = opts || {};
  const s = await getSession(request, env);
  if(!s) return {err: jerr("Not logged in", 401)};
  const u = await getUser(env, s.email);
  if(!u) return {err: jerr("User not found", 401)};
  let usage = {};
  try{
    const row = await getUsage(env, u.email);
    usage = {dict: row.dict_lookups, tts_chars: row.tts_chars, english_scans: row.english_scans, english_uploads: row.english_uploads, backtest_count: row.backtest_count, ai_calls: row.ai_calls || 0, agent_calls: row.agent_calls || 0};
  }catch(e){ /* usage table may lack new columns */ }
  Object.assign(usage, opts.usage || {});
  const r = canUseFeature(u, feature, usage, opts);
  if(!r.ok) return {err: jerr("Limit reached. Please upgrade to continue.", 402)};
  return {user: u, usage};
}

// GET /api/user/plan
export async function handleGetPlan(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const u = await getUser(env, s.email);
  if(!u) return jerr("User not found", 401);
  const p = getActivePlan(u);
  const daysLeft = p.expires ? Math.max(0, Math.ceil((p.expires - Date.now())/86400000)) : null;
  return jok({plan: p.plan, expires_at: p.expires, days_left: daysLeft});
}

// GET /api/user/usage
export async function handleGetUsage(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const u = await getUser(env, s.email);
  if(!u) return jerr("User not found", 401);
  const usage = await getUsage(env, u.email);
  return jok({date: usage.date, dict_lookups: usage.dict_lookups, tts_chars: usage.tts_chars});
}

// POST /api/admin/set-plan {email, plan, note}
export async function handleSetPlan(request, env){
  const a = await requireAdmin(request, env);
  if(a.err) return a.err;
  let d; try{ d = await request.json(); }catch(e){ return jerr("Bad JSON"); }
  const email = String(d.email||"").trim().toLowerCase();
  const plan = String(d.plan||"").trim();
  if(!email) return jerr("Email required");
  if(!PLAN_IDS.includes(plan)) return jerr("Invalid plan");
  const u = await getUser(env, email);
  if(!u) return jerr("User not found", 404);

  const now = Date.now();
  let expires = null;
  if(plan !== "free"){
    const dur = PLAN_DURATIONS[plan];
    // Stack on existing expiry if still active
    const base = (u.plan_expires && u.plan_expires > now) ? u.plan_expires : now;
    expires = base + dur;
  }
  const history = u.plan_history || [];
  history.push({plan, activated_at: now, expires_at: expires, by: a.user.email, note: d.note||""});

  u.plan = plan;
  u.plan_expires = expires;
  u.plan_history = history.slice(-20); // keep last 20
  await dbPutUser(env, u);

  // Log to subscriptions table
  if(plan !== "free"){
    await env.DB.prepare("INSERT INTO subscriptions (email, plan, started_at, expires_at, activated_by, note) VALUES (?,?,?,?,?,?)")
      .bind(email, plan, now, expires, a.user.email, d.note||"").run();
  }
  return jok({ok: true, plan, expires_at: expires});
}

// GET /api/admin/subscriptions — list recent subscriptions
