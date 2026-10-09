const rateMap = new Map();

export function checkRate(ip) {
  const now = Date.now();
  let rec = rateMap.get(ip);
  if (!rec || now > rec.reset) rec = { count: 0, reset: now + 86400000 };
  rec.count++;
  rateMap.set(ip, rec);
  if (rateMap.size > 2000) for (const [k, v] of rateMap) if (now > v.reset) rateMap.delete(k);
  return rec.count <= 300;
}

export function jerr(msg, status) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { "Content-Type": "application/json" } });
}

export function fetchTimeout(url, ms, opts={}){
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), ms);
  return fetch(url, {...opts, signal: ctl.signal}).finally(()=>clearTimeout(t));
}

export function stripHtml(s){
  return (s||"").replace(/<[^>]*>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
}

export function randToken(n=32){
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");
}

export function sJson(data, status){
  return new Response(JSON.stringify(data), {status: status||200, headers:{"Content-Type":"application/json"}});
}

