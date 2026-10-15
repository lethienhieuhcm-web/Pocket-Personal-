// js/core/aiClient.js — BYOK hybrid AI client (Phase 1).
// Routing: có user key → gọi trực tiếp Google từ browser (0đ server).
// Lỗi (401/403/429/network) → fallback server 1 lần.
// Key lưu ở IndexedDB, KHÔNG BAO GIỜ gửi về server, không log.
import { apiCall, apiCallTimed, apiFetchTimed } from './api.js';

const DB_NAME = 'pp_ai';
const STORE = 'keys';
const KEY_ID = 'gemini_user_key';
const MODEL_ID = 'gemini_user_model';
const BASE_URL_ID = 'ai_base_url';
// 8b: Danh sách model ứng viên Gemini — verify bằng POST thật (có CORS).
// Dùng cho backward compat khi user chưa nhập base_url (mặc định Gemini).
// Verify 2026-10-11 bằng key thật:
// 8b 2026-10-12 (Henrry Chốt): user nhập base_url + API key → suy ra provider + model.
// Kiểu ông lớn (OpenAI SDK, Vercel AI SDK): không đoán provider từ format key,
// user khai endpoint ở đâu, app gọi {base_url}/models để lấy danh sách thật.
// KHÔNG hardcode bất kỳ provider URL nào — user phải nhập endpoint.
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(id) {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) { return null; }
}

async function idbSet(id, val) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(id) {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (e) {}
}

export async function getUserKey() {
  const k = await idbGet(KEY_ID);
  return (typeof k === 'string' && k.trim()) ? k.trim() : null;
}

export async function saveUserKey(key) {
  const k = (key || '').trim();
  if (!k) throw new Error('empty');
  await idbSet(KEY_ID, k);
}

export async function deleteUserKey() {
  await idbDel(KEY_ID);
  await idbDel(MODEL_ID); // xóa luôn model đã chọn
}

export async function getUserModel() {
  const m = await idbGet(MODEL_ID);
  return (typeof m === 'string' && m.trim()) ? m.trim() : null;
}

export async function saveUserModel(model) {
  const m = (model || '').trim();
  if (!m) throw new Error('empty');
  await idbSet(MODEL_ID, m);
}

// 8b 2026-10-12: base_url do user nhập. Không có default — user phải nhập endpoint.
export async function getBaseUrl() {
  const u = await idbGet(BASE_URL_ID);
  return (typeof u === 'string' && u.trim()) ? u.trim().replace(/\/+$/, '') : null;
}

