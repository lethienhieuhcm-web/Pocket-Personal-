// P1-4 (§8 muc 10, §7b) — heartbeat HAI CHIEU + tach hai dong ho.
// Chay: node tests/p1-heartbeat.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register("./p1-hooks.mjs", import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const { MarketRoom } = await import("../worker/src/market-room.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

/* ================= A. PHIA DO (server) ================= */
function fakeWs(){
  return { sent: [], closed: null, send(s){ this.sent.push(s); }, close(code, reason){ this.closed = { code: code, reason: reason }; } };
}
const realNow = Date.now;
const realPair = globalThis.WebSocketPair;
function makeRoom(){
  const alarms = [];
  const ctx = { storage: { setAlarm: async (when) => { alarms.push(when); } }, acceptWebSocket: () => {} };
  return { room: new MarketRoom(ctx, { INTERNAL_SECRET: "s3cr3t" }), alarms: alarms };
}
async function activate(room, ws){
  await room.webSocketMessage(ws, JSON.stringify({ t: "auth", token: "" }));
  await room.webSocketMessage(ws, JSON.stringify({ t: "sub", view: "market" }));
}

{
  const T0 = Date.UTC(2026, 10, 2, 2, 0, 0);
  Date.now = () => T0;
  // Duong that: WS upgrade qua fetch() -> cap socket + lap alarm heartbeat.
  // Response cua Node khong nhan status 101 (chi co tren runtime CF) -> stub.
  const realResp = globalThis.Response;
  globalThis.Response = class FakeResponse {
    constructor(body, init){ this.status = (init || {}).status; this.webSocket = (init || {}).webSocket; }
  };
  const opened = [];
  globalThis.WebSocketPair = function WebSocketPair(){
    const server = fakeWs(), client = { tag: "client" };
    opened.push({ server: server, client: client });
    return { 0: client, 1: server };
  };
  const { room, alarms } = makeRoom();
  const res = await room.fetch({ url: "https://x/api/stock/stream", method: "GET", headers: { get: (k) => (k.toLowerCase() === "upgrade" ? "websocket" : null) } });
  check("A0 WS upgrade -> 101 + socket duoc lien ket vao phong", res.status === 101 && res.webSocket === opened[0].client && opened.length === 1 && room.sockets.has(opened[0].server), { status: res.status, n: opened.length });
  globalThis.Response = realResp;
  check("A1 alarm lap lai theo ~30s (HB_SEND_MS), khong con 60s", alarms.length === 1 && alarms[0] === T0 + 30000, alarms);

  const ws = opened[0].server;            // khach CHUA dang nhap -> kich hoat chi-đoc
  await activate(room, ws);
  ws.sent.length = 0;

  // 11 phut khong mot tin nao tu client; alarm chay ~30s/lan (P1-4: server
  // chu dong phat hb, va KHONG duoc vo socket chi vi client im lang).
  let t = T0;
  for(let i = 0; i < 22; i++){
    t += 30000; Date.now = () => t;
    await room.alarm();
  }
  const hbs = ws.sent.map(s => JSON.parse(s)).filter(m => m.t === "hb");
  check("A2 server chu dong phat hb (~30s/lan, khong can ping)", hbs.length >= 20, { n: hbs.length });
  check("A3 socket da kich hoat VAN SONG sau 11 phut im lang", ws.closed === null && room.sockets.has(ws) === true, ws.closed);
  check("A4 hb mang srv_ts (dong ho server), khong phai frame du lieu", hbs.every(h => typeof h.srv_ts === "number" && h.seq === undefined), hbs[0]);

  // Frame duoc van phai den noi (hb khong thay duoc duong du lieu).
  room._ingest([{ t: "idx", rows: [{ s: "VNINDEX", p: 1766.87 }], ts: t }]);
  check("A5 duong du lieu van song sau hang chuc lan hb", ws.sent.map(s => JSON.parse(s)).some(m => m.t === "idx"));
  Date.now = realNow;
  globalThis.WebSocketPair = realPair;
}

