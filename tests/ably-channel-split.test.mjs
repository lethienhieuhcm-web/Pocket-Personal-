// Test tach kenh Ably `market` theo moi truong (staging vs production).
// Bao phu ca hai dau: fan-out publish ben worker (stock.js) va
// channelFor ben client (unified-ingest.js), cong voi hAblyToken (gateway
// quyen subscribe). Muc tieu: staging publish/subscribe len `market-staging`,
// production giu nguyen `market` (khong doi hanh vi production).
// Run: node tests/ably-channel-split.test.mjs
import { register } from "node:module";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
register("./flow-hooks.mjs", import.meta.url);

const { hStockPublish, hAblyToken } = await import("../worker/src/stock.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

const full = { close: 22500, change: 100, pct_change: 0.45, volume: 1234567, value_vnd: 27700000000 };

function mockEnv(opts){
  opts = opts || {};
  const store = new Map();
  return {
    store,
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
// pubReq: request POST stock-publish. `host` = hostname cua URL ma VM goi toi
// (staging = staging.lethanhdong.one / ...-staging...workers.dev; prod = lethanhdong.one).
function pubReq(body, host){
  const url = (host ? "https://" + host : "https://x") + "/api/internal/stock-publish";
  return {
    url,
    headers: { get: (k) => (k === "X-Publish-Secret" ? "s3cr3t" : null) },
    json: async () => body,
  };
}
// DO sống: cap seqs lien tuc (khong roi vao fallback).
function liveDo(calls){
  let seq = 0;
  return {
    idFromName: (n) => n,
    get: () => ({
      fetch: async (req) => {
        const body = JSON.parse(await req.text());
        calls.push(body.frames);
        const seqs = body.frames.map(() => ++seq);
        return { ok: true, status: 200, json: async () => ({ ok: true, published: body.frames.length, seq: seq, seqs }) };
      },
    }),
  };
}

const origFetch = globalThis.fetch;
let ablyCalls = [];
function stubPublishFetch(){
  ablyCalls = [];
  globalThis.fetch = async (url, opts) => {
    ablyCalls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201, text: async () => "" };
  };
}
let tokenCalls = [];
function stubTokenFetch(){
  tokenCalls = [];
  globalThis.fetch = async (url, opts) => {
    tokenCalls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => "", json: async () => ({ token: "tok" }) };
  };
}
function restoreFetch(){ globalThis.fetch = origFetch; }

const MSG_URL = (ch) => "https://rest.ably.io/channels/" + ch + "/messages";

// =================== WORKER: fan-out publish tach theo hostname ===================

// (2) STAGING publish → kenh market-staging.
{
  const env = mockEnv({ marketRoom: liveDo([]), ablyKey: "key:secret" });
  stubPublishFetch();
  const pending = [];
  await hStockPublish(pubReq({ quotes_patch: { ACB: full } }, "staging.lethanhdong.one"), env, null, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  check("staging: fan-out len market-staging", ablyCalls.length === 1 && ablyCalls[0].url === MSG_URL("market-staging"), ablyCalls.map(c => c.url));
  restoreFetch();
}

// (2b) STAGING qua workers.dev (ten worker ...-staging) → market-staging.
{
  const env = mockEnv({ marketRoom: liveDo([]), ablyKey: "key:secret" });
  stubPublishFetch();
  const pending = [];
  await hStockPublish(pubReq({ quotes_patch: { ACB: full } }, "fancy-wood-2b3c-staging.acct.workers.dev"), env, null, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  check("staging workers.dev: market-staging", ablyCalls.length === 1 && ablyCalls[0].url === MSG_URL("market-staging"), ablyCalls.map(c => c.url));
  restoreFetch();
}

// (3) PRODUCTION publish → van len `market` (khong doi).
{
  const env = mockEnv({ marketRoom: liveDo([]), ablyKey: "key:secret" });
  stubPublishFetch();
  const pending = [];
  await hStockPublish(pubReq({ quotes_patch: { ACB: full } }, "lethanhdong.one"), env, null, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  check("production: fan-out van len market", ablyCalls.length === 1 && ablyCalls[0].url === MSG_URL("market"), ablyCalls.map(c => c.url));
  restoreFetch();
}

// (3b) PRODUCTION qua workers.dev (ten worker khong co -staging) → market.
{
  const env = mockEnv({ marketRoom: liveDo([]), ablyKey: "key:secret" });
  stubPublishFetch();
  const pending = [];
  await hStockPublish(pubReq({ quotes_patch: { ACB: full } }, "fancy-wood-2b3c.acct.workers.dev"), env, null, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  check("production workers.dev: market", ablyCalls.length === 1 && ablyCalls[0].url === MSG_URL("market"), ablyCalls.map(c => c.url));
  restoreFetch();
}

// (1) Request khong co url (dinh dang cu — test cu/tuong thich) → mac dinh market.
{
  const env = mockEnv({ marketRoom: liveDo([]), ablyKey: "key:secret" });
  stubPublishFetch();
  const pending = [];
  const req = { headers: { get: (k) => (k === "X-Publish-Secret" ? "s3cr3t" : null) }, json: async () => ({ quotes_patch: { ACB: full } }) };
  await hStockPublish(req, env, null, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  check("khong co request.url: market", ablyCalls.length === 1 && ablyCalls[0].url === MSG_URL("market"), ablyCalls.map(c => c.url));
  restoreFetch();
}

// (d) Burst 45 frame qua duong fan-out → du 45 frame, seq lien tuc, kenh dung.
{
  const doCalls = [];
  const env = mockEnv({ marketRoom: liveDo(doCalls), ablyKey: "key:secret" });
  stubPublishFetch();
  const pending = [];
  const qp = {};
  for(let i = 0; i < 45; i++) qp["S" + i] = full;
  await hStockPublish(pubReq({ quotes_patch: qp }, "staging.lethanhdong.one"), env, null, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  const totalDo = doCalls.reduce((a, c) => a + c.length, 0);
  const msgs = ablyCalls.length ? ablyCalls[0].body.map(m => JSON.parse(m.data)) : [];
  check("burst 45: DO nhan du 45 frame", totalDo === 45, totalDo);
  check("burst 45: kenh market-staging", ablyCalls.length === 1 && ablyCalls[0].url === MSG_URL("market-staging"), ablyCalls.map(c => c.url));
  const seqs = msgs.map(m => m.seq).sort((a, b) => a - b);
  check("burst 45: 45 seq lien tuc 1..45, khong fallback", msgs.length === 45 && seqs[0] === 1 && seqs[44] === 45 && msgs.every(m => m.seqFallback !== true), { n: msgs.length, first: seqs[0], last: seqs[44] });
  restoreFetch();
}

// =================== WORKER: hAblyToken — capability chi kenh duoc hoi ===================

function tokReq(channel, host){
  const u = "https://" + (host || "lethanhdong.one") + "/api/ably-token" + (channel ? "?channel=" + encodeURIComponent(channel) : "");
  return { url: u };
}

// production (mac dinh) → capability {market:[subscribe]} (han che, khong kem market thua).
{
  stubTokenFetch();
  const res = await hAblyToken(tokReq(null), { ABLY_ROOT_KEY: "keyid:secret" });
  const cap = JSON.parse(tokenCalls[0].body.capability);
  check("token mac dinh: kenh market", Object.keys(cap).length === 1 && Array.isArray(cap.market) && cap.market[0] === "subscribe", cap);
  check("token market: khong mo quyen ghi", cap.market.length === 1, cap);
  restoreFetch();
}

// staging client hoi market-staging → duoc phep, capability chi market-staging.
{
  stubTokenFetch();
  const res = await hAblyToken(tokReq("market-staging", "staging.lethanhdong.one"), { ABLY_ROOT_KEY: "keyid:secret" });
  check("token market-staging: ok", res.status === 200, res.status);
  const cap = JSON.parse(tokenCalls[0].body.capability);
  check("token market-staging: chi kenh do, khong kem market", Object.keys(cap).length === 1 && cap["market-staging"][0] === "subscribe", cap);
  restoreFetch();
}

// kenh thu staging-h1 → chi kenh do (truoc day kem 'market' -> loi nhieu cheo).
{
  stubTokenFetch();
  const res = await hAblyToken(tokReq("staging-h1-20261102", "staging.lethanhdong.one"), { ABLY_ROOT_KEY: "keyid:secret" });
  const cap = JSON.parse(tokenCalls[0].body.capability);
  check("token kenh thu: khong con kem market subscribe", Object.keys(cap).length === 1 && cap["staging-h1-20261102"][0] === "subscribe", cap);
  restoreFetch();
}

// kenh la → 400.
{
  stubTokenFetch();
  const res = await hAblyToken(tokReq("market-production-private"), { ABLY_ROOT_KEY: "keyid:secret" });
  check("token kenh la: 400", res.status === 400, res.status);
  check("token kenh la: khong goi Ably", tokenCalls.length === 0);
  restoreFetch();
}

// =================== CLIENT: channelFor tach theo hostname ===================

const uiSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "js", "features", "unified-ingest.js"), "utf8");
function loadUI(locationObj){
  const moduleObj = { exports: {} };
  const sandbox = {
    module: moduleObj, exports: moduleObj.exports, console,
    setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams,
  };
  if(locationObj) sandbox.location = locationObj;
  vm.createContext(sandbox);
  vm.runInContext(uiSrc, sandbox);
  return moduleObj.exports;
}
{
  const U = loadUI(); // khong co location (Node) → host tu location = "" → market
  check("client pushchan van uu tien tren het", U.channelFor("?pushchan=staging-h1-20261102", "staging.lethanhdong.one") === "staging-h1-20261102");
  check("client khong host → market", U.channelFor("") === "market");
  check("client host prod → market", U.channelFor("", "lethanhdong.one") === "market");
  check("client host staging. → market-staging", U.channelFor("", "staging.lethanhdong.one") === "market-staging");
  check("client host -staging workers.dev → market-staging", U.channelFor("", "fancy-wood-2b3c-staging.acct.workers.dev") === "market-staging");
  check("client host prod workers.dev → market", U.channelFor("", "fancy-wood-2b3c.acct.workers.dev") === "market");
}
{
  // location that (khong truyen host thu cong) → chanName/channelFor dung location.hostname.
  const U = loadUI({ hostname: "staging.lethanhdong.one", search: "" });
  check("client location staging → market-staging", U.channelFor("") === "market-staging");
  const U2 = loadUI({ hostname: "lethanhdong.one", search: "?pushchan=khong-hop-le" });
  check("client location prod, pushchan la → market", U2.channelFor("?pushchan=khong-hop-le") === "market");
}

console.log("\n" + passed + " passed, " + failed + " failed");
if(failed) process.exit(1);