export async function saveBaseUrl(url) {
  const u = (url || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('empty');
  if (!/^https?:\/\//i.test(u)) throw new Error('invalid-url');
  await idbSet(BASE_URL_ID, u);
}

export async function deleteBaseUrl() {
  await idbDel(BASE_URL_ID);
}

// Y chang file đính kèm: user chọn độ dài trả lời (SHORT/BALANCED/LONG/VERY LONG).
// Chung IDB nên Talk/English Lab/Stocks tự nhận theo nhau.
const RLEN_ID = 'elab.ai.rlen';
const RLEN_VALUES = [512, 2048, 4096, 8192];
export async function getResponseLength(){
  const v = parseInt(await idbGet(RLEN_ID), 10);
  return RLEN_VALUES.includes(v) ? v : 2048;
}
export async function saveResponseLength(n){
  n = parseInt(n, 10);
  if(!RLEN_VALUES.includes(n)) throw new Error('invalid-rlen');
  await idbSet(RLEN_ID, String(n));
}

// 8b 2026-10-12: Override endpoint/model riêng từng app (mặc định dùng chung).
// app: 'talk' | 'english' | 'stocks'. Key và độ dài trả lời luôn dùng chung.
const APP_EP_ID = (app) => 'elab.ai.' + app + '.endpoint';
const APP_MODEL_ID = (app) => 'elab.ai.' + app + '.model';
export async function getAppEndpoint(app){
  const u = await idbGet(APP_EP_ID(app));
  return (typeof u === 'string' && u.trim()) ? u.trim().replace(/\/+$/, '') : null;
}
export async function saveAppEndpoint(app, url){
  const u = (url || '').trim().replace(/\/+$/, '');
  if(!u) throw new Error('empty');
  if(!/^https?:\/\//i.test(u)) throw new Error('invalid-url');
  await idbSet(APP_EP_ID(app), u);
}
export async function deleteAppEndpoint(app){ await idbDel(APP_EP_ID(app)); }
export async function getAppModel(app){
  const m = await idbGet(APP_MODEL_ID(app));
  return (typeof m === 'string' && m.trim()) ? m.trim() : null;
}
export async function saveAppModel(app, model){
  const m = (model || '').trim();
  if(!m) throw new Error('empty');
  await idbSet(APP_MODEL_ID(app), m);
}
export async function deleteAppModel(app){ await idbDel(APP_MODEL_ID(app)); }
// Endpoint/model hiệu dụng: ưu tiên riêng của app, không có thì dùng chung.
export async function getEffectiveEndpoint(app){
  const v = await getAppEndpoint(app).catch(()=>null);
  return v || await getBaseUrl().catch(()=>null);
}
// tốc T5-router: model nhỏ cho việc dễ (tra từ). Để trống = dùng model chính.
// Lưu dùng chung (như key + độ dài trả lời), không override riêng từng app.
const SMALL_MODEL_ID = 'elab.ai.small_model';
export async function getSmallModel(){
  const m = await idbGet(SMALL_MODEL_ID);
  return (typeof m === 'string' && m.trim()) ? m.trim() : null;
}
export async function saveSmallModel(model){
  const m = (model || '').trim();
  if(!m){ await idbDel(SMALL_MODEL_ID); return; }
  await idbSet(SMALL_MODEL_ID, m);
}
export async function deleteSmallModel(){ await idbDel(SMALL_MODEL_ID); }
// Router: thứ tự model cho task dễ — model nhỏ trước (nếu có và khác model
// chính), rồi model chính. Caller thử lần lượt, hỏng thì sang model tiếp theo.
export async function getRouterModels(app){
  const small = await getSmallModel().catch(()=>null);
  const main = await getEffectiveModel(app).catch(()=>null);
  const out = [];
  if(small && small !== main) out.push(small);
  if(main) out.push(main);
  return out;
}
export async function getEffectiveModel(app){
  const v = await getAppModel(app).catch(()=>null);
  return v || await getUserModel().catch(()=>null);
}
export async function isAppCustom(app){
  const ep = await getAppEndpoint(app).catch(()=>null);
  const mo = await getAppModel(app).catch(()=>null);
  return !!(ep || mo);
}

// 8b 2026-10-12: Từ base_url + key → suy ra provider type + models dùng được.
// Thử OpenAI-compatible trước ({base}/models, Bearer), rồi Gemini-style.
// Trả về {type:'openai'|'gemini', models:[...]} hoặc throw lỗi chi tiết.
export async function detectFromEndpoint(baseUrl, key) {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  const k = (key || '').trim();
  if (!base) { const e = new Error('empty-base-url'); e.code = 'empty_base_url'; throw e; }
  if (!k) { const e = new Error('empty-key'); e.code = 'empty'; throw e; }

  // 1. Thử OpenAI-compatible: GET {base}/models + Bearer
  try {
    const r = await fetch(base + '/models', { headers: { 'Authorization': 'Bearer ' + k } });
    if (r.status === 401 || r.status === 403) {
      const e = new Error('Key không đúng hoặc bị từ chối'); e.code = 'invalid_key'; throw e;
    }
    if (r.ok) {
      const j = await r.json();
      const models = (j.data || []).map(m => m.id).filter(Boolean);
      return { type: 'openai', models };
    }
    // Lỗi khác (404, 500...) → có thể không phải OpenAI-compatible, thử Gemini-style
  } catch (e) {
    if (e.code === 'invalid_key') throw e;
    // network error hoặc 404 → thử tiếp Gemini-style
  }

  // 2. Thử Gemini-style: GET {base}/models?key=KEY
  try {
    const r = await fetch(base + '/models?key=' + encodeURIComponent(k));
    if (r.status === 400 || r.status === 403) {
      try {
        const j = await r.json();
        const msg = (j.error && j.error.message) || '';
        if (/API key not valid/i.test(msg)) { const e = new Error('Key không đúng'); e.code = 'invalid_key'; throw e; }
      } catch (je) { if (je.code === 'invalid_key') throw je; }
      const e = new Error('Key không đúng hoặc bị từ chối'); e.code = 'invalid_key'; throw e;
    }
    if (r.ok) {
      const j = await r.json();
      // 8b 2026-10-12: không lọc theo tên — trả về tất cả model API trả về
      const models = (j.models || []).map(m => (m.name || '').replace(/^models\//, '')).filter(Boolean);
      return { type: 'gemini', models };
    }
  } catch (e) {
    if (e.code === 'invalid_key') throw e;
  }

  const e = new Error('Không kết nối được endpoint này');
  e.code = 'unreachable';
  throw e;
}

// 8b 2026-10-12: Chat qua base_url + key + model do user cấu hình.
// Tự chọn format: OpenAI-compatible ({base}/chat/completions) hoặc Gemini.
// messages: [{role:'user'|'model', text}]. Streaming qua onToken.
export async function chatWithEndpoint(baseUrl, key, model, messages, onToken) {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  const k = (key || '').trim();
  const m = (model || '').trim();
  if (!base || !k || !m) throw new Error('missing-config');
  checkDirectRate();

  const msgs = (messages || []).filter(x => x && x.text && x.text.trim());
  if (!msgs.length) throw new Error('empty-messages');

  // 8b 2026-10-12: thử OpenAI-compatible trước, 404 thì thử Gemini-style.
  // Không check tên provider trong URL — thuần format-based.
  try {
    return await chatOpenAICompat(base, k, m, msgs, onToken);
  } catch (e) {
    if (e.status === 404) {
      return await chatGeminiStyle(base, k, m, msgs, onToken);
    }
    throw e;
  }
}

async function chatOpenAICompat(base, key, model, messages, onToken) {
  const body = {
    model,
    messages: messages.map(x => ({
      role: x.role === 'model' ? 'assistant' : 'user',
      content: x.text,
    })),
    stream: true,
  };
  // 8b 2026-10-12 BUG-7: thêm timeout 60s — fetch treo vô hạn làm UI đơ
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let r;
  try {
    r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') { const te = new Error('timeout'); te.code = 'timeout'; throw te; }
    throw e;
  }
  clearTimeout(timer);
  // 8b 2026-10-12: đính kèm body lỗi (cắt 300 ký tự) để UI hiện diagnostic —
  // app "mọi provider" mà nuốt chi tiết lỗi thì không ai debug được.
  if (!r.ok) {
    const e = new Error('HTTP ' + r.status); e.status = r.status;
    try { e.detail = (await r.text()).slice(0, 300); } catch (_) {}
    throw e;
  }
  // SSE: data: {"choices":[{"delta":{"content":"..."}}]}
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const c = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
        if (c) { full += c; if (onToken) onToken(c); }
      } catch (e) {}
    }
  }
  return full;
}

async function chatGeminiStyle(base, key, model, messages, onToken) {
  const contents = messages.map(x => ({
    role: x.role === 'model' ? 'model' : 'user',
    parts: [{ text: x.text }],
  }));
  // 8b 2026-10-12 BUG-7: thêm timeout 60s
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let r;
  try {
    r = await fetch(
      `${base}/models/${model}:streamGenerateContent?alt=sse`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents }), signal: ctrl.signal }
    );
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') { const te = new Error('timeout'); te.code = 'timeout'; throw te; }
    throw e;
  }
  clearTimeout(timer);
  // 8b 2026-10-12: đính kèm body lỗi như chatOpenAICompat (xem trên).
  if (!r.ok) {
    const e = new Error('HTTP ' + r.status); e.status = r.status;
    try { e.detail = (await r.text()).slice(0, 300); } catch (_) {}
    throw e;
  }
  return readGeminiStream(r.body, onToken);
}

