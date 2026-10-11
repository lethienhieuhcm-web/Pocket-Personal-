// js/core/aiClient.js — BYOK hybrid AI client (Phase 1).
// Routing: có user key → gọi trực tiếp Google từ browser (0đ server).
// Lỗi (401/403/429/network) → fallback server 1 lần.
// Key lưu ở IndexedDB, KHÔNG BAO GIỜ gửi về server, không log.
import { apiCall } from './api.js';

const DB_NAME = 'pp_ai';
const STORE = 'keys';
const KEY_ID = 'gemini_user_key';
// 8b: KHÔNG đoán tên model. Discovery từ API thật bằng key của user.
// Cache model đã verify để không gọi listModels mỗi lần.
let _verifiedModel = null;

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
}

// 8b: Discovery model từ API thật, không đoán tên.
// Gọi GET /v1beta/models bằng key user, chọn model hỗ trợ generateContent.
async function discoverModel(key) {
  if (_verifiedModel) return _verifiedModel;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
  );
  if (!r.ok) {
    const err = new Error('HTTP ' + r.status);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  const models = (data.models || []).filter(m =>
    (m.supportedGenerationMethods || []).includes('generateContent')
  );
  if (!models.length) throw new Error('no_model');
  // Ưu tiên flash (nhanh, rẻ), rồi mới đến các model khác
  models.sort((a, b) => {
    const aFlash = a.name.includes('flash') ? 0 : 1;
    const bFlash = b.name.includes('flash') ? 0 : 1;
    return aFlash - bFlash;
  });
  // name dạng "models/gemini-xxx", lấy phần sau "models/"
  _verifiedModel = models[0].name.replace('models/', '');
  return _verifiedModel;
}

// Kiểm tra key bằng 1 request thật nhẹ.
// Dùng listModels để verify key + discovery model.
export async function testUserKey(key) {
  const k = (key || '').trim();
  if (!k) return { ok: false, error: 'empty' };
  try {
    _verifiedModel = null; // force re-discovery khi test
    await discoverModel(k);
    return { ok: true };
  } catch (e) {
    if (e.status === 400) return { ok: false, error: 'invalid_key' };
    if (e.status === 403) return { ok: false, error: 'forbidden' };
    if (e.message === 'no_model') return { ok: false, error: 'no_model' };
    return { ok: false, error: 'network' };
  }
}

// Gọi trực tiếp Google từ browser, stream SSE từng chunk.
// 8b: dùng model đã discovery từ API thật, không đoán tên.
export async function callDirect(prompt, onToken) {
  const key = await getUserKey();
  if (!key) throw new Error('no-key');
  const model = await discoverModel(key);
  return await callDirectWithModel(key, model, prompt, onToken);
}

async function callDirectWithModel(key, model, prompt, onToken) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  if (!r.ok) {
    const e = new Error('HTTP ' + r.status);
    e.status = r.status;
    throw e;
  }
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
        const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
        for (const p of parts) {
          if (p.text) { full += p.text; if (onToken) onToken(p.text); }
        }
      } catch (e) {}
    }
  }
  return full;
}

// Đường server (giữ nguyên endpoint cũ).
export async function callServer(path, body) {
  return apiCall(path, { method: 'POST', body: JSON.stringify(body) });
}

// AI giải thích từ: thử direct trước, lỗi thì fallback server 1 lần.
export async function explainWithFallback(word, sentence, lang, onToken) {
  const key = await getUserKey();
  if (key) {
    try {
      const prompt = 'Explain the English word "' + word + '"' +
        (sentence ? ' in this sentence: "' + sentence + '"' : '') +
        '. Answer in ' + (lang === 'vi' ? 'Vietnamese' : 'English') + ', concise, with an example.';
      const text = await callDirect(prompt, onToken);
      if (text.trim()) return { explanation: text, via: 'direct' };
    } catch (e) {
      // Rớt direct → fallback server 1 lần (mọi loại lỗi)
    }
  }
  const r = await callServer('/api/ai/explain', { word, sentence, lang });
  return Object.assign({}, r, { via: 'server' });
}

// Trạng thái đường AI hiện tại (cho indicator UI).
export async function aiRoute() {
  const key = await getUserKey();
  return key ? 'direct' : 'server';
}
