// Tests cho "Cảnh báo biến động" VNINDEX (±1%, Finhay-style): cong vao
// nhanh `indices` cua hStockPublish -> one-shot Telegram push + card R2,
// state theo phien trong R2 (restart khong replay), route doc public
// /api/stock/market-alert theo pattern cachedMarket.
// Mock R2 + mock fetch (khong Telegram that, khong network, khong deploy).
// Run: node tests/vol-alert.test.mjs
// Minimal Cache API stub (Workers `caches.default` does not exist in Node).
globalThis.caches = {
  default: {
    _m: new Map(),
    async match(req){ const r = this._m.get(req.url); return r ? r.clone() : undefined; },
    async put(req, resp){ this._m.set(req.url, resp.clone()); },
  },
};

import { register } from "node:module";
register("./flow-hooks.mjs", import.meta.url);

const { hStockPublish, hStockMarketAlert, evalMarketAlert,
        MARKET_ALERT_THRESHOLD_PCT, MARKET_ALERT_SYMBOL } =
  await import("../worker/src/stock.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}
check("0.1 THRESHOLD_PCT la mot dinh so = 1.0",
  MARKET_ALERT_THRESHOLD_PCT === 1.0 && MARKET_ALERT_SYMBOL === "VNINDEX");

const TOKEN = "123456:TESTTOKEN-abc";
const CHAT  = "700111222";
const tgSends = [];      // moi lan Worker goi api.telegram.org
globalThis.fetch = async (url, opts) => {
  if(String(url).includes("api.telegram.org/")){
    tgSends.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  return { ok: false, status: 599, json: async () => ({}), text: async () => "" };
};

let getCounts;           // dem DATA.get theo key (kien tra duong doc re)
function mockEnv(store){
  return {
    DATA: {
      get: async (key) => {
        getCounts[key] = (getCounts[key] || 0) + 1;
        const v = store.get(key);
        if(v === undefined) return null;
        return { json: async () => JSON.parse(JSON.stringify(v)), etag: "e1" };
      },
      put: async (key, val) => { store.set(key, JSON.parse(val)); },
    },
    STOCK_PUBLISH_SECRET: "s3cr3t",
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_CHAT_ID: CHAT,
  };
}
const pubReq = (body) => ({
  headers: { get: (k) => (k === "X-Publish-Secret" ? "s3cr3t" : null) },
  json: async () => body,
});
const getReq = (url) => ({ headers: { get: () => null }, url });

// Ngay phien hom nay theo gio ICT — dung DUNG cong thuc cua worker
// (_ictDateNow), khong mock dong ho (giong cac test stale-gate khac).
const ictDate = (d) => new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Ho_Chi_Minh"}).format(d);
const today = ictDate(new Date());
const yesterday = ictDate(new Date(Date.now() - 86400000));
const mkRow = (o) => Object.assign({
  symbol: "VNINDEX", close: 1728.92, open: 1697.71, high: 1730.86, low: 1692.36,
  volume: 533339139, time: today, change: 29.30, pct_change: 1.72,
  prev_close: 1699.62, prev_date: yesterday,
}, o);

const AK = "stock/market/market_alert.json";
const SK = "stock/market/market_alert_state.json";

async function publish(store, rows, ctx){
  getCounts = {};
  const env = mockEnv(store);
  const res = await hStockPublish(pubReq({ indices: rows }), env, null, ctx || null);
  return { res, body: await res.json(), env };
}

// --- 1. Cross +1%: fire 1 lan — Telegram + card + state ---------------------
{
  const store = new Map(); tgSends.length = 0;
  const { body } = await publish(store, [mkRow()]);
  const alert = store.get(AK), state = store.get(SK);
  check("1.1 cross +1.72% -> fired, written indices van 1 (không đổi hợp đồng publish)",
    body.ok === true && body.written === 1 && state && state.fired_up === true && state.fired_down === false, body);
  check("1.2 co DUNG 1 push Telegram", tgSends.length === 1, tgSends.length);
  check("1.3 card R2 dung so live (value/change/pct/session)",
    alert && alert.active === true && alert.direction === "up" &&
    alert.value === 1728.92 && alert.change === 29.30 && alert.pct_change === 1.72 &&
    alert.session_date === today, alert);
  check("1.4 card duoc danh dau fired_at + state luu truoc khi gui (at-most-once)",
    !!alert && !!alert.fired_at && store.has(SK));
  const t = tgSends[0] && tgSends[0].body.text || "";
  check("1.5 noi dung TG tieng Viet: dau bang + gia + % + timestamp ICT + y nghia",
    t.includes("Thị trường biến động mạnh") && t.includes("VNINDEX") &&
    t.includes("1.728,92") && t.includes("+1,72%") && /\d{2}:\d{2} · \d{2}\/\d{2}\/\d{4}/.test(t) &&
    t.includes("Ý nghĩa"), t);
}

// --- 2. Cross -1%: fire chieu xuong (mot lan/chieu) --------------------------
{
  const store = new Map(); tgSends.length = 0;
  await publish(store, [mkRow({ close: 1672.63, change: -26.99, pct_change: -1.59 })]);
  const alert = store.get(AK);
  check("2.1 cross -1.59% -> fired direction down + 1 push",
    tgSends.length === 1 && alert && alert.direction === "down" && alert.pct_change === -1.59, alert);
  // cung phien, chieu nguoc lai van duoc fire (up once, down once)
  await publish(store, [mkRow()]);
  const state = store.get(SK);
  check("2.2 sau do chieu up fire tiep, dung 2 push tong cong",
    tgSends.length === 2 && state.fired_down === true && state.fired_up === true, { tg: tgSends.length, state });
}

// --- 3. Khong replay: same direction, same session ---------------------------
{
  const store = new Map(); tgSends.length = 0;
  await publish(store, [mkRow()]);
  await publish(store, [mkRow({ pct_change: 2.4, change: 40.8 })]);
  await publish(store, [mkRow({ pct_change: 1.1 })]);
  check("3.1 3 luot publish vuot +1% -> van DUNG 1 push, state khong doi",
    tgSends.length === 1 && store.get(SK).fired_up === true);
}

// --- 4. Reset phien moi -------------------------------------------------------
{
  const store = new Map(); tgSends.length = 0;
  await publish(store, [mkRow()]);
  check("4.1 phien hom nay: 1 push", tgSends.length === 1);
  // sang phien mai: state cu (session_date hom qua) -> duoc phep fire lai
  store.set(SK, { session_date: yesterday, fired_up: true, fired_down: true });
  tgSends.length = 0;
  await publish(store, [mkRow()]);
  const state = store.get(SK);
  check("4.2 phien moi -> reset, fire lai dung 1 push, state gan theo ngay moi",
    tgSends.length === 1 && state.session_date === today && state.fired_up === true && state.fired_down === false, state);
}

// --- 5. Chan du lieu stale / thieu -------------------------------------------
{
  const store = new Map(); tgSends.length = 0;
  await publish(store, [mkRow({ time: yesterday, pct_change: 2.0, change: 34.0 })]);   // as_of != hom nay ICT
  await publish(store, [mkRow({ stale: true, pct_change: 2.0 })]);                       // stale flag (hang tran)
  await publish(store, [mkRow({ pct_change: null })]);                                   // pct thieu
  await publish(store, [mkRow({ pct_change: "abc" })]);                                  // pct khong phai so
  await publish(store, [{ symbol: "HNX30", close: 270, pct_change: 2.2, time: today }]); // khong co VNINDEX
  await publish(store, [mkRow({ time: null })]);  // VNINDEX khong co time -> khong xac duoc phien -> chan
  check("5.1 stale/thieu du lieu -> KHONG fire, KHONG ghi card/state",
    tgSends.length === 0 && !store.has(AK) && !store.has(SK), { tg: tgSends.length, keys: [...store.keys()] });
}

// --- 6. Boundary: dung 1.0 fire; 0.99 khong ----------------------------------
{
  const store = new Map(); tgSends.length = 0;
  await publish(store, [mkRow({ pct_change: 0.99, change: 16.83 })]);
  check("6.1 0.99% -> khong fire", tgSends.length === 0 && !store.has(SK));
  await publish(store, [mkRow({ pct_change: 1.0, change: 16.9962 })]);
  check("6.2 dung 1.0% -> fire (nguong >=)", tgSends.length === 1 && store.get(SK).fired_up === true);
  tgSends.length = 0;
  await publish(store, [mkRow({ pct_change: -0.99 })]);
  await publish(store, [mkRow({ pct_change: -1.0, change: -17.0 })]);
  check("6.3 chieu am: -0.99 khong, -1.0 fire",
    tgSends.length === 1 && store.get(SK).fired_down === true);
}

// --- 7. Duong ctx.waitUntil (Worker co ctx): job chay nền, ket qua nhu nhau --
{
  const store = new Map(); tgSends.length = 0;
  const jobs = [];
  await publish(store, [mkRow()], { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
  check("7.1 ctx.waitUntil -> van fire 1 push, publish khong cho TG",
    tgSends.length === 1 && store.get(AK) && store.get(AK).direction === "up");
}

// --- 8. Duong doc /api/stock/market-alert: re, cached, public ----------------
{
  const store = new Map(); tgSends.length = 0;
  await publish(store, [mkRow()]);
  const env = mockEnv(store);
  const u = "https://x/api/stock/market-alert";
  getCounts = {};
  const r1 = await hStockMarketAlert(getReq(u), env);
  const b1 = await r1.json();
  const r2 = await hStockMarketAlert(getReq(u), env);
  check("8.1 route tra dung card (direction/value/pct/ts_ict)",
    r1.status === 200 && b1.active === true && b1.direction === "up" &&
    b1.value === 1728.92 && typeof b1.ts_ict === "string", b1);
  const maGets = getCounts[AK] || 0;
  check("8.2 luot doc thu 2 trung edge-cache -> R2 GET dung 1 lan (doc re)",
    maGets === 1, getCounts);
  check("8.3 Cache-Control public, max-age ngan (60s)",
    /max-age=60/.test(r1.headers.get("Cache-Control") || ""), r1.headers.get("Cache-Control"));
  const r3 = await hStockMarketAlert(getReq("https://y/api/stock/market-alert"), mockEnv(new Map()));
  const b3 = await r3.json();
  check("8.4 chua co alert -> 200 shape trong (frontend an card, khong NaN)",
    r3.status === 200 && (b3.direction === undefined || b3.direction === null), b3);
}

// --- 9. Bao toan: duong rule-alerts per-symbol khong bi cham ------------------
// (Hook chi nhan khoa `indices`; publish quotes/screener KHONG duoc tao file
//  market-alert/state. Cac test rule-alerts hien co van chay trong suite.)
{
  const store = new Map(); tgSends.length = 0;
  getCounts = {};
  await hStockPublish(pubReq({ quotes: { FPT: { close: 100000, pct_change: 5 } } }), mockEnv(store), null, null);
  await hStockPublish(pubReq({ screener: [{ symbol: "FPT", pct_change: 5, updated_at: today }] }), mockEnv(store), null, null);
  check("9.1 publish khong co khoa indices -> khong fire, khong ghi file market-alert",
    tgSends.length === 0 && !store.has(AK) && !store.has(SK) &&
    store.has("stock/market/quotes.json") && store.has("stock/market/screener.json"), [...store.keys()]);
  // evalMarketAlert goi thang khong duoc throw (Worker restart-safe)
  const e = await evalMarketAlert(mockEnv(new Map()), null);
  check("9.2 evalMarketAlert(rows khong hop le) -> {fired:false}, khong throw", e && e.fired === false, e);
}

// --- 10. Khong leak secret ----------------------------------------------------
{
  const store = new Map(); tgSends.length = 0;
  await publish(store, [mkRow()]);
  let leak = false;
  for(const [k, v] of store){
    const s = JSON.stringify(v);
    if(s.includes(TOKEN) || s.includes(CHAT)) leak = true;
  }
  const t = (tgSends[0] && tgSends[0].body.text) || "";
  check("10.1 R2 docs + noi dung TG KHONG chua bot token/chat id", !leak && !t.includes(TOKEN) && !t.includes(CHAT));
}

console.log("---");
console.log("PASS=" + passed + " FAIL=" + failed);
if(failed > 0) process.exit(1);
