// Tests cho M/B per-code trong v-detail (Chot Henrry 10:43 04/11):
// endpoint GET /api/stock/money-flow-trades?symbol=X — doc raw chunk SSI
// cua MA (JSONL row = [src, sym, ts_event, ts_recv, price, vol, acc, side],
// side that "bu"/"sd" da verify live 04/11) va JOIN theo (gia doi dong,
// KL, |dt| <= MF_JOIN_TOL_SEC) voi bang khop lenh DNSE (market/tape/<sym>.json).
// Mock ticks + mock R2 only; no network, no D1, no deploy.
// Run: node tests/money-flow-trades.test.mjs
import { register } from "node:module";
import { gzipSync } from "node:zlib";
register("./flow-hooks.mjs", import.meta.url);

const { mfSsiTicksForSymbol, mfJoinTapeSsi, hStockMoneyFlowTrades,
  hStockMoneyFlowLive, MF_WINDOW_SEC, MF_JOIN_TOL_SEC } = await import("../worker/src/stock.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}
check("tol = 5s", MF_JOIN_TOL_SEC === 5);

// --- 1. mfSsiTicksForSymbol: loc theo ma + cua so + dedup + side ----------
{
  const now = 1762220000, cut = now - MF_WINDOW_SEC;
  const rows = [
    ["ssi-mqtt", "CTD", now - 60, now - 59, 50.5, 1000, 11, "bu"],
    ["ssi-mqtt", "CTD", now - 40, now - 39, 50.5, 2000, 12, "sd"],
    ["ssi-mqtt", "CTD", now - 40, now - 39, 50.5, 2000, 12, "sd"],   // dup acc
    ["ssi-mqtt", "HHP", now - 30, now - 29, 15.0, 500,  21, "bu"],  // ma khac
    ["ssi-mqtt", "CTD", cut - 10, cut -  9, 50.5, 1000, 13, "bu"],  // ngoai cua so
    ["ssi-mqtt", "CTD", now - 20, now - 19, 50.5, 1000, 14, "ZZ"],  // side la
    ["ssi-mqtt", "CTD", now - 10, now -  9, "PUT", {vol: 1}],       // dong PUT 6 cot
    ["dnse",     "CTD", now - 15, now - 14, 50.5, 700,  31, null],  // khong side
    ["ssi-mqtt", "CTD", now + 500, now + 501, 50.5, 100, 32, "bu"], // tuong lai >120s
  ];
  const { ticks, stats } = mfSsiTicksForSymbol(rows, "CTD", cut, now);
  check("loc dung ma, dung cua so, co side that -> 2 ticks",
    ticks.length === 2 && ticks[0].side === "buy" && ticks[1].side === "sell", ticks);
  check("gia/KL/ts giu nguyen de join",
    ticks[0].price === 50.5 && ticks[0].vol === 1000 && ticks[0].ts === now - 60, ticks[0]);
  check("ticks sort tang dan theo ts", ticks[0].ts < ticks[1].ts);
  check("stats: dedup 1, out_of_window 2, other_symbol 1, no_side 1, unk ZZ 1",
    stats.dedup_dropped === 1 && stats.out_of_window === 2 && stats.other_symbol === 1 &&
    stats.no_side === 1 && stats.side_unknown["ZZ"] === 1, stats);
  // sym phai hoa (handler dang uppercase tu URL truoc khi goi)
  check("sym hoa moi khop (handler loai bo case o route)",
    mfSsiTicksForSymbol(rows, "ctd", cut, now).ticks.length === 0);
}

// --- 2. mfJoinTapeSsi: cung gia (doi dong), cung KL, |dt| <= tol ----------
{
  const now = 1762220000;
  const ticks = [
    { ts: now - 60, price: 50.5, vol: 1000, side: "buy" },
    { ts: now - 40, price: 50.5, vol: 2000, side: "sell" },
    { ts: now - 20, price: 11.7, vol: 500,  side: "buy" },
  ];
  const trades = [
    { ts: now - 61, time: "09:29:59", p: 50.5, v: 1000, s: "B" }, // khop, dt=1 -> ghi de tick-rule SAI
    { ts: now - 40, time: "09:30:20", p: 50.5, v: 2000, s: "B" }, // khop het
    { ts: now - 20, time: "09:30:40", p: 11.7, v: 500,  s: "M" }, // float nghin: 11.7*1000 le 11699.999... van khop
    { ts: now - 10, time: "09:31:50", p: 50.5, v: 1000, s: "M" }, // khong co tick cung thoi diem -> khong match
    { ts: now - 60, time: "09:29:00", p: 51.0, v: 1000, s: "M" }, // khac gia -> khong match
    { ts: now - 60, time: "09:29:00", p: 50.5, v: 900,  s: "M" }, // khac KL -> khong match
    { ts: now - 75, time: "09:28:45", p: 50.5, v: 1000, s: "M" }, // |dt|=15 > tol -> khong match
  ];
  const j = mfJoinTapeSsi(trades, ticks, MF_JOIN_TOL_SEC);
  check("join: 3 lenh khop", j.matched === 3, j);
  check("join: side that theo ts (bu->buy du tick-rule noi B)",
    j.trades[0].ts === now - 61 && j.trades[0].side === "buy" &&
    j.trades[1].side === "sell" && j.trades[2].side === "buy", j.trades);
  // tick gan nhat duoc chon khi nhieu tick cung (p,v) trong tol
  const t2 = [
    { ts: now - 100, price: 20, vol: 100, side: "sell" },
    { ts: now - 2,  price: 20, vol: 100, side: "buy" },
  ];
  const j2 = mfJoinTapeSsi([{ ts: now, p: 20, v: 100 }], t2, MF_JOIN_TOL_SEC);
  check("join: chon tick gan thoi diem nhat (buy dt=2 < sell dt=100)",
    j2.matched === 1 && j2.trades[0].side === "buy", j2);
  const j3 = mfJoinTapeSsi([{ ts: null, p: 20, v: 100 }, { ts: now, p: 0, v: 100 }, { ts: now, p: 20, v: null }], t2, MF_JOIN_TOL_SEC);
  check("join: lenh thieu ts/gia/KL bo qua, khong loi", j3.matched === 0);
}

// --- 3. handler end-to-end mock R2 (tape CTD + chunk ssi-mqtt) ------------
function ictNow(){
  const ms = Date.now();
  const ict = new Date(ms + 7 * 3600 * 1000);
  return { date: ict.toISOString().slice(0, 10), hh: String(ict.getUTCHours()).padStart(2, "0"),
    prevHh: String((ict.getUTCHours() + 23) % 24).padStart(2, "0"), sec: Math.floor(ms / 1000) };
}
function mockR2(store){
  return {
    DATA: {
      get: async (key) => {
        const v = store.get(key);
        if(v === undefined) return null;
        if(v instanceof Uint8Array) return { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) };
        return { json: async () => JSON.parse(JSON.stringify(v)) };
      },
      list: async ({ prefix }) => {
        const objects = [...store.keys()].filter(k => k.startsWith(prefix)).map(k => ({ key: k }));
        return { objects, truncated: false, cursor: undefined };
      },
    },
  };
}
const gzLines = (rows) => gzipSync(Buffer.from(rows.map(r => JSON.stringify(r)).join("\n")));

