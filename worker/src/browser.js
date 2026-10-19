// worker/src/browser.js — Proxy browser backend.
// Kiến trúc 19/10/2026 (Henrry Chốt): PWA -> Worker -> relay botkeep -> website đích.
// Worker POST tới relay (Bearer EGRESS_TOKEN); relay fetch bằng IP egress của
// server botkeep cá nhân. Website đích thấy IP botkeep, không thấy IP Cloudflare
// hay IP máy user. Không có EGRESS_TOKEN -> fallback fetch trực tiếp (hành vi cũ).
// Quy tắc 9 (RULES.md): KHÔNG né CAPTCHA/anti-bot, KHÔNG dùng proxy để vượt chặn.
// Nếu site chặn bot/trả captcha -> trả nguyên trạng thái về cho user, không bypass.

import { drizzle } from "drizzle-orm/d1";
import { eq, and, sql } from "drizzle-orm";
import { browserCookies } from "./schema.js";
import { getUser, canUseFeature } from "./auth.js";
import { dbGetSession } from "./db.js";

const B64_RE = /^[A-Za-z0-9\-_]+$/;

function b64urlEncode(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function jerr(msg, code) {
  return new Response(JSON.stringify({ error: msg }), {
    status: code || 400,
    headers: { "Content-Type": "application/json" },
  });
}

// --- SSRF guard: chỉ cho http/https, port 80/443, chặn IP nội bộ & chính domain mình ---
const OWN_HOSTS = ["lethanhdong.one"];
function isAllowedTarget(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false; // chặn URL dạng user:pass@host
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (port !== "80" && port !== "443") return false;
  const h = u.hostname.toLowerCase();
  for (const own of OWN_HOSTS) {
    if (h === own || h.endsWith("." + own)) return false; // chống proxy loop
  }
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  if (h === "metadata.google.internal" || h.endsWith(".internal")) return false;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const p = v4.slice(1).map(Number);
    if (p.some((n) => n < 0 || n > 255)) return false;
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 169 && p[1] === 254) return false; // link-local (gồm 169.254.169.254)
  }
  if (h === "[::1]" || h === "::1") return false;
  return true;
}

// --- Egress relay (botkeep): Worker -> relay (IP cá nhân) -> website đích ---
// Relay protocol (egress-relay.py, verify live 19/10/2026):
//   POST /fetch {"url","method","headers","body_b64"} (Bearer EGRESS_TOKEN)
//     -> 200 {"status","headers":[[k,v],...],"body_b64","truncated"}
//   GET /health -> {"ok":true}
// Relay KHÔNG follow redirect (trả 3xx nguyên) — Worker giữ logic redirect
// manual + SSRF guard + cookie jar per-hop như cũ.
const RELAY_URL_DEFAULT = "https://wwfzth.bot-keep.xyz"; // verify live 19/10/2026

function relayCfg(env) {
  const token = env.EGRESS_TOKEN || "";
  if (!token) return null;
  const base = (env.EGRESS_RELAY_URL || RELAY_URL_DEFAULT).replace(/\/+$/, "");
  return { url: base + "/fetch", token };
}

function b64encodeBuf(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64decodeToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Fetch 1 hop qua relay. Trả về Response (tương thích với code xử lý bên dưới:
// HTMLRewriter.transform, .headers.get/getSetCookie, .body streaming).
// Trả null khi chưa cấu hình relay -> caller fallback fetch trực tiếp.
// Ném lỗi khi relay từ chối (401/403) hoặc response sai định dạng.
// Relay stream NDJSON (chunk 64KB) -> Worker pipe thang vao Response body,
// khong doi buffer het (TTFB nhanh gap ~4 lan so voi ban JSON 1 cuc).
async function fetchViaRelay(env, targetHref, method, headers, bodyBuf, timeoutMs) {
  const cfg = relayCfg(env);
  if (!cfg) return null;
  const plain = {};
  headers.forEach((v, k) => { plain[k] = v; });
  const payload = {
    url: targetHref,
    method: method,
    headers: plain,
    body_b64: bodyBuf && bodyBuf.byteLength ? b64encodeBuf(bodyBuf) : null,
    stream: true,
  };
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
  const done = () => clearTimeout(timer);
  const poke = () => {
    // Idle-timeout: co du lieu ve -> cho them (tai file cham khong chet oan)
    clearTimeout(timer);
    timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs || 25000);
  };
  let res;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.token,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    done();
    throw e;
  }
  if (res.status === 401 || res.status === 403) {
    done();
    throw new Error("relay rejected (" + res.status + ")");
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("x-ndjson") || !res.body) {
    // Fallback: relay cu (JSON 1 cuc) — doc het roi dung nhu truoc.
    let data;
    try {
      data = await res.json();
    } catch (e) {
      done();
      throw new Error("relay bad json");
    }
    done();
    if (!data || typeof data.status !== "number" || typeof data.body_b64 !== "string") {
      throw new Error("relay bad response");
    }
    return responseFromRelayJson(data.status, data.headers, data.body_b64);
  }
  // Stream NDJSON: dong dau = head {status, headers}, sau la {chunk_b64} / {done}.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  async function readLine() {
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        return line;
      }
      const r = await reader.read();
      if (r.done) {
        const line = buf;
        buf = "";
        return line || null;
      }
      buf += dec.decode(r.value, { stream: true });
    }
  }
  let head;
  try {
    head = JSON.parse(await readLine());
  } catch (e) {
    done();
    throw new Error("relay bad stream head");
  }
  if (!head || typeof head.status !== "number" || !Array.isArray(head.headers)) {
    done();
    throw new Error("relay bad stream head");
  }
  const rh = new Headers();
  for (const pair of head.headers) {
    try { rh.append(pair[0], pair[1]); } catch (e) { /* header lạ: bỏ qua */ }
  }
  // Stream NDJSON qua TransformStream (new ReadableStream() can
  // streams_enable_constructors flag ma Worker chua bat -> dung TransformStream
  // co san). Pump chay nen: doc tung dong tu relay, write chunk vao writable.
  // Timer la idle-timeout: reset moi khi co chunk (tai file cham van khong chet).
  const ts = new TransformStream();
  const writer = ts.writable.getWriter();
  const pump = (async () => {
    try {
      while (true) {
        let line;
        try {
          line = await readLine();
        } catch (e) {
          throw e;
        }
        if (line === null) break;
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          throw new Error("relay bad chunk");
        }
        if (msg.done) break;
        if (typeof msg.chunk_b64 === "string" && msg.chunk_b64) {
          await writer.write(b64decodeToBuf(msg.chunk_b64));
        }
        poke(); // co du lieu -> reset idle timer
      }
      done();
      try { await writer.close(); } catch (e) {}
    } catch (e) {
      done();
      try { await writer.abort(e); } catch (_) {}
      try { reader.cancel(); } catch (_) {}
      try { ctrl.abort(); } catch (_) {}
    }
  })();
  // Huy pump khi consumer huy body (vd redirect): tranh treo connection.
  // (TransformStream: writer.write se reject khi readable bi cancel -> pump tu dung.)
  return new Response(ts.readable, { status: head.status, headers: rh });
}

