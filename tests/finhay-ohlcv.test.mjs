// Test cho reader nen 1D Finhay (worker/src/stock_finhay.js):
//   GET /api/stock/finhay-ohlcv   — doc R2 market/finhay/candles/<SYM>.json,
//                                    dich bars[] (unix giay) -> rows[] (ISO "YYYY-MM-DD")
//   GET /api/stock/finhay-compare — doi chieu close vs nen chinh market/ohlcv/
// Mock R2 only; khong mang, khong D1, khong deploy, khong ghi that.
// Fixture = cat nguyen bo envelope that tu R2 (read-only) 06/11: 30 nen cuoi
// cua FPT ca hai kenh, nen nen duoc doi chieu trong test so sanh.
// Run: node tests/finhay-ohlcv.test.mjs
globalThis.caches = { default: { async match(){ return undefined; }, async put(){} } };

import { register } from "node:module";
import fs from "node:fs";
register("./flow-hooks.mjs", import.meta.url);

const { hFinhayOhlcv, hFinhayCompare, finhayBarDay, finhayCandlesToRows, finhayCandles } =
  await import("../worker/src/stock_finhay.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}
function mockEnv(store){
  return { DATA: { get: async (key) => {
    const v = store.get(key);
    if(v === undefined) return null;
    return { json: async () => JSON.parse(JSON.stringify(v)) };
  } } };
}
const getReq = (url) => ({ url, method: "GET", headers: { get: () => null } });
const jsonOf = async (res) => JSON.parse(await res.text());

const FH = JSON.parse(fs.readFileSync(new URL("./fixtures/finhay-candles-FPT.sample.json", import.meta.url), "utf8"));
const PR = JSON.parse(fs.readFileSync(new URL("./fixtures/ohlcv-FPT.sample.json", import.meta.url), "utf8"));
const FH_KEY = "stock/market/finhay/candles/FPT.json";
const PR_KEY = "stock/market/ohlcv/FPT.json";
const withStore = (extra) => {
  const m = new Map([[FH_KEY, FH], [PR_KEY, PR]]);
  if(extra) for(const [k, v] of extra) m.set(k, v);
  return m;
};

// --- 1. finhayBarDay: quy doi mốc unix -> ISO -------------------------------
{
  check("barDay: unix giay nua dem UTC -> dung ngay giao dich",
    finhayBarDay(1636070400) === "2021-11-05", finhayBarDay(1636070400));
  check("barDay: chap nhan ca ms (phong khi nguon doi don vi)",
    finhayBarDay(1636070400000) === "2021-11-05", finhayBarDay(1636070400000));
  check("barDay: rac -> null (khong nem)", finhayBarDay("abc") === null && finhayBarDay(undefined) === null);
}

// --- 2. finhayCandlesToRows: shape -------------------------------------------
{
  const d = finhayCandlesToRows(FH);
  check("rows: so luong khop bars goc", d && d.rows.length === FH.bars.length, d && d.rows.length);
  check("rows: t la ISO YYYY-MM-DD (khong con unix)",
    d.rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.t)), d.rows.slice(0, 2));
  check("rows: du 6 truong o/h/l/c/v theo nen chinh",
    d.rows.every(r => "o" in r && "h" in r && "l" in r && "c" in r && "v" in r), d.rows[0]);
  check("rows: sap tang dan theo ngay",
    d.rows.every((r, i) => i === 0 || d.rows[i - 1].t <= r.t));
  check("rows: first/last = ngay dau/cuoi cua tap nen (khong phai metadata cu)",
    d.first === d.rows[0].t && d.last === d.rows[d.rows.length - 1].t, { first: d.first, last: d.last });
  check("rows: gan source=finhay + don vi NGHIN_VND (giong kenh chinh)",
    d.source === "finhay" && /NGHIN_VND/.test(d.unit), d.unit);
  check("rows: stale_days tinh tu `updated` that (du lieu dong 03/11)",
    typeof d.stale_days === "number" && d.stale_days >= 3, d.stale_days);
  // doc bien dang -> null, khong nem
  check("rows: null khi doc khong phai object", finhayCandlesToRows(null) === null);
  check("rows: null khi bars khong phai mang", finhayCandlesToRows({ bars: {} }) === null);
  check("rows: null khi bars rong", finhayCandlesToRows({ bars: [] }) === null);
  check("rows: bo qua nen rac, van doc duoc nen tot",
    finhayCandlesToRows({ bars: [null, { nope: 1 }, FH.bars[0]] }).rows.length === 1);
}