const t = ictNow();
const rawP = "stock/market/shadow_tick/raw/" + t.date + "/ssi-mqtt/";
const store = new Map();
store.set("stock/market/shadow_tick/flow/watchlist/latest.json",
  { for_date: t.date, candidates: [{ symbol: "CTD" }, { symbol: "HHP" }] });
// Tape CTD (dinh dang file collector: gia NGHIN dong, ts giay nguyen, s tick-rule)
const tapeTrades = [
  { ts: t.sec - 120, time: "09:01:00", p: 50.5, v: 1000, s: "M" }, // se khop tick buy
  { ts: t.sec - 100, time: "09:01:20", p: 50.5, v: 2000, s: "B" }, // khop tick sell
  { ts: t.sec - 30,  time: "09:02:30", p: 50.5, v: 700,  s: "M" }, // khong co tick -> fallback
  { ts: t.sec - 20,  time: "09:02:40", p: 50.5, v: 300,  s: null },
];
store.set("stock/market/tape/CTD.json", { symbol: "CTD", date: t.date, source: "dnse",
  side_method: "tick_rule", trades: tapeTrades, total_vol: 4000, buy_vol: 1700, sell_vol: 2000 });
// Tape VCB (ma NGOAI watchlist SSI): co bang khop lenh, khong co chunk nao
store.set("stock/market/tape/VCB.json", { symbol: "VCB", date: t.date, source: "dnse",
  side_method: "tick_rule", trades: [{ ts: t.sec - 60, time: "09:02:00", p: 100.2, v: 100, s: "B" }] });
