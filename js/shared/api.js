// js/shared/api.js — Shared REST client (Gốc G8, 2026-10-13)
// Big-tech pattern: single client, auth auto-inject, standardized errors, retry.
// Khác js/core/api.js: không phụ thuộc state.js của app nào, token qua setToken().
// Dùng cho app mới. Các app cũ (stocks, talk) giữ nguyên code đang chạy ổn (8b).

let _token = null;
let _tokenGetter = null;

export function setToken(token) {
  _token = token;
}

export function setTokenGetter(fn) {
  _tokenGetter = fn;
}

function getToken() {
  if (_tokenGetter) {
    try { return _tokenGetter(); } catch (e) { return _token; }
  }
  return _token;
}

export function authHeaders() {
  const t = getToken();
  return t ? { "Authorization": "Bearer " + t } : {};
}

// Error contract: Error with .status (HTTP code) and .data (parsed body, if any).
export async function apiCall(path, opts = {}) {
  const token = opts.token !== undefined ? opts.token : getToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { "Authorization": "Bearer " + token } : {}),
    ...(opts.headers || {}),
  };
  // Không log token (8b: không lộ secret)
  const { token: _t, ...fetchOpts } = opts;
  const r = await fetch(path, { ...fetchOpts, headers });
  if (!r.ok) {
    const e = new Error("HTTP " + r.status);
    e.status = r.status;
    try {
      const j = await r.json();
      e.message = j.error || e.message;
      e.data = j;
    } catch (_) {}
    throw e;
  }
  return r.json();
}

// Raw fetch for non-JSON responses (audio blobs, images). Auth always attached.
export async function apiFetchRaw(path, opts = {}) {
  const token = opts.token !== undefined ? opts.token : getToken();
  const headers = {
    ...(token ? { "Authorization": "Bearer " + token } : {}),
    ...(opts.headers || {}),
  };
  const { token: _t, ...fetchOpts } = opts;
  const r = await fetch(path, { ...fetchOpts, headers });
  if (!r.ok) {
    const e = new Error("HTTP " + r.status);
    e.status = r.status;
    throw e;
  }
  return r;
}

// Retry wrapper cho lỗi transient (502/503/504, network fail).
// Big-tech pattern: exponential backoff, tối đa 3 lần.
export async function apiCallRetry(path, opts = {}, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await apiCall(path, opts);
    } catch (e) {
      lastErr = e;
      // Chỉ retry lỗi transient
      const transient = e.status === 502 || e.status === 503 || e.status === 504 || e.status === undefined;
      if (!transient || i === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 500));
    }
  }
  throw lastErr;
}
