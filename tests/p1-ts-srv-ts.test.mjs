// P1-2 (§8 muc 7, §7a) — đồng hồ THI TRUONG trong frame.
// Chung minh: (1) fanout gan `ts` = moc feed (retrieved_at / time chi so),
// (2) DO giu `ts` goc + them `srv_ts` rieng, KHONG de `ts`, (3) replay tu
// ring buffer van mang `ts` goc (khong mang dong ho luc replay), (4) client
// bo frame khac ngay phien + bao "stale". Run: node tests/p1-ts-srv-ts.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register("./p1-hooks.mjs", import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const { buildFanoutFrames, deriveMarketTs } = await import("../worker/src/fanout.js");
const { MarketRoom } = await import("../worker/src/market-room.js");
const { stubState } = await import("./stubs/db.mjs");

// Client ham thuan (vm, khong DOM).
const src = fs.readFileSync(path.join(here, "..", "js", "features", "unified-ingest.js"), "utf8");
const moduleObj = { exports: {} };
const sandbox = {
  module: moduleObj, exports: moduleObj.exports, console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval,
  URLSearchParams: URLSearchParams,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const U = moduleObj.exports;

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

const FEED_TS = Date.UTC(2026, 10, 2, 2, 30, 0);   // 09:30 ICT 02/11 — trong phien
const YESTERDAY = Date.UTC(2026, 10, 1, 2, 0, 0);  // 09:00 ICT 01/11 — ngoai phien
const REPLAY_TS = Date.UTC(2026, 10, 2, 9, 0, 0);  // dong ho server luc replay

/* ---------- 1. deriveMarketTs + fanout gan ts ---------- */
{
  check("1a retrieved_at duoc lay truoc", deriveMarketTs({ _prov: { retrieved_at: "2026-11-02T02:30:00.000Z" }, indices: [{ time: "2026-11-01T02:00:00.000Z" }] }) === FEED_TS);
  check("1b fallback `time` cua chi so dau tien", deriveMarketTs({ indices: [{ symbol: "VNINDEX", time: "2026-11-02T02:30:00.000Z" }] }) === FEED_TS);
  check("1c khong nguon -> undefined (khong bịa ts)", deriveMarketTs({ quotes: { ACB: { close: 1 } } }) === undefined);
  check("1d chuoi khong hop le -> undefined", deriveMarketTs({ _prov: { retrieved_at: "khong-phai-ngay" } }) === undefined);

  const b = buildFanoutFrames({
    _prov: { retrieved_at: "2026-11-02T02:30:00.000Z" },
    quotes_patch: { ACB: { close: 22500, pct_change: 0.45 } },
    indices: [{ symbol: "VNINDEX", close: 1766.87, pct_change: 0.31 }],
  });
  check("1e frame q mang ts = feed", b.q.length === 1 && b.q[0].ts === FEED_TS, b.q[0]);
  check("1f frame idx mang ts = feed", b.idx && b.idx.ts === FEED_TS, b.idx);
  const b2 = buildFanoutFrames({ quotes_patch: { ACB: { close: 22500, pct_change: 0.45 } } });
  check("1g khong co nguon -> frame khong mang ts", b2.q[0].ts === undefined, b2.q[0]);
}

/* ---------- 2. DO: giu ts goc + srv_ts rieng ---------- */
const realNow = Date.now;
function makeRoom(){
  const ctx = { storage: { setAlarm: async () => {} } };
  return new MarketRoom(ctx, { INTERNAL_SECRET: "s3cr3t" });
}
function fakeWs(){
  return { sent: [], closed: null, send(s){ this.sent.push(s); }, close(code, reason){ this.closed = { code: code, reason: reason }; } };
}
async function activate(room, ws){
  await room.webSocketMessage(ws, JSON.stringify({ t: "auth", token: "" }));
  await room.webSocketMessage(ws, JSON.stringify({ t: "sub", view: "market" }));
}

{
  Date.now = () => REPLAY_TS;                      // dong ho server = 16:00 ICT
  const room = makeRoom(), ws = fakeWs();
  await activate(room, ws);
  ws.sent.length = 0;
  const res = room._ingest([{ t: "idx", rows: [{ s: "VNINDEX", p: 1766.87, pc: 0.31 }], ts: FEED_TS }, { t: "q", s: "ACB", p: 22500, ts: FEED_TS }]);
  const got = ws.sent.map(s => JSON.parse(s));
  const idxF = got.find(f => f.t === "idx"), qF = got.find(f => f.t === "q");
  check("2a DO giu NGUYEN ts goc (khong de Date.now)", idxF && idxF.ts === FEED_TS && qF && qF.ts === FEED_TS, { idx: idxF && idxF.ts, q: qF && qF.ts });
  check("2b DO them srv_ts = dong ho server", idxF && idxF.srv_ts === REPLAY_TS && qF && qF.srv_ts === REPLAY_TS, { idx: idxF && idxF.srv_ts });
  check("2c ts va srv_ts la hai field tach biet", idxF && idxF.ts !== idxF.srv_ts, idxF && { ts: idxF.ts, srv_ts: idxF.srv_ts });
  check("2d ingest tra seq day du", res.published === 2 && res.seqs.length === 2, res);
  check("2e khong dat tsFallback khi nguon co ts", idxF && idxF.tsFallback === undefined, idxF);

  // Replay sau khi dong ho server tien den — ring buffer PHAI giu ts goc.
  Date.now = () => REPLAY_TS + 3600 * 1000;
  const ws2 = fakeWs();
  await activate(room, ws2);
  await room.webSocketMessage(ws2, JSON.stringify({ t: "resume", since: 0 }));
  const replayed = ws2.sent.map(s => JSON.parse(s)).filter(f => f.t === "idx" || f.t === "q");
  check("3a replay giu ts goc (khong mang gio luc replay)", replayed.length === 2 && replayed.every(f => f.ts === FEED_TS), replayed.map(f => f.ts));
  check("3b replay giu srv_ts luc phat (khong phai luc replay)", replayed.every(f => f.srv_ts === REPLAY_TS), replayed.map(f => f.srv_ts));
  Date.now = realNow;
}

/* ---------- 2f. DO fallback: nguon khong co ts -> ts=Date.now + tsFallback ---------- */
{
  Date.now = () => REPLAY_TS;
  const room = makeRoom(), ws = fakeWs();
  await activate(room, ws);
  ws.sent.length = 0;
  room._ingest([{ t: "q", s: "ACB", p: 22500 }]);
  const f = JSON.parse(ws.sent[0]);
  check("2f khong co ts nguon -> ts=server + danh dau tsFallback", f.ts === REPLAY_TS && f.tsFallback === true && f.srv_ts === REPLAY_TS, f);
  Date.now = realNow;
}

/* ---------- 4. Client: bo frame khac ngay phien, bao "stale" ---------- */
{
  check("4a ictDay theo gio ICT (+07)", U.ictDay(FEED_TS) === "2026-11-02" && U.ictDay(YESTERDAY) === "2026-11-01", [U.ictDay(FEED_TS), U.ictDay(YESTERDAY)]);
  check("4b 20:00 UTC 01/11 = 03:00 ICT 02/11 -> dung phien 02/11", U.ictDay(Date.UTC(2026, 10, 1, 20, 0)) === "2026-11-02", U.ictDay(Date.UTC(2026, 10, 1, 20, 0)));
  let staleSeen = 0;
  const opts = { sessionDate: "2026-11-02", onStale: function(){ staleSeen++; } };
  const okIdx = { t: "idx", seq: 5, ts: FEED_TS, rows: [{ s: "VNINDEX", p: 1766.87 }] };
  const oldIdx = { t: "idx", seq: 6, ts: YESTERDAY, rows: [{ s: "VNINDEX", p: 1700 }] };
  const noTs = { t: "q", seq: 7, s: "ACB", p: 22500 };
  check("4c frame trong phien duoc chap nhan", U.parseFrame(okIdx, opts) === okIdx && staleSeen === 0);
  check("4d frame ngoai phien bi BO", U.parseFrame(oldIdx, opts) === null && staleSeen === 1, staleSeen);
  check("4e frame khong mang ts bi BO (khong co bang chung phien)", U.parseFrame(noTs, opts) === null && staleSeen === 2, staleSeen);
  check("4f hb/ping khong seq van khong phai frame", U.parseFrame({ t: "hb", ts: FEED_TS, srv_ts: FEED_TS }, opts) === null);
  check("4g khong truyen sessionDate -> hanh vi cu (tuong thich Ably cu)", U.parseFrame(oldIdx) === oldIdx);
  check("4h frame bi bo thi khong duoc apply (deltaPlan khong chay)", U.deltaPlan(U.parseFrame(oldIdx, opts), "v-market", null, false) === "ignore");
}

/* ---------- 5. hb cua DO KHONG duoc tinh la duoc tuoi ---------- */
{
  // hb khong co seq -> parseFrame tra null -> onFrame/applyFrame khong chay.
  stubState.session = null;
  const room = makeRoom(), ws = fakeWs();
  await activate(room, ws);
  ws.sent.length = 0;
  await room.webSocketMessage(ws, JSON.stringify({ t: "ping" }));
  const hb = JSON.parse(ws.sent[0]);
  check("5a ping -> hb", hb.t === "hb" && typeof hb.srv_ts === "number", hb);
  check("5b hb khong phai frame (khong seq) nen khong lam duoc 'tuoi'", U.parseFrame(hb, { sessionDate: U.ictDay(hb.srv_ts) }) === null, hb);
}

console.log("p1-ts-srv-ts: " + passed + " pass, " + failed + " fail");
process.exit(failed ? 1 : 0);
