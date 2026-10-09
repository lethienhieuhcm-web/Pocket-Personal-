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
