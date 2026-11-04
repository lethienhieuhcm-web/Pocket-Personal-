// Repuan thu duong merge tick -> nen 1m/5m, chay bang CODE THAT:
//   js/features/stock-chart.js (applyTick/planTick/bucketStart) + khoi onIngestTick
//   cat ra tu stocks.html + ham thuan cua js/features/unified-ingest.js.
// Du lieu: nen + quote THAT cua FPT luc 09:13–09:29 ICT 04/11/2026 (tu
// tick-chart-live-check-20261104.md va /api/stock/ohlcv?interval=1m).
// Run: node tests/tick-merge.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Goc code: mac dinh `work/`, override bang TICKFIX_ROOT (vi du verify/ =
// baseline 6b88efe + tick-chart.patch + tick-chart-livefix.patch).
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", process.env.TICKFIX_ROOT || "work");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

/* ---------- stub DOM/LightweightCharts ---------- */
const seriesLog = [];          // moi series tao ra: {kind, setData:[], updates:[]}
function makeSeries(kind) {
  const s = {
    kind, setDataCalls: [], updateCalls: [], _data: [],
    setData(d) { this.setDataCalls.push(d); this._data = d.slice(); },
    update(d) { this.updateCalls.push(d); },
    createPriceLine() {}, applyOptions() {},
    data() { return this._data; }
  };
  seriesLog.push(s);
  return s;
}
function el() {
  return { style: { cssText: "" }, innerHTML: "", textContent: "",
    appendChild() {}, querySelectorAll() { return []; }, clientWidth: 340 };
}
const viewOn = { id: "v-detail" };
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams,
  Date, Math, JSON, Number, String, Object, Array, isFinite, parseInt, parseFloat,
  Map, Set, Error, RegExp, Infinity, NaN,
  module: { exports: {} }, exports: {},
  document: { createElement: () => el(), body: el(), documentElement: el(),
    querySelector: sel => (sel === ".view.on" ? viewOn : null),
    addEventListener() {}, readyState: "complete", hidden: false },
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  location: { hostname: "lethanhdong.one", search: "", href: "https://lethanhdong.one/stocks/" },
  navigator: { onLine: true },
  fetch: () => Promise.reject(new Error("no network in test")),
  WebSocket: function () { this.close = () => {}; },
};
sandbox.window = { LightweightCharts: {
  ColorType: { Solid: "solid" },
  LineStyle: { Dashed: 2 },
  CandlestickSeries: { name: "Candlestick" },
  HistogramSeries: { name: "Histogram" },
  LineSeries: { name: "Line" },
  AreaSeries: { name: "Area" },
  customSeriesDefaultOptions: {},
  createChart: () => sandbox.window.__chart
} };
function newChartStub() {
  return {
    addSeries: def => makeSeries(def && def.name ? def.name : "Series"),
    addCustomSeries: () => makeSeries("Custom"),
    priceScale: () => ({ applyOptions() {} }),
    timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 0, to: 59 }),
      setVisibleLogicalRange() {}, fitContent() {} }),
    subscribeCrosshairMove() {}, unsubscribeCrosshairMove() {},
    applyOptions() {}, remove() {},
    addPane: () => ({ setStretchFactor() {} }),
    panes: () => [{ setStretchFactor() {} }, ]
  };
}
sandbox.window.__chart = newChartStub();
vm.createContext(sandbox);

/* ---------- nap module that ---------- */
vm.runInContext(read("js/features/stock-chart.js"), sandbox, { filename: "stock-chart.js" });
const CH = sandbox.module.exports;
check("stock-chart export applyTick/planTick/bucketStart/lastCandleTime",
  ["applyTick", "planTick", "bucketStart", "lastCandleTime", "candleData"].every(k => typeof CH[k] === "function"),
  Object.keys(CH));