store.set(rawP + t.hh + "/" + (t.sec * 1000) + ".jsonl.gz", gzLines([
  ["ssi-mqtt", "CTD", t.sec - 121, t.sec - 120, 50.5, 1000, 11, "bu"],
  ["ssi-mqtt", "CTD", t.sec - 100, t.sec -  99, 50.5, 2000, 12, "sd"],
  ["ssi-mqtt", "CTD", t.sec -  99, t.sec -  98, 50.5, 2000, 12, "sd"], // dup acc
  ["ssi-mqtt", "HHP", t.sec -  50, t.sec -  49, 15.0, 500,  21, "bu"],
  ["ssi-mqtt", "XXX", t.sec -  50, t.sec -  49, 20.0, 100,  31, "bu"], // ma la trong chunk
]));
const env = mockR2(store);

{
  const res = await hStockMoneyFlowTrades({ url: "http://w/api/stock/money-flow-trades?symbol=ctd" }, env);
  const body = await res.json();
  check("handler CTD: 200 + available + symbol uppercase",
    res.status === 200 && body.available === true && body.symbol === "CTD", { s: res.status, sym: body.symbol });
  check("handler CTD: tape present + total 4", body.tape.present === true &&
    body.tape.total === 4 && body.tape.side_method === "tick_rule", body.tape);
  check("handler CTD: matched 2, side bu/sd -> buy/sell theo dung ts lenh",
    body.matched === 2 && body.trades.length === 2 &&
    body.trades[0].ts === t.sec - 120 && body.trades[0].side === "buy" &&
    body.trades[1].ts === t.sec - 100 && body.trades[1].side === "sell", body.trades);
  check("handler CTD: dedup acc trong chunk (used 3/4 dong CTD+khac)",
    body.meta.dedup_dropped === 1 && body.ssi_ticks === 2, body.meta);
  check("handler CTD: window 15 phut ISO +07:00, dung gio ICT",
    body.window.minutes === 15 && /\+07:00$/.test(body.window.from) &&
    Math.abs(Date.parse(body.window.to) - Date.now()) <= 2000 &&
    Date.parse(body.window.to) - Date.parse(body.window.from) === 900000, body.window);
  check("handler CTD: meta files_read 1; other_symbol 2 (HHP + XXX khong thuoc CTD)",
    body.meta.files_read === 1 && body.meta.other_symbol === 2, body.meta);
}
{
  // Ma NGOAI watchlist SSI: khong loi, trades rong -> frontend giu tick-rule.
  const res = await hStockMoneyFlowTrades({ url: "http://w/api/stock/money-flow-trades?symbol=VCB" }, env);
  const body = await res.json();
  check("handler VCB (ngoai watchlist): 200, available, matched 0, trades []",
    res.status === 200 && body.available === true && body.matched === 0 &&
    body.trades.length === 0 && body.tape.present === true, body);
}
{
  // Khong co tape file: van 200 + present false (khong 404, khong vo bang).
  const res = await hStockMoneyFlowTrades({ url: "http://w/api/stock/money-flow-trades?symbol=FPT" }, env);
  const body = await res.json();
  check("handler FPT (khong co tape): 200 + tape.present false",
    res.status === 200 && body.available === true && body.tape.present === false &&
    body.tape.total === 0 && body.trades.length === 0, body);
}
{
  const bad1 = await hStockMoneyFlowTrades({ url: "http://w/api/stock/money-flow-trades" }, env);
  const bad2 = await hStockMoneyFlowTrades({ url: "http://w/api/stock/money-flow-trades?symbol=AB" }, env);
  const bad3 = await hStockMoneyFlowTrades({ url: "http://w/api/stock/money-flow-trades?symbol=CTD&date=x" }, env);
  check("400: thieu symbol / symbol qua ngan / date sai",
    bad1.status === 400 && bad2.status === 400 && bad3.status === 400,
    [bad1.status, bad2.status, bad3.status]);
}