// Đọc SSE stream Gemini (dùng chung).
async function readGeminiStream(body, onToken) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
        for (const p of parts) {
          if (p.text) { full += p.text; if (onToken) onToken(p.text); }
        }
      } catch (e) {}
    }
  }
  return full;
}

// Liệt kê models hoạt động được với key của user.
// Test từng candidate bằng POST nhẹ (có CORS), chỉ trả về model nào không 404.
// Đường server (giữ nguyên endpoint cũ).
export async function callServer(path, body) {
  return apiCall(path, { method: 'POST', body: JSON.stringify(body) });
}

// ============================================================================
// Luồng proxy y chang ai-chat-windows.html (file đính kèm, đọc 2026-10-12):
// frontend KHÔNG BAO GIỜ gọi provider trực tiếp — mọi request qua
// POST /api/ai/relay {baseUrl,key,path,method,body}; server gắn key (Bearer)
// và forward, y như {origin}/proxy/<path> của bản desktop.
// Điều chỉnh duy nhất cho web: browser gửi baseUrl+key theo từng request
// (Worker stateless, không giữ key trong RAM như DPAPI bản desktop).
// ============================================================================

// textFromContent + extractText: y chang file (giữ nguyên thứ tự candidates).
function textFromContent(value){
  if(typeof value === "string") return value.trim();
  if(Array.isArray(value)) return value.map(item => typeof item === "string" ? item : textFromContent(item?.text ?? item?.content ?? item?.value)).filter(Boolean).join("").trim();
  if(value && typeof value === "object") return textFromContent(value.text ?? value.content ?? value.value);
  return "";
}
export function extractText(data){
  const choice = data?.choices?.[0];
  const candidates = [choice?.message?.content, choice?.message?.reasoning_content, choice?.text, choice?.delta?.content, data?.output_text, data?.message?.content, data?.content, data?.response, data?.text];
  for(const item of candidates){ const text = textFromContent(item); if(text) return text; }
  if(Array.isArray(data?.output)){
    const text = data.output.map(item => textFromContent(item?.content ?? item?.text)).filter(Boolean).join("").trim();
    if(text) return text;
  }
  return "";
}

