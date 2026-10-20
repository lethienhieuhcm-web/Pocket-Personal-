import { jerr, sJson } from './utils.js';
import { getSession } from './auth.js';
import { drizzle } from "drizzle-orm/d1";
import { eq, and, asc, sql } from "drizzle-orm";
import { watchlist, portfolioTxns, alerts, targets, ruleAlerts } from "./schema.js";

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

// Tu chu: market regime (scripts/market_regime.py) + signals (scripts/signal_detector.py)
export async function hStockRegime(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/regime.json", 300);
}
export async function hStockSignals(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/signals.json", 300);
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

/* ---- Data accessors (extracted for stock_agent reuse) ---- */
export async function getQuoteData(env, sym){
  sym = String(sym||"").toUpperCase();
  if(!sym) return null;
  const d = await sGet(env, "market/quotes.json");
  const q = d && d.by_symbol ? d.by_symbol[sym] : null;
  if(!q) return null;
  // Include data timestamp so AI can state which trading session the data is from
  return Object.assign({symbol:sym, data_updated:d.updated||null}, q);
}

export async function getFundamentalsData(env, sym){
  sym = String(sym||"").toUpperCase();
  if(!sym) return null;
  const d = await sGet(env, "market/fundamentals.json");
  const f = d && d.by_symbol ? d.by_symbol[sym] : null;
  return f ? Object.assign({symbol:sym}, f) : null;
}

export async function getStatementsData(env, sym){
  sym = String(sym||"").toUpperCase();
  if(!sym) return null;
  const d = await sGet(env, "market/statements/"+sym+".json");
  return d || null;
}

export async function getNewsData(env, sym, limit){
  sym = String(sym||"").toUpperCase();
  if(!sym) return {symbol:sym, items:[], updated:null};
  const d = await sGet(env, "market/news/"+sym+".json");
  const out = d || {symbol:sym, items:[], updated:null};
  if(limit && out.items && out.items.length > limit){
    out.items = out.items.slice(0, limit);
  }
  return out;
}

export async function getOhlcvSummary(env, sym, count){
  sym = String(sym||"").toUpperCase();
  if(!sym) return null;
  count = Math.max(10, Math.min(parseInt(count||60,10)||60, 120));
  const d = await sGet(env, "market/ohlcv/"+sym+".json");
  if(!d || !d.rows || !d.rows.length) return null;
  const rows = d.rows.slice(-count);
  const closes = rows.map(r=>r.c).filter(v=>typeof v==="number");
  if(!closes.length) return null;
  const latest = rows[rows.length-1];
  const first = rows[0];
  const highs = rows.map(r=>r.h).filter(v=>typeof v==="number");
  const lows = rows.map(r=>r.l).filter(v=>typeof v==="number");
  const vols = rows.map(r=>r.v).filter(v=>typeof v==="number");
  const chg = first.c ? ((latest.c - first.c)/first.c*100) : 0;
  // Simple trend: compare last 5 vs first 5 closes
  const n = Math.min(5, closes.length);
  const recentAvg = closes.slice(-n).reduce((a,b)=>a+b,0)/n;
  const earlyAvg = closes.slice(0,n).reduce((a,b)=>a+b,0)/n;
  const trend = recentAvg > earlyAvg ? "up" : (recentAvg < earlyAvg ? "down" : "flat");
  return {
    symbol: sym,
    count: rows.length,
    period_days: rows.length,
    latest: {date: latest.t, open: latest.o, high: latest.h, low: latest.l, close: latest.c, volume: latest.v},
    change_pct: Math.round(chg*100)/100,
    high_max: highs.length ? Math.max(...highs) : null,
    low_min: lows.length ? Math.min(...lows) : null,
    avg_volume: vols.length ? Math.round(vols.reduce((a,b)=>a+b,0)/vols.length) : null,
    trend: trend,
    closes: closes.slice(-30), // last 30 for sparkline, not full 300
    updated: d.updated || null
  };
}

export async function hStockQuote(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  if(!sym) return jerr("Symbol required", 400);
  const q = await getQuoteData(env, sym);
  if(!q) return jerr("No data for "+sym, 404);
  return sJson(q);
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
  // Merge fundamentals (pe_ttm/pb/roe_ttm) + foreign net tu quotes vao tung row:
  // truoc day frontend doc cac field nay tu /screener nhung khong ai ghi -> luon "—".
  const out = rows.slice(0,500);
  try{
    const fd = await sGet(env, "market/fundamentals.json");
    const qt = await sGet(env, "market/quotes.json");
    const funds = (fd && fd.by_symbol) || {};
    const bySym = (qt && qt.by_symbol) || {};
    for(const r of out){
      const f = funds[r.symbol], q = bySym[r.symbol];
      if(f){
        if(f.eps>0 && r.close) r.pe_ttm = Math.round(r.close*1000/f.eps*100)/100;
        if(f.bvps>0 && r.close) r.pb = Math.round(r.close*1000/f.bvps*100)/100;
        if(f.roe!=null) r.roe_ttm = f.roe;
      }
      if(q && q.foreign_buy_value!=null && q.foreign_sell_value!=null)
        r.foreign_net_value = q.foreign_buy_value - q.foreign_sell_value;
    }
  }catch(e){}
  return sJson({updated:d?d.updated:null, count:rows.length, rows:out});
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
  // Quality filter BEFORE scoring (2026-10-09 20:41): filter penny stocks early to reduce CPU.
  // Scoring all 1149 rows then filtering caused 503 (CPU timeout).
  // r.close is in thousands VND, so >=10 means >=10,000 VND.
  const noQualityFilter = u.searchParams.get("all") === "1";
  if(!noQualityFilter){
    rows = rows.filter(r => (r.close||0) >= 10);
  }
  // Thorough fix (2026-10-09 20:43): only score top 200 by liquidity.
  // Frontend shows max 30, scoring 1000+ rows exceeds Worker CPU limit → 503.
  rows = [...rows].sort((a,b)=>((b.value_vnd||0)-(a.value_vnd||0))).slice(0,200);
  rows = sScoreRows(rows.map(r=>Object.assign({},r)), funds, closes);
  const minS = parseFloat(u.searchParams.get("min_score"));
  if(!isNaN(minS)) rows = rows.filter(r=>r.score!=null && r.score>=minS);
  // Filter no-PE after scoring (pe is calculated in sScoreRows)
  if(!noQualityFilter){
    rows = rows.filter(r => r.pe != null);
  }
  // Attach industry/roe/debt for frontend filters (cheap: only ~200 rows)
  for(const r of rows){
    const f = funds[r.symbol];
    if(!f) continue;
    if(f.industry) r.industry = f.industry;
    if(f.roe != null) r.roe = f.roe;
    if(f.debt_to_equity != null) r.debt_to_equity = f.debt_to_equity;
  }
  rows.sort((a,b)=>(b.score??-1)-(a.score??-1));
  return sJson({updated:sc?sc.updated:null, count:rows.length, rows:rows.slice(0,500)});
}

export async function hStockFundamentals(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  if(!sym) return jerr("Symbol required", 400);
  const f = await getFundamentalsData(env, sym);
  if(!f) return jerr("No data for "+sym, 404);
  // Frontend doc pe_ttm/pb/roe_ttm/roa_ttm/de_ratio — tinh/ghep tu eps/bvps/roe/roa/d2e
  // + gia hien tai (truoc day khong ai ghi cac field nay -> man chi tiet toan "—").
  try{
    const q = await getQuoteData(env, sym);
    const close = q && q.close;
    if(close){
      if(f.eps>0) f.pe_ttm = Math.round(close/f.eps*100)/100;
      if(f.bvps>0) f.pb = Math.round(close/f.bvps*100)/100;
    }
  }catch(e){}
  if(f.roe!=null) f.roe_ttm = f.roe;
  if(f.roa!=null) f.roa_ttm = f.roa;
  if(f.debt_to_equity!=null) f.de_ratio = f.debt_to_equity;
  return sJson(f);
}

export async function hStockStatements(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  if(!sym) return jerr("Symbol required", 400);
  const d = await getStatementsData(env, sym);
  if(!d) return jerr("No statements for "+sym, 404);
  return sJson(d);
}

export async function hStockNews(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  const d = await getNewsData(env, sym);
  return sJson(d);
}

/* Tin thi truong: gop tu top30 ma, dedupe, sort moi nhat (hoc FireAnt MarketNews) */
export async function hStockMarketNews(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/market_news.json", 900); // 15m cache
}

/* Foreign flow tu chu: tu price_board (thay Market().foreign_flow() bi khoa) */
export async function hStockForeignFlow(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/foreign_flow.json", 900); // 15m cache
}

/* Proprietary flow tu chu: tu PDF cua HOSE (thay Market().proprietary_flow() bi khoa) */
export async function hStockProprietaryFlow(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/proprietary_flow.json", 300); // 5m cache
}

/* Lich su proprietary flow theo ma: ?symbol=ACB&limit=30 */
export async function hStockProprietaryHistory(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const u = new URL(request.url);
  const sym = (u.searchParams.get("symbol")||"").toUpperCase();
  if(!sym) return jerr("Missing symbol", 400);
  const limit = Math.min(parseInt(u.searchParams.get("limit")||"30")||30, 500);
  const d = await sGet(env, "market/proprietary_flow_history/"+sym+".json");
  const rows = (d && d.rows) || [];
  // Tra ve moi nhat truoc, gioi han so luong
  return sJson({symbol:sym, count:rows.length, rows:rows.slice(-limit).reverse(),
    updated:d?d.updated:null});
}

/* Lich su foreign flow theo ma: ?symbol=ACB&limit=30 */
export async function hStockForeignHistory(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const u = new URL(request.url);
  const sym = (u.searchParams.get("symbol")||"").toUpperCase();
  if(!sym) return jerr("Missing symbol", 400);
  const limit = Math.min(parseInt(u.searchParams.get("limit")||"30")||30, 500);
  const d = await sGet(env, "market/foreign_flow_history/"+sym+".json");
  const rows = (d && d.rows) || [];
  return sJson({symbol:sym, count:rows.length, rows:rows.slice(-limit).reverse(),
    updated:d?d.updated:null});
}

export async function getCompanyProfile(env, sym){
  sym = String(sym||"").toUpperCase();
  if(!sym) return {symbol:sym};
  const d = await sGet(env, "market/company_profile/"+sym+".json");
  return d || {symbol:sym};
}

export async function hStockCompanyProfile(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  if(!sym) return jerr("Symbol required", 400);
  const d = await getCompanyProfile(env, sym);
  return sJson(d);
}

export async function hStockEvents(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  const d = await sGet(env, "market/events/"+sym+".json");
  return sJson(d || {symbol:sym, items:[], updated:null});
}

export async function hStockBacktest(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  // Backtest là tính năng stocks_full, 10 lượt/ngày (gói nhadautu).
  // Trước đây chỉ chặn gói free nên gói dilam (stocks_basic) lọt, và không đếm lượt.
  const {checkFeature, incrUsage} = await import('./billing.js');
  const chk = await checkFeature(request, env, 'stocks_backtest');
  if(chk.err) return chk.err;
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
  try{ await incrUsage(env, s.email, 'backtest_count', 1); }catch(e){}
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
    const db = drizzle(env.DB);
    if(name === "watchlist"){
      const rows = await db.select({ symbol: watchlist.symbol }).from(watchlist)
        .where(eq(watchlist.email, email)).orderBy(asc(watchlist.addedAt));
      return rows.map(x=>x.symbol);
    }
    if(name === "portfolio"){
      const rows = await db.select().from(portfolioTxns)
        .where(eq(portfolioTxns.email, email)).orderBy(asc(portfolioTxns.date), asc(portfolioTxns.id));
      return {txns: rows.map(x=>({id:x.id, symbol:x.symbol, side:x.side, price:x.price, qty:x.qty, fee:x.fee, note:x.note, date:x.date}))};
    }
    if(name === "alerts"){
      const rows = await db.select().from(alerts)
        .where(and(eq(alerts.email, email), eq(alerts.active, 1))).orderBy(asc(alerts.id));
      return rows.map(x=>({id:x.id, symbol:x.symbol, direction:x.direction, price:x.price, active:x.active}));
    }
    if(name === "targets"){
      const rows = await db.select().from(targets).where(eq(targets.email, email));
      return rows.map(x=>({symbol:x.symbol, take_profit_pct:x.takeProfitPct, stop_loss_pct:x.stopLossPct, tp_done:!!x.tpDone, sl_done:!!x.slDone}));
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
  const db = drizzle(env.DB);
  await db.insert(watchlist).values({ email, symbol: symbol.toUpperCase(), addedAt: Date.now() })
    .onConflictDoNothing({ target: [watchlist.email, watchlist.symbol] });
}
export async function d1WatchDel(env, email, symbol){
  const db = drizzle(env.DB);
  await db.delete(watchlist).where(and(eq(watchlist.email, email), eq(watchlist.symbol, symbol.toUpperCase())));
}
export async function d1TxnAdd(env, email, t){
  const db = drizzle(env.DB);
  const rows = await db.insert(portfolioTxns).values({
    email, symbol: t.symbol, side: t.side, price: t.price, qty: t.qty,
    fee: t.fee||0, note: t.note||null, date: t.date, createdAt: Date.now(),
  }).returning({ id: portfolioTxns.id });
  return rows[0]?.id;
}
export async function d1TxnDel(env, email, id){
  const db = drizzle(env.DB);
  await db.delete(portfolioTxns).where(and(eq(portfolioTxns.email, email), eq(portfolioTxns.id, id)));
}
export async function d1TxnUpdateNote(env, email, id, note){
  const db = drizzle(env.DB);
  await db.update(portfolioTxns).set({ note })
    .where(and(eq(portfolioTxns.email, email), eq(portfolioTxns.id, id)));
}
export async function d1AlertAdd(env, email, symbol, direction, price){
  const db = drizzle(env.DB);
  const rows = await db.insert(alerts).values({
    email, symbol: symbol.toUpperCase(), direction, price, active: 1, createdAt: Date.now(),
  }).returning({ id: alerts.id });
  return rows[0]?.id;
}
export async function d1AlertDel(env, email, id){
  // Get symbol before delete for index cleanup
  const db = drizzle(env.DB);
  const rows = await db.select({ symbol: alerts.symbol }).from(alerts)
    .where(and(eq(alerts.email, email), eq(alerts.id, id))).limit(1);
  await db.delete(alerts).where(and(eq(alerts.email, email), eq(alerts.id, id)));
  return rows[0] ? rows[0].symbol : null;
}
export async function d1TargetSet(env, email, symbol, tp_pct, sl_pct){
  // Preserve existing TP/SL when only one side is updated; keep done flags
  const db = drizzle(env.DB);
  await db.insert(targets).values({
    email, symbol: symbol.toUpperCase(),
    takeProfitPct: tp_pct, stopLossPct: sl_pct, tpDone: 0, slDone: 0,
  }).onConflictDoUpdate({
    target: [targets.email, targets.symbol],
    set: {
      takeProfitPct: sql`COALESCE(${tp_pct}, ${targets.takeProfitPct})`,
      stopLossPct: sql`COALESCE(${sl_pct}, ${targets.stopLossPct})`,
    },
  });
}
export async function d1TargetDel(env, email, symbol){
  const db = drizzle(env.DB);
  await db.delete(targets).where(and(eq(targets.email, email), eq(targets.symbol, symbol.toUpperCase())));
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
  // Đếm số mã hiện có để checkFeature so với hạn mức gói (kind "cap").
  // Trước đây không truyền usage nên gói trả phí không bao giờ bị chặn (Chốt 2026-10-11).
  // Check tay cũ ("Free limit: 5") là code chết: gói free không có app stocks nên
  // đã bị chặn ở checkFeature trước khi tới đó.
  let wlCount = 0;
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({ c: sql`COUNT(*)` }).from(watchlist).where(eq(watchlist.email, s.email));
    wlCount = Number(rows[0]?.c ?? 0);
  }catch(e){}
  const {checkFeature} = await import('./billing.js');
  const chk = await checkFeature(request, env, 'watchlist_add', {usage: {watchlist_count: wlCount}});
  if(chk.err) return chk.err;
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
  // Đếm số cảnh báo hiện có để checkFeature so với hạn mức gói (kind "cap").
  // Trước đây không truyền usage nên gói nhadautu (20 cảnh báo) không bao giờ bị
  // chặn, còn gói dilam (chỉ có stocks_basic) lọt qua dù alerts yêu cầu stocks_full.
  // Check tay cũ ("Free limit: 3") là code chết: gói free không có app stocks.
  let alCount = 0;
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({ c: sql`COUNT(*)` }).from(alerts).where(eq(alerts.email, s.email));
    alCount = Number(rows[0]?.c ?? 0);
  }catch(e){}
  const {checkFeature} = await import('./billing.js');
  const chk = await checkFeature(request, env, 'stocks_alert', {usage: {alerts_count: alCount}});
  if(chk.err) return chk.err;
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
  const db = drizzle(env.DB);
  const rows = await db.select({
    email: alerts.email, id: alerts.id, direction: alerts.direction, price: alerts.price,
  }).from(alerts).where(and(eq(alerts.symbol, sym.toUpperCase()), eq(alerts.active, 1)));
  return sJson(rows);
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
      const db = drizzle(env.DB);
      const rows = await db.select({ c: sql`COUNT(*)` }).from(targets).where(eq(targets.email, s.email));
      if((rows[0]?.c ?? 0) >= 3) return jerr("Free limit: 3 targets. Upgrade for unlimited.", 402);
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


/* ---------- VM day snapshot len (secret, khong can session) ---------- */
export async function hStockPublish(request, env){
  const got = request.headers.get("X-Publish-Secret") || "";
  if(!env.STOCK_PUBLISH_SECRET || got !== env.STOCK_PUBLISH_SECRET) return jerr("Forbidden", 403);
  let body;
  try{ body = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const now = new Date().toISOString();
  // Provenance: VM gui kem _prov {source, retrieved_at} trong moi chunk (hoc tu vnstock 5).
  // Giu lai vao moi file R2 de sau nay biet so lieu tu dau, luc nao.
  const prov = (body._prov && typeof body._prov === "object") ? body._prov : null;
  const doc = (o)=> prov ? Object.assign({updated:now, _prov:prov}, o) : Object.assign({updated:now}, o);
  let n = 0;
  const put1 = async (key, val)=>{
    if(val===undefined) return;
    await sPut(env, "market/"+key+".json", doc(val));
    n++;
  };
  if(body.indices) await put1("indices", {rows:body.indices});
  if(body.quotes) await put1("quotes", {by_symbol:body.quotes});
  if(body.screener) await put1("screener", {rows:body.screener});
  if(body.fundamentals) await put1("fundamentals", {by_symbol:body.fundamentals});
  if(body.symbols) await put1("symbols", {rows:body.symbols});
  if(body.ohlcv) for(const sym of Object.keys(body.ohlcv)){
    await sPut(env, "market/ohlcv/"+sym+".json", doc({rows:body.ohlcv[sym]}));
    n++;
  }
  if(body.indicators) for(const sym of Object.keys(body.indicators)){
    await sPut(env, "market/indicators/"+sym+".json", doc({rows:body.indicators[sym]}));
    n++;
  }
  if(body.news) for(const sym of Object.keys(body.news)){
    await sPut(env, "market/news/"+sym+".json", doc({symbol:sym, items:body.news[sym]}));
    n++;
  }
  if(body.statements) for(const sym of Object.keys(body.statements)){
    await sPut(env, "market/statements/"+sym+".json", doc(body.statements[sym]));
    n++;
  }
  if(body.market_news) await put1("market_news", {items:body.market_news});
  if(body.regime) await put1("regime", body.regime);
  if(body.signals) await put1("signals", {signals:body.signals});
  // Batch history upload cho backfill (nhanh hon nhieu so voi tung ngay)
  if(body.foreign_flow_history_batch){
    for(const sym of Object.keys(body.foreign_flow_history_batch)){
      const days = body.foreign_flow_history_batch[sym];
      if(!Array.isArray(days) || !days.length) continue;
      const hkey = "market/foreign_flow_history/"+sym+".json";
      const h = await sGet(env, hkey) || {rows:[]};
      const rows = h.rows || [];
      const byDate = {};
      for(const r of rows) if(r.trade_date) byDate[r.trade_date] = r;
      for(const d of days){
        if(!d.trade_date) continue;
        byDate[d.trade_date] = {
          trade_date:d.trade_date,
          buy_volume:d.buy_volume??null,
          sell_volume:d.sell_volume??null,
          net_volume:d.net_volume??null,
          buy_value_est:d.buy_value_est??null,
          sell_value_est:d.sell_value_est??null,
          net_value_est:d.net_value_est??null
        };
      }
      const merged = Object.values(byDate);
      merged.sort((a,b)=>(a.trade_date||"").localeCompare(b.trade_date||""));
      const trimmed = merged.slice(-500);
      await sPut(env, hkey, doc({symbol:sym, rows:trimmed}));
      n++;
    }
  }
  if(body.foreign_flow){
    await put1("foreign_flow", {by_symbol:body.foreign_flow});
    // Append lich su foreign flow theo tung ma
    // Ho tro backfill: neu payload co trade_date thi dung, khong thi dung today
    const defaultDate = new Date().toISOString().slice(0,10);
    for(const sym of Object.keys(body.foreign_flow)){
      const d = body.foreign_flow[sym];
      if(!d || d.buy_volume==null) continue;
      const tdate = d.trade_date || defaultDate;
      const hkey = "market/foreign_flow_history/"+sym+".json";
      const h = await sGet(env, hkey) || {rows:[]};
      const rows = h.rows || [];
      const idx = rows.findIndex(r=>r.trade_date===tdate);
      const entry = {trade_date:tdate, buy_volume:d.buy_volume, sell_volume:d.sell_volume,
        net_volume:d.net_volume, buy_value_est:d.buy_value_est||null,
        sell_value_est:d.sell_value_est||null, net_value_est:d.net_value_est||null};
      if(idx>=0) rows[idx] = entry; else rows.push(entry);
      // Sort theo ngay va giu 500 phien moi nhat
      rows.sort((a,b)=>(a.trade_date||"").localeCompare(b.trade_date||""));
      const trimmed = rows.slice(-500);
      await sPut(env, hkey, doc({symbol:sym, rows:trimmed}));
      n++;
    }
  }
  if(body.proprietary_flow){
    await put1("proprietary_flow", {by_symbol:body.proprietary_flow});
    // Append vao lich su theo tung ma (giu toi da 500 phien ~2 nam)
    for(const sym of Object.keys(body.proprietary_flow)){
      const d = body.proprietary_flow[sym];
      if(!d || d.buy_volume==null) continue;
      const hkey = "market/proprietary_flow_history/"+sym+".json";
      const h = await sGet(env, hkey) || {rows:[]};
      const rows = h.rows || [];
      // Tranh trung ngay (neu publish lai cung ngay thi update)
      const tdate = d.trade_date || "";
      const idx = rows.findIndex(r=>r.trade_date===tdate);
      const entry = {trade_date:tdate, buy_volume:d.buy_volume, sell_volume:d.sell_volume,
        net_volume:d.net_volume, buy_value_vnd:d.buy_value_vnd,
        sell_value_vnd:d.sell_value_vnd, net_value_vnd:d.net_value_vnd};
      if(idx>=0) rows[idx] = entry; else rows.push(entry);
      // Giu 500 phien moi nhat
      const trimmed = rows.slice(-500);
      await sPut(env, hkey, doc({symbol:sym, rows:trimmed}));
      n++;
    }
  }
  if(body.events) for(const sym of Object.keys(body.events)){
    await sPut(env, "market/events/"+sym+".json", doc({symbol:sym, items:body.events[sym]}));
    n++;
  }
  if(body.company_profile) for(const sym of Object.keys(body.company_profile)){
    await sPut(env, "market/company_profile/"+sym+".json", doc(Object.assign({symbol:sym}, body.company_profile[sym])));
    n++;
  }
  if(body.intraday) for(const key of Object.keys(body.intraday)){
    await sPut(env, "market/intraday/"+key+".json", doc({rows:body.intraday[key]}));
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


/* ---------- internal: Modal bao loi -> Telegram ---------- */
export async function hModalAlert(request, env){
  const got = request.headers.get("X-Publish-Secret") || "";
  if(!env.STOCK_PUBLISH_SECRET || got !== env.STOCK_PUBLISH_SECRET) return jerr("Forbidden", 403);
  let body;
  try{ body = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const token = env.TELEGRAM_BOT_TOKEN || "";
  const chatId = env.TELEGRAM_CHAT_ID || "";
  if(!token || !chatId) return jerr("Telegram not configured", 500);
  const when = body.time || new Date().toISOString();
  const text = "🚨 " + (body.fn || "modal-fn") + " thất bại (Modal)\n🕘 " + when + "\nChi tiết: " + (body.detail || "?");
  try{
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if(!r.ok) return jerr("Telegram send failed", 502);
  }catch(e){ return jerr("Telegram error", 502); }
  return sJson({ok:true});
}


/* ---------- internal: du lieu cho script bao cao Telegram ---------- */
export async function hStockReportData(request, env){
  const got = request.headers.get("X-Publish-Secret") || "";
  if(!env.STOCK_PUBLISH_SECRET || got !== env.STOCK_PUBLISH_SECRET) return jerr("Forbidden", 403);
  // List all emails with stock data from D1
  const userEmails = new Set();
  if(env.DB){
    const db = drizzle(env.DB);
    for(const [tbl, col] of [[watchlist, watchlist.email], [portfolioTxns, portfolioTxns.email], [alerts, alerts.email], [targets, targets.email]]){
      const rows = await db.selectDistinct({ email: col }).from(tbl);
      for(const x of rows) userEmails.add(x.email);
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
  const db = drizzle(env.DB);
  await db.update(alerts).set({ active: 0 }).where(and(eq(alerts.email, email), eq(alerts.id, id)));
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
  
  const stats = {users: 0, watchlist: 0, txns: 0, alerts: 0, targets: 0};
  
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
    const now = Date.now();
    const db = drizzle(env.DB);
    // Watchlist
    for(const w of watchlist){
      const sym = typeof w === 'string' ? w : (w.symbol || w);
      if(!sym) continue;
      await db.insert(watchlist).values({ email, symbol: sym.toUpperCase(), addedAt: now })
        .onConflictDoNothing({ target: [watchlist.email, watchlist.symbol] });
      stats.watchlist++;
    }
    // Portfolio txns
    for(const t of (portfolio.txns || [])){
      await db.insert(portfolioTxns).values({
        email, symbol: t.symbol, side: t.side, price: t.price, qty: t.qty,
        fee: t.fee||0, note: t.note||null, date: t.date, createdAt: now,
      });
      stats.txns++;
    }
    // Alerts
    for(const a of alerts){
      await db.insert(alerts).values({
        email, symbol: a.symbol, direction: a.direction, price: a.price,
        active: a.active?1:0, createdAt: now,
      });
      stats.alerts++;
    }
    // Targets
    for(const t of targets){
      await db.insert(targets).values({
        email, symbol: t.symbol,
        takeProfitPct: t.take_profit_pct||null, stopLossPct: t.stop_loss_pct||null,
        tpDone: t.tp_done?1:0, slDone: t.sl_done?1:0,
      }).onConflictDoUpdate({
        target: [targets.email, targets.symbol],
        set: {
          takeProfitPct: t.take_profit_pct||null, stopLossPct: t.stop_loss_pct||null,
          tpDone: t.tp_done?1:0, slDone: t.sl_done?1:0,
        },
      });
      stats.targets++;
    }
  }
  
  return sJson({ok: true, stats});
}

/* ================= stockui Dot B: risk + rule-alerts (tuchu) ================= */
/* Port risk_limits.py / trade_journal.py / risk_profile.py sang JS (D1/KV-backed). */

// FIFO stats — port trade_journal.get_closed_pnl + get_stats
function fifoStats(txns){
  const sorted = [...(txns||[])].sort((a,b)=> a.date<b.date?-1:a.date>b.date?1:(a.id||0)-(b.id||0));
  const lots = {}; const closed = [];
  for(const t of sorted){
    const sym = String(t.symbol||"").toUpperCase(); if(!sym) continue;
    lots[sym] = lots[sym]||[];
    if(t.side==="BUY"){ lots[sym].push({qty:t.qty, price:t.price}); }
    else{
      let need=t.qty, buyCost=0, buyQty=0;
      while(need>0 && lots[sym].length){
        const lot=lots[sym][0]; const take=Math.min(lot.qty,need);
        buyCost+=take*lot.price; buyQty+=take; lot.qty-=take; need-=take;
        if(lot.qty<=0) lots[sym].shift();
      }
      if(buyQty>0){
        const fee=t.fee||0; const pnl=buyQty*t.price-fee-buyCost;
        closed.push({symbol:sym, quantity:buyQty, buy_price:Math.round(buyCost/buyQty*100)/100,
          sell_price:t.price, sell_date:t.date, pnl:Math.round(pnl), pnl_pct:Math.round(pnl/buyCost*1e4)/100});
      }
    }
  }
  if(!closed.length) return {trades:0, note:"chua co vong chot"};
  const wins=closed.filter(c=>c.pnl>0), losses=closed.filter(c=>c.pnl<=0);
  const gw=wins.reduce((a,c)=>a+c.pnl,0), gl=-losses.reduce((a,c)=>a+c.pnl,0);
  return {
    trades: closed.length, wins: wins.length, losses: losses.length,
    win_rate_pct: Math.round(wins.length/closed.length*1e3)/10,
    total_pnl: Math.round(closed.reduce((a,c)=>a+c.pnl,0)),
    avg_win: wins.length?Math.round(gw/wins.length):0,
    avg_loss: losses.length?Math.round(gl/losses.length):0,
    profit_factor: gl>0?Math.round(gw/gl*100)/100:null,
  };
}

// Risk profile — port risk_profile.assess (chi dung trade_stats, khong co cau hoi)
function riskProfileAssess(tradeStats){
  let score=50; const reasons=[];
  if(tradeStats && (tradeStats.trades||0)>=5){
    const wr=tradeStats.win_rate_pct||50, pf=tradeStats.profit_factor||1.0;
    const adj=(wr-50)*0.3+(Math.min(pf,3.0)-1.0)*10;
    score+=adj*0.4;
    reasons.push(`lich su ${tradeStats.trades} vong: win rate ${wr}%, PF ${pf} -> ${adj>=0?"+":""}${adj.toFixed(1)}d`);
  }else reasons.push("chua du lich su (<5 vong), dung muc mac dinh");
  score=Math.max(0,Math.min(100,Math.round(score*10)/10));
  const lim={
    than_trong:{max_position_pct:10,stop_loss_pct:5,note:"Cat lo som, khong tap trung"},
    can_bang:{max_position_pct:15,stop_loss_pct:7,note:"Can bang giua giu va cat"},
    tang_truong:{max_position_pct:20,stop_loss_pct:10,note:"Cho room bien dong rong hon"},
    mao_hiem:{max_position_pct:25,stop_loss_pct:12,note:"Gioi han van can, tranh all-in"},
  };
  let profile, desc;
  if(score<30){profile="than_trong";desc="Uu tien bao toan von. Phu hop: trai phieu, bluechip co tuc cao, ty trong co phieu thap.";}
  else if(score<55){profile="can_bang";desc="Chap nhan bien dong vua phai. Phu hop: bluechip + midcap, ty trong co phieu 40-60%.";}
  else if(score<75){profile="tang_truong";desc="Huong toi tang truong dai han. Phu hop: co phieu tang truong, ty trong cao, chiu duoc drawdown 20-30%.";}
  else{profile="mao_hiem";desc="Tim loi nhuan cao, chiu rui ro lon. Phu hop: penny/midcap bien dong, margin co kiem soat.";}
  return {profile, score, mo_ta:desc, ly_do:reasons, goi_y_gioi_han:lim[profile]};
}

// GET /api/stock/risk — port risk_limits.check_limits
export async function hStockRisk(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const pf = await uGet(env, s.email, "portfolio", {txns:[]});
  const txns = pf.txns||[];
  const q = await sGet(env, "market/quotes.json");
  const byQ = (q && q.by_symbol)||{};
  const calc = sCalcPositions(txns);
  // Gioi han theo ho so rui ro cua user (risk_profile.goi_y_gioi_han);
  // chua co ho so thi dung mac dinh cu (20% / 7%).
  const stats0 = fifoStats(txns);
  const prof0 = riskProfileAssess(stats0);
  const lim0 = (prof0 && prof0.goi_y_gioi_han) || {};
  const MAXP = lim0.max_position_pct || 20, SLP = lim0.stop_loss_pct || 7, HEATW = 15;
  const violations=[], valued=[];
  let nav=0;
  for(const sym of Object.keys(calc.pos)){
    const p=calc.pos[sym]; if(!p.qty || p.qty<=1e-9) continue;
    const qq=byQ[sym]||{}; const close=qq.close;
    if(!(close>0)||!p.qty){
      violations.push({type:"no_price",symbol:sym,message:`${sym}: khong co gia hien tai, bo qua`,severity:"warn"});
      continue;
    }
    const mv=p.qty*close, cost=p.cost, pnl=mv-cost, pnl_pct=cost?(pnl/cost*100):0;
    nav+=mv;
    valued.push({symbol:sym,quantity:Math.round(p.qty*100)/100,avg_price:Math.round(cost/p.qty*100)/100,
      close,market_value:Math.round(mv),cost:Math.round(cost),pnl:Math.round(pnl),pnl_pct:Math.round(pnl_pct*100)/100});
  }
  if(nav<=0) return sJson({violations, summary:{nav:0,positions:0,heat_pct:0,note:"NAV = 0, nhap danh muc de xem"}, positions:[], stats:stats0, profile:prof0, limits:{max_position_pct:MAXP, stop_loss_pct:SLP, heat_pct:HEATW, source:"risk_profile"}});
  let heat=0;
  for(const v of valued){
    v.weight_pct=Math.round(v.market_value/nav*1e4)/100;
    if(v.weight_pct>MAXP) violations.push({type:"position_size",symbol:v.symbol,message:`${v.symbol}: ty trong ${v.weight_pct}% vuot gioi han ${MAXP}%`,severity:"high"});
    if(v.pnl_pct<=-SLP) violations.push({type:"stop_loss",symbol:v.symbol,message:`${v.symbol}: lo ${v.pnl_pct}% (von ${v.avg_price.toLocaleString("vi-VN")} -> ${v.close.toLocaleString("vi-VN")}), cham nguong ${SLP}%`,severity:"high"});
    if(v.pnl<0) heat+=-v.pnl;
  }
  const heatPct=Math.round(heat/nav*1e4)/100;
  if(heatPct>HEATW) violations.push({type:"portfolio_heat",symbol:"",message:`Portfolio heat ${heatPct}% vuot nguong ${HEATW}% (tong lo ${Math.round(heat).toLocaleString("vi-VN")} dong)`,severity:"medium"});
  const order={high:0,medium:1,warn:2};
  violations.sort((a,b)=>(order[a.severity]??9)-(order[b.severity]??9));
  const stats=stats0;
  return sJson({
    violations,
    summary:{nav:Math.round(nav),positions:valued.length,heat_pct:heatPct,n_violations:violations.length},
    positions:valued.sort((a,b)=>b.market_value-a.market_value),
    stats,
    profile:prof0,
    limits:{max_position_pct:MAXP, stop_loss_pct:SLP, heat_pct:HEATW, source:"risk_profile"},
  });
}

// ---- Strategy review (port strategy_review.py) ----
// Backtest 2 chien luoc tren cac ma user tung giao dich/dang nam giu,
// tong hop theo chien luoc + ket luan (giu / xem lai / dung) nhu mockup man 8.
function smaArr(v, n){
  const o = new Array(v.length).fill(null); let s = 0;
  for(let i = 0; i < v.length; i++){
    s += v[i]; if(i >= n) s -= v[i - n];
    if(i >= n - 1) o[i] = s / n;
  }
  return o;
}
function rsiArr(c, n = 14){
  const o = new Array(c.length).fill(null);
  if(c.length < n + 1) return o;
  let ag = 0, al = 0;
  for(let i = 1; i <= n; i++){ const d = c[i] - c[i - 1]; ag += Math.max(d, 0); al += Math.max(-d, 0); }
  ag /= n; al /= n;
  for(let i = n; i < c.length; i++){
    if(i > n){ const d = c[i] - c[i - 1]; ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n; }
    o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return o;
}
function stratTrades(closes, strategy){
  const sig = new Array(closes.length).fill(0);
  if(strategy === "ma_cross"){
    const f = smaArr(closes, 10), s = smaArr(closes, 30);
    for(let i = 1; i < closes.length; i++){
      if(f[i] == null || s[i] == null) continue;
      const pf = f[i - 1] != null ? f[i - 1] : f[i];
      const ps = s[i - 1] != null ? s[i - 1] : s[i];
      if(pf <= ps && f[i] > s[i]) sig[i] = 1;
      else if(pf >= ps && f[i] < s[i]) sig[i] = -1;
    }
  }else{
    const r = rsiArr(closes); let hold = false;
    for(let i = 0; i < closes.length; i++){
      if(r[i] == null) continue;
      if(!hold && r[i] < 30){ sig[i] = 1; hold = true; }
      else if(hold && r[i] > 70){ sig[i] = -1; hold = false; }
    }
  }
  const rets = []; let buy = null;
  for(let i = 0; i < closes.length; i++){
    if(sig[i] === 1 && buy == null) buy = closes[i];
    else if(sig[i] === -1 && buy != null){ rets.push((closes[i] - buy) / buy * 100); buy = null; }
  }
  if(buy != null) rets.push((closes[closes.length - 1] - buy) / buy * 100);
  return rets;
}

// GET /api/stock/strategy_review — danh gia chien luoc tren danh muc cua user
export async function hStockStrategyReview(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const pf = await uGet(env, s.email, "portfolio", {txns:[]});
  const syms = [...new Set((pf.txns || []).map(t => t.symbol))].slice(0, 10);
  if(!syms.length) return sJson({rows: [], symbols: 0, note: "Chua co giao dich/danh muc"});
  const agg = {
    ma_cross: {label: "Theo trend (MA 10/30)", rets: []},
    rsi_reversal: {label: "Bắt đáy (RSI 30/70)", rets: []},
  };
  let used = 0;
  for(const sym of syms){
    const d = await sGet(env, "market/ohlcv/" + sym + ".json");
    const rows = (d && d.rows) || [];
    if(rows.length < 40) continue;
    used++;
    const closes = rows.map(r => r.c);
    for(const k of Object.keys(agg)) agg[k].rets.push(...stratTrades(closes, k));
  }
  const out = [];
  for(const k of Object.keys(agg)){
    const rets = agg[k].rets;
    const wins = rets.filter(x => x > 0);
    const gw = wins.reduce((a, b) => a + b, 0);
    const gl = -rets.filter(x => x <= 0).reduce((a, b) => a + b, 0);
    const pf2 = gl > 0 ? Math.round(gw / gl * 100) / 100 : (gw > 0 ? null : 0);
    const wr = rets.length ? Math.round(wins.length / rets.length * 1000) / 10 : 0;
    let verdict = "no_data";
    if(rets.length) verdict = (pf2 != null && pf2 >= 1.5 && wr >= 55) ? "giu" : (pf2 == null || pf2 >= 1) ? "xem_lai" : "dung";
    out.push({strategy: k, label: agg[k].label, trades: rets.length,
      win_rate_pct: wr, profit_factor: pf2, verdict});
  }
  return sJson({rows: out, symbols: used, note: "Backtest don gian, chua tru phi/thue — chi de so sanh tuong doi"});
}

// ---- Rule alerts (ff_buy / ff_sell / pf_buy / signal / price) ----
// D1 table rule_alerts (tranh bug D1-vs-R2: doc cu dung uPut(R2)/uGet(D1-fallback)
// nen POST luu duoc ma GET khong thay). watchdog_live.py danh gia dinh ky.
const RULE_TYPES=["ff_buy","ff_sell","pf_buy","pf_sell","signal","price"];
export async function hRuleAlertsGet(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const db = drizzle(env.DB);
  const rows = await db.select().from(ruleAlerts)
    .where(eq(ruleAlerts.email, s.email)).orderBy(asc(ruleAlerts.createdAt));
  return sJson(rows.map(x=>({id:x.id, symbol:x.symbol, type:x.type, threshold:x.threshold,
    created_at:new Date(x.createdAt).toISOString()})));
}
export async function hRuleAlertsAdd(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const b = await request.json().catch(()=>({}));
  const sym=String(b.symbol||"").toUpperCase().trim();
  const type=String(b.type||"").trim();
  const thr=parseFloat(b.threshold);
  if(!/^[A-Z]{3,10}$/.test(sym)) return jerr("Invalid symbol", 400);
  if(!RULE_TYPES.includes(type)) return jerr("Invalid type", 400);
  if(!(thr>0)) return jerr("Threshold must be > 0", 400);
  const db = drizzle(env.DB);
  const cnt = await db.select({n: sql`count(*)`}).from(ruleAlerts)
    .where(eq(ruleAlerts.email, s.email));
  if((cnt[0]?.n||0) >= 50) return jerr("Too many alerts (max 50)", 400);
  const ins = await db.insert(ruleAlerts).values({
    email: s.email, symbol: sym, type, threshold: thr, createdAt: Date.now()}).returning({id: ruleAlerts.id});
  return sJson({id: ins[0].id, symbol: sym, type, threshold: thr, created_at: new Date().toISOString()});
}
export async function hRuleAlertsDel(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const id=parseInt(new URL(request.url).pathname.split("/").pop(),10);
  const db = drizzle(env.DB);
  await db.delete(ruleAlerts).where(and(eq(ruleAlerts.id, id), eq(ruleAlerts.email, s.email)));
  return sJson({ok:true});
}

// GET /api/internal/stock-rule-alerts?email=... — watchdog doc rules de danh gia
export async function hRuleAlertsInternal(request, env){
  const auth = request.headers.get("X-Internal-Secret");
  if(auth !== env.STOCK_PUBLISH_SECRET) return jerr("Forbidden", 403);
  const email = new URL(request.url).searchParams.get("email");
  if(!email) return jerr("Missing email", 400);
  const db = drizzle(env.DB);
  const rows = await db.select().from(ruleAlerts)
    .where(eq(ruleAlerts.email, email)).orderBy(asc(ruleAlerts.createdAt));
  return sJson(rows.map(x=>({id:x.id, symbol:x.symbol, type:x.type, threshold:x.threshold})));
}
