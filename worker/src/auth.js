import { jerr, randToken, sJson } from './utils.js';
import { dbGetUser, dbPutUser, dbDeleteUser, dbGetSession, dbPutSession, dbDeleteSession, dbCountUsers, dbGetUserByGoogleSub } from './db.js';
import { drizzle } from "drizzle-orm/d1";
import { eq, and, gt, ne, asc, desc, lt, sql } from "drizzle-orm";
import { sessions, rateLimits } from "./schema.js";

// Hardcoded administrator account
export const OWNER_EMAIL = "lethienhieuhcm@gmail.com";

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
  let tok = m[1];
  // Chịu được token cũ bị lưu dạng JSON-quoted: Bearer "abc" -> abc.
  // (Frontend từ bản này chỉ ghi chuỗi thường; đây là phòng thủ cho token cũ.)
  if(tok.length >= 2 && tok[0] === '"' && tok[tok.length-1] === '"') tok = tok.slice(1, -1);
  return dbGetSession(env, tok); // {email, exp, token} | null
}

export async function getUser(env, email){
  return dbGetUser(env, String(email));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---- 2.2: Email helper (tái dùng cho verify + reset, theo pattern GitHub) ----
async function sendEmail(env, to, subject, html){
  if(!env.RESEND_API_KEY) return false;
  try{
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "Pocket Personal <noreply@lethanhdong.one>",
        to,
        subject,
        html
      })
    });
    return r.ok;
  }catch(e){
    console.error("Email send failed:", e);
    return false;
  }
}

// ---- 2.2: Email verification via token link (pattern GitHub) ----
// Token lưu KV: verify-token/{token} -> {email, exp} (24h)
// Khác với web flow (6-digit code): link 1-click, UX tốt hơn trên mobile.
const VERIFY_TOKEN_TTL = 24*3600*1000; // 24 giờ

async function sendVerificationEmail(env, email){
  const token = randToken();
  await env.AUTHDB.put(`verify-token/${token}.json`, JSON.stringify({
    email: email.toLowerCase(), exp: Date.now() + VERIFY_TOKEN_TTL
  }), {httpMetadata: {contentType: "application/json"}});
  const link = `https://lethanhdong.one/api/auth/verify?token=${token}`;
  const sent = await sendEmail(env, email,
    "Verify your email — Pocket Personal",
    `<p>Welcome! Click the link below to verify your email address:</p>
     <p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#0d9d6c;color:#fff;text-decoration:none;border-radius:8px">Verify email</a></p>
     <p>Or copy this link: <br><code>${link}</code></p>
     <p>This link expires in 24 hours.</p>`
  );
  return {token, sent};
}

export async function handleVerifyEmail(request, env){
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  if(!token) return new Response("Missing token", {status: 400});
  // R2: get() trả về object, phải gọi .json() (không dùng tham số "json" như KV)
  let rec = null;
  try{
    const obj = await env.AUTHDB.get(`verify-token/${token}.json`);
    if(obj) rec = await obj.json();
  }catch(e){}
  if(!rec || rec.exp < Date.now()){
    return new Response(verifyPage(false, "This link is invalid or has expired."), {
      headers: {"Content-Type": "text/html;charset=UTF-8"}
    });
  }
  const u = await getUser(env, rec.email);
  if(!u){
    return new Response(verifyPage(false, "Account not found."), {
      headers: {"Content-Type": "text/html;charset=UTF-8"}
    });
  }
  u.verified = true;
  await dbPutUser(env, u);
  await env.AUTHDB.delete(`verify-token/${token}.json`);
  // Xoá marker web flow nếu có (đồng bộ 2 flow)
  await env.AUTHDB.delete(`verified/${rec.email}.json`).catch(()=>{});
  return new Response(verifyPage(true, "Your email has been verified. You can now log in to the app."), {
    headers: {"Content-Type": "text/html;charset=UTF-8"}
  });
}

