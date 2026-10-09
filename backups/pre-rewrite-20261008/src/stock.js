import { jerr, sJson } from './utils.js';
import { getSession } from './auth.js';

/* ================= STOCK (chung khoan VN, R2-backed) ================= */
/* Market snapshots: stock/market/*.json — VM day len qua POST /api/internal/stock-publish
   User data: stock/users/{email}/(watchlist|portfolio|alerts|targets).json
   Auth: dung session English Lab (getSession). Khong can JWT rieng. */

export async function sGet(env, key){
  try{ const o = await env.DATA.get("stock/"+key); return o ? await o.json() : null; }
  catch(e){ return null; }
}

// Get with ETag for optimistic concurrency
export async function sGetWithEtag(env, key){
  try{
    const o = await env.DATA.get("stock/"+key);
    if(!o) return {data: null, etag: null};
    return {data: await o.json(), etag: o.etag};
  }catch(e){ return {data: null, etag: null}; }
}

export async function sPut(env, key, val){
  await env.DATA.put("stock/"+key, JSON.stringify(val), {httpMetadata:{contentType:"application/json"}});
}

// Edge cache for market data (5 min TTL)
export async function cachedMarket(request, env, key, ttlSec=300){
  const cache = caches.default;
  const cacheKey = new Request(request.url, {method: "GET"});
  let resp = await cache.match(cacheKey);
  if(resp) return resp;
  const d = await sGet(env, key);
  resp = new Response(JSON.stringify(d || {updated:null, rows:[]}), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttlSec}`,
    }
  });
  await cache.put(cacheKey, resp.clone());
  return resp;
}

// Put with ETag check (throws on conflict)
export async function sPutIfMatch(env, key, val, etag){
  const opts = {httpMetadata:{contentType:"application/json"}};
  if(etag) opts.onlyIf = {etagMatches: etag};
  try{
    await env.DATA.put("stock/"+key, JSON.stringify(val), opts);
    return true;
  }catch(e){
    // ETag mismatch or other error
    return false;
  }
}

const SKEY = e => "users/"+e+"/";


/* ---------- tinh toan (port tu FastAPI) ---------- */
export function sCalcPositions(txns){
  const pos = {}, realized = {};
  const sorted = [...txns].sort((a,b)=> a.date<b.date?-1 : a.date>b.date?1 : a.id-b.id);
  for(const t of sorted){
    const p = pos[t.symbol] || (pos[t.symbol] = {qty:0, cost:0});
    if(t.side==="BUY"){ p.qty += t.qty; p.cost += t.price*t.qty + t.fee; }
    else{
      const avg = p.qty ? p.cost/p.qty : 0;
      realized[t.symbol] = (realized[t.symbol]||0) + (t.price-avg)*t.qty - t.fee;
      p.qty -= t.qty; p.cost -= avg*t.qty;
    }
  }
  return {pos, realized};
}

export function sAutoFee(side, price, qty){
  const v = price*qty;
  return side==="SELL" ? v*0.0025 : v*0.0015;
}

export function sPctRank(vals, v, higherBetter){
  const xs = vals.filter(x=>x!=null).sort((a,b)=>a-b);
  if(!xs.length || v==null || xs.length<2) return null;
  const below = xs.filter(x=> higherBetter ? x<v : x>v).length;
  return Math.round(below/(xs.length-1)*1000)/10;
}

const SCORE_W = {value:0.35, quality:0.35, momentum:0.20, liquidity:0.10};

export function sScoreRows(rows, funds, closes){
  const pes=[], pbs=[], roes=[], nms=[], pcs=[], liqs=[], tmp=[];
  for(const r of rows){
    const sym = r.symbol, f = funds[sym]||{};
    const close = closes[sym];
    let pe=null, pb=null;
    if(close && f.eps>0) pe = Math.round(close*1000/f.eps*100)/100;
    if(close && f.bvps>0) pb = Math.round(close*1000/f.bvps*100)/100;
    tmp.push([r,pe,pb,f.roe,f.net_margin,r.pct_change,r.value_vnd]);
    pes.push(pe); pbs.push(pb); roes.push(f.roe); nms.push(f.net_margin);
    pcs.push(r.pct_change); liqs.push(r.value_vnd);
  }
  for(const [r,pe,pb,roe,nm,pc,liq] of tmp){
    const parts = {};
    const vpe = sPctRank(pes,pe,false), vpb = sPctRank(pbs,pb,false);
    const vv = [vpe,vpb].filter(x=>x!=null);
    if(vv.length) parts.value = vv.reduce((a,b)=>a+b,0)/vv.length;
    const qroe = sPctRank(roes,roe,true), qnm = sPctRank(nms,nm,true);
    const qq = [qroe,qnm].filter(x=>x!=null);
    if(qq.length) parts.quality = qq.reduce((a,b)=>a+b,0)/qq.length;
    const qpc = sPctRank(pcs,pc,true);
    if(qpc!=null) parts.momentum = qpc;
    const qlq = sPctRank(liqs,liq,true);
    if(qlq!=null) parts.liquidity = qlq;
    const wsum = Object.keys(parts).reduce((a,k)=>a+SCORE_W[k],0);
    r.score = wsum ? Math.round(Object.keys(parts).reduce((a,k)=>a+parts[k]*SCORE_W[k],0)/wsum*10)/10 : null;
    r.pe = pe; r.pb = pb;
  }
  return rows;
}

export function sBacktest(closes, times, fast, slow){
  const n = closes.length;
  const sma = (i,p)=>{ let s=0; for(let k=i-p+1;k<=i;k++) s+=closes[k]; return s/p; };
  let pos=0, entryPx=0, entryT="", capital=1;
  const trades=[], equity=[], bhEquity=[];
  const baseBh = closes[slow];
  for(let i=slow;i<n;i++){
    const f=sma(i,fast), s=sma(i,slow), pf=sma(i-1,fast), ps=sma(i-1,slow), px=closes[i];
    if(pos===0 && pf<=ps && f>s){ pos=1; entryPx=px; entryT=times[i]; }
    else if(pos===1 && pf>=ps && f<s){
      const ret=(px-entryPx)/entryPx; capital*=(1+ret);
      trades.push({in:entryT, in_px:Math.round(entryPx*100)/100, out:times[i], out_px:Math.round(px*100)/100, ret:Math.round(ret*10000)/100});
      pos=0;
    }
    equity.push({t:times[i], v:Math.round(capital*(pos?px/entryPx:1)*10000)/10000});
    bhEquity.push({t:times[i], v: baseBh? Math.round(px/baseBh*10000)/10000 : 1});
  }
  if(pos){
    const ret=(closes[n-1]-entryPx)/entryPx; capital*=(1+ret);
    trades.push({in:entryT, in_px:Math.round(entryPx*100)/100, out:times[n-1], out_px:Math.round(closes[n-1]*100)/100, ret:Math.round(ret*10000)/100, open:true});
  }
  const wins = trades.filter(t=>t.ret>0).length;
  let peak=0, mdd=0;
  for(const p of equity){ peak=Math.max(peak,p.v); mdd=Math.min(mdd,(p.v-peak)/(peak||1)*100); }
  const bh = closes[slow] ? (closes[n-1]-closes[slow])/closes[slow]*100 : 0;
  return {trades, equity, bh_equity:bhEquity,
    stats:{trades:trades.length, winrate: trades.length? Math.round(wins/trades.length*1000)/10:0,
      strategy_ret:Math.round((capital-1)*10000)/100, bh_ret:Math.round(bh*100)/100,
      max_drawdown:Math.round(mdd*100)/100},
    note:"Excluding fees and taxes."};
}


/* ---------- market (doc tu R2 snapshot, can login) ---------- */
export async function hStockIndices(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/indices.json", 300);
}

// Lightweight version check for polling (edge-cached 60s)
// Frontend polls this every 5 min; refreshes market data only when version changes
export async function hStockVersion(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const cache = caches.default;
  const cacheKey = new Request(request.url, {method: "GET"});
  let resp = await cache.match(cacheKey);
  if(resp) return resp;
  const d = await sGet(env, "market/indices.json");
  resp = new Response(JSON.stringify({updated: (d && d.updated) || null}), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" }
  });
  await cache.put(cacheKey, resp.clone());
  return resp;
}

export async function hStockQuote(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  if(!sym) return jerr("Symbol required", 400);
  const d = await sGet(env, "market/quotes.json");
  const q = d && d.by_symbol ? d.by_symbol[sym] : null;
  if(!q) return jerr("No data for "+sym, 404);
  return sJson(Object.assign({symbol:sym}, q));
}

export async function hStockOhlcv(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const u = new URL(request.url);
  const sym = (u.searchParams.get("symbol")||"").toUpperCase();
  const count = Math.max(10, Math.min(parseInt(u.searchParams.get("count")||"120",10)||120, 500));
  const iv = u.searchParams.get("interval")||"1D";
  if(!sym) return jerr("Symbol required", 400);
  // Premium: intraday intervals
  if(iv==="1H" || iv==="15m"){
    try{
      const {getActivePlan, getUser} = await import('./auth.js');
      const usr = await getUser(env, s.email);
      if(getActivePlan(usr).plan === 'free') return jerr("Premium feature: intraday charts. Upgrade to continue.", 402);
    }catch(e){ if(e.status===402) throw e; }
  }
  let d;
  if(iv==="1D"){
    d = await sGet(env, "market/ohlcv/"+sym+".json");
  }else if(iv==="1H" || iv==="15m"){
    d = await sGet(env, "market/intraday/"+sym+"_"+iv+".json");
  }else{
    return jerr("Invalid interval (1D/1H/15m)", 400);
  }
  if(!d) return jerr("No data for "+sym+" ("+iv+")", 404);
  let indicators = null;
  if(iv==="1D"){
    try{
      const ind = await sGet(env, "market/indicators/"+sym+".json");
      if(ind && ind.rows) indicators = ind.rows.slice(-count);
    }catch(e){ /* indicators optional */ }
  }
  return sJson({symbol:sym, interval:iv, rows:d.rows.slice(-count), count:d.rows.length, updated:d.updated, indicators});
}

export async function hStockSymbols(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/symbols.json", 3600); // 1h cache (symbols rarely change)
}

export async function hStockScreener(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const u = new URL(request.url);
  const d = await sGet(env, "market/screener.json");
  let rows = (d && d.rows) || [];
  const ex = (u.searchParams.get("exchange")||"").toUpperCase();
  const minP = parseFloat(u.searchParams.get("min_pct")), maxP = parseFloat(u.searchParams.get("max_pct"));
  const minV = parseFloat(u.searchParams.get("min_volume")), minVal = parseFloat(u.searchParams.get("min_value"));
  if(ex) rows = rows.filter(r=>(r.exchange||"").toUpperCase()===ex);
  if(!isNaN(minP)) rows = rows.filter(r=>r.pct_change!=null && r.pct_change>=minP);
  if(!isNaN(maxP)) rows = rows.filter(r=>r.pct_change!=null && r.pct_change<=maxP);
  if(!isNaN(minV)) rows = rows.filter(r=>(r.volume||0)>=minV);
  if(!isNaN(minVal)) rows = rows.filter(r=>(r.value_vnd||0)>=minVal);
  const sort = u.searchParams.get("sort")||"value_vnd", order = u.searchParams.get("order")||"desc";
  rows = [...rows].sort((a,b)=>{ const av=a[sort]??-1e18, bv=b[sort]??-1e18; return order==="asc"? av-bv : bv-av; });
  return sJson({updated:d?d.updated:null, count:rows.length, rows:rows.slice(0,500)});
}

export async function hStockScreener2(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const u = new URL(request.url);
  const sc = await sGet(env, "market/screener.json");
  const fd = await sGet(env, "market/fundamentals.json");
  const q = await sGet(env, "market/quotes.json");
  let rows = (sc && sc.rows) || [];
  const funds = (fd && fd.by_symbol) || {};
  const closes = {};
  if(q && q.by_symbol) for(const k of Object.keys(q.by_symbol)) closes[k]=q.by_symbol[k].close;
  const ex = (u.searchParams.get("exchange")||"").toUpperCase();
  if(ex) rows = rows.filter(r=>(r.exchange||"").toUpperCase()===ex);
  rows = sScoreRows(rows.map(r=>Object.assign({},r)), funds, closes);
  const minS = parseFloat(u.searchParams.get("min_score"));
  if(!isNaN(minS)) rows = rows.filter(r=>r.score!=null && r.score>=minS);
  rows.sort((a,b)=>(b.score??-1)-(a.score??-1));
  return sJson({updated:sc?sc.updated:null, count:rows.length, rows:rows.slice(0,500)});
}

export async function hStockFundamentals(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  if(!sym) return jerr("Symbol required", 400);
  const d = await sGet(env, "market/fundamentals.json");
  const f = d && d.by_symbol ? d.by_symbol[sym] : null;
  if(!f) return jerr("No data for "+sym, 404);
  return sJson(Object.assign({symbol:sym}, f));
}

export async function hStockNews(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  const d = await sGet(env, "market/news/"+sym+".json");
  return sJson(d || {symbol:sym, items:[], updated:null});
}

export async function hStockEvents(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  const d = await sGet(env, "market/events/"+sym+".json");
  return sJson(d || {symbol:sym, items:[], updated:null});
}

export async function hStockBacktest(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  try{
    const {getActivePlan, getUser} = await import('./auth.js');
    const usr = await getUser(env, s.email);
    if(getActivePlan(usr).plan === 'free') return jerr("Premium feature: backtest. Upgrade to continue.", 402);
  }catch(e){ if(e.status===402) throw e; }
  const u = new URL(request.url);
  const sym = (u.searchParams.get("symbol")||"").toUpperCase();
  if(!sym) return jerr("Symbol required", 400);
  const fast = Math.max(2, Math.min(parseInt(u.searchParams.get("fast")||"20",10)||20, 200));
  const slow = Math.max(fast+1, Math.min(parseInt(u.searchParams.get("slow")||"50",10)||50, 300));
  const d = await sGet(env, "market/ohlcv/"+sym+".json");
  if(!d || !d.rows.length) return jerr("No data for "+sym, 404);
  const rows = d.rows.slice(-500);
  const closes = rows.map(r=>r.c), times = rows.map(r=>r.t);
  if(closes.length < slow+5) return jerr("Not enough data", 400);
  return sJson(Object.assign({symbol:sym, fast, slow}, sBacktest(closes, times, fast, slow)));
}

export async function hStockCompare(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const u = new URL(request.url);
  const syms = (u.searchParams.get("symbols")||"").toUpperCase().split(",").map(x=>x.trim()).filter(Boolean).slice(0,5);
  if(!syms.length) return jerr("Symbol required", 400);
  const count = Math.max(10, Math.min(parseInt(u.searchParams.get("count")||"120",10)||120, 500));
  const out = {};
  for(const sym of syms){
    const d = await sGet(env, "market/ohlcv/"+sym+".json");
    if(!d) continue;
    const rows = d.rows.slice(-count);
    const base = rows[0].c;
    out[sym] = rows.map(r=>({t:r.t, v: base? Math.round(r.c/base*10000)/100-100 : 0}));
  }
  return sJson({series:out});
}


/* ---------- user data (theo email) ---------- */
// D1-based user data (replaces R2 uGet/uPut)
export async function uGet(env, email, name, fallback){
  if(!env.DB) return fallback; // fallback to R2 if D1 not bound
  try{
    if(name === "watchlist"){
      const r = await env.DB.prepare("SELECT symbol FROM watchlist WHERE email = ? ORDER BY added_at").bind(email).all();
      return r.results.map(x=>x.symbol);
    }
    if(name === "portfolio"){
      const r = await env.DB.prepare("SELECT * FROM portfolio_txns WHERE email = ? ORDER BY date, id").bind(email).all();
      return {txns: r.results.map(x=>({id:x.id, symbol:x.symbol, side:x.side, price:x.price, qty:x.qty, fee:x.fee, note:x.note, date:x.date}))};
    }
    if(name === "alerts"){
      const r = await env.DB.prepare("SELECT * FROM alerts WHERE email = ? AND active = 1 ORDER BY id").bind(email).all();
      return r.results.map(x=>({id:x.id, symbol:x.symbol, direction:x.direction, price:x.price, active:x.active}));
    }
    if(name === "targets"){
      const r = await env.DB.prepare("SELECT * FROM targets WHERE email = ?").bind(email).all();
      return r.results.map(x=>({symbol:x.symbol, take_profit_pct:x.take_profit_pct, stop_loss_pct:x.stop_loss_pct, tp_done:!!x.tp_done, sl_done:!!x.sl_done}));
    }
    return fallback;
  }catch(e){ return fallback; }
}

export async function uPut(env, email, name, val){
  // uPut is deprecated for D1 - use specific functions below
  // Kept for compatibility, falls back to R2
  return sPut(env, SKEY(email)+name+".json", val);
}

// D1-specific write functions
export async function d1WatchAdd(env, email, symbol){
  await env.DB.prepare("INSERT OR IGNORE INTO watchlist (email, symbol, added_at) VALUES (?, ?, ?)")
    .bind(email, symbol.toUpperCase(), Date.now()).run();
}
export async function d1WatchDel(env, email, symbol){
  await env.DB.prepare("DELETE FROM watchlist WHERE email = ? AND symbol = ?")
    .bind(email, symbol.toUpperCase()).run();
}
export async function d1TxnAdd(env, email, t){
  const r = await env.DB.prepare("INSERT INTO portfolio_txns (email, symbol, side, price, qty, fee, note, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(email, t.symbol, t.side, t.price, t.qty, t.fee||0, t.note||null, t.date, Date.now()).run();
  return r.meta.last_row_id;
}
export async function d1TxnDel(env, email, id){
  await env.DB.prepare("DELETE FROM portfolio_txns WHERE email = ? AND id = ?").bind(email, id).run();
}
export async function d1TxnUpdateNote(env, email, id, note){
  await env.DB.prepare("UPDATE portfolio_txns SET note = ? WHERE email = ? AND id = ?").bind(note, email, id).run();
}
export async function d1AlertAdd(env, email, symbol, direction, price){
  const r = await env.DB.prepare("INSERT INTO alerts (email, symbol, direction, price, active, created_at) VALUES (?, ?, ?, ?, 1, ?)")
    .bind(email, symbol.toUpperCase(), direction, price, Date.now()).run();
  return r.meta.last_row_id;
}
export async function d1AlertDel(env, email, id){
  // Get symbol before delete for index cleanup
  const r = await env.DB.prepare("SELECT symbol FROM alerts WHERE email = ? AND id = ?").bind(email, id).first();
  await env.DB.prepare("DELETE FROM alerts WHERE email = ? AND id = ?").bind(email, id).run();
  return r ? r.symbol : null;
}
export async function d1TargetSet(env, email, symbol, tp_pct, sl_pct){
  // Preserve existing TP/SL when only one side is updated; keep done flags
  await env.DB.prepare(`INSERT INTO targets (email, symbol, take_profit_pct, stop_loss_pct, tp_done, sl_done)
    VALUES (?, ?, ?, ?, 0, 0)
    ON CONFLICT(email, symbol) DO UPDATE SET
      take_profit_pct = COALESCE(excluded.take_profit_pct, targets.take_profit_pct),
      stop_loss_pct = COALESCE(excluded.stop_loss_pct, targets.stop_loss_pct)`)
    .bind(email, symbol.toUpperCase(), tp_pct, sl_pct).run();
}
export async function d1TargetDel(env, email, symbol){
  await env.DB.prepare("DELETE FROM targets WHERE email = ? AND symbol = ?").bind(email, symbol.toUpperCase()).run();
}

// Index: alerts by symbol for fast lookup (used by alert checker)
// Key: index/alerts_by_symbol/{SYM}.json -> [{email, id, direction, price}]
export async function idxAlertsAdd(env, symbol, entry){
  const key = "index/alerts_by_symbol/"+symbol+".json";
  const {data, etag} = await sGetWithEtag(env, key);
  const arr = data || [];
  // Remove existing entry for same email+id (idempotent)
  const filtered = arr.filter(x=>!(x.email===entry.email && x.id===entry.id));
  filtered.push(entry);
  // Retry on conflict (max 3)
  for(let i=0;i<3;i++){
    const ok = await sPutIfMatch(env, key, filtered, i===0?etag:null);
    if(ok) return true;
    // Reload and retry
    const r2 = await sGetWithEtag(env, key);
    const arr2 = r2.data || [];
    const f2 = arr2.filter(x=>!(x.email===entry.email && x.id===entry.id));
    f2.push(entry);
    const ok2 = await sPutIfMatch(env, key, f2, r2.etag);
    if(ok2) return true;
  }
  // Fallback: blind write
  await sPut(env, key, filtered);
  return true;
}
export async function idxAlertsDel(env, symbol, email, alertId){
  const key = "index/alerts_by_symbol/"+symbol+".json";
  const {data, etag} = await sGetWithEtag(env, key);
  if(!data) return true;
  const filtered = data.filter(x=>!(x.email===email && x.id===alertId));
  if(filtered.length === data.length) return true; // nothing to remove
  if(filtered.length === 0){
    // Delete empty index key
    try{ await env.DATA.delete("stock/"+key); }catch(e){}
    return true;
  }
  await sPutIfMatch(env, key, filtered, etag);
  return true;
}


export async function hWatchlistGet(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return sJson(await uGet(env, s.email, "watchlist", []));
}

export async function hWatchlistAdd(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const body = await request.json().catch(()=>({}));
  const sym = String(body.symbol||"").toUpperCase().trim();
  if(!/^[A-Z]{3,10}$/.test(sym)) return jerr("Invalid symbol", 400);
  // Free limit: 5 symbols
  try{
    const {checkFeature} = await import('./billing.js');
    const chk = await checkFeature(request, env, 'watchlist_add');
    if(chk.err) return chk.err;
    const {getActivePlan} = await import('./auth.js');
    if(getActivePlan(chk.user).plan === 'free'){
      const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM watchlist WHERE email=?").bind(s.email).first();
      if(cnt.c >= 5) return jerr("Free limit: 5 symbols. Upgrade for unlimited.", 402);
    }
  }catch(e){ if(e.status===402) return e; }
  await d1WatchAdd(env, s.email, sym);
  return sJson({ok:true, watchlist: await uGet(env, s.email, "watchlist", [])});
}

export async function hWatchlistDel(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = decodeURIComponent(new URL(request.url).pathname.split("/").pop()).toUpperCase();
  await d1WatchDel(env, s.email, sym);
  return sJson({ok:true, watchlist: await uGet(env, s.email, "watchlist", [])});
}

export async function hPortfolio(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const pf = await uGet(env, s.email, "portfolio", {txns:[]});
  const calc = sCalcPositions(pf.txns||[]);
  const pos = calc.pos, realized = calc.realized;
  const q = await sGet(env, "market/quotes.json");
  const byQ = (q && q.by_symbol) || {};
  const positions=[]; let totalMv=0, totalCost=0;
  for(const sym of Object.keys(pos)){
    const p = pos[sym];
    if(p.qty <= 1e-9) continue;
    const qq = byQ[sym]||{};
    const cur = qq.close != null ? qq.close : null;
    const avg = p.cost/p.qty;
    const mv = cur!=null ? cur*p.qty : null;
    const unrl = cur!=null ? (cur-avg)*p.qty : null;
    positions.push({symbol:sym, qty:Math.round(p.qty*100)/100, avg_cost:Math.round(avg*100)/100,
      current:cur, market_value: mv!=null?Math.round(mv):null,
      unrealized: unrl!=null?Math.round(unrl):null,
      unrealized_pct: unrl!=null&&p.cost? Math.round(unrl/p.cost*10000)/100 : null,
      realized:Math.round(realized[sym]||0)});
    if(mv) totalMv+=mv; totalCost+=p.cost;
  }
  for(const x of positions) x.allocation = x.market_value&&totalMv? Math.round(x.market_value/totalMv*1000)/10 : null;
  positions.sort((a,b)=>(b.market_value||0)-(a.market_value||0));
  return sJson({positions, total_market_value:Math.round(totalMv), total_cost:Math.round(totalCost),
    total_unrealized:Math.round(positions.reduce((a,x)=>a+(x.unrealized||0),0)),
    total_realized:Math.round(Object.values(realized).reduce((a,b)=>a+b,0)), txns:pf.txns||[]});
}

export async function hTxnAdd(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const b = await request.json().catch(()=>({}));
  const sym = String(b.symbol||"").toUpperCase().trim();
  const side = String(b.side||"").toUpperCase();
  const price = parseFloat(b.price), qty = parseFloat(b.qty);
  let fee = b.fee==null ? null : parseFloat(b.fee);
  const date = String(b.date||""), note = String(b.note||"").slice(0,500);
  if(!/^[A-Z]{3,10}$/.test(sym)) return jerr("Invalid symbol", 400);
  if(side!=="BUY" && side!=="SELL") return jerr("side must be BUY/SELL", 400);
  if(!(price>0) || !(qty>0)) return jerr("Price/qty must be > 0", 400);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jerr("Date must be YYYY-MM-DD", 400);
  if(fee==null) fee = sAutoFee(side, price, qty);
  if(!(fee>=0)) return jerr("Fee must be >= 0", 400);
  const pf = await uGet(env, s.email, "portfolio", {txns:[]});
  const txns = pf.txns||[];
  if(side==="SELL"){
    const held = (sCalcPositions(txns).pos[sym]||{qty:0}).qty;
    if(qty > held+1e-9) return jerr("Sell "+qty+" "+sym+" exceeds holding "+held+".", 400);
  }
  const id = await d1TxnAdd(env, s.email, {symbol:sym, side, price, qty, fee:Math.round(fee*100)/100, date, note});
  return sJson({id, fee:Math.round(fee*100)/100});
}

export async function hTxnDel(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const id = parseInt(new URL(request.url).pathname.split("/").pop(),10);
  await d1TxnDel(env, s.email, id);
  return sJson({ok:true});
}

export async function hTxnNote(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const id = parseInt(new URL(request.url).pathname.split("/").pop(),10);
  const b = await request.json().catch(()=>({}));
  await d1TxnUpdateNote(env, s.email, id, String(b.note||"").slice(0,500));
  return sJson({ok:true});
}

export async function hCostHistory(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  const pf = await uGet(env, s.email, "portfolio", {txns:[]});
  const txns = (pf.txns||[]).filter(t=>t.symbol===sym).sort((a,b)=> a.date<b.date?-1:a.date>b.date?1:a.id-b.id);
  if(!txns.length) return jerr("No transactions", 404);
  let qty=0, cost=0; const events=[];
  for(const t of txns){
    if(t.side==="BUY"){ qty+=t.qty; cost+=t.price*t.qty+t.fee; }
    else{ const avg=qty?cost/qty:0; qty-=t.qty; cost-=avg*t.qty; }
    if(qty>1e-9) events.push([t.date, Math.round(cost/qty*100)/100]);
  }
  if(!events.length) return sJson({symbol:sym, series:[]});
  const d = await sGet(env, "market/ohlcv/"+sym+".json");
  const rows = ((d&&d.rows)||[]).filter(r=>r.t>=events[0][0]);
  const series=[]; let ei=0, curAvg=events[0][1];
  for(const r of rows){
    while(ei<events.length && events[ei][0]<=r.t){ curAvg=events[ei][1]; ei++; }
    series.push({time:r.t, avg:curAvg, close:r.c});
  }
  return sJson({symbol:sym, series, events:events.map(e=>({date:e[0], avg:e[1]}))});
}

export async function hAlertsGet(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return sJson(await uGet(env, s.email, "alerts", []));
}

export async function hAlertsAdd(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const b = await request.json().catch(()=>({}));
  const sym = String(b.symbol||"").toUpperCase().trim();
  const dir = String(b.direction||"").toUpperCase();
  const price = parseFloat(b.price);
  if(!/^[A-Z]{3,10}$/.test(sym)) return jerr("Invalid symbol", 400);
  if(dir!=="ABOVE" && dir!=="BELOW") return jerr("direction must be ABOVE/BELOW", 400);
  if(!(price>0)) return jerr("Price must be > 0", 400);
  // Free limit: 3 alerts
  try{
    const {getActivePlan} = await import('./auth.js');
    const {getUser} = await import('./auth.js');
    const u = await getUser(env, s.email);
    if(getActivePlan(u).plan === 'free'){
      const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM alerts WHERE email=?").bind(s.email).first();
      if(cnt.c >= 3) return jerr("Free limit: 3 alerts. Upgrade for unlimited.", 402);
    }
  }catch(e){ if(e.status===402) throw e; }
  const id = await d1AlertAdd(env, s.email, sym, dir, price);
  // Update index (keep for backward compat, will be removed)
  await idxAlertsAdd(env, sym, {email: s.email, id, direction: dir, price});
  return sJson({id});
}

export async function hAlertsDel(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const id = parseInt(new URL(request.url).pathname.split("/").pop(),10);
  const symbol = await d1AlertDel(env, s.email, id);
  // Update index
  if(symbol) await idxAlertsDel(env, symbol, s.email, id);
  return sJson({ok:true});
}

// Internal: get all alerts for a symbol (for alert checker cron) - D1 version
export async function hAlertsBySymbol(request, env){
  // Require internal secret
  const auth = request.headers.get("X-Internal-Secret");
  if(auth !== env.STOCK_PUBLISH_SECRET) return jerr("Forbidden", 403);
  const sym = new URL(request.url).searchParams.get("symbol");
  if(!sym) return jerr("Missing symbol", 400);
  const r = await env.DB.prepare("SELECT email, id, direction, price FROM alerts WHERE symbol = ? AND active = 1")
    .bind(sym.toUpperCase()).all();
  return sJson(r.results);
}
export async function hTargetsGet(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const tg = await uGet(env, s.email, "targets", []);
  const pf = await uGet(env, s.email, "portfolio", {txns:[]});
  const pos = sCalcPositions(pf.txns||[]).pos;
  const q = await sGet(env, "market/quotes.json");
  const byQ = (q && q.by_symbol) || {};
  return sJson(tg.map(t=>{
    const p = pos[t.symbol]; let unreal=null, cur=null;
    if(p && p.qty>1e-9){
      cur = byQ[t.symbol] ? byQ[t.symbol].close : null;
      if(cur!=null){ const avg=p.cost/p.qty; unreal = Math.round((cur-avg)/avg*10000)/100; }
    }
    return Object.assign({}, t, {unrealized_pct:unreal, current:cur});
  }));
}

export async function hTargetsSet(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const b = await request.json().catch(()=>({}));
  const sym = String(b.symbol||"").toUpperCase().trim();
  const tp = b.take_profit_pct==null?null:parseFloat(b.take_profit_pct);
  const sl = b.stop_loss_pct==null?null:parseFloat(b.stop_loss_pct);
  if(!/^[A-Z]{3,10}$/.test(sym)) return jerr("Invalid symbol", 400);
  if(tp==null && sl==null) return jerr("At least one target required", 400);
  if(tp!=null && !(tp>0 && tp<=1000)) return jerr("Take profit: 0-1000%", 400);
  if(sl!=null && !(sl>0 && sl<=100)) return jerr("Stop loss: 0-100%", 400);
  // Free limit: 3 targets
  try{
    const {getActivePlan, getUser} = await import('./auth.js');
    const u = await getUser(env, s.email);
    if(getActivePlan(u).plan === 'free'){
      const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM targets WHERE email=?").bind(s.email).first();
      if(cnt.c >= 3) return jerr("Free limit: 3 targets. Upgrade for unlimited.", 402);
    }
  }catch(e){ if(e.status===402) throw e; }
  await d1TargetSet(env, s.email, sym, tp, sl);
  return sJson({ok:true});
}

export async function hTargetsDel(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = decodeURIComponent(new URL(request.url).pathname.split("/").pop()).toUpperCase();
  await d1TargetDel(env, s.email, sym);
  return sJson({ok:true});
}


/* ---------- PIN lock (UI-only, 4-6 digits, SHA-256 hash) ---------- */
export async function sha256hex(str){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("stockpin:"+str));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

export async function d1PinGet(env, email){
  const r = await env.DB.prepare("SELECT pin_hash FROM pins WHERE email = ?").bind(email).first();
  return r ? r.pin_hash : null;
}
export async function d1PinSet(env, email, hash){
  await env.DB.prepare("INSERT OR REPLACE INTO pins (email, pin_hash, created_at) VALUES (?, ?, ?)")
    .bind(email, hash, Date.now()).run();
}
export async function d1PinDel(env, email){
  await env.DB.prepare("DELETE FROM pins WHERE email = ?").bind(email).run();
}

export async function hPinStatus(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const h = await d1PinGet(env, s.email);
  return sJson({has_pin: !!h});
}

export async function hPinSet(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const b = await request.json().catch(()=>({}));
  const pin = String(b.pin||"");
  if(!/^\d{4,6}$/.test(pin)) return jerr("PIN must be 4-6 digits", 400);
  const curHash = await d1PinGet(env, s.email);
  if(curHash){
    const oldPin = String(b.old_pin||"");
    if(await sha256hex(oldPin)!==curHash) return jerr("Current PIN incorrect", 403);
  }
  await d1PinSet(env, s.email, await sha256hex(pin));
  return sJson({ok:true});
}

export async function hPinVerify(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const b = await request.json().catch(()=>({}));
  const curHash = await d1PinGet(env, s.email);
  if(!curHash) return sJson({ok:true}); // no PIN set
  const ok = await sha256hex(String(b.pin||""))===curHash;
  return sJson({ok});
}

export async function hPinDel(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  await d1PinDel(env, s.email);
  return sJson({ok:true});
}


/* ---------- VM day snapshot len (secret, khong can session) ---------- */
export async function hStockPublish(request, env){
  const got = request.headers.get("X-Publish-Secret") || "";
  if(!env.STOCK_PUBLISH_SECRET || got !== env.STOCK_PUBLISH_SECRET) return jerr("Forbidden", 403);
  let body;
  try{ body = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const now = new Date().toISOString();
  let n = 0;
  const put1 = async (key, val)=>{
    if(val===undefined) return;
    await sPut(env, "market/"+key+".json", Object.assign({updated:now}, val));
    n++;
  };
  if(body.indices) await put1("indices", {rows:body.indices});
  if(body.quotes) await put1("quotes", {by_symbol:body.quotes});
  if(body.screener) await put1("screener", {rows:body.screener});
  if(body.fundamentals) await put1("fundamentals", {by_symbol:body.fundamentals});
  if(body.symbols) await put1("symbols", {rows:body.symbols});
  if(body.ohlcv) for(const sym of Object.keys(body.ohlcv)){
    await sPut(env, "market/ohlcv/"+sym+".json", {updated:now, rows:body.ohlcv[sym]});
    n++;
  }
  if(body.indicators) for(const sym of Object.keys(body.indicators)){
    await sPut(env, "market/indicators/"+sym+".json", {updated:now, rows:body.indicators[sym]});
    n++;
  }
  if(body.news) for(const sym of Object.keys(body.news)){
    await sPut(env, "market/news/"+sym+".json", {updated:now, symbol:sym, items:body.news[sym]});
    n++;
  }
  if(body.events) for(const sym of Object.keys(body.events)){
    await sPut(env, "market/events/"+sym+".json", {updated:now, symbol:sym, items:body.events[sym]});
    n++;
  }
  if(body.intraday) for(const key of Object.keys(body.intraday)){
    await sPut(env, "market/intraday/"+key+".json", {updated:now, rows:body.intraday[key]});
    n++;
  }
  // Push real-time update to Ably (fire-and-forget; skip if no key)
  if(env.ABLY_ROOT_KEY && n>0){
    try{
      const creds = btoa(env.ABLY_ROOT_KEY.trim() + ":");
      await fetch("https://rest.ably.io/channels/market/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Basic " + creds },
        body: JSON.stringify({ name: "update", data: JSON.stringify({updated: now, ts: Date.now()}) }),
      });
    }catch(e){ /* silent: publish already succeeded */ }
  }
  return sJson({ok:true, written:n});
}


/* ---------- internal: du lieu cho script bao cao Telegram ---------- */
export async function hStockReportData(request, env){
  const got = request.headers.get("X-Publish-Secret") || "";
  if(!env.STOCK_PUBLISH_SECRET || got !== env.STOCK_PUBLISH_SECRET) return jerr("Forbidden", 403);
  // List all emails with stock data from D1
  const userEmails = new Set();
  if(env.DB){
    for(const tbl of ["watchlist", "portfolio_txns", "alerts", "targets"]){
      const r = await env.DB.prepare(`SELECT DISTINCT email FROM ${tbl}`).all();
      for(const x of r.results) userEmails.add(x.email);
    }
  }
  const users = [];
  for(const email of userEmails){
    const [alerts, targets, portfolio, watchlist] = await Promise.all([
      uGet(env, email, "alerts", []),
      uGet(env, email, "targets", []),
      uGet(env, email, "portfolio", {txns:[]}),
      uGet(env, email, "watchlist", []),
    ]);
    const txns = (portfolio && portfolio.txns) || [];
    if(alerts.length || targets.length || txns.length || watchlist.length){
      users.push({email, alerts, targets, txns, watchlist});
    }
  }
  // Gia hien tai cho cac ma can thiet
  const symbols = new Set();
  for(const u of users){
    for(const a of u.alerts) symbols.add(a.symbol);
    for(const t of u.targets) symbols.add(t.symbol);
    for(const t of u.txns) symbols.add(t.symbol);
    for(const w of u.watchlist) symbols.add(w.symbol||w);
  }
  const quotes = {};
  const q = await sGet(env, "market/quotes.json");
  if(q && q.by_symbol){
    for(const sym of symbols){
      if(q.by_symbol[sym]) quotes[sym] = q.by_symbol[sym];
    }
  }
  return sJson({users, quotes});
}

export async function hStockAlertDone(request, env){
  const got = request.headers.get("X-Publish-Secret") || "";
  if(!env.STOCK_PUBLISH_SECRET || got !== env.STOCK_PUBLISH_SECRET) return jerr("Forbidden", 403);
  const b = await request.json().catch(()=>({}));
  const email = String(b.email||"").toLowerCase();
  const id = parseInt(b.id, 10);
  if(!email || !id) return jerr("email and id required", 400);
  await env.DB.prepare("UPDATE alerts SET active = 0 WHERE email = ? AND id = ?").bind(email, id).run();
  return sJson({ok:true});
}

export async function hStockTargetDone(request, env){
  const got = request.headers.get("X-Publish-Secret") || "";
  if(!env.STOCK_PUBLISH_SECRET || got !== env.STOCK_PUBLISH_SECRET) return jerr("Forbidden", 403);
  const b = await request.json().catch(()=>({}));
  const email = String(b.email||"").toLowerCase();
  const symbol = String(b.symbol||"").toUpperCase();
  const field = b.field; // "tp_done" or "sl_done"
  if(!email || !symbol || (field!=="tp_done" && field!=="sl_done")) return jerr("Bad params", 400);
  const tg = await uGet(env, email, "targets", []);
  const t = tg.find(x=>x.symbol===symbol);
  if(t){ t[field] = 1; await uPut(env, email, "targets", tg); }
  return sJson({ok:true});
}

// One-time migration: R2 -> D1 (protected by internal secret)
export async function hMigrateR2ToD1(request, env){
  const auth = request.headers.get("X-Internal-Secret");
  if(auth !== env.STOCK_PUBLISH_SECRET) return jerr("Forbidden", 403);
  if(!env.DB) return jerr("D1 not bound", 500);
  
  const stats = {users: 0, watchlist: 0, txns: 0, alerts: 0, targets: 0, pins: 0};
  
  // List all user emails from R2
  const userEmails = new Set();
  let cursor;
  do{
    const r = await env.DATA.list({prefix:"stock/users/", cursor});
    for(const o of r.objects){
      const parts = o.key.split("/");
      if(parts.length>=3) userEmails.add(parts[2]);
    }
    cursor = r.truncated ? r.cursor : null;
  }while(cursor);
  
  for(const email of userEmails){
    stats.users++;
    const [watchlist, portfolio, alerts, targets] = await Promise.all([
      uGet(env, email, "watchlist", []),
      uGet(env, email, "portfolio", {txns:[]}),
      uGet(env, email, "alerts", []),
      uGet(env, email, "targets", []),
    ]);
    // Check pin
    const pinData = await sGet(env, "users/"+email+"/pin.json").catch(()=>null);
    
    const now = Date.now();
    // Watchlist
    for(const w of watchlist){
      const sym = typeof w === 'string' ? w : (w.symbol || w);
      if(!sym) continue;
      await env.DB.prepare("INSERT OR IGNORE INTO watchlist (email, symbol, added_at) VALUES (?, ?, ?)")
        .bind(email, sym.toUpperCase(), now).run();
      stats.watchlist++;
    }
    // Portfolio txns
    for(const t of (portfolio.txns || [])){
      await env.DB.prepare("INSERT INTO portfolio_txns (email, symbol, side, price, qty, fee, note, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(email, t.symbol, t.side, t.price, t.qty, t.fee||0, t.note||null, t.date, now).run();
      stats.txns++;
    }
    // Alerts
    for(const a of alerts){
      await env.DB.prepare("INSERT INTO alerts (email, symbol, direction, price, active, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(email, a.symbol, a.direction, a.price, a.active?1:0, now).run();
      stats.alerts++;
    }
    // Targets
    for(const t of targets){
      await env.DB.prepare("INSERT OR REPLACE INTO targets (email, symbol, take_profit_pct, stop_loss_pct, tp_done, sl_done) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(email, t.symbol, t.take_profit_pct||null, t.stop_loss_pct||null, t.tp_done?1:0, t.sl_done?1:0).run();
      stats.targets++;
    }
    // Pin
    if(pinData && pinData.pin_hash){
      await env.DB.prepare("INSERT OR REPLACE INTO pins (email, pin_hash, created_at) VALUES (?, ?, ?)")
        .bind(email, pinData.pin_hash, now).run();
      stats.pins++;
    }
  }
  
  return sJson({ok: true, stats});
}