// extractModelIds: y chang file (data.data[] hoặc data.models[];
// string | id | name | model | model_name).
function extractModelIds(data){
  const raw = Array.isArray(data?.data) ? data.data
    : (Array.isArray(data?.models) ? data.models : []);
  return [...new Set(raw.map(item => {
    if(typeof item === "string") return item.trim();
    return String(item?.id || item?.name || item?.model || item?.model_name || "").trim().replace(/^models\//, "");
  }).filter(Boolean))];
}

// Gọi qua relay; lỗi ném {status, detail} (y chang readResponse của file:
// "HTTP {status}: {detail(700)}").
async function proxyCall(baseUrl, key, path, method, body){
  // tốc T1: đo 4 mốc thời gian. Worker trả Server-Timing (session/upstream/
  // upstream_body/total); browser suy ra thêm mạng browser↔Worker.
  // Chỉ log ra console — không hiện UI để khỏi rối user.
  const t0 = nowMs();
  try{
    const { data, timing } = await apiCallTimed('/api/ai/relay', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, key, path, method, body }),
    });
    logRelayTiming(t0, timing, path);
    return data;
  }catch(e){
    if(e.timing) logRelayTiming(t0, e.timing, path + " [loi]");
    const err = new Error('proxy');
    err.status = e.status || 0;
    const ej = (e.data && e.data.error) || {};
    err.detail = String(ej.message || e.message || '').slice(0, 700);
    err.upstreamStatus = ej.upstreamStatus;
    throw err;
  }
}

function nowMs(){
  return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
}

// tốc T1: in breakdown thời gian ra console, 1 dòng gọn.
// Vd: [toc] relay /chat/completions: tong 8123ms = mang 210ms + worker 7913ms
//     (session 34ms, provider-headers 1200ms, provider-body 6679ms)
function logRelayTiming(t0, timing, label){
  try{
    const total = Math.round(nowMs() - t0);
    const t = timing || {};
    const wTotal = t.total || 0;
    // mạng browser↔Worker ≈ tổng thời gian − thời gian Worker xử lý
    const net = Math.max(0, Math.round(total - wTotal));
    console.info(
      "[toc] relay " + label + ": tong " + total + "ms = " +
      "mang " + net + "ms + worker " + Math.round(wTotal) + "ms " +
      "(session " + Math.round(t.session || 0) + "ms, " +
      "provider-headers " + Math.round(t.upstream || 0) + "ms, " +
      "provider-body " + Math.round(t.upstream_body || 0) + "ms)"
    );
  }catch(_){}
}

// Y chang loadModels() của file: GET /proxy/models → danh sách id (rỗng nếu không có).
// 8b 2026-10-13: object params theo Meta (tránh đảo args như bug proxyModels(k, base)).
// Gọi: proxyModels({ baseUrl, key })
// tốc T4: thử trực tiếp trước (GET {base}/models), CORS/network lỗi → relay.
export async function proxyModels({ baseUrl, key }){
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  const origin = safeOrigin(base);
  if(base && key && (!origin || directPathCache.get(origin) !== 'relay')){
    try{
      const ids = await directModelsOnce(base, key);
      if(origin) directPathCache.set(origin, 'direct');
      return ids;
    }catch(e){
      if(e.code === 'direct-http') throw e;
      if(origin) directPathCache.set(origin, 'relay');
      console.info('[toc] direct models that bai, dung relay: ' + String(e.detail || e.message || e).slice(0, 120));
    }
  }
  const data = await proxyCall(base, key, '/models', 'GET');
  return extractModelIds(data);
}

