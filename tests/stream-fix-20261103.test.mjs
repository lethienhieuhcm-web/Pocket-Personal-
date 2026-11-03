// Fix stream 03/11 — (e) thang cap im-lang-trong-phien (DO -> Ably -> poll)
// + (f) seq theo ngay phien + DO lastSeq song qua evict (market-room.js).
// Chay: node tests/stream-fix-20261103.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register("./p1-hooks.mjs", import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "js", "features", "unified-ingest.js"), "utf8");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

/* ---------- 1. Ham thuan: cua so phien + nguong ---------- */
{
  const moduleObj = { exports: {} };
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval,
    URLSearchParams: URLSearchParams,
    module: moduleObj, exports: moduleObj.exports,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const U = moduleObj.exports;

  const T = (y,m,d,h,mi) => Date.UTC(y, m-1, d, h-7, mi); // ICT -> UTC ms
  // 03/11/2026 = THURSDAY? (thuc te: 02/11 T7, 03/11 T2 — dung getUTCDay cua chinh Date de khong phu thuoc gia thiet)
  const tue = T(2026, 11, 3, 9, 30);   // 09:30 ICT 03/11 (trong phien chan)
  check("S1 09:30 ICT 03/11 = phien le (T2–T6, 08:45–15:15)", U.inTradingSession(tue) === true, new Date(tue).toISOString());
  check("S2 21:00 ICT = ngoai phien", U.inTradingSession(T(2026, 11, 3, 21, 0)) === false);
  check("S3 08:44 ICT = truoc cua so", U.inTradingSession(T(2026, 11, 3, 8, 44)) === false);
  check("S4 08:46 ICT = trong cua so", U.inTradingSession(T(2026, 11, 3, 8, 46)) === true);
  check("S5 15:16 ICT = sau ATC", U.inTradingSession(T(2026, 11, 3, 15, 16)) === false);
  // T7/TCN: tim ngay thu bay gan nhat sau 03/11 va test giua gio
  let sat = tue; while(new Date(sat + 7*3600e3).getUTCDay() !== 6) sat += 86400e3;
  check("S6 thu bay 10:00 ICT = ngoai phien", U.inTradingSession(sat + (10-7)*3600e3) === false);
  check("S7 input nan -> false", U.inTradingSession(NaN) === false && U.inTradingSession(undefined) === false);

  check("S8 escalate mac dinh 120s", U.escalateMsFrom("") === 120000);
  check("S9 ?ingesc=0 tat thang cap", U.escalateMsFrom("?ingesc=0") === 0);
  check("S10 ?ingesc=30 -> 30s", U.escalateMsFrom("?a=1&ingesc=30") === 30000);
  check("S11 ?ingesc=abc -> mac dinh", U.escalateMsFrom("?ingesc=abc") === 120000);

  const now = tue;
  check("S12 trong phien + im 130s -> can thang cap", U.needEscalate(now, now - 130000, 120000) === true);
  check("S13 trong phien + im 60s -> chua can", U.needEscalate(now, now - 60000, 120000) === false);
  check("S14 ngoai phien + im 1h -> KHONG (giu quiet P1-4)", U.needEscalate(now + 9*3600e3, now, 120000) === false);
  check("S15 esc=0 (tat) -> KHONG", U.needEscalate(now, now - 999999, 0) === false);
}

/* ---------- 2. (f) seq theo ngay phien ---------- */
{
  const store = new Map();
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const NOW = Date.UTC(2026, 10, 3, 2, 30);   // 09:30 ICT 03/11
  class FakeDate extends Date { static now(){ return NOW; } }
  const moduleObj = { exports: {} };
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    URLSearchParams: URLSearchParams, Date: FakeDate,
    sessionStorage: sessionStorage,
    location: { search: "", protocol: "https:", host: "lethanhdong.one" },
    module: moduleObj, exports: moduleObj.exports,
  };
  store.set("ingest_last_seq", "900");
  store.set("ingest_last_seq_day", "2026-11-02");   // tab mo tu hom qua
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const U = moduleObj.exports;
  check("R1 doc seq hom qua tu storage", U.seqState().seq === 900 && U.seqState().day === "2026-11-02", U.seqState());
  U.rollSeqToToday();
  check("R2 doi phien -> lastSeq reset 0 + gan ngay moi", U.seqState().seq === 0 && U.seqState().day === "2026-11-03", U.seqState());
  check("R3 luu xuong sessionStorage", store.get("ingest_last_seq") === "0" && store.get("ingest_last_seq_day") === "2026-11-03");
  check("R4 frame seq=1 phien moi DUOC chap nhan", U.shouldAcceptSeq(1, U.seqState().seq) === true);
  U.rollSeqToToday(); // lan 2 cung ngay -> khong doi
  check("R5 cuoi ngay khong reset nua", U.seqState().day === "2026-11-03");
}

