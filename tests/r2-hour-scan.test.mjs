// Item 4 (2026-11-05): quet R2 theo prefix ngay bi cat o 2000 key -> sau 13h
// ICT /api/stock/money-flow-live tra 200 voi `rows` rong, va money-flow-trades
// mat khop lenh. Test dung mock R2 liet ke theo dung thu tu tu dien + phan
// trang (maxKeys) + delimiter + startAfter nhu binding that.
// Run: node tests/r2-hour-scan.test.mjs
import { register } from "node:module";
import { gzipSync } from "node:zlib";
register("./flow-hooks.mjs", import.meta.url);

const { hStockMoneyFlowLive, hStockMoneyFlowTrades, MF_WINDOW_SEC } =
  await import("../worker/src/stock.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

// ---- dong ho: 14:30 ICT = 07:30 UTC ----
const T0 = Date.UTC(2026, 10, 5, 7, 30, 0);
const realNow = Date.now;
Date.now = () => T0;
const ict = new Date(T0 + 7 * 3600 * 1000);
const DATE = ict.toISOString().slice(0, 10);
const HH_CUR = String(ict.getUTCHours()).padStart(2, "0");   // "14"
const HH_PREV = String((ict.getUTCHours() + 23) % 24).padStart(2, "0"); // "13"
const NOW_SEC = Math.floor(T0 / 1000);
const CUTOFF = NOW_SEC - MF_WINDOW_SEC;                      // 14:15 ICT

// ---- mock R2: thu tu tu dien, phan trang 500 key/lan, delimitedPrefixes ----
// (Workers R2 list() KHONG co startAfter, nen loc ngan cat van la JS filter.)
const PAGE = 500; // de buoc phan trang xay ra (R2 that: 1000)
function mockR2(store, opts){
  opts = opts || {};
  const stats = { list: 0, get: 0, pages: 0 };
  const sorted = () => [...store.keys()].sort();
  return {
    stats,
    DATA: {
      get: async (key) => {
        stats.get++;
        const v = store.get(key);
        if(v === undefined) return null;
        if(v instanceof Uint8Array) return { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) };
        return { json: async () => JSON.parse(JSON.stringify(v)) };
      },
      list: async ({ prefix, delimiter, cursor }) => {
        stats.list++;
        let keys = sorted().filter((k) => k.startsWith(prefix || ""));
        if(cursor) keys = keys.filter((k) => k > cursor);
        if(delimiter === "/"){
          const dirs = new Set(), objs = [];
          for(const k of keys){
            const rest = k.slice((prefix || "").length);
            const slash = rest.indexOf("/");
            if(slash < 0) objs.push({ key: k });
            else dirs.add(prefix + rest.slice(0, slash + 1));
          }
          // delimiter chi ap dung cho muc tiep theo, mock khong phan trang o day
          if(opts.noDelimiterSupport) return { objects: objs, truncated: false };
          // R2 tra delimitedPrefixes khong duong sach o cuoi -> kiem thu norm()
          return { objects: objs, delimitedPrefixes: [...dirs].map((d) => d.replace(/\/$/, "")).sort(),
                   truncated: false, cursor: undefined };
        }
        const page = keys.slice(0, PAGE);
        stats.pages++;
        const more = keys.length > page.length;
        return { objects: page.map((k) => ({ key: k })), truncated: more, cursor: more ? page[page.length - 1] : undefined };
      },
    },
  };
}
const gzLines = (rows) => gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n")));
const RAW = "stock/market/shadow_tick/raw/" + DATE + "/";
const SRC = "ssi-mqtt";

function buildStore(){
  const store = new Map();
  store.set("stock/market/shadow_tick/flow/watchlist/latest.json",
    { for_date: DATE, candidates: [{ symbol: "MSH" }, { symbol: "HDC" }] });
  // Mot buoi sang bon chay: 4 gio x 600 file, moi file 1 dong ngoai cua so.
  for(let hh = 9; hh <= 12; hh++){
    const h = String(hh).padStart(2, "0");
    for(let i = 0; i < 600; i++){
      const sec = Date.UTC(2026, 10, 5, hh - 7, 0, 0) / 1000 + i * 5; // 09:00..09:49 ICT...
      store.set(RAW + SRC + "/" + h + "/" + (sec * 1000) + ".jsonl.gz",
        gzLines([[SRC, "MSH", sec, sec, 35.1, 100000, i, "M"]]));
    }
  }
  // Gio 13 (hhPrev): 600 file, tat ca truoc ngan cat 14:15 -> khong duoc tinh.
  for(let i = 0; i < 600; i++){
    const sec = Date.UTC(2026, 10, 5, 6, 0, 0) / 1000 + i * 5; // 13:00..13:49 ICT
    store.set(RAW + SRC + "/" + HH_PREV + "/" + (sec * 1000) + ".jsonl.gz",
      gzLines([[SRC, "MSH", sec, sec, 35.1, 100000, 9000 + i, "M"]]));
  }
  // Gio 14 (hhCur): 3 file TRONG cua so 15 phut, MSH mua 3.51 ty -> co row.
  const inWin = [
    [SRC, "MSH", NOW_SEC - 120, NOW_SEC - 119, 35.1, 100000, 1, "M"], // 3.51 ty MUA
    [SRC, "MSH", NOW_SEC - 100, NOW_SEC - 99, 35.1, 20000, 2, "B"],   // 0.702 ty BAN
    [SRC, "HDC", NOW_SEC - 60, NOW_SEC - 59, 11.8, 200000, 3, "M"],   // 2.36 ty MUA
  ];
  store.set(RAW + SRC + "/" + HH_CUR + "/" + ((NOW_SEC - 118) * 1000) + ".jsonl.gz", gzLines(inWin));
  // 1 file gio 14 ghi TRUOC ngan cat (14:10) -> buoc loai theo startAfter/filter
  store.set(RAW + SRC + "/" + HH_CUR + "/" + ((CUTOFF - 300) * 1000) + ".jsonl.gz",
    gzLines([[SRC, "MSH", CUTOFF - 310, CUTOFF - 309, 35.1, 100000, 4, "M"]]));
  // Tape cho money-flow-trades
  store.set("stock/market/tape/MSH.json", { symbol: "MSH", date: DATE, source: "dnse",
    side_method: "tick_rule", trades: [{ ts: NOW_SEC - 120, time: "14:28:00", p: 35.1, v: 100000, s: "M" }],
    total_vol: 100000, buy_vol: 100000, sell_vol: 0 });
  return store;
}