// Dung Response tu dang JSON 1 cuc cua relay (fallback khi relay cu).
function responseFromRelayJson(status, hlist, bodyB64) {
  const rh = new Headers();
  for (const pair of hlist || []) {
    try { rh.append(pair[0], pair[1]); } catch (e) { /* header lạ: bỏ qua */ }
  }
  return new Response(b64decodeToBuf(bodyB64 || ""), { status: status, headers: rh });
}

// --- Auth: Bearer header (XHR) hoặc ?t= (iframe navigation không gửi header được) ---
async function resolveSession(request, env, url) {
  let tok = "";
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer (.+)$/);
  if (m) {
    tok = m[1].trim();
    if (tok.length >= 2 && tok[0] === '"' && tok[tok.length - 1] === '"') tok = tok.slice(1, -1);
  } else {
    tok = url.searchParams.get("t") || "";
  }
  if (!tok) return null;
  const s = await dbGetSession(env, tok);
  if (!s) return null;
  return { email: s.email, token: tok };
}

// --- Cookie jar: per user + host, lưu D1 ---
async function loadCookies(env, email, targetUrl) {
  try {
    const db = drizzle(env.DB);
    const now = Date.now();
    const host = targetUrl.hostname.toLowerCase();
    const path = targetUrl.pathname || "/";
    const https = targetUrl.protocol === "https:";
    // Dọn cookie hết hạn (xác suất 10% mỗi request để nhẹ DB)
    if (Math.random() < 0.1) {
      await db
        .delete(browserCookies)
        .where(sql`${browserCookies.email} = ${email} AND ${browserCookies.expiresAt} != 0 AND ${browserCookies.expiresAt} < ${now}`);
    }
    const rows = await db.select().from(browserCookies).where(eq(browserCookies.email, email));
    const out = [];
    for (const r of rows) {
      const ch = r.host.toLowerCase();
      const hostOk = host === ch || (ch.startsWith(".") && host.endsWith(ch));
      if (!hostOk) continue;
      if (!path.startsWith(r.path || "/")) continue;
      if (r.expiresAt !== 0 && r.expiresAt <= now) continue;
      if (r.secure && !https) continue;
      out.push({ name: r.name, value: r.value, pathLen: (r.path || "/").length });
    }
    out.sort((a, b) => b.pathLen - a.pathLen);
    if (!out.length) return "";
    return out.map((c) => c.name + "=" + c.value).join("; ");
  } catch (e) {
    return "";
  }
}

function parseSetCookieLine(line) {
  const parts = line.split(";");
  const nv = parts.shift().trim();
  const eqi = nv.indexOf("=");
  if (eqi <= 0) return null;
  const name = nv.slice(0, eqi).trim();
  const value = nv.slice(eqi + 1).trim();
  if (!name) return null;
  const c = { name, value, domain: "", path: "", maxAge: null, expires: 0, secure: false };
  for (const p of parts) {
    const t = p.trim();
    const pi = t.indexOf("=");
    const k = (pi >= 0 ? t.slice(0, pi) : t).trim().toLowerCase();
    const v = pi >= 0 ? t.slice(pi + 1).trim() : "";
    if (k === "domain") c.domain = v.toLowerCase().replace(/^\./, "");
    else if (k === "path" && v.startsWith("/")) c.path = v;
    else if (k === "max-age") { const n = parseInt(v, 10); if (!isNaN(n)) c.maxAge = n; }
    else if (k === "expires") { const d = Date.parse(v); if (!isNaN(d)) c.expires = d; }
    else if (k === "secure") c.secure = true;
  }
  return c;
}