function verifyPage(ok, msg){
  const title = ok ? "Email verified" : "Verification failed";
  const color = ok ? "#0d9d6c" : "#dc2626";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f6f7f9}.box{text-align:center;max-width:400px;padding:32px}.icon{font-size:48px;margin-bottom:16px}h1{color:${color};font-size:24px}p{color:#6b7280;line-height:1.6}</style></head>
<body><div class="box"><div class="icon">${ok ? "✅" : "❌"}</div><h1>${title}</h1><p>${msg}</p></div></body></html>`;
}

export async function handleResendVerification(request, env){
  let d; try{ d = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const email = String(d.email||"").trim().toLowerCase();
  if(!EMAIL_RE.test(email)) return jerr("Enter a valid email address", 400);
  const u = await getUser(env, email);
  // Không tiết lộ email có tồn tại không (chống enumeration) — luôn trả ok
  if(u && u.verified !== true){
    await sendVerificationEmail(env, email);
  }
  return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
}

// ---- 2.2: Password reset via token link (pattern GitHub/Google) ----
// Token lưu KV: reset-token/{token} -> {email, exp} (1 giờ, single-use)
const RESET_TOKEN_TTL = 3600*1000; // 1 giờ

export async function handleForgotPassword(request, env){
  let d; try{ d = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const email = String(d.email||"").trim().toLowerCase();
  if(!EMAIL_RE.test(email)) return jerr("Enter a valid email address", 400);
  const u = await getUser(env, email);
  // Luôn trả ok để không lộ email có tồn tại (chống enumeration, như GitHub)
  if(u){
    const token = randToken();
    await env.AUTHDB.put(`reset-token/${token}.json`, JSON.stringify({
      email: email, exp: Date.now() + RESET_TOKEN_TTL
    }), {httpMetadata: {contentType: "application/json"}});
    const link = `https://lethanhdong.one/reset-password?token=${token}`;
    await sendEmail(env, email,
      "Reset your password — Pocket Personal",
      `<p>Click the link below to reset your password:</p>
       <p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#0d9d6c;color:#fff;text-decoration:none;border-radius:8px">Reset password</a></p>
       <p>Or copy this link: <br><code>${link}</code></p>
       <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>`
    );
  }
  return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
}

export async function handleResetPassword(request, env){
  let d; try{ d = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const token = String(d.token||"");
  const newPw = String(d.newPassword||"");
  if(!token) return jerr("Missing token", 400);
  if(newPw.length < 8) return jerr("Password min 8 chars", 400);
  // R2: get() trả về object, phải gọi .json()
  let rec = null;
  try{
    const obj = await env.AUTHDB.get(`reset-token/${token}.json`);
    if(obj) rec = await obj.json();
  }catch(e){}
  if(!rec || rec.exp < Date.now()) return jerr("Invalid or expired token", 400);
  const u = await getUser(env, rec.email);
  if(!u) return jerr("Invalid token", 400);
  // Đổi mật khẩu → xoá tất cả sessions (như GitHub: password change invalidates sessions)
  const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  u.salt = salt;
  u.hash = await pbkdf2Hash(newPw, salt);
  await dbPutUser(env, u);
  await env.AUTHDB.delete(`reset-token/${token}.json`);
  // Xoá sessions cũ
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({token: sessions.token}).from(sessions)
      .where(eq(sessions.email, rec.email));
    for(const r of rows) await dbDeleteSession(env, r.token);
  }catch(e){ /* best effort */ }
  return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
}