// ===== A. duong that (binding ho tro delimiter) =====
{
  const store = buildStore();
  const env = mockR2(store);
  const res = await hStockMoneyFlowLive({ url: "http://w/api/stock/money-flow-live" }, env);
  const body = await res.json();
  check("A1 gio 14h: 200 + available + rows KHONG rong",
    res.status === 200 && body.available === true && body.rows.length > 0,
    { status: res.status, rows: body.rows.length, meta: body.meta });
  const by = {}; (body.rows || []).forEach((r) => { by[r.symbol] = r; });
  check("A2 MSH co row du lieu trong cua so", by.MSH && by.MSH.has_data === true, by.MSH);
  check("A3 net MSH = 3.51 - 0.702 ty", by.MSH && by.MSH.net_val === 3.51e9 - 0.702e9,
    by.MSH && { buy: by.MSH.buy_val, sell: by.MSH.sell_val, net: by.MSH.net_val });
  check("A3b MSH vuot nguong 1 ty -> flagged", by.MSH && by.MSH.flagged === true, by.MSH);
  check("A4 HDC tinh du 2.36 ty", by.HDC && by.HDC.buy_val === 2.36e9, by.HDC);
  check("A5 chi doc file trong cua so (khong scan 2400 file buoi sang)",
    env.stats.get <= 5, { gets: env.stats.get });
  check("A6 so lan list() = nguyen tac + gio, khong theo so file ca ngay",
    env.stats.list <= 8, { lists: env.stats.list });
  check("A7 files_scanned = file trong cua so (1), khong phai 2000",
    body.meta && body.meta.files_scanned === 1 && body.meta.files_read === 1, body.meta);
  check("A8 shape response giu nguyen (rows, meta.hours, window)",
    Array.isArray(body.rows) && Array.isArray(body.meta.hours) &&
    body.meta.hours.join(",") === [HH_PREV, HH_CUR].join(",") && !!body.window,
    { hours: body.meta && body.meta.hours, window: body.window });
  check("A9 file ghi 14:10 (truoc ngan cat) khong duoc doc -> MSH buy 3.51 ty",
    by.MSH && by.MSH.buy_val === 3.51e9, by.MSH && { buy: by.MSH.buy_val });
  check("A10 watchlist duoc dung (khong roi ve B200) + 3 dong trong file",
    body.meta && body.meta.lines === 3 && body.watchlist.source === "flow_watchlist" &&
    body.watchlist.count === 2, { meta: body.meta, wl: body.watchlist });
}

// ===== B. duong lui (binding KHONG tra prefixes) =====
// Phai gioi han nhu cu: 2000 key dau theo thu tu tu dien = 4 gio sang,
// nen gio 13/14 khong xuat hien -> day chinh la trieu chung loc 04/11 chieu.
{
  const store = buildStore();
  const env = mockR2(store, { noDelimiterSupport: true });
  const res = await hStockMoneyFlowLive({ url: "http://w/api/stock/money-flow-live" }, env);
  const body = await res.json();
  check("B1 fallback van 200 + khong loi",
    res.status === 200 && body.available === true, { status: res.status });
  check("B2 fallback cat 2000 key dau ngay -> rows rong (trieu chung cu)",
    body.rows.every((r) => r.has_data === false), body.rows.slice(0, 2));
  check("B3 fallback dung duong quet ngay cu (>= 4 trang list)",
    env.stats.list >= 4, { lists: env.stats.list });
}

// ===== C. money-flow-trades cung bi cat theo ngay =====
{
  const store = buildStore();
  const env = mockR2(store);
  const res = await hStockMoneyFlowTrades({ url: "http://w/api/stock/money-flow-trades?symbol=MSH" }, env);
  const body = await res.json();
  check("C1 14h: trades co khop tick SSI",
    res.status === 200 && body.available === true && body.matched > 0,
    { status: res.status, matched: body.matched, ticks: body.ticks });
  check("C2 tape van duoc tra ve", body.tape && body.tape.present === true, body.tape);
  check("C3 so file doc o lai trong cua so", env.stats.get <= 6, { gets: env.stats.get });
}
{
  const store = buildStore();
  const env = mockR2(store, { noDelimiterSupport: true });
  const res = await hStockMoneyFlowTrades({ url: "http://w/api/stock/money-flow-trades?symbol=MSH" }, env);
  const body = await res.json();
  // prefix cua trades da den <source> -> khong can delimiter van dung gio
  check("C4 trades khong phu delimiter: van khop o 14h",
    res.status === 200 && body.matched > 0, { matched: body.matched });
}

Date.now = realNow;
console.log(`\nr2-hour-scan: PASS=${passed} FAIL=${failed}`);
process.exit(failed ? 1 : 0);