// unified-ingest: doc nguon, kiem 2 noi notifyChartTick duoc goi trong applyFrame,
// roi dung ham thuan parseFrame/deltaPlan cho chuoi frame that.
const ingestSrc = read("js/features/unified-ingest.js");
const ingestModule = { exports: {} };
const ingestBox = { console, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams,
  Date, Math, JSON, Number, String, Object, Array, isFinite, parseInt, parseFloat, Map, Set, Error, RegExp,
  sessionStorage: sandbox.sessionStorage, location: sandbox.location,
  module: ingestModule, exports: ingestModule.exports };
// KHONG cap document/window -> init() khong chay (module chi xuat ham thuan).
vm.createContext(ingestBox);
vm.runInContext(ingestSrc, ingestBox, { filename: "unified-ingest.js" });
const U = ingestModule.exports;

/* ---------- du lieu THAT ---------- */
// /ohlcv?symbol=FPT&interval=1m: t = epoch GIAY, gia = NGHIN VND, v = co phieu.
// Nen cuoi theo poll 60s luc 09:19–09:20 la phut 09:18 (dong 16 log kiem live).
const T_0918 = 1793758680;   // 04/11 09:18 ICT
function barsUpTo0918() {
  // 3 nen lien truoc do, gia lap tu chinh log (chi nen cuoi du quan sat).
  return [
    { t: T_0918 - 120, o: 50.5, h: 50.6, l: 50.4, c: 50.6, v: 30000 },
    { t: T_0918 - 60,  o: 50.6, h: 50.7, l: 50.5, c: 50.7, v: 9000 },
    { t: T_0918,       o: 50.6, h: 50.7, l: 50.6, c: 50.7, v: 1900 }
  ];
}
function renderChart(bars) {
  seriesLog.length = 0;
  sandbox.window.__chart = newChartStub();
  const ok = CH.render(el(), { bars, scale: 1000, pricePrecision: 0, intraday: true,
    studies: [], volLines: [] });
  return ok;
}
const ICT = h => Date.parse("2026-11-04T" + (h.length === 5 ? h + ":00" : h) + "+07:00");   // ms
// Chuoi quote THAT (log dong 9–22): 50.400 -> 51.500
const LIVE_TICKS = [
  ["09:13", 50400], ["09:15", 50700], ["09:16", 50500], ["09:18", 50700],
  ["09:19", 50700], ["09:20", 50600], ["09:23", 50700], ["09:24", 50500],
  ["09:25", 50900], ["09:29", 51500]
].map(([h, p]) => ({ t: "q", seq: 0, s: "FPT", p, pc: 0, ts: ICT(h) }));

/* ---------- 1. frame that di qua parseFrame + deltaPlan ---------- */
sandbox.module.exports = {};   // tranh giua hai lan doc module
const f0 = LIVE_TICKS[5];      // 09:20, 50.600
check("parseFrame chap nhan frame q that (ts ms dung phien)",
  U.parseFrame({ ...f0, seq: 1200 }, { sessionDate: U.sessionDay(f0.ts) }) !== null);
check("deltaPlan -> q-detail cho FPT tren v-detail",
  U.deltaPlan({ ...f0, seq: 1200 }, "v-detail", "FPT", false) === "q-detail");
check("wiring: applyFrame goi notifyChartTick ca 2 canh q-detail + idx",
  /plan === "q-detail"[\s\S]{0,80}notifyChartTick\(d\)/.test(ingestSrc) &&
  /plan === "idx"[\s\S]{0,80}notifyChartTick\(d\)/.test(ingestSrc));

/* ---------- 2. don vi gia: frame.p (VND) vs nen da x1000 (VND) ---------- */
const cd = CH.candleData(barsUpTo0918(), 1000);
check("nen luu theo VND (50.7 nghin x 1000 = 50700) = cung don vi voi frame.p",
  cd[cd.length - 1].close === 50700 && f0.p === 50600);
check("bucketStart(09:20,60) = 1793758800",
  CH.bucketStart(Math.floor(f0.ts / 1000), 60) === T_0918 + 120);

/* ---------- 3. chay tron bochu onIngestTick that + applyTick ---------- */
check("render OK", renderChart(barsUpTo0918()) === true);
check("liveCandle = nen 09:18 tu poll", CH.lastCandleTime() === T_0918);

