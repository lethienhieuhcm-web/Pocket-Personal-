// js/core/api.js — REST client for the Cloudflare Worker backend.
// SINGLE apiCall for the whole app (Phase 4): every feature imports from here.
// Error contract: Error with .status (HTTP code) and .data (parsed body, if any).
import { state } from './state.js';
export function authHeaders(){
  return state.authToken ? {"Authorization": "Bearer "+state.authToken} : {};
}
export async function apiCall(path, opts={}){
  const r = await fetch(path, {
    ...opts,
    headers: {"Content-Type":"application/json", ...authHeaders(), ...(opts.headers||{})},
  });
  if(!r.ok){
    const e = new Error("HTTP "+r.status);
    e.status = r.status;
    try{ const j = await r.json(); e.message = j.error || e.message; e.data = j; }catch(_){}
    throw e;
  }
  return r.json();
}
// Raw fetch for non-JSON responses (audio blobs). Auth always attached.
export async function apiFetchRaw(path, opts={}){
  const r = await fetch(path, {
    ...opts,
    headers: {...authHeaders(), ...(opts.headers||{})},
  });
  if(!r.ok){
    const e = new Error("HTTP "+r.status);
    e.status = r.status;
    throw e;
  }
  return r;
}

// tốc T2: fetch thô kèm Server-Timing, KHÔNG đọc body — cho streaming,
// caller tự đọc response.body theo ý mình (SSE...).
// Trả về { response, timing }.
export async function apiFetchTimed(path, opts={}){
  const r = await fetch(path, {
    ...opts,
    headers: {"Content-Type":"application/json", ...authHeaders(), ...(opts.headers||{})},
  });
  const timing = parseServerTiming(r.headers.get("Server-Timing"));
  return { response: r, timing };
}
// tốc T1: parse Server-Timing header (chuẩn W3C) → {tên: ms}.
// Vd: "session;dur=12, upstream;dur=345, total;dur=400" → {session:12, upstream:345, total:400}
export function parseServerTiming(headerVal){
  const out = {};
  if(!headerVal || typeof headerVal !== "string") return out;
  const re = /([a-zA-Z0-9_-]+)\s*;\s*dur=([0-9.]+)/g;
  let m;
  while((m = re.exec(headerVal))){
    const v = parseFloat(m[2]);
    if(Number.isFinite(v)) out[m[1]] = v;
  }
  return out;
}

// tốc T1: như apiCall nhưng trả thêm timing đọc từ Server-Timing header.
// Trả về { data, timing } — contract của apiCall giữ nguyên, không ai bị ảnh hưởng.
export async function apiCallTimed(path, opts={}){
  const r = await fetch(path, {
    ...opts,
    headers: {"Content-Type":"application/json", ...authHeaders(), ...(opts.headers||{})},
  });
  const timing = parseServerTiming(r.headers.get("Server-Timing"));
  if(!r.ok){
    const e = new Error("HTTP "+r.status);
    e.status = r.status;
    try{ const j = await r.json(); e.message = j.error || e.message; e.data = j; }catch(_){}
    e.timing = timing;
    throw e;
  }
  const data = await r.json();
  return { data, timing };
}
