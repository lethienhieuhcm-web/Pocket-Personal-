// P1-3 (§8 muc 6) — bo gate dang nhap cho realtime CHI-DOC + poll fetch that.
// Ba lop kiem thu: (1) bang ROUTE that cua Worker (doc + danh gia literal),
// (2) hAblyToken that khong doi hoi session va chi cap quyen subscribe,
// (3) DO chap khach khong token/token cu = chi-đoc, van KHONG co quyen ghi.
// (f) enterPoll() phai goi nap duoc that, khong ngon cho.
// Run: node tests/p1-readonly-gate.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register("./p1-hooks.mjs", import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const { hAblyToken } = await import("../worker/src/stock.js");
const { MarketRoom } = await import("../worker/src/market-room.js");
const { stubState } = await import("./stubs/db.mjs");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

/* ---------- 1. Bang ROUTE that (khong doan bang regex chuoi) ---------- */
function loadRoutes(){
  const lines = fs.readFileSync(path.join(here, "..", "worker", "src", "index.js"), "utf8").split("\n");
  const start = lines.findIndex(l => l.startsWith("const ROUTES = ["));
  let end = -1;
  for(let i = start + 1; i < lines.length; i++){ if(/^\s*\];\s*$/.test(lines[i])){ end = i; break; } }
  if(start < 0 || end < 0) throw new Error("khong tim thay ROUTES trong index.js");
  const body = lines.slice(start + 1, end).join("\n");
  // Moi handler la mot ten ham -> gan gia duong dan, khong can chay that.
  const names = new Set();
  for(const m of body.matchAll(/\b(handle[A-Za-z_]+|h[A-Z][A-Za-z0-9_]*)\b/g)) names.add(m[0]);
  const sandbox = {};
  for(const n of names) sandbox[n] = n;
  vm.createContext(sandbox);
  return vm.runInContext("[" + body + "]", sandbox);
}
const ROUTES = loadRoutes();
function kindOf(method, p){ const r = ROUTES.find(([m, pat]) => m === method && pat === p); return r ? r[3] : null; }
check("1a ROUTES doc duoc", Array.isArray(ROUTES) && ROUTES.length > 100, ROUTES.length);
check("1b POST /api/ably-token = public (KHONG con 'user')", kindOf("POST", "/api/ably-token") === "public", kindOf("POST", "/api/ably-token"));
check("1c GET /api/stock/stream van public (khong doi tu truoc)", kindOf("GET", "/api/stock/stream") === "public", kindOf("GET", "/api/stock/stream"));
check("1d GET /api/stock/indices public (duong doc cua page)", kindOf("GET", "/api/stock/indices") === "public", kindOf("GET", "/api/stock/indices"));
// Ghi / tai khoan VAN phai dang nhap — day la pham vi KHONG mo.
const WRITE_ROUTES = [
  ["POST", "/api/stock/watchlist"], ["DELETE", "/api/stock/watchlist/*"],
  ["POST", "/api/stock/portfolio/txn"], ["GET", "/api/stock/portfolio"],
  ["POST", "/api/stock/targets"], ["DELETE", "/api/stock/targets/*"],
  ["POST", "/api/stock/rule-alerts"], ["GET", "/api/stock/risk"],
  ["GET", "/api/stock/strategy_review"], ["GET", "/api/auth/me"],
  ["POST", "/api/ai/chat"],
];
let writeOk = true, writeBad = [];
for(const [m, p] of WRITE_ROUTES){ const k = kindOf(m, p); if(k !== "user"){ writeOk = false; writeBad.push(m + " " + p + " => " + k); } }
check("1e moi thao tac ghi / tai khoan van 'user' (401 khi chua login)", writeOk, writeBad);
check("1f duong internal (stock-publish) van 'internal'", kindOf("POST", "/api/internal/stock-publish") === "internal", kindOf("POST", "/api/internal/stock-publish"));
check("1g khong co route 'public' nao moi moc them ngoai ably-token", ROUTES.filter(r => r[3] === "public").length > 0 && ROUTES.some(r => r[1] === "/api/ably-token"), ROUTES.length);