async function storeCookies(env, email, targetUrl, headers) {
  let lines = [];
  try {
    if (typeof headers.getSetCookie === "function") lines = headers.getSetCookie();
  } catch (e) { /* fallback bên dưới */ }
  if (!lines.length) {
    const raw = headers.get("set-cookie");
    if (raw) lines = [raw]; // tốt nhất có thể khi API thiếu
  }
  if (!lines.length) return;
  const host = targetUrl.hostname.toLowerCase();
  const defPath = targetUrl.pathname || "/";
  const now = Date.now();
  try {
    const db = drizzle(env.DB);
    for (const line of lines) {
      const c = parseSetCookieLine(line);
      if (!c) continue;
      // Domain phải khớp host (chống supercookie)
      let ch = host;
      if (c.domain) {
        if (host !== c.domain && !host.endsWith("." + c.domain)) continue;
        ch = "." + c.domain;
      }
      const path = c.path || defPath.slice(0, defPath.lastIndexOf("/") + 1) || "/";
      let exp = 0;
      if (c.maxAge !== null) exp = c.maxAge <= 0 ? 1 : now + c.maxAge * 1000;
      else if (c.expires) exp = c.expires;
      if (exp !== 0 && exp <= now) {
        await db
          .delete(browserCookies)
          .where(
            and(
              eq(browserCookies.email, email),
              eq(browserCookies.host, ch),
              eq(browserCookies.path, path),
              eq(browserCookies.name, c.name)
            )
          );
        continue;
      }
      await db
        .insert(browserCookies)
        .values({ email, host: ch, name: c.name, value: c.value, path, expiresAt: exp, secure: c.secure ? 1 : 0 })
        .onConflictDoUpdate({
          target: [browserCookies.email, browserCookies.host, browserCookies.path, browserCookies.name],
          set: { value: c.value, expiresAt: exp, secure: c.secure ? 1 : 0 },
        });
    }
  } catch (e) { /* jar lỗi thì bỏ qua, không chặn browse */ }
}

// --- URL rewriting ---
function proxify(absHref, token) {
  return "/api/browse?url=" + b64urlEncode(absHref) + (token ? "&t=" + encodeURIComponent(token) : "");
}

function rewriteAttrVal(val, base, token) {
  if (val === null || val === undefined) return val;
  val = String(val).trim();
  if (!val) return val;
  if (/^(data|blob|javascript|mailto|tel|sms):/i.test(val)) return val;
  try {
    let abs;
    if (val.startsWith("#")) {
      abs = new URL(base.split("#")[0] + val);
    } else {
      abs = new URL(val, base);
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return val;
    return proxify(abs.href, token);
  } catch (e) {
    return val;
  }
}

function rewriteSrcset(val, base, token) {
  return String(val)
    .split(",")
    .map((part) => {
      const t = part.trim();
      if (!t) return t;
      const sp = t.search(/\s/);
      if (sp < 0) return rewriteAttrVal(t, base, token);
      return rewriteAttrVal(t.slice(0, sp), base, token) + t.slice(sp);
    })
    .join(", ");
}

function rewriteCssUrls(css, base, token) {
  return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    return "url(" + q + rewriteAttrVal(u.trim(), base, token) + q + ")";
  });
}

// Script vá fetch/XHR/WebSocket chạy trong trang đích (đầu <head>).
// __PP_TARGET__ là URL gốc của trang (để resolve URL tương đối trong JS).
// WebSocket: fail-closed (chặn, không rò IP) — bản MVP chưa relay WS.
function patchScript(targetHref) {
  const lines = [
    "(function(){try{",
    "var __PP_TARGET__=" + JSON.stringify(targetHref) + ";",
    "var __PP_T__=new URLSearchParams(location.search).get('t')||'';",
    "function __b64u(s){var enc=new TextEncoder().encode(s);var bin='';",
    "for(var i=0;i<enc.length;i++)bin+=String.fromCharCode(enc[i]);",
    "var b=btoa(bin);return b.replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}",
    "function __px(u){try{var abs=new URL(u,__PP_TARGET__);",
    "if(abs.origin===location.origin)return u;",
    "if(abs.protocol!=='http:'&&abs.protocol!=='https:')return u;",
    "return '/api/browse?url='+__b64u(abs.href)+(__PP_T__?'&t='+encodeURIComponent(__PP_T__):'');",
    "}catch(e){return u;}}",
    "var __f=window.fetch;",
    "window.fetch=function(input,init){",
    "if(typeof input==='string')input=__px(input);",
    "else if(input&&input.url){try{input=new Request(__px(input.url),input);}catch(e){}}",
    "return __f.call(this,input,init);};",
    "var __o=XMLHttpRequest.prototype.open;",
    "XMLHttpRequest.prototype.open=function(m,u){return __o.call(this,m,__px(u));};",
    "var __WS=window.WebSocket;",
    "function __pxWs(u){try{var abs=new URL(u,__PP_TARGET__);",
    "var isWs=abs.protocol==='ws:'||abs.protocol==='wss:';",
    "var wasRel=!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u);",
    "if(!isWs&&!wasRel)return null;",
    "if(!isWs)abs.protocol=(abs.protocol==='https:'?'wss:':'ws:');",
    "return (location.protocol==='https:'?'wss://':'ws://')+location.host+",
    "'/api/browse-ws?url='+__b64u(abs.href)+(__PP_T__?'&t='+encodeURIComponent(__PP_T__):'');",
    "}catch(e){return null;}}",
    "function __WS2(u,p){var px=null;try{px=__pxWs(u);}catch(e){}",
    "if(px){try{return new __WS(px,p);}catch(e){}}",
    "return new __WS(u,p);}",
    "__WS2.CONNECTING=__WS.CONNECTING;__WS2.OPEN=__WS.OPEN;__WS2.CLOSING=__WS.CLOSING;__WS2.CLOSED=__WS.CLOSED;",
    "__WS2.prototype=__WS.prototype;",
    "window.WebSocket=__WS2;",
    // B0-3: vá điều hướng bằng JS để trang ở lại trong proxy.
    // window.open / location.assign / location.replace chưa vá -> mở URL thô,
    // iframe văng khỏi proxy (404 hoặc rò ngoài). location.href không chặn
    // được (setter đặc biệt của trình duyệt) -> ghi nhận giới hạn, không cố.
    // Tất cả bọc try/catch: vá không được thì giữ hành vi cũ, không gãy trang.
    "var __wopen=window.open;",
    "window.open=function(u,t,f){",
    "try{if(typeof u==='string'){var p=__px(u);if(p)u=p;}}catch(e){}",
    "return __wopen.call(window,u,t,f);};",
    "try{",
    "var __Loc=window.location;",
    "var __asg=__Loc.assign.bind(__Loc);",
    "var __rpl=__Loc.replace.bind(__Loc);",
    "__Loc.assign=function(u){try{var p=__px(u);__asg(p||u);}catch(e){try{__asg(u);}catch(_){}}};",
    "__Loc.replace=function(u){try{var p=__px(u);__rpl(p||u);}catch(e){try{__rpl(u);}catch(_){}}};",
    "}catch(e){}",
    "}catch(e){}})();",
  ];
  return "<script>" + lines.join("\n") + "</scr" + "ipt>";
}

