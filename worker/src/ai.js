// worker/src/ai.js — AI features (Gemini) for English Lab.
import { jerr, fetchTimeout } from './utils.js';
import { drizzle } from "drizzle-orm/d1";
import { eq, desc } from "drizzle-orm";
import { aiCache, vocabReviews } from "./schema.js";

// Get user's recent vocab words for context (last 5 studied)
async function getRecentVocab(env, email, limit=5){
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({ word: vocabReviews.word })
      .from(vocabReviews)
      .where(eq(vocabReviews.email, email.toLowerCase()))
      .orderBy(desc(vocabReviews.updatedAt))
      .limit(limit);
    return rows.map(r => r.word).filter(Boolean);
  }catch(e){ return []; }
}

// Get user's weak words (low accuracy or short interval)
async function getWeakVocab(env, email, limit=5){
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({
        word: vocabReviews.word,
        reviews: vocabReviews.reviews,
        correct: vocabReviews.correct,
        intervalDays: vocabReviews.intervalDays,
      })
      .from(vocabReviews)
      .where(eq(vocabReviews.email, email.toLowerCase()))
      .orderBy(vocabReviews.intervalDays)
      .limit(20);
    // Score: lower accuracy + shorter interval = weaker
    const scored = rows.map(r => {
      const acc = r.reviews > 0 ? r.correct / r.reviews : 0.5;
      return { word: r.word, score: acc * 0.7 + Math.min(r.intervalDays / 30, 1) * 0.3 };
    }).filter(s => s.word);
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, limit).map(s => s.word);
  }catch(e){ return []; }
}

const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/";

// Simple hash for cache keys
function hashStr(s){
  let h = 0;
  for(let i=0; i<s.length; i++){ h = ((h<<5)-h+s.charCodeAt(i))|0; }
  return (h>>>0).toString(16);
}

async function callGeminiViaProxy(env, prompt, jsonMode, maxTokens){
  const proxyUrl = env.MODAL_PROXY_URL;
  const proxyToken = env.MODAL_PROXY_TOKEN;
  if(!proxyUrl || !proxyToken) throw new Error("Proxy not configured");
  const genConfig = {temperature: 0.7, maxOutputTokens: maxTokens || 1000};
  if(jsonMode) genConfig.response_mime_type = "application/json";
  const r = await fetchTimeout(`${proxyUrl}/gemini`, 90000, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Proxy-Token": proxyToken
    },
    body: JSON.stringify({
      api_key: env.GEMINI_API_KEY,
      model: GEMINI_MODEL,
      prompt,
      generationConfig: genConfig
    })
  });
  if(!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error(`Proxy error ${r.status}: ${t.slice(0,200)}`);
  }
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if(!text) throw new Error("Empty proxy response");
  return text.trim();
}

async function callGemini(env, prompt, jsonMode, maxTokens){
  // 8b 2026-10-12: upstream (Modal proxy/Gemini) chập chờn (~20% lỗi thoáng qua,
  // tái hiện 2026-10-12). Kiểu big tech: retry 1 lần với backoff ngắn trước khi báo lỗi.
  let lastErr = null;
  for(let attempt = 0; attempt < 2; attempt++){
    if(attempt > 0) await new Promise(r => setTimeout(r, 1500));
    try{
      return await callGeminiOnce(env, prompt, jsonMode, maxTokens);
    }catch(e){ lastErr = e; }
  }
  throw lastErr;
}

