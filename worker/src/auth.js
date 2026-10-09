import { jerr, randToken } from './utils.js';
import { dbGetUser, dbPutUser, dbGetSession, dbPutSession, dbDeleteSession, dbCountUsers } from './db.js';

// Hardcoded administrator account
const OWNER_EMAIL = "lethienhieuhcm@gmail.com";

/* ---------- server auth + RBAC (PHASE 3: D1 primary, R2 fallback via db.js) ---------- */
// Account DB (separate R2 bucket "english-lab-auth", binding AUTHDB):
//   users/{email}.json {email, salt, hash, role, created}
//   sessions/{token}.json {email, exp}
//   bank/{email}.json (encrypted blob, server can't read)
// Content DB (bucket "english-lab-data", binding DATA): books, uploads, jobs, analytics
const te = new TextEncoder();

export async function pbkdf2Hash(password, saltB64){
  const salt = Uint8Array.from(atob(saltB64), c=>c.charCodeAt(0));
  const km = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name:"PBKDF2", salt, iterations:100000, hash:"SHA-256"}, km, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

export async function getSession(request, env){
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer (.+)$/);
  if(!m) return null;
  return dbGetSession(env, m[1]); // {email, exp, token} | null
}

export async function getUser(env, email){
  return dbGetUser(env, String(email));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function handleSendCode(request, env){
  let d; try{ d = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const email = String(d.email||"").trim().toLowerCase();
  // Only Gmail allowed
  if(!/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(email)) return jerr("Only Gmail addresses allowed", 400);
  // Check if already registered
  const existing = await getUser(env, email);
  if(existing) return jerr("Email already registered", 400);
  // Generate 6-digit code
  const code = String(Math.floor(100000 + Math.random()*900000));
  const exp = Date.now() + 10*60*1000; // 10 minutes
  await env.AUTHDB.put(`verify/${email}.json`, JSON.stringify({code, exp, attempts: 0}), {
    httpMetadata: {contentType: "application/json"}
  });
  // Send via Resend (API key in env.RESEND_API_KEY)
  if(env.RESEND_API_KEY){
    try{
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "Pocket Personal <noreply@lethanhdong.one>",
          to: email,
          subject: "Your verification code",
          html: `<p>Your verification code is:</p><h1 style="font-size:32px;letter-spacing:8px">${code}</h1><p>Valid for 10 minutes.</p>`
        })
      });
    }catch(e){
      console.error("Email send failed:", e);
      // Don't fail the request, code is stored - user can try resend
    }
  }
  return new Response(JSON.stringify({ok:true, sent: !!env.RESEND_API_KEY}), {headers:{"Content-Type":"application/json"}});
}