/* ---------- 2. hAblyToken: khong hoi session, chi subscribe ---------- */
{
  const realFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = { url: url, body: JSON.parse(opts.body), authHeader: opts.headers.Authorization };
    return { ok: true, status: 200, json: async () => ({ token: "tok-op-duoc-khong-tai-ve-day", expires: Date.now() + 3600000 }), text: async () => "" };
  };
  const env = { ABLY_ROOT_KEY: "keyname:secretvalue" };
  // KHONG co cookie/Authorization nao — nhu khach vãng lai goi thang qua route 'public'.
  const req = { url: "https://x/api/ably-token?channel=market", method: "POST" };
  const res = await hAblyToken(req, env);
  const j = await res.json();
  check("2a cap token duoc ma khong can dang nhap", res.status === 200 && !!j.token, res.status);
  const caps = JSON.parse(sent.body.capability);
  const vals = Object.keys(caps).map(k => caps[k].join("+"));
  // Kenh 'market' trung khoa mac dinh -> gộp 1 key; dieu kien can: CHI subscribe.
  check("2b capability CHỈ subscribe (khong publish/presence/history)", Object.keys(caps).length >= 1 && vals.every(v => v === "subscribe"), caps);
  check("2c pham vi kenh = market (khong mo kenh khac)", caps.market && caps.market.includes("subscribe"), caps);
  check("2d khong tra key/secret ve trinh duyet", sent.url.indexOf(sent.authHeader) < 0 && j.token !== undefined && !("key" in j), Object.keys(j));
  // Chan kenh la de khong bi dung token vao kenh khac.
  const bad = await hAblyToken({ url: "https://x/api/ably-token?channel=payme", method: "POST" }, env);
  check("2e kenh khong hop le van bi chan (400)", bad.status === 400, bad.status);
  const noKey = await hAblyToken(req, {});
  check("2f thieu ABLY_ROOT_KEY -> 500, khong lot token gia", noKey.status === 500, noKey.status);
  globalThis.fetch = realFetch;
}

/* ---------- 3. DO: khach khong token / token cu = chi-đoc, khong phai 4401 ---------- */
function fakeWs(){
  return { sent: [], closed: null, send(s){ this.sent.push(s); }, close(code, reason){ this.closed = { code: code, reason: reason }; } };
}
function makeRoom(){
  return new MarketRoom({ storage: { setAlarm: async () => {} }, acceptWebSocket: () => {} }, { INTERNAL_SECRET: "s3cr3t" });
}
{
  const room = makeRoom(), ws = fakeWs();
  await room.webSocketMessage(ws, JSON.stringify({ t: "auth", token: "" }));
  const ok = JSON.parse(ws.sent[0]);
  check("3a khong token -> {t:ok, ro:true}, socket khong bi vo", ok.t === "ok" && ok.ro === true && ws.closed === null, { ok: ok, closed: ws.closed });
  check("3b khong co quyen 'authed' (chi la khach doc)", room.sockets.get(ws).authed === false && room.sockets.get(ws).ro === true, room.sockets.get(ws) && { authed: room.sockets.get(ws).authed, ro: room.sockets.get(ws).ro });
  await room.webSocketMessage(ws, JSON.stringify({ t: "sub", view: "market" }));
  check("3c khach doc duoc sub + subbed", JSON.parse(ws.sent[1]).t === "subbed", ws.sent[1]);
  room._ingest([{ t: "q", s: "ACB", p: 22500, ts: Date.now() }]);
  check("3d khach doc NHAN duoc frame (day la muc tieu cua P1-3)", ws.sent.some(s => JSON.parse(s).t === "q"));
}
{
  // Token da het han: truoc day bi 4401 + vo; nay giam xuong chi-đoc.
  stubState.session = (token) => (token === "cu" ? { email: "a@b.c", exp: Date.now() - 1000 } : null);
  const room = makeRoom(), ws = fakeWs();
  await room.webSocketMessage(ws, JSON.stringify({ t: "auth", token: "cu" }));
  const ok = JSON.parse(ws.sent[0]);
  check("3e token het han -> chi-đoc (khong con 4401)", ok.t === "ok" && ok.ro === true && ws.closed === null, { ok: ok, closed: ws.closed });
  stubState.session = { email: "u@x.y", exp: Date.now() + 3600000 };
  const room2 = makeRoom(), ws2 = fakeWs();
  await room2.webSocketMessage(ws2, JSON.stringify({ t: "auth", token: "ngon" }));
  const ok2 = JSON.parse(ws2.sent[0]);
  check("3f token hop le van duoc authed (ro:false), khong ha cap khach login", ok2.t === "ok" && ok2.ro === false && room2.sockets.get(ws2).authed === true, ok2);
  // Message truoc handshake -> van phai yeu cau auth.
  const room3 = makeRoom(), ws3 = fakeWs();
  await room3.webSocketMessage(ws3, JSON.stringify({ t: "sub", view: "market" }));
  check("3g gui sub truoc handshake -> auth-required (khong lot duoc duoc lieu)", JSON.parse(ws3.sent[0]).t === "auth-required", ws3.sent[0]);
  stubState.session = null;
}
/* ---------- 3h. Chan spam van con (mo doc khong mo lo lam phat) ---------- */
{
  const room = makeRoom(), ws = fakeWs();
  await room.webSocketMessage(ws, JSON.stringify({ t: "auth", token: "" }));
  let closed = null;
  for(let i = 0; i < 25; i++){
    await room.webSocketMessage(ws, JSON.stringify({ t: "ping" }));
    if(ws.closed){ closed = ws.closed; break; }
  }
  check("3h socket gui >10 tin/giay van bi chan (rate-limit giu nguyen)", closed && closed.code === 1008, closed);
}

