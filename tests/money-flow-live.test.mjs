// Tests for M/B live money-flow (Chot Henrry 08:11 04/11): aggregation of
// buy/sell/net from R2 raw tick chunks (JSONL row = [src, sym, ts_event,
// ts_recv, price, vol, acc, side]) and the net > 1 tỷ / 15 min flag.
// Mock ticks + mock R2 only; no network, no D1, no deploy.
// Run: node tests/money-flow-live.test.mjs
import { register } from "node:module";
import { gzipSync } from "node:zlib";
register("./flow-hooks.mjs", import.meta.url);

const { mfSideClass, mfAggregateRows, hStockMoneyFlowLive,
  MF_WINDOW_SEC, MF_THRESHOLD_VND } = await import("../worker/src/stock.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

// --- 1. side classification (VIE convention: M = mua, B = ban) -----------
check("side M -> buy", mfSideClass("M") === "buy");
check("side B -> sell", mfSideClass("B") === "sell");
check("side mua -> buy", mfSideClass("mua") === "buy");
check("side sell -> sell", mfSideClass("SELL") === "sell");
check("side null -> none", mfSideClass(null) === "none");
check("side empty -> none", mfSideClass(" ") === "none");
check("side junk -> unk", mfSideClass("XX") === "unk");

// --- 2. pure aggregation: buy/sell/net + units (gia nghin dong x1000) ----
{
  const now = 1762220000;             // epoch s (ICT ~09:30 04/11/2026)
  const cut = now - MF_WINDOW_SEC;
  const rows = [
    ["ssi-mqtt", "MSH", now - 60,  now - 59, 35.1, 1000, 101, "M"],   // buy  35.1M VND
    ["ssi-mqtt", "MSH", now - 40,  now - 39, 35.2, 2000, 102, "B"],   // sell 70.4M
    ["ssi-mqtt", "HDC", now - 30,  now - 29, 11.8, 5000, 201, "M"],
    ["ssi-mqtt", "XXX", now - 30,  now - 29, 20.0, 1000, 301, "M"],   // ngoai danh sach
    ["ssi-mqtt", "HDC", cut - 10,  cut -  9, 11.8, 5000, 202, "M"],   // ngoai cua so
    ["dnse",     "HDC", now - 20,  now - 19, 11.8, 5000, 203, null],  // khong side
    ["dnse",     "HDC", now - 20,  now - 19, 11.8, 5000, 203, null],  // dup theo acc
    ["vndirect", "HDC", now - 20,  now - 19, "PUT", {vol: 1}],        // dong PUT 6 cot
    ["ssi-mqtt", "HDC", now - 10,  now -  9, 11.8, 1000, 204, "ZZ"],  // side la
  ];
  const { rows: out, stats } = mfAggregateRows(rows, ["MSH", "HDC"], cut, now);
  const by = Object.fromEntries(out.map(r => [r.symbol, r]));
  check("MSH buy_vol = 1000", by.MSH.buy_vol === 1000, by.MSH);
  check("MSH buy_val = 35.1e6 VND", by.MSH.buy_val === Math.round(35.1 * 1000 * 1000), by.MSH);
  check("MSH sell_val = 70.4e6 VND", by.MSH.sell_val === Math.round(35.2 * 1000 * 2000), by.MSH);
  check("MSH net = buy - sell", by.MSH.net_val === Math.round(35.1e6 - 35.2 * 2e6), by.MSH);
  check("HDC dedup acc: buy_vol = 5000 (1 ban ghi, 1 dup, 1 khong side)",
    by.HDC.buy_vol === 5000 && stats.dedup_dropped === 1 && stats.no_side === 1, { out: by.HDC, stats });
  check("HDC out-of-window + PUT + unk side loai het",
    by.HDC.sell_vol === 0 && stats.side_unknown["ZZ"] === 1 && stats.other_symbol === 1 &&
    stats.out_of_window === 1, stats);
  check("watchlist symbol khong co tick van co row (has_data false)",
    out.length === 2 && by.MSH.has_data === true);
}

// --- 3. flag net > 1 ty / 15 phut ----------------------------------------
{
  const now = 1762220000, cut = now - MF_WINDOW_SEC;
  // MSH: 30 ty mua - 1 ban nho -> net > 1 ty -> co.
  // HDC: net 0.9 ty -> khong co.  ACB: net -2 ty -> khong co (nguong la duong).
  const rows = [
    ["ssi-mqtt", "MSH", now - 60, now - 59, 50.0, 600000, 1, "M"],  // 30 ty
    ["ssi-mqtt", "MSH", now - 50, now - 49, 50.0, 100,     2, "B"],  // 0.005 ty
    ["ssi-mqtt", "HDC", now - 60, now - 59, 10.0, 90000,   3, "M"],  // 0.9 ty
    ["ssi-mqtt", "ACB", now - 60, now - 59, 25.0, 80000,   4, "B"],  // -2 ty
    ["ssi-mqtt", "TRI", now - 60, now - 59, 10.0, 100000,  5, "M"],  // dung 1 ty
  ];
  const { rows: out } = mfAggregateRows(rows, ["MSH", "HDC", "ACB", "TRI"], cut, now);
  const by = Object.fromEntries(out.map(r => [r.symbol, r]));
  check("flag: MSH net 29.995 ty -> co", by.MSH.flagged === true, by.MSH);
  check("flag: HDC net 0.9 ty -> khong", by.HDC.flagged === false);
  check("flag: ACB net -2 ty -> khong (nguong duong theo chat)", by.ACB.flagged === false);
  check("flag: net dung bang 1 ty -> khong (>, khong >=)", by.TRI.flagged === false, by.TRI);
  check("threshold = 1e9 VND", MF_THRESHOLD_VND === 1e9);
  check("rows sort theo net giam dan", out[0].symbol === "MSH" && out[1].symbol === "TRI" &&
    out[2].symbol === "HDC" && out[3].symbol === "ACB", out.map(r => r.symbol));
}

// --- 4. handler end-to-end mock R2 (gzip chunks + watchlist latest) ------
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

{
  const t = ictNow();
  const rawP = "stock/market/shadow_tick/raw/" + t.date + "/ssi-mqtt/";
  const mk = (hh, writeSec, rows) => [rawP + hh + "/" + (writeSec * 1000) + ".jsonl.gz", gzLines(rows)];
  const store = new Map();
  store.set("stock/market/shadow_tick/flow/watchlist/latest.json",
    { for_date: t.date, screen_date: "2026-11-03", candidates: [{ symbol: "msh" }, { symbol: "HDC" }] });
  store.set(...mk(t.hh, t.sec - 30, [
    ["ssi-mqtt", "MSH", t.sec - 60, t.sec - 59, 35.1, 100000, 1, "M"],   // 3.51 ty mua
    ["ssi-mqtt", "MSH", t.sec - 50, t.sec - 49, 35.1, 100000, 2, "B"],   // 3.51 ty ban
    ["ssi-mqtt", "HDC", t.sec - 40, t.sec - 39, 11.8, 200000, 3, "M"],   // 2.36 ty mua
  ]));
  store.set(...mk(t.hh, t.sec - 25, [
    ["ssi-mqtt", "HDC", t.sec - 20, t.sec - 19, 11.8, 90000, 4, "M"],    // +1.062 ty -> net 3.422 ty -> co
  ]));
  // File ghi tru cutoff -> bo qua (khong the chua dong trong cua so).
  store.set(...mk(t.prevHh, t.sec - MF_WINDOW_SEC - 120, [
    ["ssi-mqtt", "MSH", t.sec - MF_WINDOW_SEC - 60, t.sec - MF_WINDOW_SEC - 59, 30, 1, 0, "M"],
  ]));
  const env = mockR2(store);
  const res = await hStockMoneyFlowLive({ url: "http://w/api/stock/money-flow-live" }, env);
  const body = await res.json();
  check("handler: 200 + available", res.status === 200 && body.available === true);
  check("handler: watchlist tu flow_watchlist, uppercase + dedup",
    body.watchlist.source === "flow_watchlist" && body.watchlist.count === 2, body.watchlist);
  const msh = body.rows.find(r => r.symbol === "MSH");
  const hdc = body.rows.find(r => r.symbol === "HDC");
  check("handler: MSH net ~0, khong co", msh && Math.abs(msh.net_val) < 1e9 && msh.flagged === false, msh);
  check("handler: HDC net 3.422 ty -> co flag", hdc && hdc.flagged === true &&
    Math.abs(hdc.net_val - 3422000000) < 1e6, hdc);
  check("handler: file cu tru cutoff khong duoc doc",
    body.meta.files_read === 2 && body.meta.files_scanned === 2, body.meta);
  check("handler: window 15 phut, ISO +07:00",
    body.window.minutes === 15 && /\+07:00$/.test(body.window.from) && /\+07:00$/.test(body.window.to), body.window);
  check("handler: window.from/to parse ve dung epoch ICT (isoOf +7h, hoi quy bug cham 7h)",
    Math.abs(new Date(body.window.from).getTime() / 1000 - (t.sec - MF_WINDOW_SEC)) < 3 &&
    Math.abs(new Date(body.window.to).getTime() / 1000 - t.sec) < 3, body.window);
  check("handler: chi tra row cua watchlist (khong co ma la)",
    body.rows.length === 2, body.rows.map(r => r.symbol));
}

// --- 5. fallback B200 42 ma khi watchlist khong san ----------------------
{
  const t = ictNow();
  const store = new Map();
  // Watchlist latest sai for_date (qua han) -> khong dung.
  store.set("stock/market/shadow_tick/flow/watchlist/latest.json",
    { for_date: "2020-01-01", candidates: [{ symbol: "ZZZ" }] });
  const env = mockR2(store);
  const res = await hStockMoneyFlowLive({ url: "http://w/api/stock/money-flow-live" }, env);
  const body = await res.json();
  check("fallback: b200_fallback, 42 ma",
    body.watchlist.source === "b200_fallback" && body.watchlist.count === 42 &&
    body.rows.length === 42, { w: body.watchlist, n: body.rows.length });
  check("fallback: rows khong co du lieu van available false-flag",
    body.rows.every(r => r.has_data === false && r.flagged === false && r.net_val === 0));
}

console.log("\nmoney-flow-live: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
