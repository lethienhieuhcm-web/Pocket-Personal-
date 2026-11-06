// tests/finhay-cross.test.mjs — TASK 06/11: noi UI Finhay sang 2 route moi
//   GET /api/stock/finhay-ohlcv?symbol=X&count=   (nen 1D, shape = /api/stock/ohlcv 1D)
//   GET /api/stock/finhay-compare?symbol=X&days=  (primary vs finhay)
// Chuoi that: response prod (fixtures duoc copy tu lethanhdongong lane public,
// 06/11) -> js/stocks/finhay.js render -> DOM stub. Khong network, khong worker,
// khong D1, khong deploy.
// Run: node tests/finhay-cross.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = (n) => path.join(here, "fixtures", n);
const SRC = fs.readFileSync(path.join(here, "..", "js", "stocks", "finhay.js"), "utf8");
const HTML = fs.readFileSync(path.join(here, "..", "stocks.html"), "utf8");
const DETAIL = fs.readFileSync(path.join(here, "..", "js", "stocks", "detail.js"), "utf8");

const O_FPT   = JSON.parse(fs.readFileSync(FIX("finhay-ohlcv-FPT.prod.json"), "utf8"));
const O_EMPTY = JSON.parse(fs.readFileSync(FIX("finhay-ohlcv-empty.prod.json"), "utf8"));
const C_FPT   = JSON.parse(fs.readFileSync(FIX("finhay-compare-FPT.prod.json"), "utf8"));
const C_PART  = JSON.parse(fs.readFileSync(FIX("finhay-compare-partial.prod.json"), "utf8"));

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

// ---- DOM stub: du cho innerHTML + style.display + getElementById ------------
class El{
  constructor(){ this.innerHTML = ""; this.style = { display: "" }; this.textContent = ""; }
}
function boot(resolver){
  const ids = ["finhayWrap", "dRec", "dRecSec", "dFinhaySec", "dFinhay", "dFinhayOhlcv", "dFinhayCmp"];
  const els = new Map(ids.map(id => [id, new El()]));
  const calls = [];
  const sandbox = {
    document: { getElementById: (id) => els.get(id) || null, querySelectorAll: () => [] },
    console, Promise, encodeURIComponent, isFinite, Number, String, Math, Date, JSON, RegExp, Array, Object,
    api: async (p) => { calls.push(p); const d = resolver(p); if(d instanceof Error) throw d; return d; },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "js/stocks/finhay.js" });
  return { byId: (id) => els.get(id), calls, win: sandbox.window };
}
const shown = (m, id) => m.byId(id).style.display !== "none";

// ---- 1. module expoort du 3 ham moi -----------------------------------------
{
  const m = boot(() => null);
  check("finhay.js expoort loadFinhayOhlcv/Compare/Cross + __fhTest",
    typeof m.win.loadFinhayOhlcv === "function" && typeof m.win.loadFinhayCompare === "function" &&
    typeof m.win.loadFinhayCross === "function" && !!m.win.__fhTest,
    Object.keys(m.win).filter(k => /^loadFinhay|__fh/.test(k)));
}

// ---- 2. goi DUNG 2 route moi (symbol duoc hoa, count/days gan param) --------
{
  const m = boot(p => (p.startsWith("/finhay-ohlcv") ? O_FPT : C_FPT));
  await m.win.loadFinhayCross("fpt");
  check("loadFinhayCross GET /finhay-ohlcv (symbol=FPT, count=250)",
    m.calls.some(p => p === "/finhay-ohlcv?symbol=FPT&count=250"), m.calls);
  check("loadFinhayCross GET /finhay-compare (symbol=FPT, days=60)",
    m.calls.some(p => p === "/finhay-compare?symbol=FPT&days=60"), m.calls);
  check("KHONG con goi 3 lane cu /finhay/* trong luong nay",
    !m.calls.some(p => p.startsWith("/finhay/")), m.calls);
}