// ============================================================================
// tốc T4 — Gọi thẳng provider, bỏ 1 hop qua Worker (bớt ~0.1–0.4s/tin nhắn).
// Key đã nằm sẵn trong browser nên direct không lộ thêm gì — ngược lại còn
// bớt 1 chặng trung gian thấy key. Chỉ fallback về relay khi lỗi MẠNG
// (TypeError = CORS/network, AbortError = timeout 10s, đứt stream trước
// chữ đầu). Provider đã TRẢ LỜI bằng HTTP lỗi → throw luôn, không thử
// relay (relay sẽ nhận cùng lỗi, thử chỉ tốn thêm thời gian).
// Nhớ đường đi theo origin trong RAM (Map, mất khi reload): provider nào
// chặn CORS thì các tin sau đi thẳng relay, không chịu preflight hỏng lặp lại.
// ============================================================================
const DIRECT_TIMEOUT_MS = 10000;
const directPathCache = new Map(); // origin -> 'direct' | 'relay'
function safeOrigin(base){
  try{ return new URL(base).origin; }catch(e){ return ''; }
}
// Lấy message lỗi có nghĩa từ body lỗi provider (JSON {error:{message}} hoặc text).
function directErrorDetail(text){
  const t = String(text || '');
  if(!t) return '';
  try{
    const j = JSON.parse(t);
    const m = j?.error?.message || j?.message;
    if(m) return String(m).slice(0, 700);
  }catch(e){}
  return t.slice(0, 700);
}
function directNetworkErr(e){
  const ne = new Error('direct-network');
  ne.code = 'direct-network';
  ne.detail = String((e && e.message) || e).slice(0, 200);
  return ne;
}
function directHttpErr(status, detail){
  const e = new Error('HTTP ' + status);
  e.code = 'direct-http';
  e.status = status;
  e.detail = String(detail || '').slice(0, 700);
  return e;
}
// Một lần gọi thẳng provider. Throw direct-network (lỗi mạng → caller rớt
// về relay) hoặc direct-http (provider đã trả lời → caller KHÔNG thử relay).
async function directChatOnce(base, key, body, onToken, t0){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DIRECT_TIMEOUT_MS);
  let r;
  try{
    r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  }catch(e){
    clearTimeout(timer);
    throw directNetworkErr(e);
  }
  clearTimeout(timer);
  if(!r.ok){
    let detail = '';
    try{ detail = directErrorDetail(await r.text()); }catch(_){}
    throw directHttpErr(r.status, detail);
  }
  if(body.stream){
    if(!r.body || !r.body.getReader) throw directHttpErr(200, 'Response không có body để stream.');
    try{
      const res = await readOpenAIStream(r.body, onToken);
      logDirectTiming(t0, res.tFirst, true);
      return res.full;
    }catch(e){
      // Đứt stream trước chữ nào → coi như lỗi mạng, rớt về relay.
      if(e.message === 'stream-read') throw directNetworkErr(e);
      // 'empty' = provider trả 200 nhưng body đọc không được → đã trả lời,
      // relay sẽ nhận cùng body nên không thử lại.
      if(e.message === 'empty') throw directHttpErr(200, e.detail);
      throw e;
    }
  }
  let j = null;
  try{ j = await r.json(); }catch(e){}
  const answer = extractText(j);
  if(!answer) throw directHttpErr(200, 'API trả về nhưng không có nội dung đọc được.');
  logDirectTiming(t0, 0, false);
  return answer;
}
// Gọi thẳng provider (có thử lại body compat max_completion_tokens khi đúng
// lỗi param — y chang relay). Throw direct-network → caller rớt về relay;
// throw direct-http → caller throw luôn.
async function directChat({ base, key, model, msgs, toks, onToken }){
  const t0 = nowMs();
  const streaming = typeof onToken === 'function';
  const bodies = [
    { model: model, messages: msgs, max_tokens: toks, stream: streaming },
    { model: model, messages: msgs, max_completion_tokens: toks, stream: streaming },
  ];
  let lastErr = null;
  for(let i = 0; i < bodies.length; i++){
    try{
      return await directChatOnce(base, key, bodies[i], onToken, t0);
    }catch(e){
      lastErr = e;
      if(e.code === 'direct-network') throw e;
      // direct-http: chỉ thử body compat khi đúng lỗi param.
      if(!/max_tokens|unsupported.*param|unknown.*param|unrecognized.*param/i.test(String(e.detail || ''))) throw e;
    }
  }
  throw lastErr;
}
// Một lần lấy models thẳng từ provider. Throw direct-network / direct-http
// (cùng quy ước directChatOnce).
async function directModelsOnce(base, key){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DIRECT_TIMEOUT_MS);
  let r;
  try{
    r = await fetch(base + '/models', {
      headers: { 'Authorization': 'Bearer ' + key },
      signal: ctrl.signal,
    });
  }catch(e){
    clearTimeout(timer);
    throw directNetworkErr(e);
  }
  clearTimeout(timer);
  if(!r.ok){
    let detail = '';
    try{ detail = directErrorDetail(await r.text()); }catch(_){}
    throw directHttpErr(r.status, detail);
  }
  let j = null;
  try{ j = await r.json(); }catch(e){}
  return extractModelIds(j);
}
// tốc T4: log đường direct — cùng format TTFT như stream để so sánh với relay.
function logDirectTiming(t0, tFirst, streaming){
  try{
    const total = Math.round(nowMs() - t0);
    const ttft = tFirst ? Math.round(tFirst - t0) : -1;
    console.info(
      '[toc] direct /chat/completions: tong ' + total + 'ms' +
      (streaming ? (ttft >= 0 ? ' | TTFT ' + ttft + 'ms' + (ttft <= 3000 ? ' OK' : ' CHAM') : ' | TTFT n/a') : ' (buffered)')
    );
  }catch(_){}
}