// Khoi onIngestTick nguyen van trong stocks.html (khong viet lai).
const html = read("stocks.html");
const start = html.indexOf("// Nen phut dang hinh");
const endMark = "window.onIngestTick = function(frame)";
const s2 = html.indexOf(endMark, start);
const block = html.slice(start, html.indexOf("\n};", s2) + 3);
check("tim thay khoi onIngestTick trong stocks.html", start > 0 && s2 > start && block.length > 500,
  { start, s2, len: block.length });
sandbox.window._chartIv = "1m";
sandbox.window._chartSym = "FPT";
sandbox.window._idxMode = false;
vm.runInContext("window.onIngestTick = null;\n" + block, sandbox, { filename: "stocks.html#tick" });
check("window.onIngestTick duoc dinh nghia", typeof sandbox.window.onIngestTick === "function");

const candleSeries = seriesLog.find(s => s.kind === "Candlestick");
const volSeries = seriesLog.find(s => s.kind === "Histogram");
const trace = [];
for (const frame of LIVE_TICKS) {
  const before = candleSeries.updateCalls.length;
  sandbox.window.onIngestTick(frame);
  const u = candleSeries.updateCalls[candleSeries.updateCalls.length - 1];
  trace.push({ ts: frame.ts,
    ict: new Date(frame.ts + 7 * 3600e3).toISOString().slice(11, 16), price: frame.p,
    merged: candleSeries.updateCalls.length > before, candle: u ? `${u.open}/${u.high}/${u.low}/${u.close}` : null });
}
console.log("\n  trace 10 tick live qua onIngestTick -> applyTick (nen poll = 09:18):");
for (const r of trace) console.log("   " + r.ict + "  " + String(r.price).padEnd(6) +
  (r.merged ? "  MERGE -> " + r.candle : "  (khong ve)"));
console.log("");

// Tick 09:13/09:15/09:16 thuoc phut DA QUA so voi nen poll 09:18 -> 'old',
// KHONG duoc dung vao nen khac (do la hanh vi dung, khong phai loi).
const expected = trace.map(r => new Date(r.ts + 7 * 3600e3).toISOString().slice(11, 16) >= "09:18");
const last = trace[trace.length - 1];

// (a) moi tick trong phien phai ve len nen
check("A1: moi tick tu bucket cua nen poll tro di sau duoc merge (7/7)",
  trace.every((r, i) => r.merged === expected[i]), trace.map(r => r.ict + ":" + (r.merged ? "M" : "-")).join(" "));
// (b) gia bi nhat theo tick: sau tick 09:29 (51.500) thi H >= 51500 va C = 51500
check("A2: close theo tick cuoi", last.merged && Number(last.candle.split("/")[3]) === 51500, last.candle);
check("A3: high duoc cap nhat khi tick vuot high (51.500 > 50.700)",
  last.merged && Number(last.candle.split("/")[1]) >= 51500, last.candle);
// (c) khong ve nen cua phut qua (tick 09:13/09:15/09:16 ben trai nen poll 09:18)
check("A4: tick cu hon nen poll KHONG duoc dung vao nen do",
  trace.slice(0, 3).every(r => !r.merged || Number(r.candle.split("/")[0]) !== 50600), trace[0]);
// (d) zoom khong bi reset: merge phai dung series.update(), KHONG setData(), KHONG chart moi
check("B1: merge dung series.update() in place", candleSeries.updateCalls.length > 0);
check("B2: merge khong goi setData() (khong ve lai nen -> giu zoom)",
  candleSeries.setDataCalls.length === 1, { setDataCalls: candleSeries.setData.length });
// (e) volume: tick khong mang volume per-tick -> khong duoc cham volSeries
check("C1: volume khong bi tick cong them", volSeries.updateCalls.length === 0,
  { volUpdates: volSeries.updateCalls.length });