// ---- 3. du lieu that: gia + nhan stale_days --------------------------------
{
  const m = boot(p => (p.startsWith("/finhay-ohlcv") ? O_FPT : C_FPT));
  const ok = await m.win.loadFinhayCross("FPT");
  const o = m.byId("dFinhayOhlcv").innerHTML, c = m.byId("dFinhayCmp").innerHTML;
  check("cross render du 2 phan (resolve true)", ok === true, ok);
  check("ong o nen 1D: gia dong cua phien cuoi = 50.400 đ (NGHIN_VND x1000)",
    /50\.400/.test(o), o.slice(0, 160));
  check("ong o nen 1D: do sau 1.244 phien tu envelope.that",
    /1\.244 phi\xEAn/.test(o) && /05\/11\/2021/.test(o) && /03\/11\/2026/.test(o), o.slice(0, 300));
  check("nhans stale_days: 'đóng băng' + 3 ngày + phiên 03/11/2026 (ca 2 ô)",
    /đóng băng từ phiên 03\/11\/2026 — cũ 3 ngày/.test(o) &&
    /đóng băng từ phiên 03\/11\/2026 — cũ 3 ngày/.test(c), {o: o.slice(-220), c: c.slice(-220)});
  check("nhan stale noi ro 'chưa có writer' + khong phai gia truc tiep",
    /chưa có writer/.test(o) && /không phải giá trực tiếp/.test(o));
  check("sọc nến 1D duoc ve (svg co >2 nến = line+rect)",
    /<svg class="fhspark"/.test(o) && (o.match(/<rect/g) || []).length >= 20,
    (o.match(/<rect/g) || []).length);
  check("ô đối chiếu: 57/57 khớp + ngưỡng bước nhảy + 3 phiên thiếu",
    /57\/57/.test(c) && /100\.0%/.test(c) && /ngưỡng 50 ₫/.test(c) && /3 phiên nến chính có mà Finhay chưa có/.test(c),
    c.slice(0, 260));
  check("card + section hien khi co du lieu", shown(m, "dFinhay") && shown(m, "dFinhaySec"));
}

// ---- 4. fail-open: empty (ZZZ) -> an khoi, khong placeholder chui, khong loi
{
  const m = boot(p => (p.startsWith("/finhay-ohlcv") ? O_EMPTY : C_PART));
  const ok = await m.win.loadFinhayCross("ZZZ");
  check("ZZZ empty+partial -> resolve false, khong ném lỗi", ok === false, ok);
  check("ZZZ -> nội dung 2 ô bị xoá (khong con 'Đang tải…' treo)",
    m.byId("dFinhayOhlcv").innerHTML === "" && m.byId("dFinhayCmp").innerHTML === "");
  check("ZZZ -> card + section AN (display:none)",
    m.byId("dFinhay").style.display === "none" && m.byId("dFinhaySec").style.display === "none");
}

// ---- 5. fail-open: mang loi / 401 -> an, trang van chay ---------------------
{
  const m = boot(() => new Error("500"));
  const ok = await Promise.resolve(m.win.loadFinhayCross("FPT")).catch(() => "THREW");
  check("api ném lỗi -> loadFinhayCross resolve false (khong bao gio throw)", ok === false, ok);
  check("api lỗi -> an khoi", m.byId("dFinhay").style.display === "none");
}
{
  const m = boot(() => new Error("401"));
  const o = await m.win.loadFinhayOhlcv("FPT"), c = await m.win.loadFinhayCompare("FPT");
  check("tung loader doc lap cung fail-open", o === false && c === false, [o, c]);
}
{
  const m = boot(() => O_FPT);
  const r1 = await m.win.loadFinhayCross(""), r2 = await m.win.loadFinhayCross("   ");
  check("symbol rong -> khong goi route, an khoi",
    r1 === false && r2 === false && m.calls.length === 0, [r1, r2, m.calls]);
}
{
  const m = boot(() => null);
  const ok = await m.win.loadFinhayCross(undefined);
  check("loadFinhayCross(undefined) -> false, khong ném", ok === false, ok);
}