// Y chang ask() của file: POST /proxy/chat/completions, stream:false,
// max_tokens → thử lại max_completion_tokens khi lỗi param.
// 8b 2026-10-13: object params theo Meta (tránh đảo args).
// tốc T2: thêm onToken (optional). Có onToken → stream chữ chảy dần qua relay
// (SSE); stream hỏng trước khi có chữ nào thì tự rớt về buffered. Không có
// onToken → y chang đường cũ, các caller hiện tại không bị ảnh hưởng.
// Gọi: proxyChat({ baseUrl, key, model, messages, maxTokens, onToken })
export async function proxyChat({ baseUrl, key, model, messages, maxTokens, onToken }){
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  const k = (key || '').trim();
  const m = (model || '').trim();
  if(!base || !k || !m){ const e = new Error('missing-config'); e.status = 0; e.detail = ''; throw e; }
  const toks = Math.max(256, Math.min(16384, Number(maxTokens) || 2048)); // y chang file
  const msgs = messages.map(x => ({ role: x.role === 'model' ? 'assistant' : 'user', content: x.text }));
  // tốc T4: thử gọi thẳng provider trước (bỏ 1 hop). Provider chặn CORS /
  // lỗi mạng / timeout 10s → rớt về relay như cũ. Provider đã trả HTTP lỗi
  // → throw luôn (relay sẽ trả cùng lỗi).
  const origin = safeOrigin(base);
  if(!origin || directPathCache.get(origin) !== 'relay'){
    try{
      const answer = await directChat({ base: base, key: k, model: m, msgs: msgs, toks: toks, onToken: onToken });
      if(origin) directPathCache.set(origin, 'direct');
      return answer;
    }catch(de){
      if(de.code === 'direct-http'){
        if(origin) directPathCache.set(origin, 'direct'); // CORS mở (provider đã trả lời)
        throw de;
      }
      if(origin) directPathCache.set(origin, 'relay');
      console.info('[toc] direct that bai, dung relay: ' + String((de && de.detail) || (de && de.message) || de).slice(0, 120));
    }
  }
  // tốc T2: thử stream trước để user thấy chữ chảy dần.
  if(typeof onToken === 'function'){
    try{
      return await proxyChatStream({ base: base, key: k, model: m, msgs: msgs, toks: toks, onToken: onToken });
    }catch(se){
      // Chưa có chữ nào mà stream đã hỏng → rớt về buffered cho chắc.
      // (Đã có chữ chảy rồi thì proxyChatStream tự trả phần đã có, không throw.)
      console.info('[toc] stream that bai, dung buffered: ' + String((se && se.detail) || (se && se.message) || se).slice(0, 120));
    }
  }
  const body = { model: m, messages: msgs, max_tokens: toks, stream: false };
  let data;
  try{
    data = await proxyCall(base, k, '/chat/completions', 'POST', body);
  }catch(error){
    if(!/max_tokens|unsupported.*param|unknown.*param|unrecognized.*param/i.test(String(error.detail || ""))) throw error;
    const compat = { ...body, max_completion_tokens: toks };
    delete compat.max_tokens;
    data = await proxyCall(base, k, '/chat/completions', 'POST', compat);
  }
  const answer = extractText(data);
  if(!answer){ const e = new Error('empty'); e.status = 0; e.detail = 'API trả về nhưng không có nội dung đọc được.'; throw e; }
  return answer;
}

// tốc T2: chat streaming qua relay. Body gửi provider có stream:true, envelope
// relay có stream:true → Worker pipe SSE thẳng về browser (không buffer).
// onToken(chunk) được gọi mỗi khi có chữ mới. Trả về toàn bộ text khi xong.
// Quy ước để UI không bao giờ hiện trùng lặp:
// - Chưa nhận chữ nào mà stream hỏng → throw (caller rớt về buffered).
// - Đã có chữ chảy rồi mà stream đứt → trả phần đã có, không throw.
async function proxyChatStream({ base, key, model, msgs, toks, onToken }){
  const t0 = nowMs();
  const bodies = [
    { model: model, messages: msgs, max_tokens: toks, stream: true },
    { model: model, messages: msgs, max_completion_tokens: toks, stream: true },
  ];
  let lastErr = null;
  for(let i = 0; i < bodies.length; i++){
    try{
      return await relayStreamOnce(base, key, bodies[i], t0, onToken);
    }catch(e){
      lastErr = e;
      // Chỉ thử body thứ 2 khi lỗi đúng kiểu "provider không hiểu max_tokens".
      if(!/max_tokens|unsupported.*param|unknown.*param|unrecognized.*param/i.test(String(e.detail || ""))) throw e;
    }
  }
  throw lastErr;
}