// --- 3. GET /api/stock/finhay-ohlcv ------------------------------------------
{
  const res = await hFinhayOhlcv(getReq("https://x/api/stock/finhay-ohlcv?symbol=FPT"), mockEnv(withStore()));
  const body = await jsonOf(res);
  check("ohlcv: 200 + dung shape kenh ohlcv (symbol/interval/rows/updated)",
    res.status === 200 && body.symbol === "FPT" && body.interval === "1D" && Array.isArray(body.rows), body);
  check("ohlcv: rows doc duoc tu R2 that (30 nen cuoi cua fixture)",
    body.count === FH.bars.length && body.total === FH.bars.length, { count: body.count, total: body.total });
  check("ohlcv: nen cuoi = 2026-11-03 (ding ky dong cua lane 5y)",
    body.rows[body.rows.length - 1].t === "2026-11-03", body.rows[body.rows.length - 1]);
  check("ohlcv: bao loi stale de M/B dan nian nhan, khong an",
    typeof body.stale_days === "number" && body.stale_days >= 3, body.stale_days);

  const lim = await jsonOf(await hFinhayOhlcv(getReq("https://x/api/stock/finhay-ohlcv?symbol=fpt&count=5"), mockEnv(withStore())));
  check("ohlcv: count cat phan cuoi + khong phan biet hoa",
    lim.count === 5 && lim.rows.length === 5 && lim.rows[0].t === body.rows[body.rows.length - 5].t, lim.count);

  const miss = await hFinhayOhlcv(getReq("https://x/api/stock/finhay-ohlcv?symbol=XYZ"), mockEnv(withStore()));
  const missBody = await jsonOf(miss);
  check("ohlcv: thieu file -> 200 empty shape, khong 404/500",
    miss.status === 200 && missBody.empty === true && missBody.rows.length === 0, missBody);

  const emptyStore = mockEnv(new Map([[FH_KEY, { symbol: "AAA", schema: FH.schema, bars: [] }]]));
  const emptyBody = await jsonOf(await hFinhayOhlcv(getReq("https://x/api/stock/finhay-ohlcv?symbol=AAA"), emptyStore));
  check("ohlcv: file ton tai nhung 0 nen -> empty shape, khong crash",
    emptyBody.empty === true && emptyBody.count === 0, emptyBody);

  const broken = mockEnv(new Map([[FH_KEY, { symbol: "BBB", bars: [{ t: "khong phai so" }] }]]));
  const brokenBody = await jsonOf(await hFinhayOhlcv(getReq("https://x/api/stock/finhay-ohlcv?symbol=BBB"), broken));
  check("ohlcv: nen hong du lieu -> empty shape (fail-open)", brokenBody.empty === true, brokenBody);

  const noSym = await hFinhayOhlcv(getReq("https://x/api/stock/finhay-ohlcv"), mockEnv(withStore()));
  check("ohlcv: thieu symbol -> 400", noSym.status === 400);

  const trav = await hFinhayOhlcv(getReq("https://x/api/stock/finhay-ohlcv?symbol=../../etc"), mockEnv(withStore()));
  check("ohlcv: key co traversal -> khong doc ngoai prefix (empty, khong crash)",
    trav.status === 200 && (await jsonOf(trav)).empty === true);
}

