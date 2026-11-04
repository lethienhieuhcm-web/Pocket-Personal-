// Test hop cua may trang thai unified-ingest.js — do ngat watchdog tren
// duong du phong Ably (nguyen nhan "nen khong nhay theo tick" 04/11).
// Chay tren NHAN ban duoc dan nhap (pristine hoac da patch) de doi chieu
// truoc->sau tren cung mot dong ho gia lap va cung kich ban phat frame.
//   node tests/ably-watchdog.test.mjs running/js/features/unified-ingest.js
//   node tests/ably-watchdog.test.mjs work/js/features/unified-ingest.js
// Run both: node tests/ably-watchdog.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// 2026-11-04 09:00:00 ICT = 02:00:00Z — giua phien sang, thu 4.
const T0 = Date.UTC(2026, 10, 4, 2, 0, 0);

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}
function snap(env){ const s = env.stats(); return { t: s.mode, mode: s.mode, path: s.path, lastSeq: s.lastSeq, gotFrame: s.gotFrame, err: s.err, log: env.log.msgs.slice(-4) }; }

/* ---------- Dong ho gia lap + truong trinh duyet gia ---------- */
function makeEnv(file, opts){
  opts = opts || {};
  const log = { ws: [], ably: [], tokens: 0, ticks: [], msgs: [], clients: 0 };
  let now = T0, ids = 1;
  const queue = [];
  const sched = (fn, ms, period) => { const id = ids++; queue.push({ id, at: now + (ms || 0), fn, period }); return id; };
  const cancel = (id) => { const i = queue.findIndex(x => x.id === id); if(i >= 0) queue.splice(i, 1); };
  async function advance(ms){
    const target = now + ms;
    for(let guard = 0; guard < 500000; guard++){
      let next = null;
      for(const t of queue) if(t.at <= target && (!next || t.at < next.at)) next = t;
      if(!next) break;
      cancel(next.id);
      now = next.at;
      try{ next.fn(); }catch(e){ log.msgs.push("TIMER ERR " + e.message); }
      if(next.period) sched(next.fn, next.period, next.period);
      // Nho microtask: promise (fetch -> authCallback -> connected) phai duoc
      // chay GIUA cac timer nhu trong trinh duyet that, neu khong thi
      // connection.state dung lai "initialized" va ablyAlive() gia false.
      for(let i = 0; i < 12; i++) await null;
    }
    now = target;
  }
  function FakeDate(...a){ return a.length ? new Date(...a) : new Date(now); }
  FakeDate.now = () => now; FakeDate.prototype = Date.prototype;

  const mkEl = (id) => ({ id: id || "", textContent: "", innerHTML: "", className: "", style: {},
    querySelectorAll: () => [], querySelector: () => null, appendChild: () => {} });
  const els = { "v-market": mkEl("v-market"), "v-detail": mkEl("v-detail"),
    dSym: Object.assign(mkEl("dSym"), { textContent: "ACB" }), pushStatus: mkEl("pushStatus") };
  const viewOn = Object.assign(mkEl(opts.view || "v-detail"), {});
  const document = {
    readyState: "complete", hidden: false, documentElement: { lang: "vi" }, body: mkEl("body"),
    getElementById: (id) => (Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null),
    querySelector: (sel) => (sel === ".view.on" ? viewOn : null),
    createElement: mkEl, addEventListener: () => {},
  };
  const store = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const window = { SS_PX: {}, SS_IDX: {},
    onIngestTick: (f) => log.ticks.push({ t: now - T0, seq: f && f.seq, s: f && f.s }) };

  /* --- WebSocket gia: wsOpen = socket song that (MO + ok + hb), wsClose =
   * socket chet lien (kich ban cascade do->ably chay nhanh trong ~8s) --- */
  const sockets = [];
  function FakeWebSocket(url){
    const self = { url, readyState: 0, sent: [],
      onopen: null, onmessage: null, onclose: null, onerror: null,
      send(s){ self.sent.push(String(s)); },
      close(){ self.readyState = 3; },
      emit(obj){ if(self.onmessage) self.onmessage({ data: JSON.stringify(obj) }); } };
    sockets.push(self);
    log.ws.push({ ev: "new", t: now - T0 });
    if(opts.wsOpen) sched(function(){ self.readyState = 1; log.ws.push({ ev: "open", t: now - T0 }); if(self.onopen) self.onopen({}); }, 5);
    if(opts.wsClose) sched(function(){ self.readyState = 3; log.ws.push({ ev: "close", t: now - T0 }); if(self.onclose) self.onclose({ code: 1006 }); }, opts.wsClose);
    return self;
  }

  /* --- Ably gia: token + connected sau 200ms, kenh attached khi subscribe --- */
  let channel = null;
  function FakeChannel(name){
    const c = { name, state: "initialized", _fn: null, subs: 0, unsubs: 0,
      subscribe(fn){ c._fn = fn; c.subs++; c.state = "attached"; log.ably.push({ ev: "subscribe", t: now - T0, ch: name }); },
      unsubscribe(){ c._fn = null; c.unsubs++; c.state = "detached"; log.ably.push({ ev: "unsubscribe", t: now - T0 }); },
      emit(data){ if(c._fn) c._fn({ data: JSON.stringify(data), name: "update", timestamp: now }); } };
    return c;
  }
  function FakeRealtime(o){
    const cli = this;
    cli.closed = false;
    cli.connection = { state: "initialized", on(ev, fn){ (cli.h = cli.h || {})[ev] = fn; } };
    cli.channels = { get(name){ if(!channel) channel = FakeChannel(name); return channel; } };
    log.clients++;
    log.ably.push({ ev: "new client", t: now - T0 });
    sched(function(){
      if(cli.closed) return;
      if(typeof o.authCallback === "function"){
        o.authCallback({}, function(err, td){
          if(err){ cli.connection.state = "failed"; if(cli.h && cli.h.failed) cli.h.failed({ reason: err }); return; }
          log.tokens++; cli.connection.state = "connected"; log.ably.push({ ev: "connected", t: now - T0 });
        });
      } else cli.connection.state = "connected";
    }, 200);
    cli.close = function(){ cli.closed = true; if(channel) channel.unsubscribe(); log.ably.push({ ev: "close client", t: now - T0 }); };
  }
  const Ably = { Realtime: FakeRealtime };
  const fetchStub = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tokenString: "fake", expires: now / 1000 + 3600 }) });

  const moduleObj = { exports: {} };
  const sandbox = {
    module: moduleObj, exports: moduleObj.exports,
    console: { log: () => {}, warn: (m) => log.msgs.push("warn " + String(m).slice(0, 90)), error: (m) => log.msgs.push("err " + String(m).slice(0, 90)), info: () => {} },
    setTimeout: (fn, ms) => sched(fn, ms), clearTimeout: cancel,
    setInterval: (fn, ms) => sched(fn, ms, ms), clearInterval: cancel,
    Date: FakeDate, URLSearchParams, document, window,
    location: { search: opts.search || "", hostname: "lethanhdong.one", host: "lethanhdong.one", protocol: "https:" },
    sessionStorage: store, localStorage: store,
    WebSocket: FakeWebSocket, Ably, fetch: fetchStub, Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(ROOT, file), "utf8"), sandbox);
  const api = sandbox.window.UnifiedIngest;
  return { api, log, sockets, advance, now: () => now, channel: () => channel, stats: () => api.stats(), ablyLog: () => log.ably.slice(-8) };
}