/* ---------- 3. (e) thang cap end-to-end: DO im lang trong phien -> Ably ---------- */
function makeTimers(start){
  let now = start; const pool = new Map(); let id = 1;
  const api = {
    now: () => now,
    setTimeout(fn, ms){ const i = id++; pool.set(i, { at: now + (ms || 0), fn: fn, every: null }); return i; },
    clearTimeout(i){ pool.delete(i); },
    setInterval(fn, ms){ const i = id++; pool.set(i, { at: now + (ms || 1), fn: fn, every: ms || 1 }); return i; },
    clearInterval(i){ pool.delete(i); },
    advance(ms){
      const target = now + ms; let guard = 0;
      for(;;){
        if(++guard > 5000) throw new Error("loop timer khong tat");
        let pick = null;
        for(const [i, t] of pool) if(t.at <= target && (pick === null || t.at < pick[1].at)) pick = [i, t];
        if(!pick) break;
        now = pick[1].at;
        if(pick[1].every !== null) pick[1].at = now + pick[1].every; else pool.delete(pick[0]);
        pick[1].fn();
      }
      now = target;
    },
  };
  return api;
}
{
  const T0 = Date.UTC(2026, 10, 3, 2, 0);       // 09:00 ICT T2 03/11 — TRONG phien
  const timers = makeTimers(T0);
  const sockets = [];
  class FakeWS {
    constructor(url){ this.url = url; this.sent = []; this.readyState = 0; this.closedByClient = false; sockets.push(this); }
    send(s){ if(this.readyState !== 1) throw new Error("send khi chua open"); this.sent.push(JSON.parse(s)); }
    close(){ this.closedByClient = true; this.readyState = 3; }
    _open(){ this.readyState = 1; if(this.onopen) this.onopen(); }
    _emit(obj){ if(this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
  }
  const els = { pushStatus: { textContent: "" }, "v-market": {}, "v-detail": null };
  const ablyCtor = [];
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    Date: class FakeDate extends Date { static now(){ return timers.now(); } },
    JSON: JSON, Math: Math, Number: Number, Object: Object,
    Array: Array, String: String, Boolean: Boolean, Promise: Promise,
    URLSearchParams: URLSearchParams, WebSocket: FakeWS,
    sessionStorage: { getItem: () => "0", setItem: () => {} },
    localStorage: { getItem: () => null },
    location: { search: "", protocol: "https:", host: "lethanhdong.one" },
    document: {
      readyState: "complete", documentElement: { lang: "vi" }, hidden: false,
      getElementById: (id) => els[id] || null, addEventListener: () => {}, querySelector: () => null,
    },
    Ably: { Realtime: function(cfg){ ablyCtor.push(cfg); this.connection = { on: () => {} }; this.channels = { get: () => ({ subscribe: () => {}, unsubscribe: () => {} }) }; } },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ token: "x" }) }),
  };
  sandbox.window = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const api = sandbox.window.UnifiedIngest;

  check("E1 socket DO mo (duong chinh)", sockets.length === 1 && api.path() === "do", { n: sockets.length });
  const ws = sockets[0];
  ws._open();
  ws._emit({ t: "ok", ro: true });
  ws._emit({ t: "subbed" });
  ws._emit({ t: "hb", ts: timers.now(), srv_ts: timers.now() });
  timers.advance(5000);
  check("E2 co hb, chua co frame -> quiet (P1-4 giu nguyen)", els.pushStatus.textContent === "quiet", els.pushStatus.textContent);

  // TRIEU CHUNG 03/11: hb deu (link "song") nhung DO trong tay, im lang.
  // Chi echo hb — khong co frame. linkAliveAt phai luoi moi hon 70s de
  // watchdog LINK khong xen vao truoc khi nguong DATA 120s kip bat.
  function hbUntil(target){
    while(timers.now() < target){
      const step = Math.min(30000, target - timers.now());
      timers.advance(step);
      sockets[sockets.length - 1]._emit({ t: "hb", ts: timers.now(), srv_ts: timers.now() });
    }
  }
  hbUntil(T0 + 115000);
  check("E2b 115s im lang = DUOI nguong -> chua doi duong", ablyCtor.length === 0 && sockets.length === 1 && api.mode() === "do", { n: sockets.length, mode: api.mode() });
  timers.advance(6000); // cham nguong 120s (khong co hb nua — thang cap noi len TRUOC)
  check("E3 im lang >120s TRONG phien -> duong do bi coi la chet, DO thu lai (socket 2)", ablyCtor.length === 0 && sockets.length === 2 && ws.closedByClient === true, { n: sockets.length, ably: ablyCtor.length });
  // Cac lan retry roi van hb-deu-khong-frame (dung nhu 03/11) -> thang sang Ably.
  for(let round = 0; round < 6 && ablyCtor.length === 0; round++){
    const cur = sockets[sockets.length - 1];
    if(cur.readyState === 0){ cur._open(); cur._emit({ t: "ok", ro: true }); cur._emit({ t: "subbed" }); }
    hbUntil(T0 + 121000 + 135000 * (round + 1));
  }
  check("E4 DO van im lang -> thang sang ABLY (duong du phong)", ablyCtor.length >= 1, { ably: ablyCtor.length, sockets: sockets.length });
  check("E5 Ably dung authCallback lay token tu /api/ably-token", typeof ablyCtor[0].authCallback === "function");
}