// --- 4. GET /api/stock/finhay-compare (du lieu that cua ca 2 kenh) -----------
{
  const res = await hFinhayCompare(getReq("https://x/api/stock/finhay-compare?symbol=FPT&days=30"), mockEnv(withStore()));
  const body = await jsonOf(res);
  check("compare: 200 + doi chieu duoc 2 nguon",
    res.status === 200 && body.compared > 0, body);
  check("compare: close Finhay khop nen chinh trong dung buoc nhay gia VN",
    body.within_tol === body.compared && body.mismatches.length === 0,
    { compared: body.compared, within_tol: body.within_tol, max: body.max_abs_diff });
  check("compare: lech lon nhat < 1 buoc nhay 0.1 (2 le vs 3 le, khong phai sai so)",
    Math.abs(body.max_abs_diff) < 0.05, body.max_abs_diff);
  check("compare: phan dinh danh sach 2 kenh (coverage), khong an",
    body.finhay && body.finhay.last === "2026-11-03" && body.primary && body.primary.last === PR.rows[PR.rows.length - 1].t,
    { fh: body.finhay && body.finhay.last, pr: body.primary && body.primary.last });

  // tiem 1 lech lon -> phai bat duoc (tren ngay MA CA 2 KENH deu co nen)
  const tampered = JSON.parse(JSON.stringify(PR));
  const shared = tampered.rows.filter(r => FH.bars.some(b => finhayBarDay(b.t) === r.t));
  const target = shared[shared.length - 1];
  const before = target.c;
  target.c = before * 1.5;
  const tRes = await jsonOf(await hFinhayCompare(
    getReq("https://x/api/stock/finhay-compare?symbol=FPT&days=30"),
    mockEnv(withStore([[PR_KEY, tampered]]))));
  check("compare: lech 50% bi ghi vao mismatches + max_abs_diff",
    tRes.mismatches.length === 1 && tRes.mismatches[0].t === target.t &&
    tRes.within_tol === tRes.compared - 1 && Math.abs(tRes.max_abs_diff) > before * 0.4,
    { m: tRes.mismatches, max: tRes.max_abs_diff, day: target.t, before });
  check("compare: cong bo dung buoc nhay trong payload (tick_tolerance)",
    tRes.tick_tolerance === 0.05, tRes.tick_tolerance);
  check("compare: dem duong trong khi Finhay dong benh (nen chinh moi hon 03/11)",
    tRes.missing_in_finhay > 0 && tRes.compared + tRes.missing_in_finhay <= tRes.primary.count,
    { missing: tRes.missing_in_finhay, compared: tRes.compared });

  const noFh = await jsonOf(await hFinhayCompare(
    getReq("https://x/api/stock/finhay-compare?symbol=VCB&days=30"), mockEnv(new Map([[PR_KEY, PR]]))));
  check("compare: khong co nen Finhay -> partial no_finhay_candles, 200 khong crash",
    noFh.partial === "no_finhay_candles" && noFh.compared === 0, noFh);

  const noPr = await jsonOf(await hFinhayCompare(
    getReq("https://x/api/stock/finhay-compare?symbol=FPT"), mockEnv(new Map([[FH_KEY, FH]]))));
  check("compare: khong co nen chinh -> partial no_primary_ohlcv", noPr.partial === "no_primary_ohlcv", noPr);

  const none = await jsonOf(await hFinhayCompare(
    getReq("https://x/api/stock/finhay-compare?symbol=ZZZ"), mockEnv(new Map())));
  check("compare: ca 2 kenh deu khong -> 200, compared=0", none.compared === 0 && !!none.partial, none);
}

// --- 5. finhayCandles(): ham thap cap dung boi reader khac -------------------
{
  const d = await finhayCandles(mockEnv(withStore()), "fpt");
  check("finhayCandles: thuong hoa ma + tra rows", d && d.rows.length === FH.bars.length);
  check("finhayCandles: ma khong ton tai -> null", (await finhayCandles(mockEnv(withStore()), "NOPE")) === null);
  check("finhayCandles: symbol co traversal -> null (khong vet R2 ngoai prefix)",
    (await finhayCandles(mockEnv(withStore()), "A/../../B")) === null);
}

console.log(`\nfinhay-ohlcv: ${passed} PASS, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