/* ---------- (f) enterPoll() PHAI fetch that ---------- */
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
        for(const [i, t] of pool){ if(t.at <= target && (pick === null || t.at < pick[1].at)) pick = [i, t]; }
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
  const T0 = Date.UTC(2026, 10, 2, 2, 0, 0);
  const timers = makeTimers(T0);
  let reloads = 0;
  const logs = [];
  const els = { pushStatus: { textContent: "" }, "v-market": {}, "v-detail": null };
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: (m) => logs.push(String(m)) },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    Date: class extends Date { static now(){ return timers.now(); } },
    JSON: JSON, Math: Math, Number: Number, Object: Object, Array: Array,
    String: String, Boolean: Boolean, Promise: Promise, URLSearchParams: URLSearchParams,
    WebSocket: function(){ this.readyState = 1; this.send = () => {}; this.close = () => {}; },
    sessionStorage: { getItem: () => "0", setItem: () => {} },
    localStorage: { getItem: () => null },
    location: { search: "", protocol: "https:", host: "lethanhdong.one" },
    document: {
      readyState: "complete", documentElement: { lang: "vi" }, hidden: false,
      getElementById: (id) => els[id] || null, addEventListener: () => {}, querySelector: () => null,
    },
    reloadCurrentView: () => { reloads++; return Promise.resolve(true); },
    // Khong co Ably toan cuc -> duong Ably that bai -> roi poll (kich hoan enterPoll).
    window: {},
  };
  vm.createContext(sandbox);
  // Ep duong Ably bang ?pushchan=staging-* (testMode) de vao thang enterPoll.
  sandbox.location.search = "?pushchan=staging-h1-20261102";
  const src = fs.readFileSync(path.join(here, "..", "js", "features", "unified-ingest.js"), "utf8");
  vm.runInContext(src, sandbox);
  const ablyTries = () => logs.filter(l => l.indexOf("[ingest:ably]") === 0).length;
  check("f1 roi vào poll (Ably SDK khong co) -> nhan 'poll'", els.pushStatus.textContent === "poll", els.pushStatus.textContent);
  check("f2 enterPoll goi nap duoc THAT ngay lap tuc (reloadCurrentView)", reloads === 1, reloads);
  timers.advance(60000);
  check("f3 poll tiep tuc fetch moi 60s (khong ngon cho 5 phut)", reloads === 2, reloads);
  timers.advance(60000);
  check("f4 poll lap lan 3 o phut 2", reloads === 3, reloads);
  // Den POLL_RETRY_MS (5 phut) phai THU NOI LAI realtime — khong poll mai.
  timers.advance(4 * 60 * 1000);
  check("f5 van tiep tuc fetch trong luc poll", reloads >= 6, reloads);
  timers.advance(70 * 1000);
  check("f6 den ky (5 phut) thu noi lai realtime, khong chi nam im", ablyTries() >= 2, { tries: ablyTries(), reloads: reloads });
  check("f7 that bai duong realtime van duoc dem (errCount tang, khong nuot im)", typeof sandbox.window.UnifiedIngest === "object" && sandbox.window.UnifiedIngest.errCount() >= 2, sandbox.window.UnifiedIngest && sandbox.window.UnifiedIngest.errCount());
}

console.log("p1-readonly-gate: " + passed + " pass, " + failed + " fail");
process.exit(failed ? 1 : 0);
