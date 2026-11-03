// poll-stale (hàng đợi #17d) — đường poll /screener không được đè giá EOD stale
// lên giá live trong SS_PX. Chạy: node tests/poll-stale-screener.test.mjs
// Nap market.js that (qua vm, khong DOM) de goi ham mergeScreenerPx THOC.
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "js", "stocks", "market.js"), "utf8");

// Boot market.js trong vm: co window + module, KHONG co document -> loadMarket()
// khong chay (duoc bao bang `if(typeof document!=="undefined")`), khong cham DOM.
const moduleObj = { exports: {} };
const sandbox = {
  module: moduleObj, exports: moduleObj.exports, console: console,
  window: {}, setTimeout: () => {}, clearTimeout: () => {},
  setInterval: () => {}, clearInterval: () => {},
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const mergeScreenerPx = moduleObj.exports && moduleObj.exports.mergeScreenerPx;

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

check("market.js xuat mergeScreenerPx", typeof mergeScreenerPx === "function", Object.keys(moduleObj.exports || {}));

// Hanh vi CU (truoc sua) = dung dong da xoa o market.js:61, ghi khong dieu kien.
// ( doi chieu "git show HEAD:js/stocks/market.js" )
function oldMerge(rows, sspx){
  (rows||[]).forEach(r=>{ try{ sspx[r.symbol]={c:r.close,p:r.pct_change}; }catch(e){} });
  return sspx;
}

// Row screener cho VCB: snapshot EOD 30/10 (khac ngay phien) -> applyStaleGate gan
// stale:true + pct=null nhung VAN giu close=56.3 (gia cu). Gia live Do/Ably ~55.0.
const STALE_VCB = { symbol:"VCB", close:56.3, pct_change:null, stale:true, updated_at:"2026-10-30" };
const FRESH_ABC = { symbol:"ABC", close:24.5, pct_change:1.2, updated_at:"2026-11-02" };

// (b) REPRO truoc sua: poll tra 56.3 stale -> gia live bi de.
{
  const sspx = { VCB: { c: 55.0, p: 0.4 } };          // gia live tu frame
  oldMerge([STALE_VCB], sspx);
  check("(b) TRUOC sua: gia live bi stale de (VCB.c 55.0 -> 56.3)", sspx.VCB.c === 56.3, sspx.VCB);
}

// (c) SAU sua: gia live KHONG bi de boi stale trong phien.
{
  const sspx = { VCB: { c: 55.0, p: 0.4 } };
  mergeScreenerPx([STALE_VCB], sspx);
  check("(c) SAU sua: stale bo qua, live giu nguyen (VCB.c van 55.0)", sspx.VCB.c === 55.0 && sspx.VCB.p === 0.4, sspx.VCB);
}

// (c) Poll van cap nhat khi live im: row dung phien (khong stale) -> ghi.
{
  const sspx = {};                                    // live im, SS_PX trong
  mergeScreenerPx([FRESH_ABC], sspx);
  check("(c) live im + du lieu tuoi: poll nap duoc (ABC.c=24.5)", sspx.ABC && sspx.ABC.c === 24.5 && sspx.ABC.p === 1.2, sspx);
}

// (c) Row co stale:false tuong minh (duoc coi la tuoi) -> ghi.
{
  const sspx = {};
  mergeScreenerPx([{ symbol:"PQR", close:30.1, pct_change:0.0, stale:false }], sspx);
  check("(c) stale:false -> duoc coi la tuoi, ghi SS_PX", sspx.PQR && sspx.PQR.c === 30.1, sspx);
}

// (c) close khong phai so (null/undefined) -> bo qua, khong tao entry rac.
{
  const sspx = {};
  mergeScreenerPx([{ symbol:"XYZ", close:null, pct_change:0 }, { symbol:"UVW", pct_change:1 }], sspx);
  check("(c) close khong phai so -> bo qua (khong co XYZ/UVW)", !("XYZ" in sspx) && !("UVW" in sspx), sspx);
}

// (c) cac truong hop bien: rows khong mang / sspx thieu.
{
  check("(c) rows=undefined -> khong nang", (()=>{ const s={V:{c:50}}; mergeScreenerPx(undefined, s); return s.V.c===50; })());
  check("(c) rows khong phai array -> khong nang", (()=>{ const s={V:{c:50}}; mergeScreenerPx({}, s); return s.V.c===50; })());
  check("(c) sspx thieu (undefined) -> tra ve, khong nang", (()=>{ try{ mergeScreenerPx([FRESH_ABC], undefined); return true; }catch(e){ return false; } })());
  check("(c) row rac (null / thieu symbol) -> bo qua", (()=>{ const s={}; mergeScreenerPx([null, {close:5}, {symbol:123,close:5}], s); return Object.keys(s).length===0; })());
}

// (d) khong regression burst: 45 gia live (frame 1..45) vao SS_PX, xen ke poll
// stale; SAU sua 45/45 gia live con nguyen (khong bi 56.3 che).
{
  const livePrices = [];
  for(let i=0;i<45;i++) livePrices.push(90100 + i*100); // nhu burst 90100->94500 buoc +100
  const sspx = {};
  for(let i=0;i<45;i++){
    sspx.VCB = { c: livePrices[i], p: 0.5 };           // frame live apply (applyQMarket ghi cur.c=f.p)
    mergeScreenerPx([STALE_VCB], sspx);               // poll chen vao giua chung
  }
  const survived = livePrices[44] === sspx.VCB.c;       // frame cuoi (94500) con?
  // Dem so gia live bi 56.3 (stale) che trong qua trinh — sau sua phai = 0.
  check("(d) burst 45 frame: gia live cuoi khong bi stale che (SS_PX.VCB=94500)", survived && sspx.VCB.c === 94500, sspx.VCB);
  check("(d) burst: 45/45 gia live khong bi 56.3 de (khong con gia che)", sspx.VCB.c !== 56.3, sspx.VCB);
}

// (d) doi chieu: voi hanh vi CU, poll sau frame 20 & 31 dung ra 2 gia burst bi che.
{
  const livePrices = [];
  for(let i=0;i<45;i++) livePrices.push(90100 + i*100);
  const sspx = {};
  let hiddenByStale = 0;
  for(let i=0;i<45;i++){
    sspx.VCB = { c: livePrices[i], p: 0.5 };
    oldMerge([STALE_VCB], sspx);                       // poll de du bat ke
    if(sspx.VCB.c === 56.3) hiddenByStale++;           // gia live bi che ngay sau frame
  }
  check("(d) CU: poll de gia live (hidden>0) — bug tai hien", hiddenByStale === 45, { hiddenByStale });
}

console.log("poll-stale-screener: " + passed + " pass, " + failed + " fail");
process.exit(failed ? 1 : 0);