/* ---------- 4. planTick don vi ---------- */
const live = { time: T_0918, open: 50600, high: 50700, low: 50600, close: 50700 };
check("D1: tick cung bucket -> merge giu open, doi h/l/c",
  CH.planTick(live, { time: T_0918, price: 50400 }).action === "merge" &&
  CH.planTick(live, { time: T_0918, price: 50400 }).candle.open === 50600 &&
  CH.planTick(live, { time: T_0918, price: 50400 }).candle.low === 50400);
check("D2: tick bucket sau (lag poll 1 phut, 60s) -> co nen dang hinh tai bucket do",
  CH.planTick(live, { time: T_0918 + 60, price: 50700, stepSec: 60 }).action === "merge",
  CH.planTick(live, { time: T_0918 + 60, price: 50700, stepSec: 60 }));
check("D3: tick bucket sau 2 buoc (lag 120s, dung bang so lieu live 09:20/09:18) -> cung seed",
  CH.planTick(live, { time: T_0918 + 120, price: 50600, stepSec: 60 }).action === "merge");
check("D4a: bucket sau 4 buoc (live-check 09:29 khi nen poll 09:25) -> van seed",
  CH.planTick(live, { time: T_0918 + 240, price: 50600, stepSec: 60 }).action === "merge");
check("D4b: bucket sau 11 buoc (ts bo sai / poll lot ca lu) -> 'new', khong bia nen lac",
  CH.planTick(live, { time: T_0918 + 660, price: 50600, stepSec: 60 }).action === "new");
check("D4c: cuoc phien truoc (14:45 03/11) roi tick 09:13 hom sau -> 'new' (cach 1108 buoc)",
  CH.planTick({ time: 1793691900, open: 50400, high: 50400, low: 50400, close: 50400 },
              { time: 1793758380, price: 50400, stepSec: 60 }).action === "new");
check("D5: tick bucket truoc -> 'old'", CH.planTick(live, { time: T_0918 - 60, price: 50600 }).action === "old");
check("D6: lech don vi gia (px gap 1000 lan) -> 'unit', khong ve",
  CH.planTick(live, { time: T_0918, price: 50600000 }).action === "unit");
check("D7: 5m seed dung stepSec=300, bucket hop nhat 5m",
  CH.bucketStart(Math.floor(ICT("09:27:40") / 1000), 300) === 1793759100 &&
  CH.planTick(live, { time: 1793759100, price: 50900, stepSec: 300 }).action === "merge");

/* ---------- 5. chieu nguoc: /ohlcv DI TRUOC frame (do 09:54:51) ---------- */
check("E1: tick le nen poll 1 bucket -> ap vao nen cuoi (khong skip lang)",
  CH.planTick({ time: T_0918 + 120, open: 52900, high: 53000, low: 52800, close: 52900 },
              { time: T_0918 + 60, price: 52400, stepSec: 60 }).action === "merge");
check("E2: va ap DUNG vao nen cuoi (time khong doi), h/l/c bi nhat",
  (function () {
    const p = CH.planTick({ time: T_0918 + 120, open: 52900, high: 53000, low: 52800, close: 52900 },
                          { time: T_0918 + 60, price: 52400, stepSec: 60 });
    return !!p.candle && p.candle.time === T_0918 + 120 && p.candle.low === 52400 && p.candle.close === 52400;
  })());
check("E3: tick le 2 bucket (frame cu/thap thieu ~120s) -> 'old', de poll ve dung",
  CH.planTick({ time: T_0918 + 120, open: 52900, high: 53000, low: 52800, close: 52900 },
              { time: T_0918, price: 52400, stepSec: 60 }).action === "old");
check("E4: khong co stepSec -> khong doan bua, 'old'/'new' nhu cu",
  CH.planTick({ time: T_0918 + 120, open: 52900, high: 53000, low: 52800, close: 52900 },
              { time: T_0918 + 60, price: 52400 }).action === "old" &&
  CH.planTick({ time: T_0918, open: 50600, high: 50700, low: 50600, close: 50700 },
              { time: T_0918 + 60, price: 50700 }).action === "new");

console.log("\ntick-merge: " + passed + " pass, " + failed + " fail");
process.exit(failed ? 1 : 0);
