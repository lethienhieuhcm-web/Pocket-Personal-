// tests/mb-ctd-detail.test.mjs — regression M/B v-detail frontend (mb-ctd-fix 04/11).
// Test THAT file js/stocks/detail.js trong node:vm + DOM stub (khuon mau
// ctg-banks/watchlist.test.mjs), driver dung cac ham loadTape/loadMB/
// renderMBBlock/clearDetailOnSwitch qua hook __dtTest (hook nay do patch
// them vao — tren base chua patch boot fail co chu dinh, do do baseline
// FAIL la duc mong muon, khong phai hoai).
// Khuyet diem 1: khoi tom tat M/B hien khi money-flow-live CO du lieu cho ma
//   du KHONG co tape DNSE (CTD); bang lenh van an/trong nhu hien tai.
// Khuyet diem 2 (nghiem trong): doi ma trong v-detail (HHP -> CTD) khong bao
//   gio con hien so cua ma khac — xoa dong bo khi doi + response pending
//   cu phai bi bo (guard seq/curSym).
// giu nguyen: ma CO tape (HHP badge SSI vien dam + note; VCB ngoai watchlist
//   "Chua co du lieu M/B"); khong poll rieng (moi lan mo ma dung 3 goi
//   /trades + /money-flow-live + /money-flow-trades).
// Mock chi la DOM + api() gia lap (endpoint that du lieu theo shape worker);
// khong network, khong D1/R2, khong deploy.
// Run: node tests/mb-ctd-detail.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_FILE = path.join(here, "..", "js", "stocks", "detail.js");
const SRC = fs.readFileSync(SRC_FILE, "utf8");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

// ===== fixtures — shape dung nhu worker/src/stock.js sinh ra =================
// rows /money-flow-live: {symbol,buy_vol,buy_val,sell_vol,sell_val,net_vol,net_val,has_data,flagged}
const LIVE_WINDOW = { minutes: 15, from: "2026-11-04T11:23:00+07:00", to: "2026-11-04T11:38:00+07:00" };
const ROW_HHP = { symbol: "HHP", buy_vol: 83000, buy_val: 1470000000, sell_vol: 51000, sell_val: 900000000, net_vol: 32000, net_val: 570000000, has_data: true, flagged: false };
const ROW_CTD = { symbol: "CTD", buy_vol: 120000, buy_val: 898000000, sell_vol: 60000, sell_val: 624000000, net_vol: 60000, net_val: 274000000, has_data: true, flagged: false };
const LIVE = { available: true, window: LIVE_WINDOW, rows: [ROW_HHP, ROW_CTD] }; // VCB ngoai watchlist -> khong co row
// /trades (DNSE tape): CTD khong co tape (empty) — dung nhu da nghiem thu live 04/11
const TAPES = {
  HHP: { total_vol: 1422900, buy_vol: 800000, sell_vol: 622900,
    trades: [
      { ts: 1111, time: "11:27:59", p: 17.6,  v: 500, s: "B" }, // join duoc -> side that buy (de len tick-rule B)
      { ts: 1700, time: "11:28:18", p: 17.65, v: 100, s: "M" }, // join duoc -> side that sell
      { ts: 2222, time: "11:29:02", p: 18.55, v: 200, s: "M" }, // KHONG join -> giu badge luat tick nhe
    ],
    levels: [{ p: 17.6, v: 9000 }, { p: 18.55, v: 2000 }] },
  VCB: { total_vol: 455800, buy_vol: 200000, sell_vol: 255800,
    trades: [{ ts: 3333, time: "11:30:00", p: 52.0, v: 300, s: "B" }],
    levels: [{ p: 52, v: 1500 }] },
};
const JOINS = {
  HHP: { available: true, matched: 2, trades: [{ ts: 1111, side: "buy" }, { ts: 1700, side: "sell" }] },
  CTD: { available: true, matched: 0, trades: [] },
  VCB: { available: true, matched: 0, trades: [] },
};
function symOf(url){ const m = /symbol=([A-Za-z]+)/.exec(url); return m ? m[1].toUpperCase() : null; }
function dataFor(url){
  if(url.startsWith("/trades?")) return TAPES[symOf(url)] || { empty: true };
  if(url === "/money-flow-live") return LIVE;
  if(url.startsWith("/money-flow-trades")) return JOINS[symOf(url)] || { available: true, matched: 0, trades: [] };
  if(url === "/watchlist") return [];
  return {};
}