// --- 4. khong hoi quy: cung store, money-flow-live van chay + tom tat (a)
//        khop dung so voi tick join duoc (cung nguon, cua so 15 phut) -------
{
  const res = await hStockMoneyFlowLive({ url: "http://w/api/stock/money-flow-live" }, env);
  const body = await res.json();
  const ctd = body.rows.find(r => r.symbol === "CTD");
  const hhp = body.rows.find(r => r.symbol === "HHP");
  const vcb = body.rows.find(r => r.symbol === "VCB");
  check("live: CTD row = buy 1000 CP @50.5, sell 2000 CP @50.5 (dedup), net am",
    ctd && ctd.buy_vol === 1000 && ctd.buy_val === Math.round(50.5 * 1000 * 1000) &&
    ctd.sell_vol === 2000 && ctd.net_val === -Math.round(50.5 * 1000 * 1000) &&
    ctd.flagged === false, ctd);
  check("live: HHP co tick bu 500 CP @15.0 (endpoint live khong bi patch nay doi hanh vi)",
    hhp && hhp.buy_vol === 500 && hhp.buy_val === Math.round(15 * 1000 * 500), hhp);
  check("live: ma ngoai watchlist (VCB) KHONG co row -> frontend hien 'ngoai watchlist'",
    vcb === undefined, body.rows.map(r => r.symbol));
}

// --- 5. replay bang tick LIVE probe SSI WS 04/11 (gia tri side that bu/sd) --
{
  const now = 1793757900, cut = now - MF_WINDOW_SEC;
  // 7 tick da ghi live (mb_probe_ticks.jsonl) -> dung chinh no lam tape
  // (ts nguyen hoan) de kiem join + huong bu/sd.
  const liveRows = [
    ["ssi-mqtt", "QTP", 1793757726.0, 1793757726.441, 11.1, 100, 100, "sd"],
    ["ssi-mqtt", "QTP", 1793757726.0, 1793757726.441, 11.1, 100, 200, "sd"],
    ["ssi-mqtt", "SHS", 1793757779.0, 1793757779.376, 12.4, 1500, 3700, "bu"],
    ["ssi-mqtt", "AAS", 1793757792.0, 1793757792.854, 9.8, 1100, 1200, "bu"],
    ["ssi-mqtt", "VGS", 1793757794.0, 1793757794.374, 19.1, 100, 100, "bu"],
    ["ssi-mqtt", "VGS", 1793757810.0, 1793757811.089, 19.4, 100, 200, "bu"],
    ["ssi-mqtt", "SHS", 1793757812.0, 1793757812.229, 12.4, 400, 4100, "bu"],
  ];
  const { ticks } = mfSsiTicksForSymbol(liveRows, "SHS", cut, now);
  check("live replay SHS: 2 tick bu -> buy (1500 + 400 CP)",
    ticks.length === 2 && ticks.every(k => k.side === "buy"), ticks);
  const tapeLike = [{ ts: 1793757779, p: 12.4, v: 1500, s: "B" }]; // tick-rule noi nguoc -> SSI ghi du
  const j = mfJoinTapeSsi(tapeLike, ticks, MF_JOIN_TOL_SEC);
  check("live replay: join khop cung thoi diem/gia/KL, side that = buy (de len tick-rule)",
    j.matched === 1 && j.trades[0].side === "buy", j);
}

console.log("\nmoney-flow-trades: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