// tốc T4: đọc SSE OpenAI dùng chung cho cả direct và relay.
// Trả {full, tFirst}. Quy ước (giữ y chang T2):
// - Đứt stream sau khi có chữ → trả phần đã có.
// - Đứt trước chữ nào → throw 'stream-read'.
// - 200 nhưng không SSE, không đọc được JSON → throw 'empty'.
async function readOpenAIStream(body, onToken){
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '', raw = '', gotToken = false, tFirst = 0;
  const push = (c) => {
    full += c; gotToken = true;
    if(!tFirst) tFirst = nowMs();
    try{ onToken(c); }catch(_){}
  };
  try{
    for(;;){
      const { done, value } = await reader.read();
      if(done) break;
      const chunk = dec.decode(value, { stream: true });
      raw += chunk; buf += chunk;
      const lines = buf.split('\n'); buf = lines.pop();
      for(const line of lines){
        const t = line.trim();
        if(!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if(!data || data === '[DONE]') continue;
        let j; try{ j = JSON.parse(data); }catch(e){ continue; }
        const c = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
        if(c) push(c);
      }
    }
  }catch(e){
    // Đứt giữa chừng: đã có chữ thì giữ phần đã có (không fallback gây trùng).
    if(gotToken) return { full, tFirst };
    const ne = new Error('stream-read'); ne.detail = String((e && e.message) || e).slice(0, 200); throw ne;
  }
  if(!gotToken){
    // Provider trả 200 nhưng không phải SSE (bỏ qua stream:true, trả JSON thường)
    // → đọc như buffered để không mất câu trả lời.
    try{
      const answer = extractText(JSON.parse(raw));
      if(answer){ push(answer); return { full, tFirst }; }
    }catch(e){}
    const e = new Error('empty'); e.status = 0; e.detail = 'API trả về nhưng không có nội dung đọc được.'; throw e;
  }
  return { full, tFirst };
}

// Một lần thử stream. Trả về full text; throw khi chưa nhận được chữ nào.
async function relayStreamOnce(base, key, body, t0, onToken){
  let r, timing;
  try{
    const res = await apiFetchTimed('/api/ai/relay', {
      method: 'POST',
      body: JSON.stringify({ baseUrl: base, key: key, path: '/chat/completions', method: 'POST', body: body, stream: true }),
    });
    r = res.response; timing = res.timing;
  }catch(e){
    const ne = new Error('network'); ne.detail = String((e && e.message) || e).slice(0, 200); throw ne;
  }
  if(!r.ok){
    const e = new Error('HTTP ' + r.status); e.status = r.status;
    try{
      const j = await r.json();
      const ej = (j.error || {});
      e.detail = String(ej.message || '').slice(0, 700);
      e.upstreamStatus = ej.upstreamStatus;
    }catch(_){}
    logStreamTiming(t0, timing, 0);
    throw e;
  }
  if(!r.body || !r.body.getReader){
    const e = new Error('empty'); e.status = 0; e.detail = 'Response không có body để stream.'; throw e;
  }
  try{
    const res = await readOpenAIStream(r.body, onToken);
    logStreamTiming(t0, timing, res.tFirst);
    return res.full;
  }catch(e){
    logStreamTiming(t0, timing, 0);
    throw e;
  }
}

// tốc T2: log stream — thêm TTFT (thời gian tới chữ đầu tiên), mục tiêu ≤ 3000ms.
function logStreamTiming(t0, timing, tFirst){
  try{
    const now = nowMs();
    const total = Math.round(now - t0);
    const t = timing || {};
    const wTotal = t.total || 0;
    const net = Math.max(0, Math.round(total - wTotal));
    const ttft = tFirst ? Math.round(tFirst - t0) : -1;
    console.info(
      '[toc] stream: tong ' + total + 'ms = mang ' + net + 'ms + worker ' + Math.round(wTotal) + 'ms ' +
      '(session ' + Math.round(t.session || 0) + 'ms, provider-headers ' + Math.round(t.upstream || 0) + 'ms)' +
      (ttft >= 0 ? ' | TTFT ' + ttft + 'ms' + (ttft <= 3000 ? ' OK' : ' CHAM') : ' | TTFT n/a')
    );
  }catch(_){}
}

// ============================================================================
// tốc T5 — Cache: câu hỏi lặp (tra từ, quiz) → trả ngay kết quả cũ, không gọi AI.
// Chỉ cho task xác định (explain/quiz), KHÔNG cache chat (hội thoại phụ thuộc
// ngữ cảnh, cache sẽ trả lời sai). Lưu ở IndexedDB riêng 'pp_ai_cache'
// (không động DB key 'pp_ai'), key = hash (endpoint|model|prompt). TTL 30 ngày,
// tối đa 200 mục (quá thì xoá cũ nhất). Cache hỏng → bỏ qua, không chặn chat.
// ============================================================================
const CACHE_DB = 'pp_ai_cache';
const CACHE_STORE = 'entries';
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const CACHE_MAX = 200;
function cacheDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB, 1);
    req.onupgradeneeded = () => { try{ req.result.createObjectStore(CACHE_STORE); }catch(e){} };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
