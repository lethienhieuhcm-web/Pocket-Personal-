import { jerr, sJson } from './utils.js';
import { getSession } from './auth.js';
import { drizzle } from "drizzle-orm/d1";
import { eq, and, asc, sql } from "drizzle-orm";
import { watchlist, portfolioTxns, alerts, targets, ruleAlerts } from "./schema.js";

/* ================= STOCK (chung khoan VN, R2-backed) ================= */
/* Market snapshots: stock/market/*.json — VM day len qua POST /api/internal/stock-publish
   User data: stock/users/{email}/(watchlist|portfolio|alerts|targets).json
   Auth: dung session English Lab (getSession). Khong can JWT rieng. */

/* CONG TAC CHE DO PHAT TRIEN — Henrry lenh 20/10/2026: trong giai doan
   phat trien, TAT HET cong goi tra phi cua Stocks. true = bo qua moi
   plan-gate ben duoi (logic goi van giu nguyen, chi khong chan).
   Khi ra mat thuong mai: dat false TAI DAY (mot cho duy nhat) la toan
   bo cong goi song lai. KHONG lien quan dang nhap/secret — bao mat
   giu nguyen. */
export const STOCK_DEV_OPEN_GATES = true;

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


/* ---------- market (doc tu R2 snapshot, can login) ---------- */
export async function hStockIndices(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/indices.json", 300);
}

// Chi so nganh (engine chi so Dot B): file rieng market/sector_indices.json
export async function hStockSectorIndices(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/sector_indices.json", 300);
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
const STOCK_BUILD_ID = "__BUILD__"; // cf_deploy thay bang ma ban dung cua lan deploy

export async function hStockVersion(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const cache = caches.default;
  const cacheKey = new Request(request.url, {method: "GET"});
  let resp = await cache.match(cacheKey);
  if(resp) return resp;
  // Gom _prov tu cac bo du lieu chinh: frontend poll 5 phut, chi tai lai
  // khi `updated` doi; `versions` = cac ban vnstock dang cap du lieu
  // (giai doan lai 4+5 thi ca hai — quy tac Henrry 2026-10-20).
  const files = ["indices", "quotes", "screener", "fundamentals", "regime",
                 "ohlcv/FPT", "company_profile/FPT", "statements/FPT"];
  const bySource = {};
  let updated = null;
  for(const f of files){
    const d = await sGet(env, "market/"+f+".json").catch(()=>null);
    if(!d) continue;
    if(d.updated && (!updated || d.updated > updated)) updated = d.updated;
    const p = d._prov;
    if(p && p.source){
      const cur = bySource[p.source] || {source: p.source, retrieved_at: p.retrieved_at || null, datasets: []};
      if(p.retrieved_at && (!cur.retrieved_at || p.retrieved_at > cur.retrieved_at)) cur.retrieved_at = p.retrieved_at;
      cur.datasets.push(f);
      bySource[p.source] = cur;
    }
  }
  const sources = Object.values(bySource).sort((a,b)=>String(b.retrieved_at||"").localeCompare(String(a.retrieved_at||"")));
  const versions = [...new Set(sources.flatMap(x=>{
    const m = String(x.source).match(/vnstock(\d+)/g) || [];
    return m.map(t=>t.replace("vnstock",""));
  }))].sort();
  resp = new Response(JSON.stringify({build: STOCK_BUILD_ID, updated, sources, versions}), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" }
  });
  await cache.put(cacheKey, resp.clone());
  return resp;
}

/* ---- Data accessors (dung chung trong stock.js) ---- */
// Dien do sau 3 buoc tu market/depth.json (poller publish moi 5 phut tu
// bang KBS toan thi truong) khi quote chinh thieu — tien le FR/FO:
// nguon chinh thieu thi dien tu nguon co that (22/10/2026).
async function _withDepth(env, sym, q){
  if(!q || (q.bid != null && q.ask != null)) return q;
  try{
    const d = await sGet(env, "market/depth.json");
    const dep = d && d.by_symbol ? d.by_symbol[sym] : null;
    if(dep){
      if(q.bid == null && dep.bid) q.bid = dep.bid;
      if(q.ask == null && dep.ask) q.ask = dep.ask;
      if(dep.bid || dep.ask) q.depth_updated = d.updated || null;
    }
  }catch(e){ /* depth la lop bo sung — loi thi tra quote goc */ }
  return q;
}

export async function getQuoteData(env, sym){
  sym = String(sym||"").toUpperCase();
  if(!sym) return null;
  const d = await sGet(env, "market/quotes.json");
  const q = d && d.by_symbol ? d.by_symbol[sym] : null;
  if(q){
    // Include data timestamp so AI can state which trading session the data is from
    return _withDepth(env, sym, Object.assign({symbol:sym, data_updated:d.updated||null, _prov:d._prov||null}, q));
  }
  // Fallback (22/10, bug chi tiet DGC): ma ngoai vu tru poller
  // realtime (~30 ma) khong co trong quotes.json -> lay dong
  // screener (snapshot EOD toan thi truong) thay vi 404. Gia
  // screener tinh bang NGHIN dong, hop dong quote la DONG -> x1000.
  // data_updated = moc cua chinh dong de thay do tuoi that.
  const sc = await sGet(env, "market/screener.json");
  const row = sc && Array.isArray(sc.rows) ? sc.rows.find(r=>r.symbol===sym) : null;
  if(!row || row.close == null) return null;
  return _withDepth(env, sym, {symbol:sym, close:row.close*1000, pct_change:row.pct_change,
          volume:row.volume, value_vnd:row.value_vnd,
          exchange:row.exchange, data_updated:row.updated_at||sc.updated||null,
          _prov:{source:"screener-eod", retrieved_at:sc.updated||null}});
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
      if(!STOCK_DEV_OPEN_GATES && getActivePlan(usr).plan === 'free') return jerr("Premium feature: intraday charts. Upgrade to continue.", 402);
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

// GET /api/stock/trades?symbol=STB&limit=120 — bang khop lenh chi
// tiet cua phien (bo thu tick, chan DNSE). Phia M/B suy theo luat
// tick (side_method trong file). Khong co du lieu -> 404.
export async function hStockTrades(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const u = new URL(request.url);
  const sym = (u.searchParams.get("symbol")||"").toUpperCase();
  if(!sym) return jerr("Symbol required", 400);
  const limit = Math.max(10, Math.min(parseInt(u.searchParams.get("limit")||"120",10)||120, 1000));
  const d = await sGet(env, "market/tape/"+sym+".json");
  // Chua co bang khop lenh (vd truoc phien dau tien co du lieu):
  // 200 + empty de frontend an khoi sach (khong phai loi mang 404).
  if(!d) return sJson({symbol: sym, empty: true, trades: [], levels: [],
    total_vol: 0, buy_vol: 0, sell_vol: 0, unknown_vol: 0, n_trades: 0});
  // Gia trong tape la NGHIN dong (quy uoc chan DNSE) -> doi sang
  // dong de khop thang gia quote o frontend.
  const trades = (d.trades || []).slice(-limit).map(t => ({
    ts: t.ts, time: t.time, p: (t.p != null ? Math.round(t.p * 1000) : null),
    v: t.v, s: t.s}));
  const levels = (d.levels || []).map(l => ({
    p: (l.p != null ? Math.round(l.p * 1000) : null), v: l.v}));
  return sJson({symbol: sym, date: d.date, source: d.source,
    side_method: d.side_method, partial: !!d.partial,
    total_vol: d.total_vol, buy_vol: d.buy_vol, sell_vol: d.sell_vol,
    unknown_vol: d.unknown_vol, n_trades: d.n_trades,
    levels, trades, updated: d.updated});
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
  const baseRows = rows; // pool cham diem: chi loc san (nhu screener2 cu)
  if(!isNaN(minP)) rows = rows.filter(r=>r.pct_change!=null && r.pct_change>=minP);
  if(!isNaN(maxP)) rows = rows.filter(r=>r.pct_change!=null && r.pct_change<=maxP);
  if(!isNaN(minV)) rows = rows.filter(r=>(r.volume||0)>=minV);
  if(!isNaN(minVal)) rows = rows.filter(r=>(r.value_vnd||0)>=minVal);
  const sort = u.searchParams.get("sort")||"value_vnd", order = u.searchParams.get("order")||"desc";
  rows = [...rows].sort((a,b)=>{ const av=a[sort]??-1e18, bv=b[sort]??-1e18; return order==="asc"? av-bv : bv-av; });
  // Merge fundamentals (pe_ttm/pb/roe_ttm) + foreign net tu quotes vao tung row:
  // truoc day frontend doc cac field nay tu /screener nhung khong ai ghi -> luon "—".
  // all=1: tra toan bo tap da loc (khoi Nhan dinh o client tinh tren tap nay).
  const out = u.searchParams.get("all") ? rows.slice(0,2000) : rows.slice(0,500);
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
        // Truong co ban cho khoi Nhan dinh Sang loc (client-side)
        r.industry = f.industry ?? null;
        r.eps = f.eps ?? null; r.bvps = f.bvps ?? null;
        r.roa = f.roa ?? null; r.net_margin = f.net_margin ?? null;
        r.debt_to_equity = f.debt_to_equity ?? null;
        r.altman_z = f.altman_z ?? null; r.piotroski = f.piotroski ?? null;
      }
      if(q && q.foreign_buy_value!=null && q.foreign_sell_value!=null)
        r.foreign_net_value = q.foreign_buy_value - q.foreign_sell_value;
    }
    // Score tong hop — gop tu /screener2 (route da xoá, dot A 20/10):
    // loc penny (close >= 10 nghin dong), top 200 thanh khoan, sScoreRows.
    const closes = {};
    for(const k of Object.keys(bySym)) closes[k] = bySym[k].close;
    let cand = baseRows.filter(r=>(r.close||0) >= 10);
    cand = [...cand].sort((a,b)=>((b.value_vnd||0)-(a.value_vnd||0))).slice(0,200);
    const scored = sScoreRows(cand.map(r=>Object.assign({},r)), funds, closes);
    const scoreBy = {};
    for(const r of scored) if(r.score!=null) scoreBy[r.symbol] = r.score;
    for(const r of out) if(scoreBy[r.symbol]!=null) r.score = scoreBy[r.symbol];
  }catch(e){}
  return sJson({updated:d?d.updated:null, count:rows.length, rows:out});
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
      // Don vi (do that 22/10/2026): quotes.json close la DONG
      // (FPT 57400), eps/bvps cung la dong/co phieu -> P/E, P/B
      // chia truc tiep, KHONG *1000. Chi screener.json moi co
      // close bang NGHIN dong (FPT 57,4) nen o handler screener
      // moi can *1000. Dung tron 2 nguon nay se lech 1000 lan.
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