export async function handleVerifyCode(request, env){
  let d; try{ d = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const email = String(d.email||"").trim().toLowerCase();
  const code = String(d.code||"").trim();
  const obj = await env.AUTHDB.get(`verify/${email}.json`);
  if(!obj) return jerr("No code sent. Request a new one.", 400);
  const v = await obj.json();
  if(Date.now() > v.exp){
    await env.AUTHDB.delete(`verify/${email}.json`);
    return jerr("Code expired. Request a new one.", 400);
  }
  if(v.attempts >= 5){
    await env.AUTHDB.delete(`verify/${email}.json`);
    return jerr("Too many attempts. Request a new one.", 400);
  }
  if(v.code !== code){
    v.attempts++;
    await env.AUTHDB.put(`verify/${email}.json`, JSON.stringify(v), {httpMetadata:{contentType:"application/json"}});
    return jerr("Invalid code", 400);
  }
  // Code valid - mark verified (delete the code, create verified marker)
  await env.AUTHDB.delete(`verify/${email}.json`);
  await env.AUTHDB.put(`verified/${email}.json`, JSON.stringify({email, ts: Date.now()}), {
    httpMetadata: {contentType: "application/json"}
  });
  return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
}

export async function handleRegister(request, env){
  let d; try{ d = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const email = String(d.email||"").trim().toLowerCase().slice(0,80);
  const pw = String(d.password||"");
  const dob = String(d.dob||""); // YYYY-MM-DD
  if(!EMAIL_RE.test(email)) return jerr("Enter a valid email address", 400);
  if(pw.length < 8) return jerr("Password min 8 chars", 400);
  // Validate DOB and calculate age group
  let ageGroup = "adult";
  if(dob){
    const m = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return jerr("Invalid birth date", 400);
    const birth = new Date(+m[1], +m[2]-1, +m[3]);
    if(isNaN(birth.getTime()) || birth > new Date()) return jerr("Invalid birth date", 400);
    const age = Math.floor((Date.now() - birth.getTime()) / 31557600000);
    if(age < 0 || age > 120) return jerr("Invalid birth date", 400);
    ageGroup = age < 18 ? "kid" : "adult";
  }
  if(await getUser(env, email)) return jerr("Email already registered", 409);
  // Only owner email gets admin role
  const role = (email === OWNER_EMAIL) ? "admin" : "user";
  const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const hash = await pbkdf2Hash(pw, salt);
  await dbPutUser(env, {
    email, salt, hash, role, dob: dob||null, ageGroup, created: Date.now(),
    plan: "free", plan_expires: null, plan_history: []
  });
  return new Response(JSON.stringify({ok:true, role, ageGroup, email, plan:"free"}), {headers:{"Content-Type":"application/json"}});
}

export async function handleLogin(request, env){
  let d; try{ d = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const email = String(d.email||"").trim().toLowerCase();
  const u = await getUser(env, email);
  if(!u) return jerr("Invalid credentials", 401);
  const hash = await pbkdf2Hash(String(d.password||""), u.salt);
  if(hash !== u.hash) return jerr("Invalid credentials", 401);
  const token = randToken();
  const fp = makeFingerprint(request, d.fp);
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const planInfo = getActivePlan(u);
  // Enforce concurrent session limit (kicks oldest if over)
  await enforceSessionLimit(env, u.email, planInfo.plan === "admin" ? "admin" : planInfo.plan);
  await dbPutSession(env, {email: u.email, exp: Date.now()+7*86400000, token, fp, ip, ua: request.headers.get("User-Agent")||"", created_at: Date.now()});
  const role = (u.email === OWNER_EMAIL) ? "admin" : "user";
  return new Response(JSON.stringify({token, email: u.email, role, ageGroup: u.ageGroup||"adult", plan: planInfo.plan, plan_expires: planInfo.expires}), {headers:{"Content-Type":"application/json"}});
}

// GET /api/auth/sessions - list active sessions for current user
export async function handleListSessions(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  try{
    const rows = await env.DB.prepare(
      "SELECT token, data, updated_at FROM sessions WHERE email=? AND exp>? ORDER BY updated_at DESC"
    ).bind(s.email.toLowerCase(), Date.now()).all();
    const list = (rows.results||[]).map(r => {
      let d = {};
      try{ d = JSON.parse(r.data||"{}"); }catch(e){}
      return {
        token: r.token.slice(0, 8) + "...", // partial for identification
        current: r.token === s.token,
        ip: d.ip || "",
        ua: (d.ua||"").slice(0, 80),
        created_at: d.created_at || r.updated_at,
        last_active: r.updated_at
      };
    });
    return sJson({sessions: list});
  }catch(e){ return jerr("Failed", 500); }
}

// POST /api/auth/sessions/revoke {token_prefix} - revoke a session (or all others)
export async function handleRevokeSession(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  let d; try{ d = await request.json(); }catch(e){ d = {}; }
  const prefix = String(d.token_prefix||"");
  try{
    if(d.all_others){
      const rows = await env.DB.prepare(
        "SELECT token FROM sessions WHERE email=? AND token!=?"
      ).bind(s.email.toLowerCase(), s.token).all();
      for(const r of (rows.results||[])) await dbDeleteSession(env, r.token);
      return sJson({ok:true, revoked: (rows.results||[]).length});
    }
    if(prefix){
      const rows = await env.DB.prepare(
        "SELECT token FROM sessions WHERE email=?"
      ).bind(s.email.toLowerCase()).all();
      let n = 0;
      for(const r of (rows.results||[])){
        if(r.token.startsWith(prefix) && r.token !== s.token){
          await dbDeleteSession(env, r.token);
          n++;
        }
      }
      return sJson({ok:true, revoked: n});
    }
    return jerr("Missing token_prefix or all_others", 400);
  }catch(e){ return jerr("Failed", 500); }
}

export async function handleLogout(request, env){
  const s = await getSession(request, env);
  if(s) await dbDeleteSession(env, s.token);
  return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
}

export async function handleMe(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const u = await getUser(env, s.email);
  const planInfo = getActivePlan(u);
  const role = (u.email === OWNER_EMAIL) ? "admin" : "user";
  return new Response(JSON.stringify({email: u.email, role, ageGroup: u.ageGroup||"adult", plan: planInfo.plan, plan_expires: planInfo.expires}), {headers:{"Content-Type":"application/json"}});
}

// Plan durations in milliseconds (all new plans are monthly)
export const PLAN_DURATIONS = {
  monthly: 30 * 86400000,
  // legacy (kept for backward compat, mapped to 30d)
  weekly: 30 * 86400000,
  yearly: 30 * 86400000,
};
// Tier-based packages (all monthly billing)
export const PLANS = {
  free: {
    id: "free", price: 0,
    apps: ["chess", "music", "english"],
    limits: { english_scans: 5, english_chars: 1000, english_uploads: 0, voice_chars: 0, watchlist: 0, portfolio_txns: 0, backtest: 0, alerts: 0, ai_calls: 10, agent_calls: 5 },
  },
  hocsinh: {
    id: "hocsinh", price: 29000,
    apps: ["chess", "music", "english"],
    limits: { english_scans: 50, english_chars: 5000, english_uploads: 3, voice_chars: 0, watchlist: 0, portfolio_txns: 0, backtest: 0, alerts: 0, ai_calls: 30, agent_calls: 20 },
  },
  sinhvien: {
    id: "sinhvien", price: 49000,
    apps: ["chess", "music", "english", "voice"],
    limits: { english_scans: 100, english_chars: 10000, english_uploads: 10, voice_chars: 30000, watchlist: 0, portfolio_txns: 0, backtest: 0, alerts: 0, ai_calls: 50, agent_calls: 30 },
  },
  dilam: {
    id: "dilam", price: 99000,
    apps: ["chess", "music", "english", "voice", "stocks_basic"],
    limits: { english_scans: 200, english_chars: 20000, english_uploads: 30, voice_chars: 100000, watchlist: 20, portfolio_txns: 0, backtest: 0, alerts: 0, ai_calls: 100, agent_calls: 60 },
  },
  nhadautu: {
    id: "nhadautu", price: 149000,
    apps: ["chess", "music", "english", "voice", "stocks_full"],
    limits: { english_scans: 500, english_chars: 50000, english_uploads: 100, voice_chars: 300000, watchlist: 20, portfolio_txns: 200, backtest: 10, alerts: 20, ai_calls: 200, agent_calls: 150 },
  },
};
export const PLAN_IDS = Object.keys(PLANS);
// Feature definitions: which app is required + which limit applies
// kind: "daily" (usage per day), "monthly" (usage per month), "cap" (max count),
//       "per_request" (opts.value checked against limit), "access" (app only)
const FEATURES = {
  english_scan:     { app: "english", limit: "english_scans",   usage: "english_scans",   kind: "daily" },
  english_text:     { app: "english", limit: "english_chars",   kind: "per_request" },
  english_upload:   { app: "english", limit: "english_uploads", usage: "english_uploads", kind: "monthly" },
  voice_tts:        { app: "voice",   limit: "voice_chars",     usage: "tts_chars",       kind: "daily" },
  stocks_view:      { app: ["stocks_basic", "stocks_full"], kind: "access" },
  stocks_watchlist: { app: ["stocks_basic", "stocks_full"], limit: "watchlist",      usage: "watchlist_count",  kind: "cap" },
  stocks_portfolio: { app: ["stocks_full"], kind: "access" },
  stocks_backtest:  { app: ["stocks_full"], limit: "backtest",  usage: "backtest_count",   kind: "daily" },
  stocks_alert:     { app: ["stocks_full"], limit: "alerts",    usage: "alerts_count",     kind: "cap" },
  stock_agent:      { app: "english", limit: "agent_calls", usage: "agent_calls", kind: "daily" },
  // legacy aliases (kept for backward compat)
  dict:             { app: "english", limit: "dict_lookups", usage: "dict",      kind: "daily", legacy_limit: 50 },
  ai_explain:       { app: "english", limit: "ai_calls", usage: "ai_calls", kind: "daily" },
  ai_quiz:          { app: "english", limit: "ai_calls", usage: "ai_calls", kind: "daily" },
  tts_chars:        { app: "voice",   limit: "voice_chars",  usage: "tts_chars", kind: "daily" },
  watchlist_add:    { app: ["stocks_basic", "stocks_full"], limit: "watchlist", usage: "watchlist_count", kind: "cap" },
};
// Returns active plan, auto-downgrading expired paid plans to free
export function getActivePlan(u){
  if(!u) return {plan:"free", expires:null};
  if(u.email === OWNER_EMAIL) return {plan:"admin", expires:null};
  const plan = u.plan || "free";
  if(!PLANS[plan]) return {plan:"free", expires:null}; // unknown/legacy plan -> free
  if(plan === "free" || !u.plan_expires) return {plan:"free", expires:null};
  if(Date.now() > u.plan_expires) return {plan:"free", expires:null}; // expired
  return {plan, expires: u.plan_expires};
}
// Max concurrent sessions per plan (anti account-sharing)
const SESSION_LIMITS = { free: 1, hocsinh: 1, sinhvien: 2, dilam: 3, nhadautu: 5, admin: 99 };

// Create fingerprint from request (VPN-proof: doesn't rely on IP)
export function makeFingerprint(request, bodyFp){
  const ua = request.headers.get("User-Agent") || "";
  // bodyFp: {screen, tz, lang} sent by frontend
  const parts = [ua, bodyFp?.screen||"", bodyFp?.tz||"", bodyFp?.lang||""];
  // Simple hash (not crypto-grade, just for grouping)
  let h = 0;
  const s = parts.join("|");
  for(let i=0;i<s.length;i++){ h = ((h<<5)-h+s.charCodeAt(i))|0; }
  return (h>>>0).toString(16);
}

// Enforce concurrent session limit: kick oldest if over limit
export async function enforceSessionLimit(env, email, plan){
  const limit = SESSION_LIMITS[plan] ?? 1;
  try{
    const rows = await env.DB.prepare(
      "SELECT token, updated_at FROM sessions WHERE email=? AND exp>? ORDER BY updated_at ASC"
    ).bind(email.toLowerCase(), Date.now()).all();
    const sessions = rows.results || [];
    if(sessions.length >= limit){
      // Delete oldest to make room for the new one
      const toDelete = sessions.slice(0, sessions.length - limit + 1);
      for(const s of toDelete){
        await env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(s.token).run();
      }
      return toDelete.length;
    }
  }catch(e){}
  return 0;
}

// Check if user can use a feature.
// Returns {ok:true} or {ok:false, reason, used, limit}.
// reason: "app_locked" (plan lacks the app) or "limit_reached".
export function canUseFeature(u, feature, usage, opts){
  usage = usage || {};
  opts = opts || {};
  const {plan} = getActivePlan(u);
  if(plan === "admin") return {ok:true};
  const p = PLANS[plan] || PLANS.free;
  const f = FEATURES[feature];
  if(!f) return {ok:true}; // unknown feature = allowed
  // App access check
  const apps = Array.isArray(f.app) ? f.app : [f.app];
  const hasApp = apps.some(a => p.apps.includes(a));
  if(!hasApp) return {ok:false, reason:"app_locked"};
  // Limit check
  if(f.kind === "per_request"){
    const limit = p.limits[f.limit] || 0;
    const value = opts.value || 0;
    if(value > limit) return {ok:false, reason:"limit_reached", limit, used:value};
    return {ok:true};
  }
  if(f.kind === "daily" || f.kind === "monthly" || f.kind === "cap"){
    let limit = p.limits[f.limit];
    if(limit === undefined && f.legacy_limit !== undefined) limit = f.legacy_limit;
    if(limit === undefined) return {ok:true};
    const used = usage[f.usage] || 0;
    if(used >= limit) return {ok:false, reason:"limit_reached", limit, used};
    return {ok:true};
  }
  return {ok:true}; // access-only
}
export async function requireAdmin(request, env){
  const s = await getSession(request, env);
  if(!s) return {err: jerr("Not logged in", 401)};
  const u = await getUser(env, s.email);
  if(!u || u.email !== OWNER_EMAIL) return {err: jerr("Admin only", 403)};
  return {user: u, session: s};
}

// Google Sign-In
function getGoogleCfg(env){
  return {
    client_id: env.GOOGLE_CLIENT_ID || "",
    client_secret: env.GOOGLE_CLIENT_SECRET || "",
    redirect_uri: "https://lethanhdong.one/api/auth/google/callback",
  };
}

export async function handleGoogleLogin(request, env){
  const cfg = getGoogleCfg(env);
  if(!cfg.client_id) return jerr("Google not configured", 500);
  const params = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: cfg.redirect_uri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
  });
  return new Response(JSON.stringify({url: "https://accounts.google.com/o/oauth2/v2/auth?"+params.toString()}), {headers:{"Content-Type":"application/json"}});
}

export async function handleGoogleCallback(request, env){
 try{
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if(!code) return new Response("Missing code", {status:400});
  const cfg = getGoogleCfg(env);
  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      code, client_id: cfg.client_id, client_secret: cfg.client_secret,
      redirect_uri: cfg.redirect_uri, grant_type: "authorization_code",
    }).toString(),
  });
  if(!tokRes.ok) return new Response("Token exchange failed", {status:500});
  const tok = await tokRes.json();
  // Get user info
  const meRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: {"Authorization": "Bearer "+tok.access_token},
  });
  if(!meRes.ok) return new Response("Failed to get user info", {status:500});
  const me = await meRes.json();
  const email = String(me.email||"").toLowerCase();
  if(!email) return new Response("No email", {status:400});

  // Find or create user
  let u = await getUser(env, email);
  if(!u){
    const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    u = {email, salt, hash: "", role: "user", ageGroup: "adult", created: Date.now(), google: true, name: me.name||""};
    // First user becomes admin
    try{
      if(u.email === OWNER_EMAIL) u.role = "admin";
    }catch(e){ /* ignore, default to user */ }
    await dbPutUser(env, u);
  }
  const token = randToken();
  const fp = makeFingerprint(request, null);
  const planInfo = getActivePlan(u);
  await enforceSessionLimit(env, u.email, planInfo.plan === "admin" ? "admin" : planInfo.plan);
  await dbPutSession(env, {email: u.email, exp: Date.now()+7*86400000, token, fp, ip: request.headers.get("CF-Connecting-IP")||"", ua: request.headers.get("User-Agent")||"", created_at: Date.now()});
  // Redirect to hub with token in hash (frontend picks it up)
  // Return loading page instead of 302 (better UX - user sees progress)
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>...</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f7f9}.box{text-align:center;color:#6b7280}.spin{width:40px;height:40px;border:4px solid #e8ebf0;border-top-color:#0d9d6c;border-radius:50%;animation:s 1s linear infinite;margin:0 auto 16px}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div class="box"><div class="spin"></div><div id="msg">Signing in...</div></div><script>var L=(navigator.language||"en").slice(0,2);var T={vi:"Đang đăng nhập...",en:"Signing in...",zh:"正在登录...",ko:"로그인 중..."};document.getElementById("msg").textContent=T[L]||T.en;location.href="https://lethanhdong.one/hub#token=${token}";</script></body></html>`;
  return new Response(html, {headers:{"Content-Type":"text/html;charset=UTF-8","Cache-Control":"no-store"}});
 }catch(e){ return new Response("Callback error: "+(e.message||e), {status:500}); }
}
