// js/core/aiClient.js — BYOK hybrid AI client (Phase 1).
// Routing: có user key → gọi trực tiếp Google từ browser (0đ server).
// Lỗi (401/403/429/network) → fallback server 1 lần.
// Key lưu ở IndexedDB, KHÔNG BAO GIỜ gửi về server, không log.
import { apiCall } from './api.js';

const DB_NAME = 'pp_ai';
const STORE = 'keys';
const KEY_ID = 'gemini_user_key';
const MODEL_ID = 'gemini_user_model';
// 8b: Danh sách model ứng viên — verify bằng POST thật (có CORS).
// Không đoán, không hardcode model duy nhất. User tự chọn từ dropdown.
// Verify 2026-10-11 bằng key thật:
// - gemini-3.5-flash: 200 OK ✅
// - gemini-3.8-flash: 503 (tạm thời, vẫn giữ trong list)
// - gemini-2.0-flash: KHÔNG tồn tại ❌ (đã loại)
// - gemini-2.5-flash: ngừng với user mới ❌ (đã loại)
const MODEL_CANDIDATES = [
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
];

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

// Liệt kê models hoạt động được với key của user.
// Test từng candidate bằng POST nhẹ (có CORS), chỉ trả về model nào không 404.
export async function listWorkingModels(key) {
  const k = (key || '').trim();
  if (!k) return [];
  const working = [];
  for (const m of MODEL_CANDIDATES) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Hi' }] }] }),
        }
      );
      // 200 = hoạt động; 400 = model tồn tại nhưng key sai hoặc request lỗi (vẫn tính là model đúng)
      // 404 = model không tồn tại → loại
      if (r.status !== 404) working.push(m);
    } catch (e) {
      // network error: bỏ qua model này
    }
  }
  return working;
}

// Kiểm tra key bằng 1 request POST thật nhẹ.
// 8b: Dùng POST (có CORS), không dùng GET listModels (không có CORS).
// Trả về { ok, error, models } — models là danh sách model hoạt động được.
export async function testUserKey(key) {
  const k = (key || '').trim();
  if (!k) return { ok: false, error: 'empty', models: [] };
  const models = await listWorkingModels(k);
  if (!models.length) {
    // Không model nào hoạt động → key sai hoặc network lỗi
    // Thử 1 request để lấy lỗi cụ thể
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_CANDIDATES[0]}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Hi' }] }] }),
        }
      );
      if (r.status === 400) {
        try {
          const data = await r.json();
          const msg = (data.error && data.error.message) || '';
          if (msg.includes('API key not valid')) return { ok: false, error: 'invalid_key', models: [] };
        } catch (e) {}
        return { ok: false, error: 'invalid_key', models: [] };
      }
      if (r.status === 403) return { ok: false, error: 'forbidden', models: [] };
      return { ok: false, error: 'network', models: [] };
    } catch (e) {
      return { ok: false, error: 'network', models: [] };
    }
  }
  return { ok: true, models };
}

// Gọi trực tiếp Google từ browser, stream SSE từng chunk.
// Dùng model user đã chọn, fallback sang model đầu tiên trong list.
export async function callDirect(prompt, onToken) {
  const key = await getUserKey();
  if (!key) throw new Error('no-key');
  const selected = await getUserModel();
  const modelsToTry = selected ? [selected, ...MODEL_CANDIDATES.filter(m => m !== selected)] : MODEL_CANDIDATES;
  let lastErr = null;
  for (const m of modelsToTry) {
    try {
      return await callDirectWithModel(key, m, prompt, onToken);
    } catch (e) {
      lastErr = e;
      if (e.status === 404) continue; // invalid model, try next
      throw e; // other errors (401/403/429/network) → fallback server
    }
  }
  throw lastErr || new Error('no-model');
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