// GET /reset-password?token=... — trang đặt mật khẩu mới (cho link trong email)
export async function handleResetPasswordPage(request, env){
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  // Kiểm tra token còn hiệu lực không (không tiết lộ email)
  // R2: get() trả về object, phải gọi .json()
  let rec = null;
  try{
    if(token){
      const obj = await env.AUTHDB.get(`reset-token/${token}.json`);
      if(obj) rec = await obj.json();
    }
  }catch(e){}
  const valid = rec && rec.exp > Date.now();
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset password</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f6f7f9}.box{background:#fff;padding:32px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1);max-width:400px;width:90%}h1{font-size:20px;margin:0 0 16px}input{width:100%;padding:12px;margin:8px 0;border:1px solid #ddd;border-radius:8px;box-sizing:border-box;font-size:16px}button{width:100%;padding:12px;background:#0d9d6c;color:#fff;border:0;border-radius:8px;font-size:16px;cursor:pointer;margin-top:8px}button:disabled{opacity:.5}.err{color:#dc2626;font-size:14px;margin-top:8px;display:none}.ok{color:#0d9d6c;font-size:14px;margin-top:8px;display:none}</style></head>
<body><div class="box">
<h1>Đặt mật khẩu mới</h1>
${valid ? `
<input type="password" id="pw1" placeholder="Mật khẩu mới (tối thiểu 8 ký tự)" autocomplete="new-password">
<input type="password" id="pw2" placeholder="Nhập lại mật khẩu mới" autocomplete="new-password">
<button id="btn" onclick="doReset()">Đặt lại mật khẩu</button>
<div class="err" id="err"></div><div class="ok" id="ok"></div>
<script>
async function doReset(){
  const p1 = document.getElementById('pw1').value;
  const p2 = document.getElementById('pw2').value;
  const err = document.getElementById('err'), ok = document.getElementById('ok');
  err.style.display = 'none'; ok.style.display = 'none';
  if(p1.length < 8){ err.textContent = 'Mật khẩu tối thiểu 8 ký tự'; err.style.display = 'block'; return; }
  if(p1 !== p2){ err.textContent = 'Hai mật khẩu không khớp'; err.style.display = 'block'; return; }
  const btn = document.getElementById('btn'); btn.disabled = true;
  try{
    const r = await fetch('/api/auth/reset-password', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: ${JSON.stringify(token)}, newPassword: p1})
    });
    const j = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(j.error || 'Failed');
    ok.textContent = 'Đặt lại mật khẩu thành công! Bạn có thể đăng nhập trong app.';
    ok.style.display = 'block';
    document.getElementById('pw1').style.display = 'none';
    document.getElementById('pw2').style.display = 'none';
    btn.style.display = 'none';
  }catch(e){ err.textContent = e.message; err.style.display = 'block'; btn.disabled = false; }
}
</script>` : `
<p style="color:#dc2626">Link này không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu link mới từ app.</p>`}
</div></body></html>`;
  return new Response(html, {headers: {"Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store"}});
}

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
  // 2.2: Kiểm tra web flow đã verify chưa (verified/{email}.json từ verify-code).
  // Nếu web đã verify → verified=true luôn, không gửi email token nữa.
  // Nếu chưa (Android register trực tiếp) → verified=false + gửi email token link.
  // R2: get() trả về object, phải gọi .json()
  let verified = false;
  try{
    const obj = await env.AUTHDB.get(`verified/${email}.json`);
    if(obj){
      const marker = await obj.json();
      if(marker && marker.email === email){
        verified = true;
        await env.AUTHDB.delete(`verified/${email}.json`).catch(()=>{});
      }
    }
  }catch(e){ /* không có marker → chưa verify */ }
  await dbPutUser(env, {
    email, salt, hash, role, dob: dob||null, ageGroup, created: Date.now(),
    plan: "free", plan_expires: null, plan_history: [],
    verified
  });
  let sent = false;
  if(!verified){
    const r = await sendVerificationEmail(env, email);
    sent = r.sent;
  }
  return new Response(JSON.stringify({ok:true, role, ageGroup, email, plan:"free", verified, needsVerification: !verified, emailSent: sent}), {headers:{"Content-Type":"application/json"}});
}

// ---- dac-app Phase 1.1: per-(email+fingerprint) failed-login lock + timing equalization ----
// Chốt C (2026-10-13): key = email + fingerprint, BỎ IP khỏi key.
// Lý do: IP xoay — sandbox mỗi request 1 IPv6 khác (đã chứng minh bằng D1), user thật đổi
// WiFi/4G/CGNAT cũng xoay IP → per-(IP+email) không bao giờ đủ 5. Fingerprint (UA + screen/tz/lang,
// hàm makeFingerprint đã có, VPN-proof) ổn định theo thiết bị, không theo IP.
// Tái dùng bảng D1 rate_limits đã có (PK: ip, endpoint, windowStart) — KHÔNG tạo bảng mới (8d).
// Cột `ip` lưu "fp:<fingerprint>" cho hàng login-failed (để phân biệt với IP thật của hàng generic).
// endpoint = "/api/auth/login-failed:<sha256hex(email)>" — hash email để không lưu PII plain text.
// Cửa sổ CỐ ĐỊNH 15 phút, khớp pattern checkRateLimit trong index.js (không phải sliding window — ghi rõ giới hạn).
// Đếm cả email không tồn tại để không lộ email có tồn tại qua 429 vs 401.
// Lưu ý: attacker có thể spoof fingerprint (đặt cùng UA + fp body) nếu biết fingerprint victim —
// khó hơn nhiều so với per-email (chỉ cần email), và lock chỉ 15 phút. App Android cần gửi `fp`
// ở 1.3 để fingerprint phân biệt thiết bị tốt nhất (hiện chỉ dựa UA khi không có fp).
const LOGIN_FAIL_WINDOW_SEC = 900; // 15 phút
const LOGIN_FAIL_MAX = 5;
const LOGIN_FAIL_PREFIX = "/api/auth/login-failed:";
// Salt giả cho email không tồn tại: 16 byte 0 → base64 "AAAAAAAAAAAAAAAAAAAAAA=="
// PBKDF2 chạy đủ 100k vòng như user thật → thời gian tương đương (chống timing attack).
const DUMMY_SALT_B64 = "AAAAAAAAAAAAAAAAAAAAAA==";

async function loginFailEndpoint(email){
  const data = new TextEncoder().encode(String(email||"").toLowerCase());
  const buf = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
  return LOGIN_FAIL_PREFIX + hex;
}

function loginFailClientKey(fp){ return "fp:" + String(fp||""); }

async function checkLoginLocked(env, fp, email){
  try{
    const endpoint = await loginFailEndpoint(email);
    const ipKey = loginFailClientKey(fp);
    const windowStart = Math.floor(Date.now()/1000/LOGIN_FAIL_WINDOW_SEC)*LOGIN_FAIL_WINDOW_SEC;
    const db = drizzle(env.DB);
    // Dọn cửa sổ cũ cho đúng (fingerprint, endpoint) này — chỉ giữ cửa sổ hiện tại.
    await db.delete(rateLimits).where(and(eq(rateLimits.ip, ipKey), eq(rateLimits.endpoint, endpoint), lt(rateLimits.windowStart, windowStart)));
    const rows = await db.select({ count: rateLimits.count }).from(rateLimits)
      .where(and(eq(rateLimits.ip, ipKey), eq(rateLimits.endpoint, endpoint), eq(rateLimits.windowStart, windowStart))).limit(1);
    const count = rows[0]?.count ?? 0;
    return { locked: count >= LOGIN_FAIL_MAX, count };
  }catch(e){ return { locked: false, count: 0 }; } // fail-open: lỗi DB không chặn login
}

async function recordLoginFailed(env, fp, email){
  try{
    const endpoint = await loginFailEndpoint(email);
    const ipKey = loginFailClientKey(fp);
    const windowStart = Math.floor(Date.now()/1000/LOGIN_FAIL_WINDOW_SEC)*LOGIN_FAIL_WINDOW_SEC;
    const db = drizzle(env.DB);
    await db.insert(rateLimits).values({ ip: ipKey, endpoint, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimits.ip, rateLimits.endpoint, rateLimits.windowStart],
        set: { count: sql`${rateLimits.count} + 1` },
      });
  }catch(e){} // fail-open
}

async function clearLoginFailed(env, fp, email){
  try{
    const endpoint = await loginFailEndpoint(email);
    const ipKey = loginFailClientKey(fp);
    const db = drizzle(env.DB);
    await db.delete(rateLimits).where(and(eq(rateLimits.ip, ipKey), eq(rateLimits.endpoint, endpoint)));
  }catch(e){} // fail-open
}

export async function handleLogin(request, env){
  let d; try{ d = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const email = String(d.email||"").trim().toLowerCase();
  const password = String(d.password||"");
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const fp = makeFingerprint(request, d.fp); // Chốt C: lock key = email + fingerprint, không dùng IP
  // 1.1-C: khoá per (email+fingerprint) sau 5 lần sai / 15 phút — check TRƯỚC PBKDF2.
  const lock = await checkLoginLocked(env, fp, email);
  if(lock.locked) return jerr("Too many failed attempts. Try again in 15 minutes.", 429);
  // 1.1: timing equalization — luôn chạy PBKDF2 đủ vòng, kể cả khi user không tồn tại.
  const u = await getUser(env, email);
  const hash = await pbkdf2Hash(password, u ? u.salt : DUMMY_SALT_B64);
  if(!u || hash !== u.hash){
    await recordLoginFailed(env, fp, email);
    return jerr("Invalid credentials", 401);
  }
  // 2.2: Chặn login nếu email chưa verify (user cũ không có field → cho qua, grandfathered).
  if(u.verified === false){
    return new Response(JSON.stringify({error: "email_not_verified", needsVerification: true}),
      {status: 403, headers: {"Content-Type": "application/json"}});
  }
  // Login đúng → xoá đếm sai để user không bị khoá oan vì lần sai cũ.
  await clearLoginFailed(env, fp, email);
  const token = randToken();
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
    const db = drizzle(env.DB);
    const rows = await db.select({ token: sessions.token, data: sessions.data, updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(and(eq(sessions.email, s.email.toLowerCase()), gt(sessions.exp, Date.now())))
      .orderBy(desc(sessions.updatedAt));
    const list = rows.map(r => {
      let d = {};
      try{ d = JSON.parse(r.data||"{}"); }catch(e){}
      return {
        token: r.token.slice(0, 8) + "...", // partial for identification
        current: r.token === s.token,
        ip: d.ip || "",
        ua: (d.ua||"").slice(0, 80),
        created_at: d.created_at || r.updatedAt,
        last_active: r.updatedAt
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
    const db = drizzle(env.DB);
    if(d.all_others){
      const rows = await db.select({ token: sessions.token }).from(sessions)
        .where(and(eq(sessions.email, s.email.toLowerCase()), ne(sessions.token, s.token)));
      for(const r of rows) await dbDeleteSession(env, r.token);
      return sJson({ok:true, revoked: rows.length});
    }
    if(prefix){
      const rows = await db.select({ token: sessions.token }).from(sessions)
        .where(eq(sessions.email, s.email.toLowerCase()));
      let n = 0;
      for(const r of rows){
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
  // 5-tier packages (all monthly billing, added 2026-10-07)
  hocsinh: 30 * 86400000,
  sinhvien: 30 * 86400000,
  dilam: 30 * 86400000,
  nhadautu: 30 * 86400000,
  // legacy (kept for backward compat, mapped to 30d)
  weekly: 30 * 86400000,
  yearly: 30 * 86400000,
};
// Tier-based packages (all monthly billing)
export const PLANS = {
  free: {
    id: "free", price: 0,
    apps: ["chess", "music", "english", "voice", "browser"],
    limits: { english_chars: 1000, english_uploads: 0, voice_chars: 2000, watchlist: 0, portfolio_txns: 0, backtest: 0, alerts: 0, ai_calls: 10, agent_calls: 5, browse_pages: 20 },
  },
  hocsinh: {
    id: "hocsinh", price: 29000,
    apps: ["chess", "music", "english", "voice", "browser"],
    limits: { english_chars: 5000, english_uploads: 3, voice_chars: 5000, watchlist: 0, portfolio_txns: 0, backtest: 0, alerts: 0, ai_calls: 30, agent_calls: 20, browse_pages: 50 },
  },
  sinhvien: {
    id: "sinhvien", price: 49000,
    apps: ["chess", "music", "english", "voice", "browser"],
    limits: { english_chars: 10000, english_uploads: 10, voice_chars: 30000, watchlist: 0, portfolio_txns: 0, backtest: 0, alerts: 0, ai_calls: 50, agent_calls: 30, browse_pages: 100 },
  },
  dilam: {
    id: "dilam", price: 99000,
    apps: ["chess", "music", "english", "voice", "stocks_basic", "browser"],
    limits: { english_chars: 20000, english_uploads: 30, voice_chars: 100000, watchlist: 20, portfolio_txns: 0, backtest: 0, alerts: 0, ai_calls: 100, agent_calls: 60, browse_pages: 200 },
  },
  nhadautu: {
    id: "nhadautu", price: 149000,
    apps: ["chess", "music", "english", "voice", "stocks_full", "browser"],
    limits: { english_chars: 50000, english_uploads: 100, voice_chars: 300000, watchlist: 20, portfolio_txns: 200, backtest: 10, alerts: 20, ai_calls: 200, agent_calls: 150, browse_pages: 500 },
  },
};
export const PLAN_IDS = Object.keys(PLANS);
// Feature definitions: which app is required + which limit applies
// kind: "daily" (usage per day), "monthly" (usage per month), "cap" (max count),
//       "per_request" (opts.value checked against limit), "access" (app only)
const FEATURES = {
  // english_scan đã xoá (Chốt 2026-10-11): scan OCR chạy 100% phía client
  // (Tesseract.js), server không có endpoint để đếm nên quota này không
  // enforce được. Giữ cột DB cho tương thích, không config limit nữa.
  english_text:     { app: "english", limit: "english_chars",   kind: "per_request" },
  english_upload:   { app: "english", limit: "english_uploads", usage: "english_uploads", kind: "monthly" },
  voice_tts:        { app: "voice",   limit: "voice_chars",     usage: "tts_chars",       kind: "daily" },
  stocks_view:      { app: ["stocks_basic", "stocks_full"], kind: "access" },
  stocks_watchlist: { app: ["stocks_basic", "stocks_full"], limit: "watchlist",      usage: "watchlist_count",  kind: "cap" },
  stocks_portfolio: { app: ["stocks_full"], kind: "access" },
  stocks_backtest:  { app: ["stocks_full"], limit: "backtest",  usage: "backtest_count",   kind: "daily" },
  stocks_alert:     { app: ["stocks_full"], limit: "alerts",    usage: "alerts_count",     kind: "cap" },
  stock_agent:      { app: "english", limit: "agent_calls", usage: "agent_calls", kind: "daily" },
  browse_pages:     { app: "browser", limit: "browse_pages", usage: "browse_pages", kind: "daily" },
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
    const db = drizzle(env.DB);
    const rows = await db.select({ token: sessions.token, updatedAt: sessions.updatedAt }).from(sessions)
      .where(and(eq(sessions.email, email.toLowerCase()), gt(sessions.exp, Date.now())))
      .orderBy(asc(sessions.updatedAt));
    if(rows.length >= limit){
      // Delete oldest to make room for the new one
      const toDelete = rows.slice(0, rows.length - limit + 1);
      for(const s of toDelete){
        await db.delete(sessions).where(eq(sessions.token, s.token));
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
  // v3.0 Phase B: xin luôn scope Drive để DAC player dùng ngay (1 lần duy nhất).
  // User thấy 1 màn hình consent với cả 2 quyền.
  const params = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: cfg.redirect_uri,
    response_type: "code",
    scope: "openid email profile https://www.googleapis.com/auth/drive.readonly",
    access_type: "offline",
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
  // v3.0 Phase B: nếu được cấp refresh_token (scope Drive) → lưu vào driveTokens
  // để DAC player dùng ngay không cần kết nối lại.
  try{
    if(tok.refresh_token && tok.access_token){
      const { drizzle } = await import("drizzle-orm/d1");
      const { driveTokens } = await import("./schema.js");
      const db = drizzle(env.DB);
      await db.insert(driveTokens).values({
        email: email,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAt: Date.now()+(tok.expires_in||3600)*1000,
        createdAt: Date.now(),
      }).onConflictDoUpdate({
        target: driveTokens.email,
        set: {accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now()+(tok.expires_in||3600)*1000},
      });
    }
  }catch(e){ /* không chặn login nếu lưu Drive token thất bại */ }
  // Redirect to hub with token in hash (frontend picks it up)
  // Return loading page instead of 302 (better UX - user sees progress)
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>...</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f7f9}.box{text-align:center;color:#6b7280}.spin{width:40px;height:40px;border:4px solid #e8ebf0;border-top-color:#0d9d6c;border-radius:50%;animation:s 1s linear infinite;margin:0 auto 16px}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div class="box"><div class="spin"></div><div id="msg">Signing in...</div></div><script>var L=(navigator.language||"en").slice(0,2);var T={vi:"Đang đăng nhập...",en:"Signing in...",zh:"正在登录...",ko:"로그인 중..."};document.getElementById("msg").textContent=T[L]||T.en;location.href="https://lethanhdong.one/hub#token=${token}";</script></body></html>`;
  return new Response(html, {headers:{"Content-Type":"text/html;charset=UTF-8","Cache-Control":"no-store"}});
 }catch(e){ return new Response("Callback error: "+(e.message||e), {status:500}); }
}