async function callGeminiOnce(env, prompt, jsonMode, maxTokens){
  // Try Modal proxy first (dual-stream architecture)
  let proxyErrMsg = "";
  try {
    return await callGeminiViaProxy(env, prompt, jsonMode, maxTokens);
  } catch(proxyErr) {
    proxyErrMsg = String((proxyErr && proxyErr.message) || proxyErr).slice(0, 150);
    // Fall through to direct call (will fail via IP block, then D1 queue)
  }
  const key = env.GEMINI_API_KEY;
  if(!key) throw new Error("AI not configured");
  const url = `${GEMINI_API}${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const genConfig = {temperature: 0.7, maxOutputTokens: maxTokens || 1000};
  if(jsonMode) genConfig.response_mime_type = "application/json";
  const r = await fetchTimeout(url, 30000, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      contents: [{parts: [{text: prompt}]}],
      generationConfig: genConfig
    })
  });
  if(!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error(`AI error ${r.status}: ${t.slice(0,200)}` + (proxyErrMsg ? ` [proxy: ${proxyErrMsg}]` : ""));
  }
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if(!text) throw new Error("Empty AI response");
  return text.trim();
}

async function getCache(env, key){
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({ response: aiCache.response }).from(aiCache).where(eq(aiCache.cacheKey, key)).limit(1);
    return rows[0] ? rows[0].response : null;
  }catch(e){ return null; }
}

async function setCache(env, key, response){
  try{
    const db = drizzle(env.DB);
    await db.insert(aiCache).values({ cacheKey: key, response, createdAt: Date.now() })
      .onConflictDoUpdate({ target: aiCache.cacheKey, set: { response, createdAt: Date.now() } });
  }catch(e){ /* cache table may not exist yet */ }
}

// POST /api/ai/explain — explain a word in sentence context
export async function handleAIExplain(request, env){
  const {checkFeature, incrUsage} = await import('./billing.js');
  const chk = await checkFeature(request, env, 'ai_explain');
  if(chk.err) return chk.err;

  let b;
  try{ b = await request.json(); }catch(e){ return jerr("Invalid JSON", 400); }
  const word = String(b.word || b.text || "").trim().slice(0, 500);
  const sentence = String(b.sentence || "").trim().slice(0, 500);
  const lang = String(b.lang || "vi").slice(0, 5);
  if(!word) return jerr("Missing word", 400);

  // Check cache
  const cacheKey = "explain:" + hashStr(word + "|" + sentence + "|" + lang);
  const cached = await getCache(env, cacheKey);
  if(cached){
    return new Response(JSON.stringify({explanation: cached, cached: true}),
      {headers: {"Content-Type": "application/json"}});
  }

  const langName = {vi: "Vietnamese", en: "English", zh: "Chinese", ko: "Korean"}[lang] || "Vietnamese";

  // Context-aware: include user's recent vocab
  const recentWords = await getRecentVocab(env, chk.user.email);
  const contextHint = recentWords.length
    ? ` The user has recently studied: ${recentWords.join(", ")}. If relevant, connect the explanation to these words.`
    : "";

  const prompt = `Explain the English word "${word}" as used in this sentence: "${sentence || "(no context)"}". ` +
    `Reply in ${langName}. Include: 1) meaning in this context, 2) part of speech, 3) one example sentence. Keep it concise (under 150 words).${contextHint}`;

  try{
    const explanation = await callGemini(env, prompt);
    await setCache(env, cacheKey, explanation);
    await incrUsage(env, chk.user.email, 'ai_calls', 1).catch(()=>{});
    return new Response(JSON.stringify({explanation, cached: false}),
      {headers: {"Content-Type": "application/json"}});
  }catch(e){
    // 8b (2026-10-12): never leak raw AI errors (quota/overload JSON) to users
    return jerr("AI is busy. Please try again later.", 500);
  }
}

// Parse AI-returned JSON robustly: the model sometimes wraps the array in
// prose or truncates it. Try direct parse first, then extract the outermost
// [...] span and retry. Returns the parsed value or throws.
function parseJsonArray(text){
  try{ return JSON.parse(text); }catch(e){}
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if(s >= 0 && e > s){
    return JSON.parse(text.slice(s, e + 1));
  }
  throw new Error("Invalid quiz format");
}

// A quiz question is usable only with this shape
function isValidQuestion(q){
  return q && typeof q.q === "string" && q.q.trim() &&
    Array.isArray(q.options) && q.options.length >= 2 &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length;
}

// POST /api/ai/quiz — generate 5 quiz questions from article text
export async function handleAIQuiz(request, env){
  const {checkFeature, incrUsage} = await import('./billing.js');
  const chk = await checkFeature(request, env, 'ai_quiz');
  if(chk.err) return chk.err;

  let b;
  try{ b = await request.json(); }catch(e){ return jerr("Invalid JSON", 400); }
  const text = String(b.text || "").trim().slice(0, 3000);
  const lang = String(b.lang || "vi").slice(0, 5);
  if(!text || text.length < 50) return jerr("Text too short (min 50 chars)", 400);

  // Check cache
  const cacheKey = "quiz:" + hashStr(text + "|" + lang);
  const cached = await getCache(env, cacheKey);
  if(cached){
    return new Response(JSON.stringify({quiz: JSON.parse(cached), cached: true}),
      {headers: {"Content-Type": "application/json"}});
  }

  const langName = {vi: "Vietnamese", en: "English", zh: "Chinese", ko: "Korean"}[lang] || "Vietnamese";

  // Context-aware: prioritize user's weak words
  const weakWords = await getWeakVocab(env, chk.user.email);
  const weakHint = weakWords.length
    ? ` The user struggles with these words: ${weakWords.join(", ")}. Prioritize questions about them if they appear in the text.`
    : "";

  const prompt = `Create 5 multiple-choice English quiz questions from this text:\n\n${text}\n\n` +
    `Reply in ${langName} (questions in English, explanations in ${langName}). ` +
    `Return a JSON array: [{"q":"question","options":["A","B","C","D"],"answer":0,"explain":"why"}]. ` +
    `Keep questions about vocabulary and comprehension.${weakHint}`;

  try{
    // 8b (2026-10-12): 5 questions with explanations need ~2000+ tokens;
    // the old 1000-token cap truncated the JSON mid-string ("Unterminated
    // string in JSON"), and a single JSON.parse with no retry turned every
    // malformed reply into a raw SyntaxError shown to the user.
    let quiz = null, failKind = "unknown";
    for(let attempt = 0; attempt < 2 && !quiz; attempt++){
      let quizText = "";
      try{
        quizText = await callGemini(env, prompt, true, 2500);
      }catch(e){ failKind = "ai_call"; continue; }
      try{
        const parsed = parseJsonArray(quizText);
        const valid = (Array.isArray(parsed) ? parsed : []).filter(isValidQuestion);
        if(valid.length > 0) quiz = valid;
        else failKind = "bad_shape";
      }catch(e){ failKind = "bad_json"; }
    }
    if(!quiz){
      // Structured error code for diagnostics; user sees a friendly message.
      return jerr("Could not generate quiz. Please try again.", 500, {code: "quiz_" + failKind});
    }
    await setCache(env, cacheKey, JSON.stringify(quiz));
    await incrUsage(env, chk.user.email, 'ai_calls', 1).catch(()=>{});
    return new Response(JSON.stringify({quiz, cached: false}),
      {headers: {"Content-Type": "application/json"}});
  }catch(e){
    return jerr("AI failed. Please try again.", 500);
  }
}

// POST /api/ai/relay — proxy provider cho browser, y chang Send-ProxyRequest
// của serve-ai-chat.ps1 (file đính kèm 2026-10-12), chỉ điều chỉnh cho web:
// - File: key trong RAM server (DPAPI). Web: Worker stateless → browser gửi
//   baseUrl+key theo từng request; server chỉ forward (RAM, KHÔNG log, KHÔNG lưu D1).
// - File: {origin}/proxy/<path>. Web: JSON envelope {baseUrl,key,path,method,body}
//   (path-style bất tiện trong route table Worker).
// Giữ y chang file: forward MỌI path (không allowlist), Bearer duy nhất,
// buffer full response (không stream), timeout 120s, wrap lỗi upstream.
// Bảo mật (bắt buộc vì server public, không còn localhost-only như file):
// - Bắt đăng nhập (getSession).
// - baseUrl: chỉ https, port 443, chặn IP nội bộ/loopback/link-local/metadata
//   và chính domain mình (SSRF guard).
// - body: JSON ≤ 512KB (chat text; file cho 16MB vì có ảnh đính kèm).
const RELAY_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
function isRelayTargetAllowed(u){
  if(u.protocol !== "https:") return false;
  if(u.username || u.password) return false;
  if(u.port && u.port !== "443") return false;
  const h = u.hostname.toLowerCase();
  const OWN = ["lethanhdong.one"];
  for(const own of OWN){ if(h === own || h.endsWith("." + own)) return false; }
  if(h === "localhost" || h.endsWith(".localhost")) return false;
  if(h === "metadata.google.internal" || h.endsWith(".internal")) return false;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if(v4){
    const p = v4.slice(1).map(Number);
    if(p.some(n => n < 0 || n > 255)) return false;
    if(p[0] === 10 || p[0] === 127 || p[0] === 0) return false;
    if(p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if(p[0] === 192 && p[1] === 168) return false;
    if(p[0] === 169 && p[1] === 254) return false; // link-local (gồm 169.254.169.254)
  }
  if(h === "[::1]" || h === "::1") return false;
  return true;
}
export async function handleAiRelay(request, env){
  // tốc T1: đo thời gian từng khâu, trả về qua Server-Timing header.
  // Chuẩn big tech (Vercel/Shopify dùng): DevTools hiện sẵn ở tab Network,
  // không đổi contract JSON body. Các mốc (ms):
  // session = đọc session D1, upstream = chờ headers từ provider,
  // upstream_body = tải body provider, total = toàn bộ Worker xử lý.
  const tRelay0 = Date.now();
  const relayTiming = (tSession, tUpH, tUpB) =>
    `session;dur=${tSession}, upstream;dur=${tUpH}, upstream_body;dur=${tUpB}, total;dur=${Date.now()-tRelay0}`;
  const withRelayTiming = (resp, tSession, tUpH, tUpB) => {
    const h = new Headers(resp.headers);
    h.set("Server-Timing", relayTiming(tSession, tUpH, tUpB));
    return new Response(resp.body, { status: resp.status, headers: h });
  };
  const { getSession } = await import('./auth.js');
  const tSess0 = Date.now();
  const s = await getSession(request, env);
  const tSession = Date.now() - tSess0;
  if(!s) return withRelayTiming(jerr("Not logged in", 401), tSession, 0, 0);

  let b;
  try{ b = await request.json(); }catch(e){ return jerr("Invalid JSON", 400); }
  const baseUrl = String(b.baseUrl || "").trim().replace(/\/+$/, "");
  const key = String(b.key || "").trim();
  const path = String(b.path || "");
  const method = String(b.method || "GET").toUpperCase();
  // tốc T2: client xin stream (pipe SSE) thay vì buffer. Relay vẫn generic —
  // body (kể cả stream:true cho provider) do client tự quyết, flag này chỉ
  // đổi cách Worker trả response về browser.
  const wantStream = b.stream === true;
  if(!baseUrl || !key) return jerr("baseUrl and key required", 400);
  // Y chang file: /proxy/<bất kỳ path nào> → {baseUrl}<path>, không allowlist.
  if(!path.startsWith("/") || /[\r\n]/.test(path)) return jerr("Invalid path", 400);
  if(!RELAY_METHODS.includes(method)) return jerr("Method not allowed", 400);

  let u;
  try{ u = new URL(baseUrl); }catch(e){ return jerr("Invalid baseUrl", 400); }
  if(!isRelayTargetAllowed(u)) return jerr("Target not allowed", 400);

  const targetUrl = u.toString() + path;
  const headers = {
    "Authorization": "Bearer " + key, // y chang file: key gắn phía server
    "Accept": "application/json",
  };
  let fwdBody;
  if(b.body !== undefined){
    let bodyStr;
    try{ bodyStr = JSON.stringify(b.body); }catch(e){ return jerr("Invalid body", 400); }
    if(bodyStr.length > 512 * 1024) return jerr("Body too large", 413);
    headers["Content-Type"] = "application/json";
    fwdBody = bodyStr;
  }

  let r = null;
  let lastErr = null;
  let attempts = 0;
  const tUp0 = Date.now();
  // tốc T3: fail fast — timeout 25s/lần (trước là 120s), thử lại 1 lần CHỈ
  // khi lỗi nhanh (<5s: DNS/reset thoáng qua). Timeout đủ 25s = provider
  // treo thật → báo lỗi ngay, không thử lại (thử lại chỉ nhân đôi thời
  // gian treo, phá mục tiêu "không treo quá 30s"). Thử lại an toàn:
  // fetch chỉ throw khi chưa nhận được response nào (chưa byte nào về
  // browser), body POST là string nên gửi lại được; HTTP status ≥400
  // không retry (đó là câu trả lời dứt khoát, không phải treo).
  const RELAY_TIMEOUT_MS = 25000;
  const RELAY_FAST_FAIL_MS = 5000;
  for(let attempt = 0; attempt < 2; attempt++){
    if(attempt > 0) await new Promise(res => setTimeout(res, 1000));
    attempts = attempt + 1;
    const tAttempt0 = Date.now();
    try{
      r = await fetchTimeout(targetUrl, RELAY_TIMEOUT_MS, { method, headers, body: fwdBody });
      break;
    }catch(e){
      lastErr = e;
      if(Date.now() - tAttempt0 >= RELAY_FAST_FAIL_MS) break; // treo thật → dừng
    }
  }
  if(!r){
    return withRelayTiming(jerr("Proxy khong goi duoc API sau " + attempts + " lan thu (timeout 25s/lan): " + String((lastErr && lastErr.message) || lastErr).slice(0, 200), 502), tSession, Date.now()-tUp0, 0);
  }
  const tUpH = Date.now() - tUp0; // tới khi nhận xong headers upstream
  if(r.status >= 400){
    // Lỗi upstream: luôn buffer để giữ nguyên contract lỗi JSON cho browser
    // (kể cả khi client xin stream — browser fallback về buffered).
    const tBody0 = Date.now();
    const respBody = await r.text().catch(() => "");
    const tUpB = Date.now() - tBody0;
    let upstreamDetail = respBody.trim() || r.statusText || "";
    if(upstreamDetail.length > 2000) upstreamDetail = upstreamDetail.slice(0, 2000) + "...";
    let diagnostic = "Upstream API tra ve HTTP " + r.status + " " + (r.statusText || "") + " tai " + targetUrl + ".";
    if(upstreamDetail) diagnostic += " Chi tiet: " + upstreamDetail;
    return withRelayTiming(new Response(JSON.stringify({ error: {
      message: diagnostic,
      upstreamStatus: r.status,
      endpoint: targetUrl,
      upstreamBody: upstreamDetail,
    }}), { status: r.status, headers: { "Content-Type": "application/json" } }), tSession, tUpH, tUpB);
  }
  // tốc T2: pipe body upstream thẳng về browser, không buffer.
  // upstream_body/total trong Server-Timing lúc này = tới khi headers xong
  // (body còn đang chảy); browser tự đo TTFT và tốc độ token.
  if(wantStream){
    const sh = new Headers();
    sh.set("Content-Type", "text/event-stream");
    sh.set("Cache-Control", "no-cache");
    sh.set("Server-Timing", relayTiming(tSession, tUpH, 0));
    return new Response(r.body, { status: r.status, headers: sh });
  }
  const tBody0 = Date.now();
  // Y chang file: buffer toàn bộ response (không stream).
  const respBody = await r.text().catch(() => "");
  const tUpB = Date.now() - tBody0; // thời gian tải body upstream
  const respType = r.headers.get("content-type") || "application/json";
  return withRelayTiming(new Response(respBody, { status: r.status, headers: { "Content-Type": respType } }), tSession, tUpH, tUpB);
}
// 8b 2026-10-12: BYOK Modal Proxy — cho phép dùng key Gemini cá nhân
// ngay cả khi browser bị chặn trực tiếp (mạng công ty).
// Luồng: Browser → Worker (session auth) → Modal gemini-proxy → Google API.
// Worker giữ GEMINI_PROXY_TOKEN (secret), browser không bao giờ thấy.
// Key user chỉ trong RAM, không log, không lưu D1.
const MODAL_PROXY_URL = "https://lethienhieuhcm-web--gemini-proxy-fastapi-app.modal.run";

export async function handleByokProxy(request, env){
  const { getSession } = await import('./auth.js');
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  
  let body;
  try{
    body = await request.json();
  }catch(e){
    return jerr("Invalid JSON", 400);
  }
  
  const { key, model, prompt, stream } = body;
  if(!model || !prompt) return jerr("model and prompt required", 400);
  // key optional: nếu không có, Modal dùng server key từ secrets
  
  const proxyToken = env.GEMINI_PROXY_TOKEN;
  if(!proxyToken) return jerr("Proxy not configured", 500);
  
  // Forward tới Modal gemini-proxy (không log key!)
  const endpoint = stream ? "/gemini/stream" : "/gemini";
  try{
    const r = await fetch(MODAL_PROXY_URL + endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Token": proxyToken,
      },
      body: JSON.stringify({
        model: model,
        contents: [{ parts: [{ text: prompt }] }],
        api_key: key || "",  // Modal sẽ dùng server key nếu rỗng
      }),
    });
    
    if(stream){
      // Stream SSE trực tiếp về browser
      return new Response(r.body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }
    
    const data = await r.json();
    return new Response(JSON.stringify(data), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }catch(e){
    return jerr("Proxy error: " + e.message, 502);
  }
}