{
  // Socket KHONG bao gio handshake -> rac -> van phai don (chong ro ri).
  const T0 = Date.UTC(2026, 10, 2, 2, 0, 0);
  Date.now = () => T0;
  const { room } = makeRoom();
  const junk = fakeWs();
  room._state(junk);                    // mo socket, chua handshake
  Date.now = () => T0 + 31 * 60 * 1000;
  await room.alarm();
  check("A6 socket chua handshake bi don sau IDLE_CLOSE_MS", junk.closed && junk.closed.code === 1000 && !room.sockets.has(junk), junk.closed);
  // Va KHONG bi don som (duoi 30 phut).
  const { room: r2 } = makeRoom();
  const junk2 = fakeWs(); r2._state(junk2);
  Date.now = () => T0 + 11 * 60 * 1000;
  await r2.alarm();
  check("A7 socket chua handshake con duoc cho den het nguong", junk2.closed === null && r2.sockets.has(junk2));
  Date.now = realNow;
}

/* ================= B. PHIA CLIENT ================= */
// Fake clock + timers: moi thu trong module chay theo mot dong ho duy nhat.
function makeTimers(start){
  let now = start;
  const pool = new Map();
  let id = 1;
  const api = {
    now: () => now,
    setTimeout(fn, ms){ const i = id++; pool.set(i, { at: now + (ms || 0), fn: fn, every: null }); return i; },
    clearTimeout(i){ pool.delete(i); },
    setInterval(fn, ms){ const i = id++; pool.set(i, { at: now + (ms || 1), fn: fn, every: ms || 1 }); return i; },
    clearInterval(i){ pool.delete(i); },
    advance(ms){
      const target = now + ms;
      let guard = 0;
      for(;;){
        if(++guard > 5000) throw new Error("loop timer khong tat");
        let pick = null;
        for(const [i, t] of pool){
          if(t.at <= target && (pick === null || t.at < pick[1].at)) pick = [i, t];
        }
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

const T0 = Date.UTC(2026, 10, 2, 2, 0, 0);       // 09:00 ICT 02/11 = trong phien
const timers = makeTimers(T0);
class FakeDate extends Date { static now(){ return timers.now(); } }

const sockets = [];
class FakeWS {
  constructor(url){
    this.url = url; this.sent = []; this.readyState = 0; this.closedByClient = false;
    sockets.push(this);
  }
  send(s){ if(this.readyState !== 1) throw new Error("send khi chua open"); this.sent.push(JSON.parse(s)); }
  close(){ this.closedByClient = true; this.readyState = 3; }   // trinh duyet: onclose async -> khong fires o day
  _open(){ this.readyState = 1; if(this.onopen) this.onopen(); }
  _emit(obj){ if(this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
  _fireClose(){ this.readyState = 3; if(this.onclose) this.onclose(); }
}

const els = { pushStatus: { textContent: "" }, "v-market": {}, "v-detail": null };
// Fixture #topMovers 1 dong ACB (fix 03/11): frame q phai ghi duoc o DOM
// thi moi bao 'live' — khong co dong nao thi bao 'norender' (dung).
const acbCells = [{ textContent: "", className: "" }, { textContent: "", className: "" }, { textContent: "", className: "" }, { textContent: "", className: "" }];
const acbRow = { querySelector: (s) => (s === "b" ? { textContent: "ACB" } : null), querySelectorAll: (s) => (s === "td" ? acbCells : []) };
els.topMovers = { querySelector: (s) => (s === "b" ? { textContent: "ACB" } : null), querySelectorAll: (s) => (s === "tr" ? [acbRow] : []) };
const sandbox = {
  console: { log: () => {}, warn: () => {}, error: () => {} },
  setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  setInterval: timers.setInterval, clearInterval: timers.clearInterval,
  Date: FakeDate, JSON: JSON, Math: Math, Number: Number, Object: Object,
  Array: Array, String: String, Boolean: Boolean, Promise: Promise,
  URLSearchParams: URLSearchParams, WebSocket: FakeWS,
  sessionStorage: { getItem: () => "0", setItem: () => {} },
  localStorage: { getItem: () => null },                 // KHACH CHUA DANG NHAP
  location: { search: "?ingesc=0", protocol: "https:", host: "lethanhdong.one" },
  // ?ingesc=0 (fix 03/11): tat dong ho THANG CAP im-lang-trong-phien de
  // test nay giu nguyen hanh vi P1-4 (quiet/stale khong doi duong).
  // Thang cap duoc test rieng trong stream-fix-20261103.test.mjs.
  document: {
    readyState: "complete", documentElement: { lang: "vi" }, hidden: false,
    getElementById: (id) => els[id] || null,
    addEventListener: () => {}, querySelector: (s) => (s === ".view.on" ? { id: "v-market" } : null),
  },
};
sandbox.window = {};
const src = fs.readFileSync(path.join(here, "..", "js", "features", "unified-ingest.js"), "utf8");
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const api = sandbox.window.UnifiedIngest;
function status(){ return els.pushStatus.textContent; }
function lastSent(ws){ return ws.sent[ws.sent.length - 1]; }

/* B1 — khong co token van noi realtime (P1-3 client, khong bi day ve poll). */
check("B1 socket duoc mo du khi CHUA dang nhap", sockets.length === 1 && api.path() === "do" && api.mode() === "do", { n: sockets.length, path: api.path(), mode: api.mode() });
const ws1 = sockets[0];
ws1._open();
check("B2 gui auth voi token trong (chi-đoc), khong chan qua login", lastSent(ws1) && lastSent(ws1).t === "auth" && lastSent(ws1).token === "", lastSent(ws1));
ws1._emit({ t: "ok", ro: true });
check("B3 duoc {t:ok,ro:true} -> gui sub view market", lastSent(ws1) && lastSent(ws1).t === "sub" && lastSent(ws1).view === "market", lastSent(ws1));
ws1._emit({ t: "subbed" });
check("B4 sau subbed -> gui resume theo seq", lastSent(ws1) && lastSent(ws1).t === "resume", lastSent(ws1));
ws1._emit({ t: "resumed", seq: 0 });

/* B5 — client ping ~25s khi socket mo. */
timers.advance(25000);
check("B5 client gui {t:ping} sau ~25s", ws1.sent.some(m => m.t === "ping"), ws1.sent.map(m => m.t));
timers.advance(25000);
check("B6 ping lap lai deu (lan 2 luc ~50s)", ws1.sent.filter(m => m.t === "ping").length === 2, ws1.sent.filter(m => m.t === "ping").length);

/* B7 — hb = link song; thi truong yen lang KHONG bi gan la dut. */
ws1._emit({ t: "hb", ts: timers.now(), srv_ts: timers.now() });
timers.advance(5000);
check("B7 hb roi, 5s sau chua co frame -> nhan 'quiet' (khong phai 'retry')", status() === "quiet", status());
check("B8 link yen lang KHONG pha socket / khong reconnect", sockets.length === 1 && ws1.closedByClient === false && api.mode() === "do", { n: sockets.length, mode: api.mode() });

/* B9 — watchdog 30s khong duoc pha link da handshake ma van chua co duoc. */
timers.advance(30000);
ws1._emit({ t: "hb", ts: timers.now(), srv_ts: timers.now() });
check("B9 handshake roi thi het watchdog 30s: socket van song, khong sang Ably", sockets.length === 1 && api.path() === "do", { n: sockets.length, path: api.path() });

/* B10 — hb KHONG duoc tinh la duoc tuoi: co frame -> 'live'; chi hb -> 'quiet'. */
ws1._emit({ t: "q", seq: 101, s: "ACB", p: 22500, ts: timers.now(), srv_ts: timers.now() });
check("B10 frame hop le (seq + ts trong phien) -> 'live'", status() === "live", status());
const e0 = api.errCount();
timers.advance(6000);
ws1._emit({ t: "hb", ts: timers.now(), srv_ts: timers.now() });
timers.advance(6000);
check("B11 chi co hb -> quay lai 'quiet', khong gian 'live'", status() === "quiet", status());
check("B12 khong co loi duong nao trong ca doan yen lang", api.errCount() === e0, api.errCount() - e0);

/* B13 — link VAN SONG (hb deu tay) nhung khong co duoc qua 5 phut
 * -> nhan "so lieu cu", khong phai "dut". */
for(let i = 0; i < 6; i++){ timers.advance(50000); ws1._emit({ t: "hb", ts: timers.now(), srv_ts: timers.now() }); }
check("B13 >5 phut khong frame duoc (link song) -> nhan 'stale'", status() === "stale", status());
check("B14 stale van khong phai la dut (giu socket + duong do)", sockets.length === 1 && api.mode() === "do", { n: sockets.length, mode: api.mode() });

/* B15 — frame ngoai phien bi bo, khong duoc 'live' hoa. */
ws1._emit({ t: "q", seq: 202, s: "FPT", p: 54000, ts: T0 - 24 * 3600 * 1000, srv_ts: timers.now() });
check("B15 frame hom qua bi tu choi -> van 'stale', khong 'live'", status() === "stale", status());

/* B16 — link chet THAT (khong hb du lau) -> onBreak + reconnect. */
const err15 = api.errCount(), sockN = sockets.length;
timers.advance(80000);
check("B17 khong hb >70s -> link chet that, dem loi va thu noi lai", api.errCount() > err15 && sockets.length > sockN, { err: api.errCount() - err15, sockets: sockets.length - sockN });
check("B18 ping duoc ngung khi socket dong (clearHb)", ws1.closedByClient === true, ws1.closedByClient);

/* B19 — duong Ably khi khong co token: van thu noi (P1-3), khong bi chan
 * ve poll. ?pushchan=staging-* ep duong Ably (testMode) — dung logic that. */
{
  const ablyCtor = [];
  const els2 = { pushStatus: { textContent: "" }, "v-market": {}, "v-detail": null };
  const timers2 = makeTimers(T0);
  const sandbox2 = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: timers2.setTimeout, clearTimeout: timers2.clearTimeout,
    setInterval: timers2.setInterval, clearInterval: timers2.clearInterval,
    Date: class extends Date { static now(){ return timers2.now(); } },
    JSON: JSON, Math: Math, Number: Number, Object: Object, Array: Array,
    String: String, Boolean: Boolean, Promise: Promise, URLSearchParams: URLSearchParams,
    WebSocket: FakeWS,
    sessionStorage: { getItem: () => "0", setItem: () => {} },
    localStorage: { getItem: () => null },              // CHUA dang nhap
    location: { search: "?pushchan=staging-h1-20261102", protocol: "https:", host: "lethanhdong.one" },
    document: {
      readyState: "complete", documentElement: { lang: "vi" }, hidden: false,
      getElementById: (id) => els2[id] || null, addEventListener: () => {}, querySelector: () => null,
    },
    Ably: { Realtime: function(cfg){ ablyCtor.push(cfg); this.connection = { on: () => {} }; this.channels = { get: () => ({ subscribe: () => {}, unsubscribe: () => {} }) }; } },
    window: {},
  };
  vm.createContext(sandbox2);
  vm.runInContext(src, sandbox2);
  check("B19 Ably khoi dong duoc khi CHUA dang nhap (khong bi day ve poll)", ablyCtor.length === 1 && els2.pushStatus.textContent === "connecting", { calls: ablyCtor.length, st: els2.pushStatus.textContent });
  // fix 03/11: lan ket noi DAU TIEN (retries=0) in "connecting" — khong
  // con "retry" ("banner Mất kết nối trên MỌI lần tải trang" la 1 phan
  // trieu chung). Sai lan thu 2 tro di moi la "retry".
}

console.log("p1-heartbeat: " + passed + " pass, " + failed + " fail");
process.exit(failed ? 1 : 0);