/* Dong thuan CTCK: tong hop toan thi truong (publish tu warehouse) */
export async function hStockConsensus(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/consensus.json", 300); // 5m cache
}

/* Tong hop nganh: bang 19 nganh (TTM + ROE + P/E) */
export async function hStockSectors(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/sectors.json", 900); // 15m cache
}

/* Tong hop nganh: chi tiet 1 nganh (chuoi ky + thanh vien) */
export async function hStockSectorsDetail(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const code = new URL(request.url).searchParams.get("code")||"";
  if(!/^[0-9]{4}$/.test(code)) return jerr("Bad code", 400);
  const d = await sGet(env, "market/sectors/"+code+".json");
  return sJson(d || {code, series:[], members:[]});
}

/* Chi muc dao co dong: index tim kiem (toan bo co dong) */
export async function hStockHolders(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/holders_index.json", 900); // 15m cache
}

/* Chi muc dao co dong: shard chi tiet theo 2 ky tu dau cua id */
export async function hStockHoldersShard(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sh = (new URL(request.url).searchParams.get("s")||"").toLowerCase();
  if(!/^[0-9a-f]{2}$/.test(sh)) return jerr("Bad shard", 400);
  const d = await sGet(env, "market/holders/"+sh+".json");
  return sJson(d || {});
}

/* Co dong theo ma: nhan dinh co dac so huu (publish warehouse-holders) */
export async function hStockHoldersSymbol(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  if(!sym) return jerr("Symbol required", 400);
  const d = await sGet(env, "market/holders_by_symbol/"+sym+".json");
  return sJson(d || {symbol:sym, insight:null});
}

/* Dong thuan theo ma: tung hang + chuoi gia muc tieu theo thoi gian */
export async function hStockConsensusDetail(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  if(!sym) return jerr("Symbol required", 400);
  const d = await sGet(env, "market/consensus/"+sym+".json");
  return sJson(d || {symbol:sym, firms:[], series:{}});
}

/* Foreign flow tu chu: tu price_board (thay Market().foreign_flow() bi khoa) */
export async function hStockForeignFlow(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/foreign_flow.json", 900); // 15m cache
}

/* Vi mo Tier 2: tong quan cac series moi nhat + lai suat dieu hanh */
export async function hStockListing(request, env){
  return cachedMarket(request, env, "market/listing.json", 3600);
}

export async function hStockMacro(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/macro/overview.json", 300);
}