// Hash 53-bit (cyrb53) — key cache ngắn gọn, va chạm không đáng kể.
export function cacheKeyFor(parts){
  const s = JSON.stringify(parts);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for(let i = 0; i < s.length; i++){
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
export async function aiCacheGet(key){
  try{
    const db = await cacheDb();
    const v = await new Promise((resolve) => {
      const tx = db.transaction(CACHE_STORE, 'readonly');
      const req = tx.objectStore(CACHE_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if(!v || typeof v.text !== 'string' || !v.text) return null;
    if(Date.now() - (v.savedAt || 0) > CACHE_TTL_MS){ aiCacheDel(key).catch(()=>{}); return null; }
    return v.text;
  }catch(e){ return null; }
}
export async function aiCacheSet(key, text){
  try{
    const t = String(text || '');
    if(!t) return;
    const db = await cacheDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      tx.objectStore(CACHE_STORE).put({ key, text: t, savedAt: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Giới hạn 200 mục: quá thì xoá cũ nhất (quét 1 lần, rẻ với 200 mục).
    const all = await new Promise((resolve) => {
      const tx = db.transaction(CACHE_STORE, 'readonly');
      const req = tx.objectStore(CACHE_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    if(all.length > CACHE_MAX){
      const old = all.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0)).slice(0, all.length - CACHE_MAX);
      await new Promise((resolve) => {
        const tx = db.transaction(CACHE_STORE, 'readwrite');
        const st = tx.objectStore(CACHE_STORE);
        for(const item of old){ try{ st.delete(item.key); }catch(e){} }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }
  }catch(e){ /* cache hỏng thì bỏ qua, không chặn chat */ }
}
async function aiCacheDel(key){
  try{
    const db = await cacheDb();
    await new Promise((resolve) => {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      tx.objectStore(CACHE_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }catch(e){}
}

// AI giải thích từ: thử proxy (key user, y chang file đính kèm — không gọi
// provider trực tiếp), lỗi thì fallback server 1 lần.
// Dùng endpoint/model hiệu dụng của app 'english' (riêng hoặc dùng chung).
// tốc T2: onToken (optional) → stream chữ chảy dần qua relay.
export async function explainWithFallback(word, sentence, lang, onToken) {
  const key = await getUserKey();
  const base = await getEffectiveEndpoint('english').catch(()=>null);
  const model = await getEffectiveModel('english').catch(()=>null);
  if (key && base && model) {
    try {
      const prompt = 'Explain the English word "' + word + '"' +
        (sentence ? ' in this sentence: "' + sentence + '"' : '') +
        '. Answer in ' + (lang === 'vi' ? 'Vietnamese' : 'English') + ', concise, with an example.';
      const rlen = await getResponseLength().catch(()=>2048);
      // tốc T5-router: việc dễ → thử model nhỏ trước (nếu có), hỏng
      // (vd model nhỏ không có trên endpoint) thì sang model chính.
      // Cache check theo từng model (key gồm endpoint|model|prompt).
      const models = await getRouterModels('english');
      for(const mdl of models){
        try{
          // tốc T5: từ đã tra rồi → trả cache, không gọi AI.
          const cacheKey = cacheKeyFor(['explain-word', base, mdl, prompt]);
          const cached = await aiCacheGet(cacheKey);
          if(cached) return { explanation: cached, via: 'cache' };
          const text = await proxyChat({ baseUrl: base, key, model: mdl, messages: [{ role: 'user', text: prompt }], maxTokens: rlen,
            onToken: (typeof onToken === 'function' ? onToken : undefined) });
          if (text.trim()){
            // Chỉ cache kết quả proxy (không cache server fallback — để lần sau
            // vẫn thử lại proxy khi key đã sửa, và server đã có cache D1 riêng).
            await aiCacheSet(cacheKey, text);
            return { explanation: text, via: 'proxy' };
          }
        }catch(e){
          // Model này hỏng → thử model tiếp theo (cuối cùng rớt server).
          continue;
        }
      }
    } catch (e) {
      // Rớt proxy → fallback server 1 lần (mọi loại lỗi)
    }
  }
  const r = await callServer('/api/ai/explain', { word, sentence, lang });
  return Object.assign({}, r, { via: 'server' });
}

// 8b 2026-10-12 (Phase 1.5 S3): Giới hạn tin nhắn/phút cho direct — bảo vệ quota key của user.
// Kiểu big tech (Vercel AI SDK): đếm sliding window, vượt thì ném lỗi để caller fallback.
const DIRECT_LIMIT_PER_MIN = 10;
const directCallTimes = [];
export function checkDirectRate(){
  const now = Date.now();
  while(directCallTimes.length && now - directCallTimes[0] > 60000) directCallTimes.shift();
  if(directCallTimes.length >= DIRECT_LIMIT_PER_MIN){
    const e = new Error('rate-limited');
    e.status = 429;
    throw e;
  }
  directCallTimes.push(now);
}

// Trạng thái đường AI hiện tại (cho indicator UI).
export async function aiRoute() {
  const key = await getUserKey();
  return key ? 'proxy' : 'server';
}