/* ---------- 3b. Duong chay BINH THUONG khong bi thang cap ham ho ---------- */
{
  const T0 = Date.UTC(2026, 10, 3, 2, 0);
  const timers = makeTimers(T0);
  const sockets = [];
  class FakeWS {
    constructor(url){ this.url = url; this.sent = []; this.readyState = 0; this.closedByClient = false; sockets.push(this); }
    send(s){ if(this.readyState !== 1) throw new Error("send khi chua open"); this.sent.push(JSON.parse(s)); }
    close(){ this.closedByClient = true; this.readyState = 3; }
    _open(){ this.readyState = 1; if(this.onopen) this.onopen(); }
    _emit(obj){ if(this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
  }
  const els = { pushStatus: { textContent: "" }, "v-market": {}, "v-detail": null };
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    Date: class FakeDate extends Date { static now(){ return timers.now(); } },
    JSON: JSON, Math: Math, Number: Number, Object: Object,
    Array: Array, String: String, Boolean: Boolean, Promise: Promise,
    URLSearchParams: URLSearchParams, WebSocket: FakeWS,
    sessionStorage: { getItem: () => "0", setItem: () => {} },
    localStorage: { getItem: () => null },
    location: { search: "", protocol: "https:", host: "lethanhdong.one" },
    document: {
      readyState: "complete", documentElement: { lang: "vi" }, hidden: false,
      getElementById: (id) => els[id] || null, addEventListener: () => {}, querySelector: () => null,
    },
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const api = sandbox.window.UnifiedIngest;
  const ws = sockets[0];
  ws._open(); ws._emit({ t: "ok", ro: true }); ws._emit({ t: "subbed" });
  let seq = 0;
  function frameEvery(){ // refresher publish moi 60s: 6 phut
    for(let i = 0; i < 6; i++){
      timers.advance(60000);
      seq++;
      ws._emit({ t: "q", seq: seq, s: "VCB", p: 53400, ts: timers.now(), srv_ts: timers.now() });
    }
  }
  frameEvery();
  check("N1 frame deu 60s/lan -> khong BAO GIO doi duong (6 phut)", api.errCount() === 0 && api.mode() === "do" && sockets.length === 1, { err: api.errCount(), mode: api.mode(), n: sockets.length });
  frameEvery();
  check("N2 tiep tuc 6 phut nua van on", api.errCount() === 0 && api.path() === "do");
  // (im lang NGOAI phien = hanh vi "quiet" dung — cover bang S14/N2:
  // 12 phut yen lang duoc tinh trong gio phien ma frame van deu thi
  // KHONG co doi duong; cua so phien bi chan bang inTradingSession.)
}

/* ---------- 4. (f-server) DO lastSeq song qua evict ---------- */
{
  const { MarketRoom } = await import("../worker/src/market-room.js");
  const store = new Map();
  const ctx = () => ({ storage: {
    setAlarm: async () => {},
    get: async (k) => (store.has(k) ? store.get(k) : undefined),
    put: async (k, v) => { store.set(k, v); },
  }, acceptWebSocket: () => {} });
  const env = { INTERNAL_SECRET: "s3cr3t" };
  function req(frames){
    return {
      url: "https://do/ingest", method: "POST",
      headers: { get: (k) => (k.toLowerCase() === "x-internal-secret" ? "s3cr3t" : null) },
      text: async () => JSON.stringify({ frames }),
    };
  }
  const r1 = await new MarketRoom(ctx(), env).fetch(req([{ t: "q", s: "VCB", p: 53400, ts: Date.now() }, { t: "q", s: "CTG", p: 45000, ts: Date.now() }]));
  const j1 = await r1.json();
  check("D1 ingest lan 1 -> seq 1,2", r1.status === 200 && j1.seqs[0] === 1 && j1.seqs[1] === 2 && j1.seq === 2, j1);
  // DO bi evict/recreate (instance moi, cung storage)
  const r2 = await new MarketRoom(ctx(), env).fetch(req([{ t: "q", s: "FPT", p: 50300, ts: Date.now() }]));
  const j2 = await r2.json();
  check("D2 DO restart -> seq TIEP DIEN (3), khong quay ve 1", j2.seqs[0] === 3 && j2.seq === 3, j2);
  // Worker fallback cung phai khong ma hoa seq cu: ingest frame seq cu (<=lastSeq) -> bo
  const r3 = await new MarketRoom(ctx(), env).fetch(req([{ t: "q", s: "FPT", p: 50300, seq: 2, ts: Date.now() }]));
  const j3 = await r3.json();
  check("D3 frame seq cu bi tu choi (published 0), lastSeq giu nguyen", j3.published === 0 && j3.seq === 3, j3);
}

console.log("stream-fix-20261103: " + passed + " pass, " + failed + " fail");
process.exit(failed ? 1 : 0);
