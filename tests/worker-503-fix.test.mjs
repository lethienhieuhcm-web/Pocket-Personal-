// worker-503-fix (2026/11-04) — 503/Cloudflare 1102.
// Test bon muc cua patch trong worker/src/stock.js:
//   (1) cachedCompute + edge-cache /api/stock/screener (TTL 60s, 1 compute/TTL)
//   (2) buildScreenerView o phia publish == ket qua duong tinh cu (reference
//       d15188a, chep nguyen algorithm duoi day)
//   (4) vong ghi R2 per-symbol trong hStockPublish chay SONG SONG (max in-flight
//       > 1) va ket qua ghi khong doi
//   (8) log `[publish]` tung POST: so lan ghi theo nhom/theo symbol, khong secret
// Run: node tests/worker-503-fix.test.mjs
import { register } from "node:module";
register("./flow-hooks.mjs", import.meta.url);

const { hStockPublish, hStockScreener, buildScreenerView, cachedCompute } =
  await import("../worker/src/stock.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}
function eq(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

// ---------- R2 mock ----------
function mkStore(){ return new Map(); }
function mkEnv(store, opts){
  opts = opts || {};
  return {
    DATA: {
      get: async (key)=>{
        opts.reads = (opts.reads || 0) + 1;
        const v = store.get(key);
        if(v === undefined) return null;
        return { json: async ()=> JSON.parse(JSON.stringify(v)) };
      },
      put: async (key, val)=>{
        if(opts.trace){
          opts.inflight++;
          opts.maxInflight = Math.max(opts.maxInflight || 0, opts.inflight);
          await new Promise((r)=> setTimeout(r, 2));
          opts.inflight--;
        }
        store.set(key, typeof val === "string" ? JSON.parse(val) : val);
      },
    },
    STOCK_PUBLISH_SECRET: "s3cr3t",
    INTERNAL_SECRET: "s3cr3t",
    MARKET_ROOM: null,
    ABLY_ROOT_KEY: null,
  };
}
const pubReq = (body)=>({
  headers: { get: (k)=> (k === "X-Publish-Secret" ? "s3cr3t" : null) },
  json: async ()=> body,
});
const getReq = (path)=>({ url: "https://lethanhdong.one" + path });
// (2) rebuild nam trong ctx.waitUntil -> harness phai "flush" cac task
// (gia lap Workers ctx.waitUntil + xong response) truoc khi doc store.
async function pub(body, env){
  const tasks = [];
  const res = await hStockPublish(pubReq(body), env, null,
    { waitUntil: (p)=>{ tasks.push(p); } });
  res._tasks = tasks;
  return res;
}
const flush = (res)=>Promise.all(res._tasks || []);
const ICT_TODAY = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Ho_Chi_Minh"}).format(new Date());

// ---------- du lieu nen ----------
const SYMS = ["AAA","BBB","CCC","DDD","EEE","FFF"];
function screenerDoc(){
  return { updated: "2026-11-04T01:00:00Z", rows: SYMS.map((s, i)=>({
    symbol: s, exchange: i % 2 ? "HNX" : "HOSE",
    close: 10 + i * 7,              // NGHIN dong (chuan screener.json)
    change: i - 2, pct_change: (i - 2) * 0.5,
    volume: 100000 * (i + 1), value_vnd: 9e9 * (i + 1),
    updated_at: ICT_TODAY,
  })) };
}
function fundamentalsDoc(){
  const by_symbol = {};
  SYMS.forEach((s, i)=>{ by_symbol[s] = { eps: 5000 + i*100, bvps: 20000, roe: 0.1 + i*0.01,
    industry: "Nganh " + i, net_margin: 0.2, roa: 0.05, debt_to_equity: 0.8, altman_z: 3.1, piotroski: 7 }; });
  return { by_symbol };
}
function quotesDoc(){
  const by_symbol = {};
  SYMS.forEach((s, i)=>{ by_symbol[s] = { close: (10 + i*7) * 1000,   // DONG
    foreign_buy_value: 5e9 + i, foreign_sell_value: 2e9 }; });
  return { by_symbol };
}

// ---------- REFERENCE: toan bo duong tinh CUA hStockScreener (base d15188a) ----------
// Chap nguyen thuat toan cu de so sanh bang — day la "shape + gia tri" ma patch
// khong duoc phep doi. (sScoreRows/applyStaleGate lay tu chinh module.)
const { sScoreRows } = await import("../worker/src/stock.js");
function refGate(rows, today){
  let staleCount = 0;
  for(const r of rows){
    const v = r.time || r.updated_at || r.date || r.as_of || null;
    let rd = null;
    if(v){
      const s = String(v);
      if(/^\d{4}-\d{2}-\d{2}$/.test(s)) rd = s;
      else{
        const dt = new Date(s);
        rd = isNaN(dt) ? null : new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Ho_Chi_Minh"}).format(dt);
      }
    }
    if(rd !== today){
      r.stale = true; r.as_of = rd || (r.time || r.updated_at || null);
      if("change" in r) r.change = null;
      r.pct_change = null;
      staleCount++;
    }
  }
  return { session_date: today, stale: staleCount > 0, stale_count: staleCount };
}
async function refScreener(request, env){
  const u = new URL(request.url, "https://lethanhdong.one");
  const sget = async (key)=>{
    const o = await env.DATA.get("stock/" + key);
    return o ? await o.json() : null;
  };
  const d = await sget("market/screener.json");
  let rows = (d && d.rows) || [];
  const ex = (u.searchParams.get("exchange")||"").toUpperCase();
  const minP = parseFloat(u.searchParams.get("min_pct")), maxP = parseFloat(u.searchParams.get("max_pct"));
  const minV = parseFloat(u.searchParams.get("min_volume")), minVal = parseFloat(u.searchParams.get("min_value"));
  if(ex) rows = rows.filter(r=>(r.exchange||"").toUpperCase()===ex);
  const baseRows = rows;
  if(!isNaN(minP)) rows = rows.filter(r=>r.pct_change!=null && r.pct_change>=minP);
  if(!isNaN(maxP)) rows = rows.filter(r=>r.pct_change!=null && r.pct_change<=maxP);
  if(!isNaN(minV)) rows = rows.filter(r=>(r.volume||0)>=minV);
  if(!isNaN(minVal)) rows = rows.filter(r=>(r.value_vnd||0)>=minVal);
  const sort = u.searchParams.get("sort")||"value_vnd", order = u.searchParams.get("order")||"desc";
  rows = [...rows].sort((a,b)=>{ const av=a[sort]??-1e18, bv=b[sort]??-1e18; return order==="asc"? av-bv : bv-av; });
  const out = u.searchParams.get("all") ? rows.slice(0,2000) : rows.slice(0,500);
  const fd = await sget("market/fundamentals.json");
  const qt = await sget("market/quotes.json");
  const funds = (fd && fd.by_symbol) || {};
  const bySym = (qt && qt.by_symbol) || {};
  for(const r of out){
    const f = funds[r.symbol], q = bySym[r.symbol];
    if(f){
      if(f.eps>0 && r.close) r.pe_ttm = Math.round(r.close*1000/f.eps*100)/100;
      if(f.bvps>0 && r.close) r.pb = Math.round(r.close*1000/f.bvps*100)/100;
      if(f.roe!=null) r.roe_ttm = f.roe;
      r.industry = f.industry ?? null;
      r.eps = f.eps ?? null; r.bvps = f.bvps ?? null;
      r.roa = f.roa ?? null; r.net_margin = f.net_margin ?? null;
      r.debt_to_equity = f.debt_to_equity ?? null;
      r.altman_z = f.altman_z ?? null; r.piotroski = f.piotroski ?? null;
    }
    if(q && q.foreign_buy_value!=null && q.foreign_sell_value!=null)
      r.foreign_net_value = q.foreign_buy_value - q.foreign_sell_value;
  }
  const closes = {};
  for(const k of Object.keys(bySym)) closes[k] = bySym[k].close;
  let cand = baseRows.filter(r=>(r.close||0) >= 10);
  cand = [...cand].sort((a,b)=>((b.value_vnd||0)-(a.value_vnd||0))).slice(0,200);
  const scored = sScoreRows(cand.map(r=>Object.assign({},r)), funds, closes);
  const scoreBy = {};
  for(const r of scored) if(r.score!=null) scoreBy[r.symbol] = r.score;
  for(const r of out) if(scoreBy[r.symbol]!=null) r.score = scoreBy[r.symbol];
  const gate = refGate(out, ICT_TODAY);
  return {updated:d?d.updated:null, session_date:gate.session_date, stale:gate.stale,
    stale_count:gate.stale_count, count:rows.length, rows:out};
}

// ---------- (2) view == duong tinh cu ----------
const store = mkStore();
store.set("stock/market/screener.json", screenerDoc());
store.set("stock/market/fundamentals.json", fundamentalsDoc());
store.set("stock/market/quotes.json", quotesDoc());
const envRead = mkEnv(store);

const QUERIES = [
  "/api/stock/screener",
  "/api/stock/screener?all=1",
  "/api/stock/screener?sort=close&order=asc",
  "/api/stock/screener?sort=pct_change&order=desc&all=1",
  "/api/stock/screener?min_value=20000000000",
  "/api/stock/screener?min_pct=0",
  "/api/stock/screener?min_volume=200000&max_pct=1",
];
const refOut = {};
for(const q of QUERIES) refOut[q] = await refScreener(getReq(q), envRead);

// (a) chua co view -> fallback duong cu, khong 500
const noView = await (await hStockScreener(getReq(QUERIES[0]), envRead)).json();
check("(2) khong view -> fallback = duong cu", eq(noView, refOut[QUERIES[0]]), {got: noView});

// (b) publish lane co screener/fundamentals/quotes -> sinh screener_view.json
const pubStore = mkStore();
const rSnap = await pub({
  screener: screenerDoc().rows, fundamentals: fundamentalsDoc().by_symbol,
  quotes: quotesDoc().by_symbol, _prov: {source: "test:snapshot"},
}, mkEnv(pubStore));
check("(2) rebuild nam trong ctx.waitUntil (POST khong cho CPU nang)",
  rSnap._tasks.length === 1 && !pubStore.has("stock/market/screener_view.json"),
  {tasks: rSnap._tasks.length, keys: [...pubStore.keys()]});
await flush(rSnap);
const viewDoc = pubStore.get("stock/market/screener_view.json");
check("(2) publish sinh market/screener_view.json", !!viewDoc && Array.isArray(viewDoc.rows) && viewDoc.rows.length === SYMS.length,
  {keys: [...pubStore.keys()]});
check("(2) view da enrich (pe_ttm + foreign_net_value + score)",
  !!viewDoc && viewDoc.rows.every((r)=> "pe_ttm" in r && "foreign_net_value" in r && "score" in r),
  viewDoc && viewDoc.rows[0]);
check("(2) POST co screener: src_updated = updated vua ghi cua screener.json",
  !!viewDoc && viewDoc.src_updated === pubStore.get("stock/market/screener.json").updated,
  {src_updated: viewDoc && viewDoc.src_updated, blob: pubStore.get("stock/market/screener.json").updated});
// (b2) lane KHONG gui screener (chi fundamentals/quotes): view dung lai
// blob screener.json trong R2 -> src_updated = timestamp cua blob ay.
const pubStore2 = mkStore();
pubStore2.set("stock/market/screener.json", screenerDoc());
await flush(await pub({
  fundamentals: fundamentalsDoc().by_symbol, quotes: quotesDoc().by_symbol,
  _prov: {source: "test:flow"},
}, mkEnv(pubStore2)));
const viewFlow = pubStore2.get("stock/market/screener_view.json");
check("(2) rebuild khong screener: src_updated = updated cua blob",
  !!viewFlow && viewFlow.src_updated === "2026-11-04T01:00:00Z",
  {src_updated: viewFlow && viewFlow.src_updated});
const viewParity = (viewFlow && viewFlow.rows) ? viewFlow : viewDoc;
{
  const s2 = mkStore();
  await hStockPublish(pubReq({tape: {AAA: {n_trades: 1}}, _prov: {source: "test:tape"}}),
    mkEnv(s2), null, { waitUntil: ()=>{} });
  check("(2) lane tape 30s KHONG kich rebuild view", !s2.has("stock/market/screener_view.json"), [...s2.keys()]);
}

// (c) co view -> duong doc chi con 1 sGet + gate, va KET QUA GUNG duong cu
for(const q of QUERIES){
  const s3 = mkStore();
  s3.set("stock/market/screener.json", screenerDoc());
  s3.set("stock/market/fundamentals.json", fundamentalsDoc());
  s3.set("stock/market/quotes.json", quotesDoc());
  s3.set("stock/market/screener_view.json", viewParity);
  const env3 = mkEnv(s3);
  const got = await (await hStockScreener(getReq(q), env3)).json();
  check("(2) view path trung duong cu: " + q, eq(got, refOut[q]), {got, want: refOut[q]});
}
{
  // dem subrequest: view path doc DUNG 1 blob (view), duong cu doc 3
  const s4 = mkStore();
  s4.set("stock/market/screener.json", screenerDoc());
  s4.set("stock/market/fundamentals.json", fundamentalsDoc());
  s4.set("stock/market/quotes.json", quotesDoc());
  s4.set("stock/market/screener_view.json", viewDoc);
  const keys = [];
  const env4 = { DATA: { get: async (key)=>{ keys.push(key); const v = s4.get(key);
      return v === undefined ? null : { json: async ()=> JSON.parse(JSON.stringify(v)) }; },
      put: async ()=>{} }, STOCK_PUBLISH_SECRET: "s3cr3t" };
  await hStockScreener(getReq("/api/stock/screener"), env4);
  check("(2) view path chi 1 R2 GET (cu: 3)", keys.length === 1 && keys[0] === "stock/market/screener_view.json", keys);
}

// ---------- (1) edge cache ----------
{
  const s5 = mkStore();
  s5.set("stock/market/screener_view.json", viewDoc);
  const env5 = mkEnv(s5);
  let produces = 0;
  // Cache API gia (Workers caches.default)
  const bucket = new Map();
  globalThis.caches = { default: {
    match: async (req)=> bucket.get(req.url) || undefined,
    put: async (req, resp)=>{ bucket.set(req.url, resp); },
  } };
  const r1 = await cachedCompute(getReq("https://x/y?a=1"), 60, async ()=>{ produces++; return new Response("A", {status:200, headers:{"Content-Type":"application/json"}}); });
  const r2 = await cachedCompute(getReq("https://x/y?a=1"), 60, async ()=>{ produces++; return new Response("B", {status:200, headers:{"Content-Type":"application/json"}}); });
  const r3 = await cachedCompute(getReq("https://x/y?a=2"), 60, async ()=>{ produces++; return new Response("C", {status:200}); });
  check("(1) cung URL trong TTL -> produce chay 1 lan", produces === 2, {produces});
  check("(1) URL khac -> khoi dung chung", (await r3.text()) === "C");
  check("(1) hit tra ve noi dung lan tinh dau", (await r2.text()) === "A");
  check("(1) Cache-Control max-age=60", /max-age=60/.test(r1.headers.get("Cache-Control")), r1.headers.get("Cache-Control"));
  // handler that: 2 luot goi /screener cung URL -> R2 chi doc 1 lan
  let gets = 0;
  const envCount = { DATA: { get: async (key)=>{ gets++; const v = s5.get(key);
      return v === undefined ? null : { json: async ()=> JSON.parse(JSON.stringify(v)) }; },
      put: async ()=>{} }, STOCK_PUBLISH_SECRET: "s3cr3t" };
  await hStockScreener(getReq("/api/stock/screener"), envCount);
  await hStockScreener(getReq("/api/stock/screener"), envCount);
  check("(1) 2 luot GET /screener -> 1 luot tinh", gets === 1, {gets});
  delete globalThis.caches;
}

// ---------- (4) song song hoa vong ghi R2 ----------
{
  const s6 = mkStore();
  const opts = {trace: true, inflight: 0, maxInflight: 0};
  const tape = {};
  for(const sym of SYMS.concat(["GGG","HHH","III","JKL"])) tape[sym] = {n_trades: 3, trades: []};
  const res = await hStockPublish(pubReq({tape, _prov: {source: "test:tape"}}), mkEnv(s6, opts), null, { waitUntil: ()=>{} });
  const j = await res.json();
  check("(4) vong tape ghi SONG SONG (max in-flight > 1)", (opts.maxInflight || 0) > 1, opts.maxInflight);
  check("(4) du 25 file tape + written dung", Object.keys(tape).every((sym)=> s6.has("stock/market/tape/"+sym+".json")) && j.written === Object.keys(tape).length, j);
  check("(4) noi dung ghi giu nguyen", eq(s6.get("stock/market/tape/AAA.json").n_trades, 3), s6.get("stock/market/tape/AAA.json"));
}
{
  // Intraday + holders + events + ohlcv cung song song, va thu tu key khong doi
  const s7 = mkStore();
  const opts = {trace: true, inflight: 0, maxInflight: 0};
  const body = {
    intraday: {AAA_1m: [{t: "x"}], BBB_1m: [{t: "y"}], CCC_1m: [{t: "z"}]},
    events: {AAA: [1], BBB: [2]},
    ohlcv: {AAA: [1], BBB: [2]},
    tick_merged: {intraday: {AAA_1m: [{t: "m"}], BBB_1m: [{t: "n"}]}},
    _prov: {source: "test:multi"},
  };
  const j = await (await hStockPublish(pubReq(body), mkEnv(s7, opts), null, { waitUntil: ()=>{} })).json();
  check("(4) cac vong per-symbol khac cung song song", (opts.maxInflight || 0) > 1, opts.maxInflight);
  check("(4) du key intraday/events/ohlcv/merged",
    ["stock/market/intraday/AAA_1m.json","stock/market/intraday/CCC_1m.json","stock/market/events/BBB.json",
     "stock/market/ohlcv/AAA.json","stock/market/shadow_tick/merged/intraday/BBB_1m.json"]
      .every((k)=> s7.has(k)), [...s7.keys()]);
  check("(4) written = tong so lan ghi", j.written === 9, j);
}
{
  // RMW cung mot key van tuan tu: quotes_patch merge + foreign_flow.json merge
  const s8 = mkStore();
  s8.set("stock/market/quotes.json", {by_symbol: {ZZZ: {close: 100}}});
  s8.set("stock/market/foreign_flow.json", {by_symbol: {ZZZ: {buy_volume: 1}}});
  await hStockPublish(pubReq({
    quotes_patch: {AAA: {close: 200}},
    tick_live: {foreign: {BBB: {buy_volume: 5}}},
    _prov: {source: "test:rmw"},
  }), mkEnv(s8), null, { waitUntil: ()=>{} });
  const q = s8.get("stock/market/quotes.json").by_symbol;
  const ff = s8.get("stock/market/foreign_flow.json").by_symbol;
  check("(4) read-modify-write giu du phan cu (quotes)", q.ZZZ && q.ZZZ.close === 100 && q.AAA.close === 200, q);
  check("(4) read-modify-write giu du phan cu (foreign_flow)", ff.ZZZ && ff.BBB, ff);
}
{
  // Loi ghi R2 van fail-fast nhu vong tuan tu cu (khong ping lang an ghi de)
  const bad = { DATA: { get: async ()=> null, put: async (k)=>{ if(k.indexOf("tape/CCC") >= 0) throw new Error("R2 500"); } },
    STOCK_PUBLISH_SECRET: "s3cr3t" };
  let threw = false;
  try{ await hStockPublish(pubReq({tape: {AAA: {n:1}, BBB: {n:1}, CCC: {n:1}}, _prov: {source: "test:err"}}), bad, null, { waitUntil: ()=>{} }); }
  catch(e){ threw = true; }
  check("(4) loi R2 van nem (fail-fast nhu cu)", threw);
}

// ---------- (8) log publish ----------
{
  const s9 = mkStore();
  const lines = [];
  const origErr = console.error;
  console.error = (m)=> lines.push(String(m));
  try{
    const tape = {};
    for(const sym of SYMS) tape[sym] = {n_trades: 1};
    await hStockPublish(pubReq({tape, indices: [{symbol:"VNINDEX"}], _prov: {source: "test:log"}}),
      mkEnv(s9), null, { waitUntil: ()=>{} });
  } finally { console.error = origErr; }
  const pub = lines.filter((l)=> l.startsWith("[publish]"));
  check("(8) co 1 dong [publish] moi POST", pub.length === 1, lines);
  let o = {};
  try{ o = JSON.parse(pub[0].replace("[publish] ", "")); }catch(e){}
  check("(8) log kieu go [fanout] + tag ok", o.tag === "ok" && o.status === 200, o);
  check("(8) dem ghi theo nhom (tape=6, indices=1)", o.puts && o.puts.tape === 6 && o.puts.indices === 1, o.puts);
  check("(8) dem ghi theo symbol", o.symPuts && Object.keys(o.symPuts).length === 6 && o.symPuts.AAA === 1, o.symPuts);
  check("(8) co nguon + written + ms", o.src === "test:log" && o.written === 7 && typeof o.ms === "number", o);
  check("(8) KHONG log secret", !lines.some((l)=> l.indexOf("s3cr3t") >= 0), lines);
  // loi block (tick_shadow) -> log fail + van tra 502 nhu cu
  const lines2 = [];
  const orig2 = console.error;
  console.error = (m)=> lines2.push(String(m));
  let code = 0;
  try{
    const e = mkEnv(mkStore());
    e.DATA.put = async (k)=>{ if(String(k).indexOf("shadow_tick") >= 0) throw new Error("R2 chai"); };
    const r = await hStockPublish(pubReq({tick_shadow: {status: {session_date: ICT_TODAY}}, _prov: {source: "test:fail"}}),
      e, null, { waitUntil: ()=>{} });
    code = r.status;
  } finally { console.error = orig2; }
  check("(8) POST fail -> log tag fail", lines2.some((l)=> l.startsWith("[publish] ") && l.indexOf('"tag":"fail"') >= 0), lines2);
  check("(8) POST fail -> van 502 nhu cu", code === 502, code);
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