function errorPage(title, desc) {
  const html =
    "<!DOCTYPE html><html lang='vi'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>" + title + "</title></head>" +
    "<body style='font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;color:#333'>" +
    "<h2 style='font-size:20px'>" + title + "</h2>" +
    "<p style='color:#666;font-size:14px'>" + desc + "</p>" +
    "</body></html>";
  return new Response(html, {
    status: 502,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Trang "hết lượt" 4 ngôn ngữ (hiện trong iframe khi quota ngày hết).
// Kiểu big tech: nói rõ giới hạn + nút nâng cấp, không phải JSON khô.
const QUOTA_I18N = {
  vi: { title: "Hết lượt hôm nay", desc: "Bạn đã dùng hết lượt duyệt web hôm nay. Nâng cấp gói để duyệt thêm, hoặc quay lại vào ngày mai.", upgrade: "Xem các gói" },
  en: { title: "Daily limit reached", desc: "You've used up today's browsing pages. Upgrade your plan for more, or come back tomorrow.", upgrade: "See plans" },
  zh: { title: "今日额度已用完", desc: "您今日的浏览额度已用完。升级套餐可继续使用，或明天再来。", upgrade: "查看套餐" },
  ko: { title: "오늘 한도 초과", desc: "오늘의 탐색 횟수를 모두 사용했습니다. 요금제를 업그레이드하거나 내일 다시 이용해 주세요.", upgrade: "요금제 보기" },
};
const AUTH_I18N = {
  vi: { title: "Phiên đăng nhập hết hạn", desc: "Vui lòng đăng nhập lại để tiếp tục duyệt web.", login: "Đăng nhập" },
  en: { title: "Session expired", desc: "Please log in again to continue browsing.", login: "Log in" },
  zh: { title: "登录已过期", desc: "请重新登录以继续浏览。", login: "登录" },
  ko: { title: "세션 만료", desc: "계속 탐색하려면 다시 로그인해 주세요.", login: "로그인" },
};
function quotaLang(request) {
  const al = (request.headers.get("Accept-Language") || "").toLowerCase();
  if (al.startsWith("vi")) return "vi";
  if (al.startsWith("zh")) return "zh";
  if (al.startsWith("ko")) return "ko";
  return "en";
}
// Đồng bộ ngôn ngữ trang thân thiện theo app (elab_uiLang), không chỉ theo
// Accept-Language của trình duyệt. Trang serve từ cùng origin nên script đọc
// được localStorage của app. Server render theo Accept-Language trước để không
// trắng chữ, script sửa lại theo đúng ngôn ngữ app đã chọn (kiểu big tech:
// server đoán tốt nhất, client hiệu chỉnh theo preference đã lưu).
function appLangFixScript(T, actionKey) {
  const norm = {};
  for (const k of Object.keys(T)) norm[k] = { title: T[k].title, desc: T[k].desc, action: T[k][actionKey] };
  return "<script>(function(){try{" +
    "var T=" + JSON.stringify(norm) + ";" +
    "var L=JSON.parse(localStorage.getItem('elab_uiLang')||'\"vi\"');" +
    "if(!T[L])return;" +
    "var S=T[L];" +
    "document.title=S.title;" +
    "var t=document.getElementById('pp-t');if(t)t.textContent=S.title;" +
    "var d=document.getElementById('pp-d');if(d)d.textContent=S.desc;" +
    "var a=document.getElementById('pp-a');if(a)a.textContent=S.action;" +
    "document.documentElement.lang=L;" +
    "}catch(e){}})();</script>";
}
function quotaExceededPage(request) {  const lang = quotaLang(request);
  const T = QUOTA_I18N[lang];
  const html =
    "<!DOCTYPE html><html lang='" + lang + "'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>" + T.title + "</title></head>" +
    "<body style='font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:48px 20px;color:#333;text-align:center'>" +
    "<h2 id='pp-t' style='font-size:20px;margin:0 0 12px'>" + T.title + "</h2>" +
    "<p id='pp-d' style='color:#666;font-size:14px;line-height:1.6;margin:0 0 24px'>" + T.desc + "</p>" +
    "<a id='pp-a' href='/upgrade' target='_top' style='display:inline-block;background:#0d9d6c;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 28px;border-radius:12px'>" + T.upgrade + "</a>" +
    appLangFixScript(QUOTA_I18N, "upgrade") +
    "</body></html>";
  return new Response(html, {
    status: 402,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function authRequiredPage(request) {
  const lang = quotaLang(request);
  const T = AUTH_I18N[lang];
  const html =
    "<!DOCTYPE html><html lang='" + lang + "'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>" + T.title + "</title></head>" +
    "<body style='font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:48px 20px;color:#333;text-align:center'>" +
    "<h2 id='pp-t' style='font-size:20px;margin:0 0 12px'>" + T.title + "</h2>" +
    "<p id='pp-d' style='color:#666;font-size:14px;line-height:1.6;margin:0 0 24px'>" + T.desc + "</p>" +
    "<a id='pp-a' href='/login' target='_top' style='display:inline-block;background:#0d9d6c;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 28px;border-radius:12px'>" + T.login + "</a>" +
    appLangFixScript(AUTH_I18N, "login") +
    "</body></html>";
  return new Response(html, {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
// B0-2: Trang "bị chặn" + "lỗi máy chủ" 4 ngôn ngữ.
// Khi site từ chối kết nối (403/429/400) hoặc báo lỗi (5xx), hiện trang thân
// thiện thay vì để user nhìn trang challenge/lỗi thô của site. Chỉ dùng cho
// navigation; asset/XHR giữ nguyên để không gãy tài nguyên con.
// Kiểu big tech: nói rõ + hướng xử lý, không tiết lộ công nghệ (RULES.md 5).
const BLOCKED_I18N = {
  vi: { title: "Trang này bị chặn", desc: "Trang web không cho phép mở qua ứng dụng này (thường do chính sách chống truy cập tự động). Bạn hãy mở địa chỉ này bằng trình duyệt trên máy của mình.", retry: "Thử lại" },
  en: { title: "This page is blocked", desc: "The website does not allow opening through this app (usually due to anti-automation policy). Please open this address in your device's browser.", retry: "Retry" },
  zh: { title: "此页面被阻止", desc: "该网站不允许通过此应用打开（通常是反自动化策略）。请在您设备的浏览器中打开此地址。", retry: "重试" },
  ko: { title: "이 페이지가 차단됨", desc: "웹사이트에서 이 앱을 통한 열기를 허용하지 않습니다(보통 자동화 방지 정책 때문). 기기의 브라우저에서 이 주소를 열어 주세요.", retry: "다시 시도" },
};
const UPSTREAMERR_I18N = {
  vi: { title: "Không mở được trang", desc: "Máy chủ của trang web đang báo lỗi. Vui lòng thử lại sau, hoặc mở bằng trình duyệt trên máy của bạn.", retry: "Thử lại" },
  en: { title: "Couldn't open the page", desc: "The website's server is returning an error. Please try again later, or open it in your device's browser.", retry: "Retry" },
  zh: { title: "无法打开页面", desc: "网站服务器正在返回错误。请稍后重试，或在您设备的浏览器中打开。", retry: "重试" },
  ko: { title: "페이지를 열 수 없습니다", desc: "웹사이트 서버에서 오류가 발생하고 있습니다. 나중에 다시 시도하거나 기기의 브라우저에서 열어 주세요.", retry: "다시 시도" },
};
// Địa chỉ không hợp lệ (400 khi validate URL) — 4 ngôn ngữ.
const BADURL_I18N = {
  vi: { title: "Địa chỉ không đúng", desc: "Địa chỉ web bạn nhập không hợp lệ. Kiểm tra lại rồi thử lại.", retry: "Thử lại" },
  en: { title: "Invalid address", desc: "The web address you entered is not valid. Check it and try again.", retry: "Retry" },
  zh: { title: "地址无效", desc: "您输入的网址无效。请检查后重试。", retry: "重试" },
  ko: { title: "주소가 올바르지 않습니다", desc: "입력한 웹 주소가 유효하지 않습니다. 확인 후 다시 시도해 주세요.", retry: "다시 시도" },
};
function friendlyErrorPage(request, status, T) {
  const lang = quotaLang(request);
  const S = T[lang];
  const html =
    "<!DOCTYPE html><html lang='" + lang + "'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>" + S.title + "</title></head>" +
    "<body style='font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:48px 20px;color:#333;text-align:center'>" +
    "<h2 id='pp-t' style='font-size:20px;margin:0 0 12px'>" + S.title + "</h2>" +
    "<p id='pp-d' style='color:#666;font-size:14px;line-height:1.6;margin:0 0 24px'>" + S.desc + "</p>" +
    "<button id='pp-a' style='display:inline-block;background:#0d9d6c;color:#fff;border:0;font-weight:700;font-size:15px;padding:12px 28px;border-radius:12px;cursor:pointer'>" + S.retry + "</button>" +
    "<script>document.getElementById('pp-a').addEventListener('click',function(){location.reload();});</script>" +
    appLangFixScript(T, "retry") +
    "</body></html>";
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
// true nếu request là navigation (muốn thấy trang HTML, không phải JSON)
function wantsHtmlPage(request) {
  const mode = request.headers.get("Sec-Fetch-Mode") || "";
  const accept = request.headers.get("Accept") || "";
  return mode === "navigate" || (!mode && accept.includes("text/html"));
}

// GET/POST /api/browse?url=<base64url>&t=<session>
export async function handleBrowse(request, env, url) {
  // 1. Auth (custom: Bearer hoặc ?t=)
  const sess = await resolveSession(request, env, url);
  if (!sess) return wantsHtmlPage(request) ? authRequiredPage(request) : jerr("Not logged in", 401);
  const user = await getUser(env, sess.email);
  if (!user) return wantsHtmlPage(request) ? authRequiredPage(request) : jerr("User not found", 401);

  // 2. Quota theo gói (lazy import tránh circular, pattern của content.js)
  const { getUsage, incrUsage } = await import("./billing.js");
  let usage = {};
  try {
    const row = await getUsage(env, user.email);
    usage = { browse_pages: row.browse_pages || 0 };
  } catch (e) { /* bỏ qua, fail-open như checkFeature */ }
  const chk = canUseFeature(user, "browse_pages", usage, {});
  if (!chk.ok) {
    // Navigation (iframe/trang) -> trang HTML thân thiện; asset/XHR -> JSON.
    if (wantsHtmlPage(request)) return quotaExceededPage(request);
    return jerr("Limit reached. Please upgrade to continue.", 402);
  }

  // 3. Decode + validate URL đích
  const enc = url.searchParams.get("url") || "";
  // Lỗi 400 với navigation -> trang thân thiện (không JSON thô trong iframe).
  const badReq = (msg) => wantsHtmlPage(request) ? friendlyErrorPage(request, 400, BADURL_I18N) : jerr(msg, 400);
  if (!enc || enc.length > 4096) return badReq("Missing url");
  let target;
  try {
    if (!B64_RE.test(enc)) return badReq("Bad url encoding");
    target = new URL(b64urlDecode(enc));
  } catch (e) {
    return badReq("Bad url");
  }
  if (!isAllowedTarget(target)) return badReq("URL not allowed");

  // 4. Fetch trực tiếp (redirect: manual, tối đa 5 hop)
  let method = request.method === "POST" ? "POST" : "GET";
  let bodyBuf = null;
  if (method === "POST") {
    try {
      bodyBuf = await request.arrayBuffer();
    } catch (e) {
      return jerr("Bad request body", 400);
    }
    if (bodyBuf.byteLength > 2 * 1024 * 1024) return jerr("Body too large", 413);
  }
  let current = target;
  let upstream = null;
  let stillRedirecting = false; // het 6 hop ma van redirect (vd chuoi auth dai) -> bao loi gon
  for (let hop = 0; hop < 6; hop++) {
    const h = new Headers();
    // UA tran (Henrry 19/10 Chot: FB loc UA day du -> 400, UA tran -> 200)
    h.set("User-Agent", "Mozilla/5.0");
    h.set("Accept", request.headers.get("Accept") || "*/*");
    h.set("Accept-Language", request.headers.get("Accept-Language") || "en-US,en;q=0.9");
    // B0-4: resolve cookie theo từng hop (current). Load 1 lần cho URL gốc
    // rồi dùng cho cả chuỗi redirect sẽ gửi nhầm cookie host A sang host B
    // (rò rỉ) và thiếu cookie đúng của host đích (login gãy giữa chừng).
    const jarCookie = await loadCookies(env, user.email, current);
    if (jarCookie) h.set("Cookie", jarCookie);
    const range = request.headers.get("Range");
    if (range) h.set("Range", range);
    // Referer/Origin trỏ về chính site đích (không rò URL proxy/token)
    h.set("Referer", current.href);
    h.set("Origin", current.origin);
    if (method === "POST") {
      const ct = request.headers.get("Content-Type");
      if (ct) h.set("Content-Type", ct);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      // Ưu tiên qua relay botkeep (IP cá nhân). Không cấu hình -> direct (cũ).
      const via = await fetchViaRelay(env, current.href, method, h, bodyBuf, 25000);
      if (via) {
        clearTimeout(timer);
        upstream = via;
      } else {
        upstream = await fetch(current.href, {
          method,
          headers: h,
          body: method === "POST" ? bodyBuf : undefined,
          redirect: "manual",
          signal: ctrl.signal,
        });
        clearTimeout(timer);
      }
    } catch (e) {
      clearTimeout(timer);
      return errorPage("Không mở được trang", "Máy chủ không kết nối được tới địa chỉ này. Kiểm tra lại địa chỉ rồi thử lại.");
    }
    await storeCookies(env, user.email, current, upstream.headers);
    const st = upstream.status;
    if (st >= 300 && st < 400 && upstream.headers.has("Location")) {
      // Redirect: khong doc body nua — huy stream de giai phong timer/connection
      // (quan trong voi relay stream: khong thi timer 25s treo toi khi het han).
      try { await upstream.body.cancel(); } catch (e) {}
      let next;
      try {
        next = new URL(upstream.headers.get("Location"), current.href);
      } catch (e) {
        return errorPage("Không mở được trang", "Địa chỉ chuyển hướng không hợp lệ.");
      }
      if (!isAllowedTarget(next)) return jerr("Redirect not allowed", 400);
      if (st === 303 || ((st === 301 || st === 302) && method === "POST")) {
        method = "GET";
        bodyBuf = null;
      }
      current = next;
      stillRedirecting = true;
      continue;
    }
    stillRedirecting = false;
    break;
  }
  if (!upstream || stillRedirecting)
    return errorPage("Không mở được trang", "Quá nhiều lần chuyển hướng.");

  const ct = upstream.headers.get("content-type") || "";
  const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");
  const clen = parseInt(upstream.headers.get("content-length") || "0", 10);
  if (clen > 20 * 1024 * 1024) return jerr("Content too large", 413);

  // Đếm quota: mỗi page HTML = 1 lượt (asset không đếm).
  // Trang bị chặn / lỗi (non-2xx) không đếm — user không tốn lượt cho trang lỗi.
  if (isHtml && upstream.ok) {
    try {
      await incrUsage(env, user.email, "browse_pages", 1);
    } catch (e) { /* không chặn browse vì lỗi đếm */ }
  }

  // B0-2: site từ chối (403/429/400) hoặc báo lỗi (5xx) -> trang thân thiện
  // 4 ngôn ngữ thay vì trang challenge/lỗi thô. Chỉ cho navigation; 404 và
  // các mã khác giữ nguyên trang của site; asset/XHR giữ nguyên.
  if (isHtml && wantsHtmlPage(request) && !upstream.ok) {
    const st = upstream.status;
    if (st === 403 || st === 429 || st === 400) return friendlyErrorPage(request, st, BLOCKED_I18N);
    if (st >= 500) return friendlyErrorPage(request, st, UPSTREAMERR_I18N);
  }

  // 5a. HTML -> HTMLRewriter viết lại URL (streaming, không buffer)
  if (isHtml) {
    const token = sess.token;
    const base = current.href;
    const rw = new HTMLRewriter();
    const URL_ATTRS = {
      a: "href", area: "href", img: "src", source: "src", script: "src",
      link: "href", form: "action", iframe: "src", video: "src", audio: "src",
      track: "src", embed: "src", input: "src", button: "formaction", object: "data",
    };
    for (const [tag, attr] of Object.entries(URL_ATTRS)) {
      rw.on(tag, {
        element(el) {
          const v = el.getAttribute(attr);
          if (v !== null) el.setAttribute(attr, rewriteAttrVal(v, base, token));
          if (tag === "img" || tag === "source") {
            const ss = el.getAttribute("srcset");
            if (ss !== null) el.setAttribute("srcset", rewriteSrcset(ss, base, token));
          }
          if (tag === "video") {
            const p = el.getAttribute("poster");
            if (p !== null) el.setAttribute("poster", rewriteAttrVal(p, base, token));
          }
        },
      });
    }
    rw.on("meta", {
      element(el) {
        if ((el.getAttribute("http-equiv") || "").toLowerCase() !== "refresh") return;
        const c = el.getAttribute("content");
        if (!c) return;
        const m = c.match(/url\s*=\s*(.+)/i);
        if (m) el.setAttribute("content", c.slice(0, m.index) + "url=" + rewriteAttrVal(m[1].trim(), base, token));
      },
    });
    rw.on("style", {
      text(t) {
        if (t.text.includes("url(")) t.replace(rewriteCssUrls(t.text, base, token));
      },
    });
    rw.on("*", {
      element(el) {
        const s = el.getAttribute("style");
        if (s && s.includes("url(")) el.setAttribute("style", rewriteCssUrls(s, base, token));
      },
    });
    // Vá JS ở đầu <head> (trước mọi script của trang); fallback cuối document
    let injected = false;
    const inject = { element(el) { if (!injected) { injected = true; el.prepend(patchScript(base), { html: true }); } } };
    rw.on("head", inject);
    rw.onDocument({
      end(end) { if (!injected) { injected = true; end.append(patchScript(base), { html: true }); } },
    });
    const transformed = rw.transform(upstream);
    const headers = new Headers(transformed.headers);
    headers.delete("content-security-policy");
    headers.delete("content-security-policy-report-only");
    headers.delete("x-frame-options");
    headers.delete("set-cookie"); // đã vào jar, không rò sang browser user
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("strict-transport-security");
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(transformed.body, { status: upstream.status, headers });
  }

  // 5b. Non-HTML -> pass-through (giữ Range/streaming cho media)
  const headers = new Headers(upstream.headers);
  headers.delete("set-cookie"); // đã vào jar
  return new Response(upstream.body, { status: upstream.status, headers });
}

// WebSocket relay: GET /api/browse-ws?url=<base64url(ws|wss)>&t=<session>
// Trình duyệt -> wss://<domain>/api/browse-ws -> Worker mở WS tới target,
// pipe message 2 chiều. Target thấy IP Cloudflare, không thấy IP user.
export async function handleBrowseWs(request, env, url) {
  const sess = await resolveSession(request, env, url);
  if (!sess) return jerr("Not logged in", 401);
  if (request.headers.get("Upgrade") !== "websocket") {
    return jerr("WebSocket upgrade required", 400);
  }
  const enc = url.searchParams.get("url") || "";
  let target;
  try {
    if (!enc || !B64_RE.test(enc)) return jerr("Bad url", 400);
    target = new URL(b64urlDecode(enc));
  } catch (e) {
    return jerr("Bad url", 400);
  }
  if (target.protocol !== "ws:" && target.protocol !== "wss:") return jerr("Bad url", 400);
  // Validate như http(s) tương đương (SSRF guard dùng chung)
  const httpEquiv = new URL(target.href);
  httpEquiv.protocol = target.protocol === "wss:" ? "https:" : "http:";
  if (!isAllowedTarget(httpEquiv)) return jerr("URL not allowed", 400);

  // Quota: 1 kết nối WS = 1 lượt (đơn giản, chống giữ socket vô hạn)
  const user = await getUser(env, sess.email);
  if (!user) return jerr("User not found", 401);
  const { getUsage, incrUsage } = await import("./billing.js");
  let usage = {};
  try {
    const row = await getUsage(env, user.email);
    usage = { browse_pages: row.browse_pages || 0 };
  } catch (e) { /* fail-open */ }
  if (!canUseFeature(user, "browse_pages", usage, {}).ok) {
    return jerr("Limit reached. Please upgrade to continue.", 402);
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  // Subprotocol của client (nếu có) forward sang upstream
  let protocols;
  const spp = request.headers.get("Sec-WebSocket-Protocol");
  if (spp) protocols = spp.split(",").map((s) => s.trim()).filter(Boolean);

  let upstream;
  try {
    upstream = protocols && protocols.length ? new WebSocket(target.href, protocols) : new WebSocket(target.href);
  } catch (e) {
    try { server.close(1011, "upstream failed"); } catch (_) { /* noop */ }
    return new Response(null, { status: 101, webSocket: client });
  }

  // Hàng đợi tin client gửi khi upstream chưa open (giới hạn 100)
  const pending = [];
  let upstreamOpen = false;
  upstream.addEventListener("open", () => {
    upstreamOpen = true;
    for (const d of pending.splice(0)) {
      try { upstream.send(d); } catch (_) { /* noop */ }
    }
  });
  server.addEventListener("message", (e) => {
    if (upstreamOpen) {
      try { upstream.send(e.data); } catch (_) { /* noop */ }
    } else if (pending.length < 100) {
      pending.push(e.data);
    }
  });
  upstream.addEventListener("message", (e) => {
    try { server.send(e.data); } catch (_) { /* noop */ }
  });
  const closeUpstream = (code, reason) => { try { upstream.close(code || 1000, reason); } catch (_) { /* noop */ } };
  const closeServer = (code, reason) => { try { server.close(code || 1000, reason); } catch (_) { /* noop */ } };
  server.addEventListener("close", (e) => closeUpstream(e.code, e.reason));
  server.addEventListener("error", () => closeUpstream(1011, "client error"));
  upstream.addEventListener("close", (e) => closeServer(e.code, e.reason));
  upstream.addEventListener("error", () => closeServer(1011, "upstream error"));

  try {
    await incrUsage(env, user.email, "browse_pages", 1);
  } catch (_) { /* không chặn WS vì lỗi đếm */ }
  return new Response(null, { status: 101, webSocket: client });
}

// --- Hyperbeam interactive tier (Henrry Chốt 19/10/2026) ---
// POST /api/hb/session {start_url?} -> {session_id, embed_url}
// DELETE /api/hb/session?id=<session_id> -> {ok:true}
// HYPERBEAM_API_KEY chỉ nằm ở Worker secret, KHÔNG lộ ra client.
// embed_url chứa token riêng của session — an toàn trả cho đúng user đã login.
const HB_API = "https://engine.hyperbeam.com"; // verify live 19/10/2026

async function hbCall(env, method, path, body) {
  const key = (env.HYPERBEAM_API_KEY || "").trim();
  if (!key) return { err: "not_configured" };
  let res;
  try {
    res = await fetch(HB_API + path, {
      method,
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { err: "network" };
  }
  let data = {};
  try { data = JSON.parse((await res.text()) || "{}"); } catch (e) {}
  if (!res.ok) return { err: "hyperbeam_" + res.status, status: res.status };
  return { data };
}

export async function handleHbSession(request, env, url) {
  const sess = await resolveSession(request, env, url);
  if (!sess) return jerr("Not logged in", 401);
  const user = await getUser(env, sess.email);
  if (!user) return jerr("User not found", 401);

  if (request.method === "POST") {
    let startUrl = "https://example.com";
    try {
      const b = await request.json();
      if (b && typeof b.start_url === "string") {
        const u = new URL(b.start_url);
        if (u.protocol === "http:" || u.protocol === "https:") startUrl = u.href;
      }
    } catch (e) { /* giữ default */ }
    const r = await hbCall(env, "POST", "/v0/vm", {
      start_url: startUrl,
      // TAM debug 19/10: bo region+timeout de test minimal nhu docs mau
    });
    if (r.err === "not_configured") return jerr("Interactive chưa cấu hình", 501);
    if (r.err) return jerr("Không tạo được phiên tương tác", 502);
    return new Response(JSON.stringify({
      session_id: r.data.session_id,
      embed_url: r.data.embed_url,
      admin_token: r.data.admin_token || null, // thu gui cho client (debug 19/10)
    }), { headers: { "Content-Type": "application/json" } });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return jerr("Bad id", 400);
    const r = await hbCall(env, "DELETE", "/v0/vm/" + id);
    if (r.err === "not_configured") return jerr("Interactive chưa cấu hình", 501);
    if (r.err) return jerr("Không hủy được phiên", 502);
    return new Response(JSON.stringify({ ok: true }),
      { headers: { "Content-Type": "application/json" } });
  }
  return jerr("Method not allowed", 405);
}

// TEMP debug 19/10 — nhận lỗi client gửi về, lưu D1 để đọc. XÓA sau khi fix xong.
export async function handleHbDebug(request, env, url) {
  const sess = await resolveSession(request, env, url);
  if (!sess) return jerr("Not logged in", 401);
  let b = {};
  try { b = await request.json(); } catch (e) { /* kệ */ }
  const step = String(b.step || "").slice(0, 64);
  const name = String(b.name || "").slice(0, 64);
  const message = String(b.message || "").slice(0, 500);
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS hb_debug (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, step TEXT, name TEXT, message TEXT)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO hb_debug (ts, step, name, message) VALUES (?, ?, ?, ?)"
    ).bind(Date.now(), step, name, message).run();
  } catch (e) { return jerr("db fail", 500); }
  return new Response(JSON.stringify({ ok: true }),
    { headers: { "Content-Type": "application/json" } });
}
