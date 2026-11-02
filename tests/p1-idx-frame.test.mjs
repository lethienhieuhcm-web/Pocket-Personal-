// P1-1 (§8 muc 5) — chung minh fan-out sinh frame `idx` DU SHAPE tu duong
// publish dang song (hStockPublish), va frame do duoc client parse/plan
// dung (`parseFrame` + `deltaPlan` cua unified-ingest.js, tuc la cai ma
// applyIdx doc). Run: node tests/p1-idx-frame.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register("./flow-hooks.mjs", import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const { hStockPublish } = await import("../worker/src/stock.js");
const { buildFanoutFrames } = await import("../worker/src/fanout.js");

// Nap ham thuan cua client bang vm (khong DOM/window) — nhu test cu.
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

const full = { close: 22500, change: 100, pct_change: 0.45, volume: 1234567, value_vnd: 27700000000 };
function mockEnv(store, marketRoom){
  return {
    DATA: {
      get: async (key) => { const v = store.get(key); if(v === undefined) return null; return { json: async () => JSON.parse(JSON.stringify(v)) }; },
      put: async (key, val) => { store.set(key, typeof val === "string" ? JSON.parse(val) : val); },
    },
    STOCK_PUBLISH_SECRET: "s3cr3t", INTERNAL_SECRET: "s3cr3t",
    MARKET_ROOM: marketRoom, ABLY_ROOT_KEY: "key:secret",
  };
}
const pubReq = (body) => ({
  headers: { get: (k) => (k === "X-Publish-Secret" ? "s3cr3t" : null) },
  json: async () => body,
});
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
const origFetch = globalThis.fetch;
let ablyCalls = [];
function stubFetch(){
  ablyCalls = [];
  globalThis.fetch = async (url, opts) => {
    ablyCalls.push({ url: url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201, text: async () => "" };
  };
}

// --- 1. publish co body.indices -> frame idx di qua DO + Ably, du shape. ---
{
  const store = new Map(), doCalls = [];
  stubFetch();
  const res = await hStockPublish(pubReq({
    indices: [{ symbol: "VNINDEX", close: 1766.87, pct_change: 0.31 }],
    sector_indices: [{ symbol: "BANK", close: 41.2, pct_change: -0.5 }],
    quotes_patch: { ACB: full },
  }), mockEnv(store, fakeDo(doCalls)), null, { waitUntil: () => {} });
  check("1 publish indices: ok", res.status === 200, res.status);
  const flat = doCalls.flat();
  const idx = flat.find(f => f.t === "idx");
  check("1 fanout co frame idx", !!idx, flat.map(f => f.t));
  check("1 idx gop ca chi so + nganh", idx && idx.rows.length === 2 && idx.rows[0].s === "VNINDEX" && idx.rows[1].s === "BANK", idx && idx.rows);
  check("1 idx row co p + pc (applyIdx doc hai field nay)", idx && idx.rows.every(r => typeof r.p === "number" && typeof r.pc === "number"), idx && idx.rows);
  // Ben client: frame phai duoc parseFrame chap nhan va deltaPlan tra "idx".
  const ablyFrames = ablyCalls.length ? ablyCalls[0].body.map(m => JSON.parse(m.data)) : [];
  const idxOnAbly = ablyFrames.find(f => f.t === "idx");
  check("1 Ably cung nhan frame idx", !!idxOnAbly, ablyFrames.map(f => f.t));
  const parsed = U.parseFrame(idxOnAbly);
  check("1 client parseFrame chap nhan idx", parsed === idxOnAbly, parsed);
  check("1 client deltaPlan -> 'idx' (vao applyIdx)", U.deltaPlan(parsed, "v-detail", "FPT", false) === "idx" && U.deltaPlan(parsed, "v-market", null, false) === "idx", U.deltaPlan(parsed, "v-market", null, false));
  check("1 frame idx co seq (client doi seq la so)", typeof idxOnAbly.seq === "number" && idxOnAbly.seq > 0, idxOnAbly.seq);
  globalThis.fetch = origFetch;
}

// --- 2. publish KHONG co indices/sector_indices -> khong co frame idx (nhu cu). ---
{
  const store = new Map(), doCalls = [];
  stubFetch();
  await hStockPublish(pubReq({ quotes_patch: { ACB: full } }), mockEnv(store, fakeDo(doCalls)), null, { waitUntil: () => {} });
  const flat = doCalls.flat();
  check("2 khong indices: khong sinh frame idx", flat.length === 1 && flat[0].t === "q", flat.map(f => f.t));
  const ablyFrames = ablyCalls[0].body.map(m => JSON.parse(m.data));
  check("2 khong indices: Ably khong co idx", !ablyFrames.some(f => f.t === "idx"), ablyFrames.map(f => f.t));
  globalThis.fetch = origFetch;
}

// --- 3. indices rong / chi co ten -> van khong co frame idx (loc nhu cu). ---
{
  const built = buildFanoutFrames({ indices: [{ symbol: "VNINDEX" }], sector_indices: "khong phai mang" });
  check("3 idx row khong co so -> bo", built.idx === null, built);
  const built2 = buildFanoutFrames({ indices: [{ symbol: "VNINDEX", close: 1766.87 }] });
  check("3 chi co close van du lam idx row", built2.idx && built2.idx.rows[0].p === 1766.87, built2.idx);
}

console.log("p1-idx-frame: " + passed + " pass, " + failed + " fail");
process.exit(failed ? 1 : 0);