/* Duong DO chet lien (wsClose) -> MAX_RETRY day sang Ably trong ~8s. */
async function toAbly(env, limitMs){
  const step = 250;
  for(let t = 0; t < limitMs; t += step){
    const s = env.stats();
    if(s.path === "ably" && s.mode === "ably") return t;
    await env.advance(step);
  }
  return -1;
}
function frame(seq, sym, at){
  return { t: "q", seq: seq, s: sym || "ACB", p: 25000, c: 100, pc: 0.4, v: 12000, ts: at };
}
function send(env, f){ const c = env.channel(); if(c) c.emit(f); }

const FILE = process.argv[2];
const files = FILE ? [FILE] : ["running/js/features/unified-ingest.js", "work/js/features/unified-ingest.js"];

for(const f of files){
  console.log("\n== " + f + " ==");
  const OPT = { wsClose: 1 };

  /* (1) DOT frame dau tien den luc +31s sau khi duong Ably mo (gap thuc
   * do duoc tren kenh `market`: 8/41/126/133/134s — phan lon vuot 30s).
   * Watchdog 30s "khong noi duoc sau 30s" co pha duong truoc kip? */
  {
    const env = makeEnv(f, OPT);
    const tA = await toAbly(env, 30000);
    check("(1) cascade do->ably hoan tat (path=ably)", tA >= 0, { tA, ...snap(env) });
    const errAt = env.stats().err, clientsAt = env.log.clients;
    await env.advance(31000);              // vuot nguong 30s, CHUA co frame nao
    const stMid = snap(env);
    check("(1) watchdog 30s khong pha duong Ably khi dot frame chua toi", stMid.err === errAt, { errAt, at31s: stMid });
    check("(1) khong reconnect trong 31s im lang (1 client Ably duy nhat)", env.log.clients === clientsAt, { clientsAt, clients: env.log.clients, at31s: stMid });
    send(env, frame(101, "ACB", env.now()));
    const st = snap(env);
    check("(1) batch +31s duoc NHAN: gotFrame + lastSeq=101", env.stats().gotFrame === true && env.stats().lastSeq === 101, { at31s: stMid, after: st });
    check("(1) tick duoc chuyen den chart (window.onIngestTick)", env.log.ticks.length === 1, { ticks: env.log.ticks.length, st });
    check("(1) van con duong ably sau +31s", env.stats().mode === "ably" && env.stats().path === "ably", st);
  }

  /* (2) Gap 100s giua hai DOT (do duoc 126–134s): watchdog "khong hb >70s"
   * co pha ket noi trong khi Ably van connected+attached? */
  {
    const env = makeEnv(f, OPT);
    await toAbly(env, 30000);
    await env.advance(5000);
    send(env, frame(201, "ACB", env.now()));
    const errAfter1 = env.stats().err, clients1 = env.log.clients;
    await env.advance(100000);
    send(env, frame(202, "ACB", env.now()));
    const st = snap(env);
    if(process.env.INGEST_DEBUG) console.log("  DBG2 " + JSON.stringify({ clients: env.log.clients, ably: env.log.ably, msgs: env.log.msgs, ws: env.log.ws.slice(-6) }, null, 1));
    check("(2) batch sau gap 100s duoc NHAN (lastSeq=202)", st.lastSeq === 202, { errAfter1, st, ably: env.ablyLog() });
    check("(2) khong break trong gap 100s (err khong tang)", st.err === errAfter1, { errAfter1, st });
    check("(2) khong pha ket noi trong gap 100s (1 client)", env.log.clients === clients1, { clients1, clients: env.log.clients, st });
  }

  /* (3) Im lang 150s trong phien = nhip BINH THUONG cua nguon (gap 126/133/
   * 134s): duong phai duoc giu, frame dot ke tiep phai vao. */
  {
    const env = makeEnv(f, OPT);
    await toAbly(env, 30000);
    await env.advance(5000);
    send(env, frame(301, "ACB", env.now()));
    await env.advance(150000);
    const st = snap(env);
    check("(3) con duong ably sau 150s im lang (khong roi poll)", st.mode === "ably" && st.path === "ably", st);
    send(env, frame(302, "ACB", env.now()));
    check("(3) batch sau 150s im lang duoc NHAN (lastSeq=302)", env.stats().lastSeq === 302, snap(env));
  }

  /* (4) Luu cu van con: im lang VUOT nguong thang cap (120s cu / 180s moi)
   * thi phai roi poll — khong de duong "song gia" mai mai. */
  {
    const env = makeEnv(f, OPT);
    await toAbly(env, 30000);
    await env.advance(5000);
    send(env, frame(401, "ACB", env.now()));
    await env.advance(300000);
    check("(4) im lang 300s -> roi poll (luu cu hoat dong)", env.stats().mode === "poll", snap(env));
  }

  /* (5) Khong regression duong DO: socket MO + {t:"ok"} + hb 30s -> im lang
   * 180s van la "quiet", khong dut (P1-4). Tat dong ho thang cap
   * (?ingesc=1000) de do RIENG watchdog connect/hb cua duong DO. */
  {
    const env = makeEnv(f, { wsOpen: true, search: "?ingesc=1000" });
    await env.advance(1000);
    const ws = env.sockets[env.sockets.length - 1];
    ws.emit({ t: "ok" });
    const errAt0 = env.stats().err;
    for(let i = 0; i < 6; i++){
      await env.advance(30000);
      const cur = env.sockets[env.sockets.length - 1];
      if(cur && cur.readyState === 1) cur.emit({ t: "hb" });
    }
    const st = snap(env);
    check("(5) duong DO co hb: van la do sau 180s (im lang = quiet)", st.path === "do" && st.mode === "do", { st, ably: env.ablyLog() });
    check("(5) DO co hb khong bi dem err trong 180s", st.err === errAt0, { errBefore: errAt0, st });
    check("(5) DO khong bi mo client Ably (khong thang cap oan)", env.log.clients === 0, { clients: env.log.clients, st });
  }

  /* (6) TAI DIEN nhip do duoc 600s tren kenh `market` (evidence-ably-cadence
   * txt): gap 8/41/126/133/134s, 6 DOT. Duong Ably phai song SUOT va ca 6
   * dot phai den chart (day la dieu kien de nen khay theo tick). */
  {
    const env = makeEnv(f, OPT);
    await toAbly(env, 30000);
    const GAPS = [8000, 41000, 126000, 133000, 134000];
    let seq = 1;
    const delivered = [];
    for(let i = 0; i < GAPS.length; i++){
      await env.advance(GAPS[i]);
      const before = env.log.ticks.length;
      send(env, frame(seq, "ACB", env.now())); seq++;
      if(env.log.ticks.length > before) delivered.push(i + 1);
    }
    const st = snap(env);
    check("(6) con duong ably het 600s tai dien", st.mode === "ably" && st.path === "ably", st);
    check("(6) 5/5 dot frame den chart (khong mat dot nao)", delivered.length === 5, { delivered, st });
    check("(6) khong break nao sau khi vao ably (err dung)", st.err === 4, { st, msgs: env.log.msgs });
    check("(6) mot ket noi Ably duy nhat trong 600s", env.log.clients === 1, { clients: env.log.clients, st });
  }
}

console.log("\nably-watchdog: " + passed + " pass, " + failed + " fail");
if(failed) process.exit(1);
