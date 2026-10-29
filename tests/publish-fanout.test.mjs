// Test fan-out H1 trong hStockPublish: DO cap seq, Ably an theo,
// loi fan-out khong lam hong publish, _ib khong fan-out.
// Run: node tests/publish-fanout.test.mjs
import { register } from "node:module";
register("./flow-hooks.mjs", import.meta.url);

const { hStockPublish } = await import("../worker/src/stock.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}
function eq(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

function mockEnv(store, opts){
  opts = opts || {};
  return {
    DATA: {
      get: async (key) => {
        const v = store.get(key);
        if(v === undefined) return null;
        return { json: async () => JSON.parse(JSON.stringify(v)) };
      },
      put: async (key, val) => { store.set(key, typeof val === "string" ? JSON.parse(val) : val); },
    },
    STOCK_PUBLISH_SECRET: "s3cr3t",
    INTERNAL_SECRET: "s3cr3t",
    MARKET_ROOM: opts.marketRoom === undefined ? null : opts.marketRoom,
    ABLY_ROOT_KEY: opts.ablyKey === undefined ? null : opts.ablyKey,
  };
}
const pubReq = (body) => ({
  headers: { get: (k) => (k === "X-Publish-Secret" ? "s3cr3t" : null) },
  json: async () => body,
});

// Fake DO: cap seq lien tuc, tra seqs[] (nhu market-room.js moi).
function fakeDo(calls){
  let seq = 0;
  return {
    idFromName: (n) => n,
    get: () => ({
      fetch: async (req) => {
        const body = JSON.parse(await req.text());
        calls.push(body.frames);
        const seqs = body.frames.map(() => ++seq);
        return { ok: true, status: 200, json: async () => ({ ok: true, published: body.frames.length, seq: seq, seqs: seqs }) };
      },
    }),
  };
}
// Fake DO cu: chi tra seq + published, khong co seqs[].
function fakeDoLegacy(calls){
  let seq = 0;
  return {
    idFromName: (n) => n,
    get: () => ({
      fetch: async (req) => {
        const body = JSON.parse(await req.text());
        calls.push(body.frames);
        seq += body.frames.length;
        return { ok: true, status: 200, json: async () => ({ ok: true, published: body.frames.length, seq: seq }) };
      },
    }),
  };
}
function failingDo(){
  return {
    idFromName: (n) => n,
    get: () => ({ fetch: async () => { throw new Error("DO chet"); } }),
  };
}

const full = { close: 22500, change: 100, pct_change: 0.45, volume: 1234567, value_vnd: 27700000000, foreign_buy_value: 5000000000, foreign_sell_value: 2000000000 };
const origFetch = globalThis.fetch;
let ablyCalls = [];
function stubFetch(){
  ablyCalls = [];
  globalThis.fetch = async (url, opts) => {
    ablyCalls.push({ url: url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201, text: async () => "" };
  };
}
function restoreFetch(){ globalThis.fetch = origFetch; }

// --- 1. Khong binding nao: publish van ok, khong goi fetch/DO. ---
{
  const store = new Map();
  stubFetch();
  const res = await hStockPublish(pubReq({ quotes_patch: { ACB: full } }), mockEnv(store, { marketRoom: null, ablyKey: null }));
  const body = await res.json();
  check("khong binding: ok", res.status === 200 && body.ok === true, body);
  check("khong binding: khong fetch Ably", ablyCalls.length === 0);
  check("khong binding: response khong them field fanout", body.fanout === undefined, body);
  check("khong binding: R2 van ghi", !!store.get("stock/market/quotes.json"));
  restoreFetch();
}

// --- 2. DO hong: fallback seq, publish van ok. ---
{
  const store = new Map();
  stubFetch();
  const pending = [];
  const ctx = { waitUntil: (p) => { pending.push(p); } };
  const res = await hStockPublish(pubReq({ quotes_patch: { ACB: full, MWG: full } }), mockEnv(store, { marketRoom: failingDo(), ablyKey: "key:secret" }), null, ctx);
  await Promise.all(pending);
  const body = await res.json();
  check("DO hong: ok", res.status === 200 && body.ok === true, body);
  check("DO hong: Ably van nhan batch", ablyCalls.length === 1 && ablyCalls[0].body.length === 2, ablyCalls.length);
  const msgs = ablyCalls[0].body.map(m => JSON.parse(m.data));
  // lastDoSeq module-level da tang o case truoc (fallback khi khong binding)
  // -> chi khang dinh tinh lien tuc + co fallback, khong khang dinh so tuyet doi.
  check("DO hong: seq fallback danh dau + lien tuc", msgs[1].seq === msgs[0].seq + 1 && msgs[0].seqFallback === true && msgs[1].seqFallback === true, msgs);
  check("DO hong: kenh market", ablyCalls[0].url === "https://rest.ably.io/channels/market/messages");
  restoreFetch();
}

// --- 3. DO cap seqs[]: idx truoc, q sau, seq lien tuc; _ib khong fan-out. ---
{
  const store = new Map();
  const doCalls = [];
  stubFetch();
  const pending = [];
  const ctx = { waitUntil: (p) => { pending.push(p); } };
  const res = await hStockPublish(pubReq({
    indices: [{ symbol: "VNINDEX", close: 1766.65, pct_change: 0.37 }],
    quotes_patch: { ACB: full, MWG: full },
    quotes_patch_ib: { ACB: full },
    indices_ib: [{ symbol: "VNINDEX", close: 1, pct_change: 0 }],
  }), mockEnv(store, { marketRoom: fakeDo(doCalls), ablyKey: "key:secret" }), null, ctx);
  await Promise.all(pending);
  const body = await res.json();
  check("DO seqs: ok", res.status === 200 && body.ok === true, body);
  check("DO seqs: 1 lan goi, 3 frame, idx truoc", doCalls.length === 1 && doCalls[0].length === 3 && doCalls[0][0].t === "idx" && doCalls[0][1].s === "ACB", doCalls);
  check("DO seqs: khong frame _ib", doCalls[0].every(f => f.t === "idx" || ["ACB", "MWG"].includes(f.s)));
  const msgs = ablyCalls[0].body.map(m => JSON.parse(m.data));
  check("DO seqs: Ably seq 1..3 khong fallback", msgs.map(m => m.seq).join(",") === "1,2,3" && msgs.every(m => !m.seqFallback), msgs);
  check("DO seqs: Ably name theo t", ablyCalls[0].body[0].name === "idx" && ablyCalls[0].body[1].name === "q");
  check("DO seqs: frame q dung field", msgs[1].p === 22500 && msgs[1].fn === 3000000000, msgs[1]);
  restoreFetch();
}

// --- 4. DO cu (khong seqs[]): suy nguoc tu seq cuoi. ---
{
  const store = new Map();
  const doCalls = [];
  stubFetch();
  const res = await hStockPublish(pubReq({ quotes_patch: { A: full, B: full, C: full } }), mockEnv(store, { marketRoom: fakeDoLegacy(doCalls), ablyKey: "key:secret" }), null, undefined);
  const body = await res.json();
  check("DO cu: ok", res.status === 200 && body.ok === true, body);
  const msgs = ablyCalls[0].body.map(m => JSON.parse(m.data));
  check("DO cu: seq suy nguoc 1..3", msgs.map(m => m.seq).join(",") === "1,2,3" && msgs.every(m => !m.seqFallback), msgs);
  restoreFetch();
}

// --- 5. Publish khong co quotes/indices: khong fan-out. ---
{
  const store = new Map();
  const doCalls = [];
  stubFetch();
  const res = await hStockPublish(pubReq({ screener: [{ symbol: "ACB" }] }), mockEnv(store, { marketRoom: fakeDo(doCalls), ablyKey: "key:secret" }), null, undefined);
  const body = await res.json();
  check("khong frame: ok", res.status === 200 && body.ok === true, body);
  check("khong frame: 0 DO + 0 Ably", doCalls.length === 0 && ablyCalls.length === 0);
  restoreFetch();
}

// --- 6. 65 ma + 1 idx = 66 frame: DO chia 60/6, Ably 1 batch. ---
{
  const store = new Map();
  const doCalls = [];
  stubFetch();
  const patch = {};
  for(let i = 0; i < 65; i++) patch["C" + i] = full;
  const res = await hStockPublish(pubReq({ indices: [{ symbol: "VNINDEX", close: 1700, pct_change: 0.1 }], quotes_patch: patch }), mockEnv(store, { marketRoom: fakeDo(doCalls), ablyKey: "key:secret" }), null, undefined);
  const body = await res.json();
  check("chunk: ok", res.status === 200 && body.ok === true, body);
  check("chunk: DO 2 lan 60/6", doCalls.length === 2 && doCalls[0].length === 60 && doCalls[1].length === 6, doCalls.map(c => c.length));
  check("chunk: Ably 1 batch 66", ablyCalls.length === 1 && ablyCalls[0].body.length === 66, ablyCalls.length);
  const seqs = ablyCalls[0].body.map(m => JSON.parse(m.data).seq);
  check("chunk: seq lien tuc 1..66", seqs[0] === 1 && seqs[65] === 66 && new Set(seqs).size === 66, seqs.slice(0, 3));
  restoreFetch();
}

console.log("publish-fanout: " + passed + " pass, " + failed + " fail");
process.exit(failed ? 1 : 0);