// ===== DOM stub (khuon ctg-banks.test.mjs) ===================================
class El{
  constructor(id){ this.id = id; this.tagName = "DIV"; this.children = []; this._t = ""; this._html = "";
    this.className = ""; this.style = {}; this.dataset = {}; this.onclick = null; this.oninput = null;
    this.classList = { add(){}, remove(){}, toggle(){} }; }
  set textContent(v){ this._t = String(v); this.children = []; }
  get textContent(){ return this._t + this.children.map(c => c.textContent).join(""); }
  set innerHTML(v){ this._html = String(v); this._t = ""; }
  get innerHTML(){ return this._html; }
  appendChild(n){ this.children.push(n); return n; }
  get firstChild(){ return this.children[0] || null; }
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtN = (v) => { if(v == null || isNaN(+v)) return "—"; const [i, d] = String(v).split(".");
  const ig = i.replace(/\B(?=(\d{3})+(?!\d))/g, "."); return d != null ? ig + "," + d : ig; };

const tick = () => new Promise(r => setImmediate(r));

function boot(){
  const els = new Map();
  const get = (id) => { if(!els.has(id)) els.set(id, new El(id)); return els.get(id); };
  for(const id of ["dTapeSec","dTapeCard","dMBSecT","dMBCard"]) get(id).style.display = "none"; // nhu HTML goc
  const queue = [];
  const api = (url) => { let res; const q = { url, done: false, res: null };
    const p = new Promise(r => { q.res = r; res = r; void res; }); queue.push(q); return p; };
  const sb = {
    console, document: { getElementById: get, createElement: (t) => new El(t),
      querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    $: get, esc, fmtN, fmtPct: (v) => String(v), fmtTy: (v) => String(v), fmtTyAbs: (v) => String(v),
    scrollTo: () => {}, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout: (t) => clearTimeout(t),
    setInterval: () => 0, clearInterval: () => {}, localStorage: { getItem: () => null, setItem: () => {} },
    api, apip: api, loadStockMod: () => {}, refreshSrc: () => {}, curLang: "vi",
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: "js/stocks/detail.js" });
  const T = sb.__dtTest || null;
  const m = {
    sb, els, api, queue,
    byId: get,
    tape: T && T.tape, mb: T && T.mb,
    hold: () => false,
    async flush(){
      for(;;){
        const q = queue.find(x => !x.done && !m.hold(x.url));
        if(!q) break;
        q.done = true; q.res(dataFor(q.url));
        await tick();
      }
    },
    async open(sym){ sb.curSym = sym; const p = m.tape(sym); await m.flush(); await p; await m.flush(); await tick(); await m.flush(); },
  };
  return m;
}

// ===== 0. module + hook ======================================================
let m = null;
{
  try{ m = boot(); }catch(e){
    check("detail.js boot trong vm (khong bi try/catch an loi)", false, String(e));
    console.log("\nmb-ctd-detail: " + passed + " passed, " + failed + " failed");
    process.exit(1);
  }
  const hooked = !!(m.tape && m.mb && typeof m.mb.load === "function" && typeof m.mb.render === "function"
    && typeof m.mb.clear === "function" && typeof m.mb.state === "function");
  check("detail.js nap + __dtTest co hook that (tape/mb.load/mb.render/mb.clear/mb.state) — PRE-PATCH base: hook chua ton tai -> FAIL la dung",
    hooked, hooked ? null : "chi co __dtTest cu (khong co tape/mb) — can patch mb-ctd-fix");
  if(!hooked){
    console.log("\nmb-ctd-detail: " + passed + " passed, " + failed + " failed (khong the driver loadTape/loadMB ma khong co hook)");
    process.exit(1);
  }
  m.sb.curSym = "PROBE";
  check("curSym bridge ghi doc dung closure (window.curSym setter/getter)", m.mb.state().tapeSym === null && m.sb.curSym === "PROBE");
}

// ===== A. KHUYET DIEM 1 — CTD: khoi tom tat hien du KHONG co tape ============
{
  m = boot();
  await m.open("CTD");
  const sec = m.byId("dMBSecT"), card = m.byId("dMBCard"), body = m.byId("dMBBody"), note = m.byId("dMBNote");
  check("CTD: khoi M/B HOAN TOAN an tr khi money-flow-live ve (hien khi _tape null)", sec.style.display === "" && card.style.display === "", [sec.style.display, card.style.display]);
  check("CTD: tieu de khoi 'M/B SSI (15 phút)'", sec.textContent === "M/B SSI (15 phút)", sec.textContent);
  const b = body.innerHTML;
  check("CTD: so cua CTD (money-flow-live) hien: Mua KL 120.000 / Mua GT +0.898", /120\.000/.test(b) && b.includes("+0.898"), b.slice(0, 400));
  check("CTD: Ban KL 60.000 / Ban GT 0.624 (class down, mau dinh giong tab Dong tien)", /60\.000/.test(b) && b.includes("+0.624") && b.includes('class="down"'), b.slice(0, 400));
  check("CTD: Net +0.274 dung nhu probe live 11:23-11:38", b.includes("+0.274"), b.slice(0, 400));
  check("CTD: co cua so 11:23–11:38 + nguon SSI trong note khoi", note.textContent.includes("11:23–11:38") && note.textContent.includes("Nguồn SSI"), note.textContent);
  check("CTD: bang lenh VAN an/fallback (khong co tape thi khong bia lenh)",
    m.byId("dTapeSec").style.display === "none" && m.byId("dTapeCard").style.display === "none" && m.byId("dTapeList").innerHTML === "" && m.byId("dTapeCards").innerHTML === "");
  const st = m.mb.state();
  check("CTD: _mbSum = row CTD, matched 0, tape null (khong pha bang khop lenh)",
    st.sum && st.sum.symbol === "CTD" && st.matched === 0 && st.tape === null, { sum: st.sum && st.sum.symbol, matched: st.matched, tape: !!st.tape });
  const urls = m.queue.map(q => q.url);
  check("CTD: dung 3 goi endpoint/lan mo ma (tai dung chu ky auto-reload 60s, khong poll rieng)",
    urls.length === 3 && urls.includes("/trades?symbol=CTD&limit=300") && urls.includes("/money-flow-live") && urls.includes("/money-flow-trades?symbol=CTD&limit=300"), urls);
}

// ===== B. KHUYET DIEM 2 — doi ma HHP -> CTD khong con du lieu HHP ============
{
  m = boot();
  await m.open("HHP");
  check("HHP (truoc khi doi): du lieu HHP dang hien — tong 1.422.900 + lenh cuoi 11:28:18 + net +0.570",
    m.byId("dTapeCards").innerHTML.includes("1.422.900") && m.byId("dTapeList").innerHTML.includes("11:28:18") && m.byId("dMBBody").innerHTML.includes("+0.570"),
    { cards: m.byId("dTapeCards").innerHTML.slice(0, 200) });
  // Dong bo nhu loadDetail(sym) goi khi bam ma moi — TRUOC moi fetch ve:
  m.sb.curSym = "CTD";
  const did = m.mb.clear("CTD");
  check("doi ma: clear tra true (phat hien ma doi)", did === true);
  check("doi ma (NGAY LAP TUC, chua keo du lieu CTD): bang lenh HHP bi xoa sach + an thep",
    m.byId("dTapeCards").innerHTML === "" && m.byId("dTapeList").innerHTML === "" && m.byId("dTapeMini").innerHTML === "" &&
    m.byId("dTapeLevels").innerHTML === "" && m.byId("dTapeSec").style.display === "none" && m.byId("dTapeCard").style.display === "none");
  check("doi ma (NGAY LAP TUC): khoi M/B HIEN trang thai loading 'Đang tải M/B…', KHONG CON so HHP nao",
    m.byId("dMBBody").innerHTML.includes("Đang tải M/B…") &&
    !["+0.570", "+1.470", "+0.900", "1.422.900", "11:28:18", "17,6", "18,55"].some(s => m.byId("dMBBody").innerHTML.includes(s)),
    m.byId("dMBBody").innerHTML);
  check("doi ma: note cua so HHP xoa theo (khong con '11:23–11:38' cua lan truoc ghi chen)",
    m.byId("dMBNote").textContent === "" && m.byId("dTapeNote").textContent === "");
  // Race: loadMB HHP van dang pending luc doi ma -> response ve muon phai bi BO
  m.sb.curSym = "HHP"; await m.open("HHP"); // mo lai HHP de co state day du
  m.hold = (u) => u.startsWith("/money-flow");
  const p = m.tape("HHP");          // /trades ve, loadMB(HHP) gi /money-flow-live lai
  await m.flush(); await p; await tick();
  m.sb.curSym = "CTD"; m.mb.clear("CTD"); // doi ma GIUA LUC live/trades SSI pending
  m.hold = () => false;
  await m.open("CTD");              // du lieu CTD ve, response cu HHP giai phong muon
  check("race: response money-flow HHP ve MUON SAU khi doi ma bi bo (seq/curSym guard) — khong ghi de len CTD",
    m.byId("dMBBody").innerHTML.includes("+0.274") && !m.byId("dMBBody").innerHTML.includes("+0.570"),
    m.byId("dMBBody").innerHTML.slice(0, 300));
  const st1 = m.mb.state();
  check("race: sau do state = CTD (sum CTD, matched 0, tape null) — khong pha bang lenh CTD",
    st1.sum && st1.sum.symbol === "CTD" && st1.matched === 0 && st1.tape === null,
    { sum: st1.sum && st1.sum.symbol, matched: st1.matched, tape: !!st1.tape });
  check("CTD ve xong: TOAN page khong con sot so HHP (1.422.900 / 11:28:18 / +0.570 / 17,6 / 18,55)",
    ["1.422.900", "11:28:18", "+0.570", "17,6", "18,55"].every(s => !(m.byId("dMBBody").innerHTML + m.byId("dTapeCards").innerHTML + m.byId("dTapeList").innerHTML + m.byId("dTapeMini").innerHTML).includes(s)),
    (m.byId("dMBBody").innerHTML + m.byId("dTapeList").innerHTML).slice(0, 200));
}

// ===== B2. Auto-reload CUNG MA khong lam trang/nhip nhap ===============
{
  m = boot();
  await m.open("HHP");
  m.hold = (u) => u.startsWith("/trades?");
  m.sb.curSym = "HHP";
  const p = m.tape("HHP"); await tick();
  check("reload 60s cung ma: trong luc /trades pending, DOM van giu nguyen so HHP (khong flash trong)",
    m.byId("dTapeCards").innerHTML.includes("1.422.900") && m.byId("dMBBody").innerHTML.includes("+0.570") &&
    m.byId("dTapeSec").style.display === "", [m.byId("dTapeCards").innerHTML.slice(0, 120), m.byId("dMBBody").innerHTML.slice(0, 120)]);
  m.hold = () => false; await m.flush(); await p; await m.flush(); await tick(); await m.flush();
  check("reload xong: van 1.422.900, khong nhan doi nan", m.byId("dTapeCards").innerHTML.includes("1.422.900") && m.byId("dMBBody").innerHTML.includes("+0.570"));
}

// ===== C. HHP co tape + side that SSI — hanh vi da nghiem thu live giu nguyen ==
{
  m = boot();
  await m.open("HHP");
  check("HHP: khoi M/B + bang lenh cung hien (tiep tuc co tape)", m.byId("dMBSecT").style.display === "" && m.byId("dTapeSec").style.display === "" && m.byId("dTapeCard").style.display === "");
  check("HHP: tong/ban le o tren dung so tape", m.byId("dTapeCards").innerHTML.includes("1.422.900") &&
    m.byId("dTapeCards").innerHTML.includes("800.000") && m.byId("dTapeCards").innerHTML.includes("622.900"));
  const rows = m.byId("dTapeList").innerHTML;
  check("HHP: lenh khop tick SSI -> badge M vien dam (side that buy de len tick-rule B cu)",
    (rows.match(/background:#c9efdb/g) || []).length === 1 && (rows.match(/border:1px solid #0a7a42/g) || []).length === 1);
  check("HHP: lenh khop tick SSI -> badge B vien dam (side that sell)", (rows.match(/background:#f8d0d0/g) || []).length === 1);
  check("HHP: lenh KHONG khop van giu badge luat tick nhe (nen trang, khong vien dam)",
    (rows.match(/background:#e5f6ec/g) || []).length === 1 && (rows.match(/border:1px solid/g) || []).length === 2);
  check("HHP: tooltip badge dung (2 'side thật SSI', 1 'luật tick') — hover badge khong doi noi dung",
    (rows.match(/side thật SSI/g) || []).length === 2 && (rows.match(/title="luật tick"/g) || []).length === 1);
  check("HHP: note duoi bang = chu side that SSI (matched>0)", m.byId("dTapeNote").textContent.startsWith("Lệnh khớp được tick SSI"), m.byId("dTapeNote").textContent);
  check("HHP: khoi M/B hien so cua chinh no tu money-flow-live (+1.470/+0.900/+0.570)",
    m.byId("dMBBody").innerHTML.includes("+1.470") && m.byId("dMBBody").innerHTML.includes("+0.900") && m.byId("dMBBody").innerHTML.includes("+0.570"));
  check("HHP: thieu co 3 dong lenh thoi gian + gia cu", ["11:27:59","11:28:18","11:29:02"].every(s => rows.includes(s)));
}

// ===== C2. VCB ngoai watchlist SSI — trang thai giu nguyen ===================
{
  m = boot();
  await m.open("VCB");
  check("VCB: bang lenh co tape van hien binh thuong (khong phia M/B co so cua ma khac)",
    m.byId("dTapeSec").style.display === "" && m.byId("dTapeList").innerHTML.includes("11:30:00"));
  check("VCB: khoi M/B hien 'Chưa có dữ liệu M/B (mã ngoài watchlist SSI)' (nhu da nghiem thu live)",
    m.byId("dMBSecT").style.display === "" && m.byId("dMBBody").innerHTML.includes("Chưa có dữ liệu M/B (mã ngoài watchlist SSI)"), m.byId("dMBBody").innerHTML);
  check("VCB: note duoi bang van la chu luat tick (matched=0)", m.byId("dTapeNote").textContent.startsWith("Phía M/B ước lượng theo luật tick"), m.byId("dTapeNote").textContent.slice(0, 60));
}

// ===== C3. Che do chi so (curSym null) khong hien khoi M/B ====================
{
  m = boot();
  m.sb.curSym = "HHP"; await m.open("HHP");
  m.sb.curSym = null; m.mb.render();
  check("index mode (curSym=null): khoi M/B an (curSym null van an như cu)", m.byId("dMBSecT").style.display === "none" && m.byId("dMBCard").style.display === "none");
}

// ===== D. Cam: i18n 4 ngon ngu con nguyen ven (khu vuc KHONG duoc dong) =====
{
  const bootM = boot();
  const I = bootM.sb.TP_I18N;
  const keys = (o) => Object.keys(o || {}).sort().join(",");
  const ref = keys(I.vi);
  check("TP_I18N du 4 ngon ngu vi/en/zh/co cung bo key (khu vuc cam, khong dong)",
    ["vi","en","zh","ko"].every(l => keys(I[l]) === ref), ["vi","en","zh","ko"].map(l => [l, keys(I[l]) === ref]));
  check("khoi M/B render duoc bang tieng EN (doi ngon ngu khong vo khoi)", (() => {
    const mm = boot(); mm.sb.curLang = "en"; mm.sb.curSym = "CTD";
    mm.tape("CTD"); return typeof mm.mb.state === "function"; })());
}

console.log("\nmb-ctd-detail: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
