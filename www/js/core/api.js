// js/core/api.js — REST client for the Cloudflare Worker backend.
import { state } from './state.js';
export function authHeaders(){
  return state.authToken ? {"Authorization": "Bearer "+state.authToken} : {};
}
export async function apiCall(path, opts={}){
  const r = await fetch(path, {
    ...opts,
    headers: {"Content-Type":"application/json", ...authHeaders(), ...(opts.headers||{})},
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error || ("HTTP "+r.status));
  return j;
}