// 2.4: POST /api/auth/google/idtoken — Android Credential Manager flow.
// Verify Google ID token qua JWKS (không tin client, không cần client_secret).
// Request: { idToken: "<JWT>" }
// Response: { token, email, role, ... } giống /api/auth/login
// Lỗi: 401 { error: 'invalid_token' }
export async function handleGoogleIdToken(request, env){
  let d; try{ d = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const idToken = String(d.idToken || "");
  if(!idToken) return jerr("Missing idToken", 400);

  // 1. Parse JWT (header.payload.signature)
  // base64url trong JWT không có padding ("=") — phải bù đủ bội số 4
  // trước khi atob, nếu không token hợp lệ vẫn bị từ chối.
  const parts = idToken.split(".");
  if(parts.length !== 3) return jerr("invalid_token", 401);
  let header, payload;
  const b64urlToBytes = (s) => {
    let b = s.replace(/-/g, "+").replace(/_/g, "/");
    while(b.length % 4) b += "=";
    return Uint8Array.from(atob(b), c => c.charCodeAt(0));
  };
  try{
    const td = new TextDecoder();
    header = JSON.parse(td.decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(td.decode(b64urlToBytes(parts[1])));
  }catch(e){ return jerr("invalid_token", 401); }

  // 2. Fetch Google JWKS, tìm key theo kid
  let jwks;
  try{
    const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if(!r.ok) return jerr("Failed to fetch JWKS", 500);
    jwks = await r.json();
  }catch(e){ return jerr("Failed to fetch JWKS", 500); }
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if(!jwk) return jerr("invalid_token", 401);

  // 3. Verify signature (RS256) bằng Web Crypto
  try{
    const key = await crypto.subtle.importKey(
      "jwk", jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, ["verify"]
    );
    const data = new TextEncoder().encode(parts[0] + "." + parts[1]);
    const sig = b64urlToBytes(parts[2]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
    if(!valid) return jerr("invalid_token", 401);
  }catch(e){ return jerr("invalid_token", 401); }

  // 4. Verify claims (theo checklist Google)
  const now = Math.floor(Date.now() / 1000);
  const aud = String(payload.aud || "");
  // aud phải là một trong các client ID của mình:
  // Android dùng Web client ID (GOOGLE_WEB_CLIENT_ID),
  // iOS dùng iOS client ID (GOOGLE_IOS_CLIENT_ID) — thêm 2026-10-14.
  const allowedAuds = [env.GOOGLE_WEB_CLIENT_ID, env.GOOGLE_IOS_CLIENT_ID]
    .filter(v => typeof v === "string" && v.length > 0);
  if(allowedAuds.length === 0 || !allowedAuds.includes(aud)) return jerr("invalid_token", 401);
  const iss = String(payload.iss || "");
  if(iss !== "https://accounts.google.com" && iss !== "accounts.google.com"){
    return jerr("invalid_token", 401);
  }
  if(!payload.exp || payload.exp < now) return jerr("invalid_token", 401);
  if(payload.email_verified !== true && payload.email_verified !== "true"){
    return jerr("invalid_token", 401);
  }
  const email = String(payload.email || "").toLowerCase();
  const sub = String(payload.sub || "");
  if(!email || !sub) return jerr("invalid_token", 401);

  // 5. Tìm hoặc tạo user
  // - google_sub đã có (lookup độc lập theo sub, vì sub ổn định hơn email) → login
  // - email đã tồn tại + email_verified → link (thêm google_sub, giữ password)
  // - mới → tạo user (verified=true, auth_provider='google')
  let u = await dbGetUserByGoogleSub(env, sub);
  if(u){
    // Đã từng đăng nhập Google. Google có thể đổi email của user (sub giữ nguyên)
    // → migrate sang key email mới, xoá row cũ để không còn 2 account.
    const storedEmail = String(u.email || "").toLowerCase();
    if(storedEmail && storedEmail !== email){
      u.email = email;
      await dbPutUser(env, u);
      await dbDeleteUser(env, storedEmail);
    }
  } else {
    u = await getUser(env, email);
  }
  if(u && !u.google_sub){
    // Link nếu chưa có google_sub
    u.google_sub = sub;
    u.auth_provider = u.auth_provider || "password"; // giữ provider cũ, thêm google
    await dbPutUser(env, u);
  } else if(u && u.google_sub && u.google_sub !== sub){
    // google_sub khác → token không khớp user (chặn confused deputy)
    return jerr("invalid_token", 401);
  } else if(!u){
    // User mới từ Google — email đã verify bởi Google nên verified=true
    const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    u = {
      email, salt, hash: "", role: "user", ageGroup: "adult",
      created: Date.now(), verified: true,
      google_sub: sub, auth_provider: "google",
      name: String(payload.name || ""), picture: String(payload.picture || ""),
    };
    if(u.email === OWNER_EMAIL) u.role = "admin";
    await dbPutUser(env, u);
  }

  // 6. Tạo session (giống login)
  const token = randToken();
  const fp = makeFingerprint(request, d.fp);
  const planInfo = getActivePlan(u);
  await enforceSessionLimit(env, u.email, planInfo.plan === "admin" ? "admin" : planInfo.plan);
  await dbPutSession(env, {
    email: u.email, exp: Date.now()+7*86400000, token, fp,
    ip: request.headers.get("CF-Connecting-IP")||"",
    ua: request.headers.get("User-Agent")||"", created_at: Date.now()
  });
  const role = (u.email === OWNER_EMAIL) ? "admin" : "user";
  return new Response(JSON.stringify({
    token, email: u.email, role,
    ageGroup: u.ageGroup||"adult", plan: planInfo.plan, plan_expires: planInfo.expires,
  }), {headers:{"Content-Type":"application/json"}});
}