// ---- 6. renderer thuong (node test duoc, khong DOM) ------------------------
{
  const t = boot(() => null).win.__fhTest;
  check("renderFinhayOhlcv(null) -> placeholder, khong crash",
    /hint/.test(t.renderFinhayOhlcv(null)) && /Finhay chưa có nến ngày/.test(t.renderFinhayOhlcv(null)));
  check("renderFinhayCompare(null) -> placeholder, khong crash",
    /hint/.test(t.renderFinhayCompare(null)));
  check("stale_days=0 -> khong dan nhan dong bang",
    t.fhStaleLabel(0, "2026-11-06") === "" && t.fhStaleLabel(null, "") === "");
  check("stale_days=3 -> so ngay lo ra mat nguoi dung",
    / cũ 3 ngày/.test(t.fhStaleLabel(3, "2026-11-03")), t.fhStaleLabel(3, "2026-11-03"));
  check("fhCandles: <2 bar hoac gia phang -> khong ve",
    t.fhCandles([{t:"2026-11-03",o:50,c:50,h:50,l:50}]) === "" &&
    t.fhCandles([{t:"a",o:5,c:5,h:5,l:5},{t:"b",o:5,c:5,h:5,l:5}]) === "");
  const XSS = { rows: [{t: "<img src=x onerror=alert(1)>", o: 1, c: 1, h: 2, l: 0.5}],
    total: 1, first: "<svg onload=1>", last: "<script>alert(1)</script>", stale_days: 3 };
  const htmlX = t.renderFinhayOhlcv(XSS);
  check(" XSS: payload tu route bi escape (khong the <img/<script song)",
    !/<img/i.test(htmlX) && !/<script/i.test(htmlX) && /&lt;script&gt;/.test(htmlX), htmlX.slice(0, 240));
  const CMP = { compared: 48, within_tol: 46, days: 60, tick_tolerance: 0.05, max_abs_diff: 1.2,
    missing_in_finhay: 2, finhay: { stale_days: 3, last: "2026-11-03" },
    mismatches: [{ t: "2026-11-02", primary: 50.2, finhay: 51.4, diff: 1.2, diff_pct: 2.39 },
                 { t: "2026-10-30", primary: 52.7, finhay: 52.1, diff: -0.6, diff_pct: -1.139 }] };
  const ch = t.renderFinhayCompare(CMP);
  check("mismatches -> bang lech, 46/48 + canh bao 2 phien",
    /46\/48/.test(ch) && /2 phiên lệch quá ngưỡng/.test(ch) &&
    (ch.match(/<tr>/g) || []).length === 3 && /51\.400/.test(ch) && /−600/.test(ch), ch.slice(0, 400));
  check("max_abs_diff duoc do ra đ (1.2 NGHIN_VND = 1.200 đ)", /1\.200 ₫/.test(ch));
}

// ---- 7. noi chuoi trong stocks.html + detail.js (regression) ---------------
{
  check("stocks.html: co section + card + 2 ô con",
    /id="dFinhaySec"/.test(HTML) && /id="dFinhay"/.test(HTML) &&
    /id="dFinhayOhlcv"/.test(HTML) && /id="dFinhayCmp"/.test(HTML));
  check("stocks.html: khong them khoi Finhay vao GATED (block free)",
    /GATED=\["margin","foreign","prop"\]/.test(HTML) && !/GATED=\[[^\]]*finhay/i.test(HTML));
  check("detail.js: goi window.loadFinhayCross(sym) trong try/catch (khong lam vo loadDetail)",
    /try\{[^}]*loadFinhayCross/.test(DETAIL));
  const NEW = SRC.slice(SRC.indexOf("// ---------- Nến 1D Finhay + đối chiếu giá"));
  check("miễn phí: code mới không gate/402/token (chi doc 2 route public)",
    NEW.length > 2000 && !/402|GATED|isPremium|localStorage|Authorization|entitle/.test(NEW),
    (NEW.match(/402|GATED|isPremium|localStorage|Authorization|entitle/g) || []).slice(0, 5));
  const LOADERS = SRC.slice(SRC.indexOf("// ---------- Nền 1D + đối chiếu giá: 2 route MỚI"));
  const paths = (LOADERS.match(/finApi\("\/[a-z-]+/g) || []).map(s => s.replace('finApi("/', ""));
  check("code moi chi goi 2 route finhay-ohlcv/finhay-compare (khong lane khac)",
    LOADERS.length > 1000 && paths.length === 2 && paths[0] === "finhay-ohlcv" && paths[1] === "finhay-compare", paths);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