/* Lich su vi mo theo series: ?series=gold_sjc&limit=250 */
export async function hStockMacroHistory(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const u = new URL(request.url);
  const sid = (u.searchParams.get("series")||"").toLowerCase();
  if(!/^[a-z0-9_]+$/.test(sid)) return jerr("Missing series", 400);
  const limit = Math.min(parseInt(u.searchParams.get("limit")||"250")||250, 1200);
  const d = await sGet(env, "market/macro/history/"+sid+".json");
  const rows = (d && d.rows) || [];
  return sJson({series:sid, count:rows.length, rows:rows.slice(-limit),
    updated:d?d.updated:null});
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

/* ===== KE SHELF 27/10 (Chot Henrry 09:59 27/10): so lenh + lich su nhom NDT =====
   Du lieu that tu 27/10: so lenh SSI 10 muc bid/ask, snapshot 60s, prefix
   R2 orderbook-YYYYMMDD; lich su nhom NDT do batch EOD publish qua
   hStockPublish (khoa flow_history, xem cuoi ham do). KHONG doc collector
   live, KHONG backfill, KHONG uoc luong so lieu. Tong KL mua/ban o day
   la TONG CONG tu cac muc hien co — tin s/MAIN khong mang
   totalBidQty/totalAskQty nen khong bao gio ghi tong tu feed. */

/* Chuan hoa 1 book: chi giu muc co gia (bo [null,null] cua so lenh mong),
   tong = tong cac muc hien co, spread = best ask - best bid. */
export function obCleanBook(raw){
  const side = (arr)=>{
    const out = [];
    for(const lv of (Array.isArray(arr) ? arr : [])){
      if(!Array.isArray(lv)) continue;
      const p = lv[0], v = lv[1];
      if(p == null || !isFinite(+p)) continue;
      out.push([+p, (v == null || !isFinite(+v)) ? null : +v]);
    }
    return out;
  };
  const bids = side(raw && raw.bids), asks = side(raw && raw.asks);
  const sum = (xs)=> xs.reduce((a, x)=> a + (x[1] || 0), 0);
  const bestBid = bids.length ? bids[0][0] : null;
  const bestAsk = asks.length ? asks[0][0] : null;
  return {
    last: (raw && raw.last != null && isFinite(+raw.last)) ? +raw.last : null,
    bids, asks,
    total_bid_vol: sum(bids), total_ask_vol: sum(asks),
    spread: (bestBid != null && bestAsk != null)
      ? Math.round((bestAsk - bestBid) * 1000) / 1000 : null,
    totals_are_sums: true,
  };
}

/* Chon snapshot gan nhat tai hoac truoc moc thoi gian (so sanh chuoi ISO,
   cung offset +07:00 do collector ghi). Tra ve null neu khong co dong nao. */
export function obPickSnapshot(lines, sym, targetIso){
  let best = null;
  for(const ln of lines){
    if(!ln || ln.kind !== "book_minute") continue;
    const books = ln.books || (ln.by_symbol ? ln.by_symbol : null);
    if(!books || !books[sym]) continue;
    if(targetIso && ln.t && ln.t > targetIso) continue;
    if(!best || (ln.t || "") >= (best.t || "")) best = ln;
  }
  if(!best) return null;
  return {t: best.t || null, book: best.books[sym]};
}

async function obGunzipText(buf){
  try{
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    return await new Response(stream).text();
  }catch(e){
    return new TextDecoder().decode(buf);
  }
}

async function obListKeys(env, prefix, cap){
  const keys = [];
  let cursor = undefined;
  while(keys.length < cap){
    const page = await env.DATA.list({prefix, cursor});
    for(const o of (page.objects || [])) keys.push(o.key);
    if(!page.truncated || !page.cursor) break;
    cursor = page.cursor;
  }
  return keys;
}

/* Gio ICT hien tai (VM thieu tzdata nen khong dung TZ): UTC+7 bang so hoc. */
function obTodayIct(){
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

const OB_SYM_RE = /^[A-Z]{3,10}$/;

/* GET /api/stock/orderbook?symbol=&date=&time=
   - time bo trong -> snapshot moi nhat (live).
   - time co -> snapshot gan nhat tai hoac truoc time trong ngay date
     (time dang "HH:MM", "HH:MM:SS" hoac ISO day du). */
export async function hStockOrderbook(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const u = new URL(request.url);
  const sym = (u.searchParams.get("symbol") || "").toUpperCase();
  if(!OB_SYM_RE.test(sym)) return jerr("Invalid symbol", 400);
  const date = u.searchParams.get("date") || obTodayIct();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jerr("Invalid date", 400);
  const src = "orderbook-" + date.replace(/-/g, "");
  const timeRaw = (u.searchParams.get("time") || "").trim();
  if(!timeRaw){
    const d = await sGet(env, "market/shadow_tick/src/" + src + "/snapshot.json");
    const raw = d && d.by_symbol ? d.by_symbol[sym] : null;
    if(!raw) return sJson({symbol: sym, date, time: null, live: true, empty: true,
      last: null, bids: [], asks: [], total_bid_vol: 0, total_ask_vol: 0,
      spread: null, totals_are_sums: true, updated: (d && d.updated) || null});
    return sJson(Object.assign({symbol: sym, date, time: (d && d.updated) || null,
      live: true, empty: false}, obCleanBook(raw),
      {updated: (d && d.updated) || null}));
  }
  let targetIso;
  if(timeRaw.includes("T")) targetIso = timeRaw;
  else{
    const tm = timeRaw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if(!tm) return jerr("Invalid time", 400);
    const hh = tm[1].padStart(2, "0");
    targetIso = date + "T" + hh + ":" + tm[2] + ":" + (tm[3] || "00") + "+07:00";
  }
  const hhReq = targetIso.slice(11, 13);
  // Di nguoc theo gio trong ngay: gio yeu cau truoc, neu khong co
  // snapshot tai/ truoc moc thi lay snapshot cuoi cua gio truoc do.
  for(let step = 0; step < 24; step++){
    const hhNum = parseInt(hhReq, 10) - step;
    if(hhNum < 0) break;
    const hh = String(hhNum).padStart(2, "0");
    const keys = await obListKeys(env,
      "stock/market/shadow_tick/raw/" + date + "/" + src + "/" + hh + "/", 500);
    if(!keys.length) continue;
    const lines = [];
    for(const k of keys){
      try{
        const o = await env.DATA.get(k);
        if(!o) continue;
        const buf = await o.arrayBuffer();
        const txt = await obGunzipText(buf);
        for(const line of txt.split("\n")){
          if(!line.trim()) continue;
          try{ lines.push(JSON.parse(line)); }catch(e){}
        }
      }catch(e){}
    }
    const pick = obPickSnapshot(lines, sym, targetIso);
    if(pick) return sJson(Object.assign({symbol: sym, date, time: pick.t,
      live: false, empty: false}, obCleanBook(pick.book)));
    // Gio nay co file nhung khong co dong nao tai/truoc moc -> gio truoc.
  }
  return sJson({symbol: sym, date, time: null, live: false, empty: true,
    last: null, bids: [], asks: [], total_bid_vol: 0, total_ask_vol: 0,
    spread: null, totals_are_sums: true});
}

/* GET /api/stock/orderbook/dates?symbol= -> cac ngay co snapshot.
   Ngay la theo nguon (prefix orderbook-YYYYMMDD), giong nhau cho ca 40 ma
   cua nguon — symbol chi de kiem dinh dang, khong loc rieng tung ma. */
export async function hStockOrderbookDates(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol") || "").toUpperCase();
  if(sym && !OB_SYM_RE.test(sym)) return jerr("Invalid symbol", 400);
  const keys = await obListKeys(env, "stock/market/shadow_tick/src/orderbook-", 1000);
  const dates = [];
  for(const k of keys){
    const m = k.match(/orderbook-(\d{8})\/snapshot\.json$/);
    if(!m) continue;
    const d = m[1].slice(0, 4) + "-" + m[1].slice(4, 6) + "-" + m[1].slice(6, 8);
    if(!dates.includes(d)) dates.push(d);
  }
  dates.sort().reverse();
  return sJson({symbol: sym || null, dates, count: dates.length});
}

/* Chuan hoa 1 dong lich su nhom NDT: giu null khi nguon thieu gia tri,
   khong dien 0 thay cho thieu. */
export function obNormalizeFlowRow(r){
  if(!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || "")) return null;
  const num = (v)=> (v == null || !isFinite(+v)) ? null : +v;
  const buyVol = num(r.buy_vol), sellVol = num(r.sell_vol);
  const buyVal = num(r.buy_val), sellVal = num(r.sell_val);
  return {
    date: r.date, buy_vol: buyVol, sell_vol: sellVol,
    net_vol: (buyVol != null && sellVol != null) ? buyVol - sellVol : null,
    buy_val: buyVal, sell_val: sellVal,
    net_val: (buyVal != null && sellVal != null) ? buyVal - sellVal : null,
  };
}

const FLOW_GROUPS = ["foreign", "proprietary"];

/* GET /api/stock/flow-history?symbol=&group=&days=
   group=foreign|proprietary -> doc file stock/flow/<group>/<symbol>.json
   (do batch EOD publish). Nhom khac -> payload no-data, KHONG dong gia. */
export async function hStockFlowHistory(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const u = new URL(request.url);
  const sym = (u.searchParams.get("symbol") || "").toUpperCase();
  if(!OB_SYM_RE.test(sym)) return jerr("Invalid symbol", 400);
  const group = (u.searchParams.get("group") || "").toLowerCase();
  const days = Math.max(1, Math.min(parseInt(u.searchParams.get("days") || "90", 10) || 90, 500));
  if(!FLOW_GROUPS.includes(group)){
    return sJson({symbol: sym, group, available: false, count: 0, rows: [],
      note: "no-data"});
  }
  const d = await sGet(env, "flow/" + group + "/" + sym + ".json");
  const rows = ((d && d.rows) || []).map(obNormalizeFlowRow).filter(Boolean)
    .sort((a, b)=> (b.date || "").localeCompare(a.date || ""));
  return sJson({symbol: sym, group, available: true,
    count: rows.length, rows: rows.slice(0, days),
    updated: (d && d.updated) || null});
}
const FLOW_SYM_RE = /^[A-Z0-9]{3,10}$/; // ma that co ca chu so (HT1, NT2, D2D...)

/* Tinh cot ngoai/tu doanh cho 1 ma tu lich su R2: chi tinh khi du
   lieu tuoi toi screen_date; cu/thieu -> null (view hien "—",
   khong suy so, khong dien 0). Lich su luu tang dan theo trade_date. */
export function flowJoinRow(frows, prows, screenDate){
  const rowsAsc = (arr)=>{
    const a = (Array.isArray(arr) ? arr : [])
      .filter(r => r && r.trade_date && (!screenDate || r.trade_date <= screenDate));
    a.sort((x, y) => String(x.trade_date).localeCompare(String(y.trade_date)));
    return a;
  };
  // null/undefined/"" la thieu so, KHONG phai 0 (Number(null) === 0
  // nen phai loc truoc khi doi so).
  const numOrNull = (v)=>{
    if(v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const sumOrNull = (arr, k)=>{
    let s = 0, any = false;
    for(const r of arr){
      const v = numOrNull(r[k]);
      if(v !== null){ s += v; any = true; }
    }
    return any ? s : null;
  };
  const f = rowsAsc(frows);
  const p = rowsAsc(prows);
  const fLatest = f.length ? f[f.length - 1] : null;
  const pLatest = p.length ? p[p.length - 1] : null;
  const fFresh = !!(fLatest && screenDate && fLatest.trade_date === screenDate);
  const pFresh = !!(pLatest && screenDate && pLatest.trade_date === screenDate);
  const last20 = fFresh ? f.slice(-20) : [];
  const f1 = fFresh ? fLatest : null;
  return {
    foreign_net20_val: fFresh ? sumOrNull(last20, "net_value_est") : null,
    foreign_net20_vol: fFresh ? sumOrNull(last20, "net_volume") : null,
    foreign_net1_val: f1 ? numOrNull(f1.net_value_est) : null,
    foreign_net1_vol: f1 ? numOrNull(f1.net_volume) : null,
    prop_net_val: pFresh ? numOrNull(pLatest.net_value_vnd) : null,
    foreign_asof: fFresh ? fLatest.trade_date : null,
    prop_asof: pFresh ? pLatest.trade_date : null,
  };
}

/* GET /api/stock/flow-screen?date= — bang xep hang sang loc dong tien
   ngay (Chot F1-F4 27/10/2026): doc dataset publish + join lich su
   ngoai/tu doanh theo ma. Chi hien thi + xac nhan, KHONG gate, khong
   doi nhan thanh tin hieu mua. */
export async function hStockFlowScreen(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const u = new URL(request.url);
  const date = (u.searchParams.get("date") || "").trim();
  if(date && !/^[A-Za-z0-9_-]{1,32}$/.test(date)) return jerr("Invalid date", 400);
  const key = date ? ("flow/flow_screen/" + date + ".json") : "flow/flow_screen_latest.json";
  const d = await sGet(env, key);
  if(!d || !Array.isArray(d.candidates)){
    return sJson({available:false, for_date:(d && d.for_date) || null,
      screen_date:(d && d.screen_date) || null, trial:true, count:0, rows:[],
      updated:(d && d.updated) || null});
  }
  const screenDate = d.screen_date || "";
  const cands = d.candidates.slice()
    .sort((a, b) => (Number(b.cmf20) || 0) - (Number(a.cmf20) || 0));
  const rows = [];
  for(const c of cands){
    const sym = String((c && c.symbol) || "").toUpperCase();
    if(!FLOW_SYM_RE.test(sym)) continue;
    const fh = await sGet(env, "market/foreign_flow_history/" + sym + ".json");
    const ph = await sGet(env, "market/proprietary_flow_history/" + sym + ".json");
    const j = flowJoinRow((fh && fh.rows) || [], (ph && ph.rows) || [], screenDate);
    rows.push(Object.assign({rank:rows.length + 1, symbol:sym,
      close:(c.close ?? null), cmf20:(c.cmf20 ?? null),
      obv20:(c.obv20 ?? null), mfi14:(c.mfi14 ?? null), mf20_val:(c.mf20_val ?? null),
      cmf60:(c.cmf60 ?? null), obv60:(c.obv60 ?? null), mf60_val:(c.mf60_val ?? null),
      cmf250:(c.cmf250 ?? null), obv250:(c.obv250 ?? null), mf250_val:(c.mf250_val ?? null)}, j));
  }
  return sJson({available:true, for_date:d.for_date || null, screen_date:screenDate,
    trial:true, count:rows.length, rows, updated:d.updated || null});
}

/* Phan ky CW-EW (Chot 11:12 28/10, khoi Tong quan thi truong 2 phan):
   snapshot divergence.json do publisher ghi; frontend hien phien moi
   nhat + as_of. Thieu file -> cachedMarket tra {updated:null, rows:[]},
   frontend hien "—", khong chan view. */
export async function hStockDivergence(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/divergence.json", 300);
}

/* Tong quan live (Chot 11:12 28/10): file market/live_overview.json do
   realtime_poller ghi moi 5 phut (do rong/TRIN tu bang KBS toan thi
   truong). Cache ngan (60s) theo nhip poll cua frontend. */
export async function hStockLiveOverview(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  return cachedMarket(request, env, "market/live_overview.json", 60);
}

/* Tong thi truong chuan HSX (Chot 22:23 27/10): doc file latest hoac
   theo ngay (?date=YYYY-MM-DD); thieu -> available:false (frontend
   hien "—", khong chan view). */
export async function hStockMarketTotals(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const u = new URL(request.url);
  const date = (u.searchParams.get("date") || "").trim();
  if(date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return jerr("Invalid date", 400);
  const key = date ? ("market/market_totals/" + date + ".json") : "market/market_totals_latest.json";
  const d = await sGet(env, key);
  if(!d || !d.date || !Number.isFinite(Number(d.total_volume))){
    return sJson({available:false, date:(d && d.date) || date || null,
      updated:(d && d.updated) || null});
  }
  return sJson({available:true, date:d.date, source:d.source || "HSX",
    source_url:d.source_url || null, retrieved_at:d.retrieved_at || null,
    rows:d.rows || 0, total_volume:d.total_volume, total_value:d.total_value,
    breakdown:d.breakdown || null, basis_note:d.basis_note || null,
    updated:d.updated || null});
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
  // Cong goi thu 3 (qua billing checkFeature) — cung qua cong tac
  // STOCK_DEV_OPEN_GATES nhu 2 cong trong stock.js (bo sung 20/10 khi
  // lam Dot B: watchlist_add bi 402 voi tai khoan free).
  if(!STOCK_DEV_OPEN_GATES){
    const {checkFeature} = await import('./billing.js');
    const chk = await checkFeature(request, env, 'watchlist_add', {usage: {watchlist_count: wlCount}});
    if(chk.err) return chk.err;
  }
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

export async function hCostHistory(request, env){
  const s = await getSession(request, env); if(!s) return jerr("Not logged in", 401);
  const sym = (new URL(request.url).searchParams.get("symbol")||"").toUpperCase();
  const pf = await uGet(env, s.email, "portfolio", {txns:[]});
  const txns = (pf.txns||[]).filter(t=>t.symbol===sym).sort((a,b)=> a.date<b.date?-1:a.date>b.date?1:a.id-b.id);
  if(!txns.length) return sJson({symbol:sym, series:[]}); // chua co giao dich = du lieu rong, khong phai loi (404 cu lam console do o trang chi tiet)
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
    if(!STOCK_DEV_OPEN_GATES && getActivePlan(u).plan === 'free'){
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
// Trang thai canh bao bat bien publish tick (Chot 21:58 27/10) —
// best-effort theo isolate: streak/total theo nguon gui.
const _tickInvariant = new Map();

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
  // Goi sua publish (Chot 21:58 27/10): loi khoi tick -> 502 thay
  // vi ok lang; canh bao bat bien gom vao tra loi.
  const tickErrors = [];
  const tickAlerts = [];
  const put1 = async (key, val)=>{
    if(val===undefined) return;
    await sPut(env, "market/"+key+".json", doc(val));
    n++;
  };
  // Helpers dung chung cho nhanh chinh + nhanh _ib (lenh Henrry 19:10
  // 28/10): MOT duong code, chi khac key file dau ra. Nhanh _ib la TAM
  // (xoa khi doi ung len production — quy tac cat trong file thiet ke
  // doi ung, muc 9). Nhan live_overview chinh (nhanh MOV) khi merge phai
  // goi putLiveOverview, khong viet lai khoi validate.
  const putQuotesPatch = async (key, patch)=>{
    const curQ = await sGet(env, "market/"+key+".json");
    await put1(key, {by_symbol:Object.assign({}, (curQ && curQ.by_symbol) || {}, patch)});
  };
  const putLiveOverview = async (key, ov)=>{
    if(!ov || typeof ov !== "object") return;
    const okDate = /^\d{4}-\d{2}-\d{2}$/.test(String(ov.session_date || ""));
    const okEx = ov.by_exchange && typeof ov.by_exchange === "object";
    if(okDate && okEx){
      await put1(key, {
        session_date: ov.session_date,
        retrieved_at: String(ov.retrieved_at || ""),
        source: String(ov.source || ""),
        n_symbols: Number(ov.n_symbols) || 0,
        advancers: Number(ov.advancers) || 0,
        decliners: Number(ov.decliners) || 0,
        unchanged: Number(ov.unchanged) || 0,
        trin: (ov.trin == null ? null : Number(ov.trin)),
        turnover_total: Number(ov.turnover_total) || 0,
        by_exchange: ov.by_exchange,
      });
    }
  };
  if(body.indices) await put1("indices", {rows:body.indices});
  // Chi so nganh (engine chi so Dot B, Chot 22/10): publish_snapshot gui
  // kem khoa sector_indices de ghi file R2 rieng — dai chi so chinh cua
  // frontend khong doc khoa nay (giu nguyen 4 the). Thieu nhanh nay thi
  // Worker bo qua khoa im lang (written khong dem), du lieu nganh mat.
  if(body.sector_indices) await put1("sector_indices", {rows:body.sector_indices});
  if(body.quotes) await put1("quotes", {by_symbol:body.quotes});
  if(body.quotes_patch){
    // Merge vao quotes.json hien co thay vi ghi de toan bo (22/10):
    // poller realtime chi giu ~30 ma tuoi — truoc day moi lan no
    // publish la phan vu tru con lai mat quote (404 trang chi tiet).
    await putQuotesPatch("quotes", body.quotes_patch);
  }
  // Do rong/TRIN live (Chot 11:12 28/10): realtime_poller tinh tu bang
  // KBS toan thi truong (moi 5 phut, buoc 1b) va gui kem live_overview —
  // ghi file market/live_overview.json de frontend poll + doi chieu duoc.
  // Chi ghi khi dung ngay phien + co bang theo san; thieu thi giu file cu.
  if(body.live_overview && typeof body.live_overview === "object"){
    const ov = body.live_overview;
    const okDate = /^\d{4}-\d{2}-\d{2}$/.test(String(ov.session_date || ""));
    const okEx = ov.by_exchange && typeof ov.by_exchange === "object";
    if(okDate && okEx){
      await put1("live_overview", {
        session_date: ov.session_date,
        retrieved_at: String(ov.retrieved_at || ""),
        source: String(ov.source || ""),
        n_symbols: Number(ov.n_symbols) || 0,
        advancers: Number(ov.advancers) || 0,
        decliners: Number(ov.decliners) || 0,
        unchanged: Number(ov.unchanged) || 0,
        trin: (ov.trin == null ? null : Number(ov.trin)),
        turnover_total: Number(ov.turnover_total) || 0,
        by_exchange: ov.by_exchange,
      });
    }
  }
  if(body.depth) await put1("depth", {by_symbol:body.depth});
  // Nhan _ib (doi ung InstaBox, Chot 17:37 28/10): TAM — publish vao file
  // R2 RIENG (market/*_ib.json), khong ghi de file production. Dung chung
  // helper put1/putQuotesPatch/putLiveOverview voi nhanh chinh, chi khac
  // key. XOA TOAN BO khoi nay khi doi ung verify dat + len production.
  for(const [bk, fk, shape] of [
    ["indices_ib", "indices_ib", (v)=> ({rows:v})],
    ["sector_indices_ib", "sector_indices_ib", (v)=> ({rows:v})],
    ["depth_ib", "depth_ib", (v)=> ({by_symbol:v})],
  ]) if(body[bk]) await put1(fk, shape(body[bk]));
  if(body.quotes_patch_ib) await putQuotesPatch("quotes_ib", body.quotes_patch_ib);
  if(body.live_overview_ib) await putLiveOverview("live_overview_ib", body.live_overview_ib);
  // Universe duy nhat (lenh Henrry 17:40 28/10): job sang ghi danh sach ma
  // vao market/universe.json; collector + code moi nap luc mo phien.
  // Validate chat: sai -> 400 LOUD (khong ghi de file cu bang du lieu loi).
  if(body.universe){
    const u = body.universe;
    const syms = Array.isArray(u.symbols) ? u.symbols : null;
    const okSyms = syms && syms.length > 0 && syms.every((s)=> typeof s === "string" && s.trim().length > 0);
    const okUniq = okSyms && new Set(syms.map((s)=> s.trim().toUpperCase())).size === syms.length;
    const okDate = /^\d{4}-\d{2}-\d{2}$/.test(String(u.as_of || ""));
    if(!okSyms || !okUniq || !okDate) return jerr("Bad universe: symbols non-empty unique + as_of YYYY-MM-DD required", 400);
    await put1("universe", {
      symbols: syms.map((s)=> s.trim().toUpperCase()),
      count: syms.length,
      as_of: u.as_of,
      basis: String(u.basis || ""),
      source: String(u.source || ""),
    });
  }
  if(body.screener) await put1("screener", {rows:body.screener});
  if(body.fundamentals) await put1("fundamentals", {by_symbol:body.fundamentals});
  if(body.symbols) await put1("symbols", {rows:body.symbols});
  if(body.listing) await put1("listing", {rows:body.listing});
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
  if(body.tape) for(const sym of Object.keys(body.tape)){
    await sPut(env, "market/tape/"+sym+".json", doc(body.tape[sym]));
    n++;
  }
  // Tape cua ban bong universe B: prefix rieng, khong de len tape live.
  if(body.tape_b) for(const sym of Object.keys(body.tape_b)){
    await sPut(env, "market/shadow_tick_b/tape/"+sym+".json", doc(body.tape_b[sym]));
    n++;
  }
  if(body.statements) for(const sym of Object.keys(body.statements)){
    await sPut(env, "market/statements/"+sym+".json", doc(body.statements[sym]));
    n++;
  }
  if(body.market_news) await put1("market_news", {items:body.market_news});
  if(body.consensus) await put1("consensus", body.consensus);
  if(body.consensus_detail) for(const sym of Object.keys(body.consensus_detail)){
    await sPut(env, "market/consensus/"+sym+".json", doc(body.consensus_detail[sym]));
    n++;
  }
  // PA2 runlog (Chot 06:38 23/10): ban ghi chu trinh dong thuan co cau
  // truc do consensus_runlog.py publish — khoa R2 rieng theo cycle_id,
  // frontend khong doc; phuc vu bao cao van hanh (failover/by_connector).
  if(body.consensus_runs) for(const cyc of Object.keys(body.consensus_runs)){
    if(!/^\d{8}_\d{6}$/.test(cyc)) continue;
    await sPut(env, "market/consensus_runs/"+cyc+".json", doc(body.consensus_runs[cyc]));
    n++;
  }
  if(body.sectors) await put1("sectors", body.sectors);
  if(body.sectors_detail) for(const code of Object.keys(body.sectors_detail)){
    if(!/^[0-9]{4}$/.test(code)) continue;
    await sPut(env, "market/sectors/"+code+".json", doc(body.sectors_detail[code]));
    n++;
  }
  if(body.holders_index) await put1("holders_index", body.holders_index);
  // Dot C (MCP GD2, Chot 12:11 23/10): snapshot tien tinh cho khoi
  // xu huong nhieu phien cua analyze_sector/analyze_market — publisher
  // publish_dotc_snapshots.py gui 4 khoa nay; thieu nhanh = Worker nuot
  // im lang, trend mai la null (bai hoc sector_indices 23/10).
  if(body.sector_flow_history) await put1("sector_flow_history", body.sector_flow_history);
  if(body.market_flow_history) await put1("market_flow_history", body.market_flow_history);
  if(body.sector_breadth) await put1("sector_breadth", body.sector_breadth);
  if(body.rs_universe) await put1("rs_universe", body.rs_universe);
  // O-1/O-2 (Chot 19:05 23/10): du lieu cho analyze_holders +
  // divergence cua analyze_market — publisher publish_holders_detail.py
  // / publish_foreign_room.py / publish_divergence.py.
  if(body.holders_detail) for(const sym of Object.keys(body.holders_detail)){
    await sPut(env, "market/holders_detail/"+sym+".json", doc(body.holders_detail[sym]));
    n++;
  }
  if(body.foreign_room) await put1("foreign_room", body.foreign_room);
  if(body.divergence) await put1("divergence", body.divergence);
  if(body.holders_shards) for(const sh of Object.keys(body.holders_shards)){
    if(!/^[0-9a-f]{2}$/.test(sh)) continue;
    await sPut(env, "market/holders/"+sh+".json", doc(body.holders_shards[sh]));
    n++;
  }
  if(body.holders_by_symbol) for(const sym of Object.keys(body.holders_by_symbol)){
    await sPut(env, "market/holders_by_symbol/"+sym+".json", doc(body.holders_by_symbol[sym]));
    n++;
  }
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
  // Batch history upload cho backfill tu doanh (doi xung foreign)
  if(body.proprietary_flow_history_batch){
    for(const sym of Object.keys(body.proprietary_flow_history_batch)){
      const days = body.proprietary_flow_history_batch[sym];
      if(!Array.isArray(days) || !days.length) continue;
      const hkey = "market/proprietary_flow_history/"+sym+".json";
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
          buy_value_vnd:d.buy_value_vnd??null,
          sell_value_vnd:d.sell_value_vnd??null,
          net_value_vnd:d.net_value_vnd??null
        };
      }
      const merged = Object.values(byDate);
      merged.sort((a,b)=>(a.trade_date||"").localeCompare(b.trade_date||""));
      const trimmed = merged.slice(-500);
      await sPut(env, hkey, doc({symbol:sym, rows:trimmed}));
      n++;
    }
  }
  // Sang loc dong tien ngay (Chot F4 27/10/2026): dataset ghi DE
  // (overwrite) — view /api/stock/flow-screen doc file nay + join lich
  // su ngoai/tu doanh theo ma. Khong merge: moi lan publish la ban
  // moi nhat cho for_date do. Chi hien thi + xac nhan, KHONG gate.
  if(body.flow_screen){
    const fs = body.flow_screen;
    const cands = Array.isArray(fs.candidates) ? fs.candidates : [];
    const rows = [];
    for(const c of cands){
      const sym = String((c && c.symbol) || "").toUpperCase();
      if(!FLOW_SYM_RE.test(sym)) continue;
      rows.push({
        symbol:sym,
        close:(c.close ?? null),
        pos60:(c.pos60 ?? null),
        ema50:(c.ema50 ?? null),
        above_ema50:(c.above_ema50 ?? null),
        updown20:(c.updown20 ?? null),
        rvol1d:(c.rvol1d ?? null),
        avg_vol20:(c.avg_vol20 ?? null),
        avg_val20:(c.avg_val20 ?? null),
        cmf20:(c.cmf20 ?? null),
        obv20:(c.obv20 ?? null),
        mfi14:(c.mfi14 ?? null),
        mf20_val:(c.mf20_val ?? null),
        cmf60:(c.cmf60 ?? null),
        obv60:(c.obv60 ?? null),
        mf60_val:(c.mf60_val ?? null),
        cmf250:(c.cmf250 ?? null),
        obv250:(c.obv250 ?? null),
        mf250_val:(c.mf250_val ?? null),
      });
    }
    const fdoc = doc({for_date:String(fs.for_date || ""),
      screen_date:String(fs.screen_date || ""), candidates:rows});
    await sPut(env, "flow/flow_screen_latest.json", fdoc);
    n++;
    const fd = String(fs.for_date || "");
    if(/^[A-Za-z0-9_-]{1,32}$/.test(fd)){
      await sPut(env, "flow/flow_screen/"+fd+".json", fdoc);
      n++;
    }
  }
  // Tong thi truong chuan HSX (Chot 22:23 27/10): tong khoi luong/gia
  // tri khop lenh GOP toan san theo phien, tach co phieu/chung quyen/
  // ETF. Payload: {"market_totals": {date, source, source_url,
  // retrieved_at, rows, total_volume, total_value, breakdown:{...},
  // basis_note, verification}} — ghi de latest + file theo ngay.
  // Bo qua neu thieu date/total hop le. Route tra available:false
  // khi thieu so, frontend hien "—", khong chan view.
  if(body.market_totals){
    const mt = body.market_totals;
    const mdate = String(mt.date || "");
    const totV = Number(mt.total_volume), totVal = Number(mt.total_value);
    if(/^\d{4}-\d{2}-\d{2}$/.test(mdate) && Number.isFinite(totV) && Number.isFinite(totVal)){
      const bk = (mt.breakdown && typeof mt.breakdown === "object") ? mt.breakdown : {};
      const bkRow = (r)=> (r && typeof r === "object") ? {
        rows:(Number(r.rows) || 0),
        total_volume_shares:(Number(r.total_volume_shares) || 0),
        total_value_vnd:(Number(r.total_value_vnd) || 0)} : null;
      const mdoc = doc({date:mdate,
        source:String(mt.source || "HSX"),
        source_url:String(mt.source_url || ""),
        retrieved_at:String(mt.retrieved_at || ""),
        rows:(Number(mt.rows) || 0),
        total_volume:totV, total_value:totVal,
        breakdown:{stock_other:bkRow(bk.stock_other),
          covered_warrant:bkRow(bk.covered_warrant),
          etf_fund:bkRow(bk.etf_fund)},
        basis_note:String(mt.basis_note || ""),
        verification:String(mt.verification || "")});
      await sPut(env, "market/market_totals_latest.json", mdoc);
      n++;
      await sPut(env, "market/market_totals/"+mdate+".json", mdoc);
      n++;
    }
  }
  // Vi mo Tier 2 (Henrry Chot T2-1 20/10/2026): overview + history
  // theo series, merge theo ngay, tran 1200 diem (~4-5 nam ngay lam
  // viec). Nguon: scripts/fetch_macro.py (SBV/VCB/SJC/NYFed/Treasury).
  if(body.macro_overview) await put1("macro/overview", body.macro_overview);
  if(body.macro_history_batch){
    for(const sid of Object.keys(body.macro_history_batch)){
      const days = body.macro_history_batch[sid];
      if(!Array.isArray(days) || !days.length) continue;
      if(!/^[a-z0-9_]+$/.test(sid)) continue;
      const hkey = "market/macro/history/"+sid+".json";
      const h = await sGet(env, hkey) || {rows:[]};
      const rows = h.rows || [];
      const byDate = {};
      for(const r of rows) if(r.date) byDate[r.date] = r;
      for(const d of days){ if(d && d.date) byDate[d.date] = d; }
      const merged = Object.values(byDate);
      merged.sort((a,b)=>(a.date||"").localeCompare(b.date||""));
      await sPut(env, hkey, doc({series:sid, rows:merged.slice(-1200)}));
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
  // Bo thu tick chay bong (Chot 21/10): chi ghi duoi prefix
  // market/shadow_tick/ — KHONG consumer production nao doc.
  if(body.tick_shadow){ try{
    const ts = body.tick_shadow;
    if(ts.intraday) for(const key of Object.keys(ts.intraday)){
      await sPut(env, "market/shadow_tick/intraday/"+key+".json",
        doc({rows:ts.intraday[key], src:(body._prov||{}).source||null, updated:now}));
      n++;
    }
    if(ts.foreign){
      await sPut(env, "market/shadow_tick/foreign.json",
        doc({by_symbol:ts.foreign, src:(body._prov||{}).source||null, updated:now}));
      n++;
    }
    if(ts.status){
      await sPut(env, "market/shadow_tick/status.json", doc(Object.assign({}, ts.status, {updated:now})));
      n++;
    }
    // Dot 2 (thiet ke tong the bo thu): raw tick chunks (gzip
    // JSONL, base64) + artifact theo nguon — van duoi prefix
    // shadow_tick, khong consumer production nao doc.
    if(ts.raw_chunks){
      const day = (ts.status && ts.status.session_date) || now.slice(0, 10);
      for(const src of Object.keys(ts.raw_chunks)){
        if(!/^[a-z0-9-]+$/.test(src)) continue;
        for(const hour of Object.keys(ts.raw_chunks[src])){
          if(!/^[0-9]{2}$/.test(hour)) continue;
          const b64 = ts.raw_chunks[src][hour];
          if(typeof b64 !== "string" || !b64) continue;
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          await env.DATA.put("stock/market/shadow_tick/raw/"+day+"/"+src+"/"+hour+"/"+Date.now()+".jsonl.gz",
            bytes, {httpMetadata:{contentType:"application/gzip"}});
          n++;
        }
      }
    }
    if(ts.src_artifacts){
      for(const src of Object.keys(ts.src_artifacts)){
        if(!/^[a-z0-9-]+$/.test(src)) continue;
        const a = ts.src_artifacts[src] || {};
        if(a.snapshot){
          await sPut(env, "market/shadow_tick/src/"+src+"/snapshot.json",
            doc(Object.assign({}, a.snapshot, {src, updated:now})));
          n++;
        }
        if(a.health){
          await sPut(env, "market/shadow_tick/src/"+src+"/health.json",
            doc(Object.assign({}, a.health, {src, updated:now})));
          n++;
        }
        const hasBk = a.buckets_dirty && Object.keys(a.buckets_dirty).length;
        const hasPt = a.buckets_pt_dirty && Object.keys(a.buckets_pt_dirty).length;
        if(hasBk || hasPt){
          const bkey = "market/shadow_tick/src/"+src+"/buckets.json";
          const cur = await sGet(env, bkey) || {buckets:{}};
          const bk = cur.buckets || {};
          const bp = cur.buckets_pt || {};
          // Chi giu phut cua phien hien tai (session_date trong
          // status cua cung payload): buckets.json khong tich luy
          // qua phien -> resume chi thay dung phien dang chay, va
          // object khong phinh theo ngay.
          const sessDay = (ts.status && ts.status.session_date) || null;
          if(sessDay){
            for(const coll of [bk, bp]){
              for(const sym of Object.keys(coll)){
                for(const mk of Object.keys(coll[sym])){
                  if(!mk.startsWith(sessDay)) delete coll[sym][mk];
                }
                if(!Object.keys(coll[sym]).length) delete coll[sym];
              }
            }
          }
          if(hasBk) for(const sym of Object.keys(a.buckets_dirty)){
            bk[sym] = Object.assign({}, bk[sym] || {}, a.buckets_dirty[sym]);
          }
          if(hasPt) for(const sym of Object.keys(a.buckets_pt_dirty)){
            bp[sym] = Object.assign({}, bp[sym] || {}, a.buckets_pt_dirty[sym]);
          }
          await sPut(env, bkey, doc({buckets:bk, buckets_pt:bp, src, updated:now}));
          n++;
        }
      }
    }
  }catch(e){ tickErrors.push({block:"tick_shadow", error:String((e&&e.message)||e).slice(0,200)}); } }
  if(body.tick_shadow_b){ try{
    const ts = body.tick_shadow_b;
    if(ts.intraday) for(const key of Object.keys(ts.intraday)){
      await sPut(env, "market/shadow_tick_b/intraday/"+key+".json",
        doc({rows:ts.intraday[key], src:(body._prov||{}).source||null, updated:now}));
      n++;
    }
    if(ts.foreign){
      await sPut(env, "market/shadow_tick_b/foreign.json",
        doc({by_symbol:ts.foreign, src:(body._prov||{}).source||null, updated:now}));
      n++;
    }
    if(ts.status){
      await sPut(env, "market/shadow_tick_b/status.json", doc(Object.assign({}, ts.status, {updated:now})));
      n++;
    }
    // Dot 2 (thiet ke tong the bo thu): raw tick chunks (gzip
    // JSONL, base64) + artifact theo nguon — van duoi prefix
    // shadow_tick, khong consumer production nao doc.
    if(ts.raw_chunks){
      const day = (ts.status && ts.status.session_date) || now.slice(0, 10);
      for(const src of Object.keys(ts.raw_chunks)){
        if(!/^[a-z0-9-]+$/.test(src)) continue;
        for(const hour of Object.keys(ts.raw_chunks[src])){
          if(!/^[0-9]{2}$/.test(hour)) continue;
          const b64 = ts.raw_chunks[src][hour];
          if(typeof b64 !== "string" || !b64) continue;
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          await env.DATA.put("stock/market/shadow_tick_b/raw/"+day+"/"+src+"/"+hour+"/"+Date.now()+".jsonl.gz",
            bytes, {httpMetadata:{contentType:"application/gzip"}});
          n++;
        }
      }
    }
    if(ts.src_artifacts){
      for(const src of Object.keys(ts.src_artifacts)){
        if(!/^[a-z0-9-]+$/.test(src)) continue;
        const a = ts.src_artifacts[src] || {};
        if(a.snapshot){
          await sPut(env, "market/shadow_tick_b/src/"+src+"/snapshot.json",
            doc(Object.assign({}, a.snapshot, {src, updated:now})));
          n++;
        }
        if(a.health){
          await sPut(env, "market/shadow_tick_b/src/"+src+"/health.json",
            doc(Object.assign({}, a.health, {src, updated:now})));
          n++;
        }
        const hasBk = a.buckets_dirty && Object.keys(a.buckets_dirty).length;
        const hasPt = a.buckets_pt_dirty && Object.keys(a.buckets_pt_dirty).length;
        if(hasBk || hasPt){
          const bkey = "market/shadow_tick_b/src/"+src+"/buckets.json";
          const cur = await sGet(env, bkey) || {buckets:{}};
          const bk = cur.buckets || {};
          const bp = cur.buckets_pt || {};
          // Chi giu phut cua phien hien tai (session_date trong
          // status cua cung payload): buckets.json khong tich luy
          // qua phien -> resume chi thay dung phien dang chay, va
          // object khong phinh theo ngay.
          const sessDay = (ts.status && ts.status.session_date) || null;
          if(sessDay){
            for(const coll of [bk, bp]){
              for(const sym of Object.keys(coll)){
                for(const mk of Object.keys(coll[sym])){
                  if(!mk.startsWith(sessDay)) delete coll[sym][mk];
                }
                if(!Object.keys(coll[sym]).length) delete coll[sym];
              }
            }
          }
          if(hasBk) for(const sym of Object.keys(a.buckets_dirty)){
            bk[sym] = Object.assign({}, bk[sym] || {}, a.buckets_dirty[sym]);
          }
          if(hasPt) for(const sym of Object.keys(a.buckets_pt_dirty)){
            bp[sym] = Object.assign({}, bp[sym] || {}, a.buckets_pt_dirty[sym]);
          }
          await sPut(env, bkey, doc({buckets:bk, buckets_pt:bp, src, updated:now}));
          n++;
        }
      }
    }
  }catch(e){ tickErrors.push({block:"tick_shadow_b", error:String((e&&e.message)||e).slice(0,200)}); } }
  // Canh bao bat bien (Chot 21:58 27/10): payload tick_shadow co raw
  // chunk nhung rong buckets/intraday 2 chu ky lien tiep -> dem canh
  // bao vao tra loi.
  if(body.tick_shadow && !tickErrors.some(e=>e.block==="tick_shadow")){
    const _ts = body.tick_shadow;
    let _rawChunks = 0;
    if(_ts.raw_chunks && typeof _ts.raw_chunks === "object")
      for(const _src of Object.keys(_ts.raw_chunks))
        _rawChunks += Object.keys(_ts.raw_chunks[_src] || {}).length;
    let _bkMin = 0;
    if(_ts.src_artifacts && typeof _ts.src_artifacts === "object")
      for(const _src of Object.keys(_ts.src_artifacts)){
        const _a = _ts.src_artifacts[_src] || {};
        for(const _k of ["buckets_dirty", "buckets_pt_dirty"])
          for(const _s of Object.keys(_a[_k] || {}))
            _bkMin += Object.keys(_a[_k][_s] || {}).length;
      }
    let _intraRows = 0;
    if(_ts.intraday && typeof _ts.intraday === "object")
      for(const _k of Object.keys(_ts.intraday))
        _intraRows += Array.isArray(_ts.intraday[_k]) ? _ts.intraday[_k].length : 0;
    const _srcKey = (prov && prov.source) || "tick";
    const _inv = _tickInvariant.get(_srcKey) || {streak:0, total:0};
    if(_rawChunks > 0 && _bkMin === 0 && _intraRows === 0){
      _inv.streak += 1;
      if(_inv.streak >= 2){
        _inv.total += 1;
        const _msg = "tick publish invariant: raw>0 but buckets/intraday empty "
          + _inv.streak + " cycles (source=" + _srcKey + ")";
        tickAlerts.push(_msg);
        console.error(_msg);
      }
    } else _inv.streak = 0;
    _tickInvariant.set(_srcKey, _inv);
  }
  // Canh bao bat bien (Chot 21:58 27/10): payload tick_shadow_b co raw
  // chunk nhung rong buckets/intraday 2 chu ky lien tiep -> dem canh
  // bao vao tra loi.
  if(body.tick_shadow_b && !tickErrors.some(e=>e.block==="tick_shadow_b")){
    const _ts = body.tick_shadow_b;
    let _rawChunks = 0;
    if(_ts.raw_chunks && typeof _ts.raw_chunks === "object")
      for(const _src of Object.keys(_ts.raw_chunks))
        _rawChunks += Object.keys(_ts.raw_chunks[_src] || {}).length;
    let _bkMin = 0;
    if(_ts.src_artifacts && typeof _ts.src_artifacts === "object")
      for(const _src of Object.keys(_ts.src_artifacts)){
        const _a = _ts.src_artifacts[_src] || {};
        for(const _k of ["buckets_dirty", "buckets_pt_dirty"])
          for(const _s of Object.keys(_a[_k] || {}))
            _bkMin += Object.keys(_a[_k][_s] || {}).length;
      }
    let _intraRows = 0;
    if(_ts.intraday && typeof _ts.intraday === "object")
      for(const _k of Object.keys(_ts.intraday))
        _intraRows += Array.isArray(_ts.intraday[_k]) ? _ts.intraday[_k].length : 0;
    const _srcKey = (prov && prov.source) || "tick";
    const _inv = _tickInvariant.get(_srcKey) || {streak:0, total:0};
    if(_rawChunks > 0 && _bkMin === 0 && _intraRows === 0){
      _inv.streak += 1;
      if(_inv.streak >= 2){
        _inv.total += 1;
        const _msg = "tick publish invariant: raw>0 but buckets/intraday empty "
          + _inv.streak + " cycles (source=" + _srcKey + ")";
        tickAlerts.push(_msg);
        console.error(_msg);
      }
    } else _inv.streak = 0;
    _tickInvariant.set(_srcKey, _inv);
  }
  // Merger tach (Dot 3): ban hop nhat theo truong + verdict
  // conformance chi ghi duoi market/shadow_tick/merged/ — khong
  // consumer production nao doc, khong ghi khoa production.
  if(body.tick_merged){ try{
    const tm = body.tick_merged;
    if(tm.intraday) for(const key of Object.keys(tm.intraday)){
      await sPut(env, "market/shadow_tick/merged/intraday/"+key+".json",
        doc({rows:tm.intraday[key], src:(body._prov||{}).source||null, updated:now}));
      n++;
    }
    if(tm.foreign){
      await sPut(env, "market/shadow_tick/merged/foreign.json",
        doc({by_symbol:tm.foreign, src:(body._prov||{}).source||null, updated:now}));
      n++;
    }
    if(tm.status){
      await sPut(env, "market/shadow_tick/merged/status.json", doc(Object.assign({}, tm.status, {updated:now})));
      n++;
    }
  }catch(e){ tickErrors.push({block:"tick_merged", error:String((e&&e.message)||e).slice(0,200)}); } }
  // Bo thu tick DA CONG — ban LAT (Chot Henrry 19:39 21/10): du lieu
  // hop nhat DNSE+KBS+VNDirect+VPS ghi thang production. Intraday ->
  // market/intraday/ (cung khoa voi nhanh intraday thuong). Khoi
  // ngoai MERGE vao market/foreign_flow.json: chi de cac ma cua bo
  // thu (40 ma), giu nguyen moi ma con lai do luong publish cham ghi.
  if(body.tick_live){ try{
    const tl = body.tick_live;
    if(tl.intraday) for(const key of Object.keys(tl.intraday)){
      await sPut(env, "market/intraday/"+key+".json", doc({rows:tl.intraday[key]}));
      n++;
    }
    if(tl.foreign && Object.keys(tl.foreign).length){
      const cur = await sGet(env, "market/foreign_flow.json") || {by_symbol:{}};
      const merged = Object.assign({}, cur.by_symbol || {}, tl.foreign);
      await sPut(env, "market/foreign_flow.json", doc({by_symbol:merged}));
      n++;
    }
  }catch(e){ tickErrors.push({block:"tick_live", error:String((e&&e.message)||e).slice(0,200)}); } }
  // Chan VCI doc lap Tang B (Chot 19:39 21/10): chay tren ha tang
  // OVH/Botkeep (Modal bi VCI chan 403) — nguon ngoai DU BO thu hai.
  // Chi ghi shadow rieng market/shadow_tick/vci/ de doi chieu +
  // bao cao do on dinh; KHONG dung du lieu production.
  if(body.tick_vci){ try{
    const tv = body.tick_vci;
    if(tv.intraday) for(const key of Object.keys(tv.intraday)){
      await sPut(env, "market/shadow_tick/vci/intraday/"+key+".json", doc({rows:tv.intraday[key]}));
      n++;
    }
    if(tv.foreign){
      await sPut(env, "market/shadow_tick/vci/foreign.json", doc({by_symbol:tv.foreign, src:(body._prov||{}).source||null, updated:now}));
      n++;
    }
    if(tv.status){
      await sPut(env, "market/shadow_tick/vci/status.json", doc(Object.assign({}, tv.status, {updated:now})));
      n++;
    }
  }catch(e){ tickErrors.push({block:"tick_vci", error:String((e&&e.message)||e).slice(0,200)}); } }
  // KE SHELF 27/10 (Chot 09:59): batch EOD publish lich su nhom NDT.
  // Payload: {"flow_history": {"foreign": {SYM: [rows]},
  //   "proprietary": {SYM: [rows]}}} — row: {date, buy_vol, sell_vol,
  //   buy_val, sell_val}, gia tri co the null khi nguon thieu (khong
  //   dien 0). Moi ma ghi 1 file stock/flow/<group>/<SYM>.json, merge
  //   theo ngay (cung ngay publish lai thi ghi de), sap xep tang dan,
  //   giu toi da 500 ngay. API /api/stock/flow-history doc file nay.
  if(body.flow_history){
    for(const group of FLOW_GROUPS){
      const bySym = body.flow_history[group];
      if(!bySym || typeof bySym !== "object") continue;
      for(const symRaw of Object.keys(bySym)){
        const sym = String(symRaw).toUpperCase();
        if(!OB_SYM_RE.test(sym)) continue;
        const days = bySym[symRaw];
        if(!Array.isArray(days) || !days.length) continue;
        const fkey = "flow/" + group + "/" + sym + ".json";
        const cur = await sGet(env, fkey) || {rows: []};
        const byDate = {};
        for(const r of (cur.rows || [])){
          const nr = obNormalizeFlowRow(r);
          if(nr) byDate[nr.date] = nr;
        }
        for(const r of days){
          const nr = obNormalizeFlowRow(r);
          if(nr) byDate[nr.date] = nr;
        }
        const merged = Object.values(byDate)
          .sort((a, b)=> (a.date || "").localeCompare(b.date || ""))
          .slice(-500);
        await sPut(env, fkey, doc({symbol: sym, group, rows: merged}));
        n++;
      }
    }
  }
  if(tickErrors.length){
    return jerr("Publish block failed", 502,
      {written:n, errors:tickErrors, alerts:tickAlerts});
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
  return sJson(Object.assign({ok:true, written:n},
    tickAlerts.length ? {alerts:tickAlerts} : {}));
}


/* ---------- internal: Modal bao loi -> Telegram ---------- */
/* Doc artifact shadow_tick (resume Dot 2 cua bo thu): route
   internal da kiem X-Internal-Secret o router. key rong ->
   status.json; key khac chi duoc nam duoi prefix shadow_tick. */
export async function hTickStateGet(request, env){
  const key = (new URL(request.url).searchParams.get("key") || "").trim();
  if(!key){
    const d = await sGet(env, "market/shadow_tick/status.json");
    return sJson(d || {});
  }
  if(key.includes("..") || !/^[a-z0-9/_.-]+$/.test(key)){
    return jerr("Bad key", 400);
  }
  const d = await sGet(env, "market/shadow_tick/" + key);
  return sJson(d || {});
}

// Universe duy nhat (lenh Henrry 17:40 28/10): collector + code moi doc
// market/universe.json luc mo phien. Chua co file -> {} (ben doc tu phan
// biet thieu file vs file loi, roi fallback theo hop dong).
export async function hInternalUniverse(request, env){
  const d = await sGet(env, "market/universe.json");
  return sJson(d || {});
}

// Lich quyen (Phuong an B, Chot 10:33 29/10): file versioned do job
// 07:30 day len R2; app render muc Lich quyen, khong Telegram.
export async function hCorporateActions(request, env){
  const d = await sGet(env, "market/corporate_actions.json");
  return sJson(d || {});
}

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
  // 2026-10-20: ghi thang D1 — targets song o D1 (cot tp_done/sl_done).
  // Ban cu doc/ghi qua uGet/uPut (duong R2) nen co bao xong khong bao
  // gio luu duoc vao noi targets that dang nam.
  const db = drizzle(env.DB);
  await db.update(targets).set(field === "tp_done" ? {tpDone: 1} : {slDone: 1})
    .where(and(eq(targets.email, email), eq(targets.symbol, symbol)));
  return sJson({ok:true});
}

// One-time migration: R2 -> D1 (protected by internal secret)

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
