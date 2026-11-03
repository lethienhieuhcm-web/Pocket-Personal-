// tests/watchlist.test.mjs — Henrry 22:05 03/11: nguoi dung PHAI SEE cac ma
// trong watchlist cua bo loc dem. Duong du lieu KHONG them moi (publish lane
// `flow_screen` + GET lane /api/stock/flow-screen da ton tai); test nay noi
// chuoi that: flow_watchlist.json 2026-11-02 (20 candidates) -> hStockPublish
// -> mock R2 -> hStockFlowScreen -> js/stocks/watchlist.js render ra DOM.
// Mock R2 + DOM stub; khong network, khong D1, khong deploy.
// Run: node tests/watchlist.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register("./flow-hooks.mjs", import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const { hStockPublish, hStockFlowScreen } = await import("../worker/src/stock.js");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

// ---- sample: bo loc chay dem 02/11, ap dung cho phien 03/11, 20 ma ---------
const SAMPLE = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "flow_watchlist_2026-11-02.json"), "utf8"));
const SAMPLE_SYMS = SAMPLE.candidates.map(c => c.symbol);
check("fixture: 20 candidates, screen 2026-11-02 -> for 2026-11-03",
  SAMPLE.screen_date === "2026-11-02" && SAMPLE.for_date === "2026-11-03" && SAMPLE.candidates.length === 20,
  { n: SAMPLE.candidates.length, screen_date: SAMPLE.screen_date, for_date: SAMPLE.for_date });

// ---- DOM stub (du cho module: getElementById/createElement/appendChild) ----
class El{
  constructor(tag){ this.tagName = tag.toUpperCase(); this.children = []; this._t = ""; this.className = ""; this.href = ""; this.onclick = null; this.style = {}; this.dataset = {}; }
  set textContent(v){ this._t = String(v); this.children = []; }
  get textContent(){ return this._t + this.children.map(c => c.textContent).join(""); }
  appendChild(n){ this.children.push(n); return n; }
  get firstChild(){ return this.children[0] || null; }
  chipTexts(){ return this.children.map(c => c.textContent); }
}
function bootWatchlist(lang){
  const src = fs.readFileSync(path.join(here, "..", "js", "stocks", "watchlist.js"), "utf8");
  const els = new Map(["wlSecT", "wlBadge", "wlHead", "wlChips", "wlNote"].map(id => [id, new El("div")]));
  const opened = [];
  const sandbox = {
    document: { getElementById: (id) => els.get(id) || null, createElement: (tag) => new El(tag), querySelector: () => null, addEventListener: () => {} },
    console: console,
    setTimeout: () => {}, clearTimeout: () => {},
    openSym: (s) => opened.push(s),
    $: (id) => els.get(id) || null,
    api: async () => { throw new Error("render tests do not fetch"); },
    curLang: lang || "vi",
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "js/stocks/watchlist.js" });
  return { byId: (id) => els.get(id) || null, opened, sandbox };
}

// ---- 1. module nap duoc (khong bi try{}catch{} an loi) ----------------------
{
  const m = bootWatchlist("vi");
  check("watchlist.js expoort loadFlowWatchlist/renderWatchlist/__wlTest",
    typeof m.sandbox.window.loadFlowWatchlist === "function" &&
    typeof m.sandbox.window.renderWatchlist === "function" &&
    !!m.sandbox.window.__wlTest && typeof m.sandbox.window.__wlTest.rerender === "function",
    Object.keys(m.sandbox.window));
}

// ---- 2. chuoi that: publish lane -> R2 -> GET lane -> render ---------------
let API_J = null;
{
  const store = new Map();
  const env = {
    DATA: {
      get: async (key) => { const v = store.get(key); return v === undefined ? null : { json: async () => JSON.parse(JSON.stringify(v)) }; },
      put: async (key, val) => { store.set(key, JSON.parse(val)); },
    },
    STOCK_PUBLISH_SECRET: "s3cr3t",
  };
  const pubRes = await hStockPublish({ headers: { get: () => "s3cr3t" }, json: async () => ({ flow_screen: SAMPLE }) }, env);
  const pubBody = await pubRes.json();
  check("publish lane nhan dung file watchlist (written=2)",
    pubBody.ok === true && pubBody.written === 2, pubBody);
  check("R2 keys dung hai key frontend doc",
    store.has("stock/flow/flow_screen_latest.json") && store.has("stock/flow/flow_screen/2026-11-03.json"),
    [...store.keys()]);

  const getRes = await hStockFlowScreen({ headers: { get: () => null }, url: "https://w/api/stock/flow-screen" }, env);
  API_J = await getRes.json();
  check("GET lane tra 20 ma + ca hai ngay",
    getRes.status === 200 && API_J.available === true && API_J.count === 20 &&
    API_J.screen_date === "2026-11-02" && API_J.for_date === "2026-11-03" && API_J.rows.length === 20,
    { status: getRes.status, available: API_J.available, count: API_J.count, rows: (API_J.rows || []).length });

  const m = bootWatchlist("vi");
  m.sandbox.window.renderWatchlist(API_J);
  const shown = m.byId("wlChips").chipTexts();
  check("render: 20 chip, du 20 ma watchlist hien tren man",
    shown.length === 20 && SAMPLE_SYMS.every(s => shown.includes(s)), shown);
  const head = m.byId("wlHead").textContent;
  check("render: dong header co screen_date + for_date + so luong",
    head.includes("2026-11-02") && head.includes("2026-11-03") && head.includes("20"), head);
  check("render: tieu de bloc + badge co chu",
    m.byId("wlSecT").textContent.length > 0 && m.byId("wlBadge").textContent.length > 0,
    { t: m.byId("wlSecT").textContent, b: m.byId("wlBadge").textContent });
  check("render: note dang ro 'khong phai tin hieu mua'",
    m.byId("wlNote").textContent.includes("không phải tín hiệu mua"), m.byId("wlNote").textContent);
  check("render: thu tu theo hang cua lane (cmf20 giam dan), khong trung lap",
    shown.length === new Set(shown).size && shown[0] === API_J.rows[0].symbol, shown.slice(0, 3));
}

// ---- 3. cham chip mo trang chi tiet (openSym) ------------------------------
{
  const m = bootWatchlist("vi");
  m.sandbox.window.renderWatchlist(API_J);
  const first = m.byId("wlChips").children[0];
  check("chip la the a.chipq (dung style san co, khong CSS moi)",
    !!first && first.tagName === "A" && first.className === "chipq", { tag: first && first.tagName, cls: first && first.className });
  let prevented = false;
  first.onclick({ preventDefault: () => { prevented = true; } });
  check("chip tap -> openSym(ma) + preventDefault",
    prevented && m.opened.length === 1 && m.opened[0] === API_J.rows[0].symbol, { prevented, opened: m.opened });
}

// ---- 4. i18n 4 ngon ngu, khong them gate/premium --------------------------
{
  for(const lang of ["vi", "en", "zh", "ko"]){
    const m = bootWatchlist(lang);
    m.sandbox.window.renderWatchlist(API_J);
    const t = m.byId("wlSecT").textContent;
    check(`i18n ${lang}: co tieu de + 20 chip`, t.length > 0 && m.byId("wlChips").children.length === 20, { t, n: m.byId("wlChips").children.length });
  }
  const blob = JSON.stringify(bootWatchlist("vi").sandbox.window.__wlTest.i18n).toLowerCase();
  check("khong tu gate/paywall nao trong module (mien phi, quy tắc Henrry)",
    !/premium|paywall|unlock|đăng ký gói|Trả phí|付費|구독/.test(blob), blob.slice(0, 80));
}

// ---- 5. stale / empty / du lieu thieu --------------------------------------
{
  const m = bootWatchlist("vi");
  const stale = m.sandbox.window.__wlTest.stale;
  check("stale: for_date < hom nay -> true; =/> -> false; dinh dang sai -> false",
    stale("2026-10-28", "2026-11-03") === true && stale("2026-11-03", "2026-11-03") === false &&
    stale("2026-12-01", "2026-11-03") === false && stale("", "2026-11-03") === false && stale("TEST", "2026-11-03") === false);
  m.sandbox.window.renderWatchlist(Object.assign({}, API_J, { for_date: "2026-10-28" }));
  check("stale: note noi ro bo loc dem co the chua chay / chua duoc day len",
    m.byId("wlNote").textContent.includes("chưa chạy"), m.byId("wlNote").textContent);

  const e = bootWatchlist("vi");
  e.sandbox.window.renderWatchlist({ available: false, rows: [], count: 0, screen_date: null, for_date: null });
  const hint = e.byId("wlChips").firstChild;
  check("available:false -> hint 'chưa có watchlist', header de tron",
    !!hint && hint.className === "hint" && /watchlist/.test(hint.textContent) && e.byId("wlHead").textContent === "",
    hint && hint.textContent);
}

// ---- 6. ma sai dinh dang bi loai (khong cho vao DOM) -----------------------
{
  const m = bootWatchlist("vi");
  const ok = m.sandbox.window.__wlTest.symOk;
  check("symOk: ACB/NT2 hop le; bom xe / qua dai / qua ngan -> false",
    ok("ACB") === true && ok("NT2") === true && ok('A"><svg') === false && ok("") === false && ok("AB") === false && ok("X".repeat(11)) === false);
  m.sandbox.window.renderWatchlist({ available: true, screen_date: "2026-11-02", for_date: "2026-11-03", count: 3,
    rows: [{ symbol: "ACB" }, { symbol: 'X"><img src=x onerror=alert(1)>' }, { symbol: "abc" }] });
  const shown = m.byId("wlChips").chipTexts();
  check("render: chi ma hop le vao DOM, ma bom xe bi bo het",
    shown.includes("ACB") && shown.includes("ABC") && shown.length === 2 && !m.byId("wlChips").textContent.includes("onerror"), shown);
}

// ---- 7. noi dung block + nap module + doi ngon ngu trong stocks.html -------
{
  const html = fs.readFileSync(path.join(here, "..", "stocks.html"), "utf8");
  check("stocks.html: du 5 id cua bloc watchlist",
    ["wlSecT", "wlBadge", "wlHead", "wlChips", "wlNote"].every(id => html.includes(`id="${id}"`)));
  const mk = html.slice(html.indexOf('id="v-market"'), html.indexOf('id="v-screen"'));
  check("stocks.html: block nam tren man Thi truong (khong phai tab an)",
    mk.includes("wlChips") && mk.includes("wlSecT"));
  check("stocks.html: v-market loader nap watchlist.js lazy",
    /"v-market":\(\)=>\{ window\.loadMarket\(\); loadStockMod\("\/english\/js\/stocks\/watchlist\.js\?v=__BUILD__"/.test(html));
  check("stocks.html: boot nap watchlist (day la view mac dinh)",
    /^\s*loadStockMod\("\/english\/js\/stocks\/watchlist\.js\?v=__BUILD__"/m.test(html));
  check("stocks.html: doi ngon ngu -> rerender bloc",
    html.includes("window.__wlTest.rerender()"));
  check("stocks.html: khong them <script src> tinh (giu lazy, khong phan bang them)",
    !/<script src="\/english\/js\/stocks\/watchlist\.js/.test(html));
}

// ---- 8. loadFlowWatchlist goi lane /flow-screen (public, khong them endpoint) --
{
  const m = bootWatchlist("vi");
  const calls = [];
  m.sandbox.api = async (p) => { calls.push(p); return API_J; };
  await m.sandbox.window.loadFlowWatchlist();
  check("loadFlowWatchlist() GET /flow-screen (duong da co, khong lane moi)",
    calls.length === 1 && calls[0] === "/flow-screen", calls);
  check("loadFlowWatchlist() render du 20 ma that tu lane",
    m.byId("wlChips").children.length === 20, m.byId("wlChips").children.length);
}
{
  const m = bootWatchlist("en");
  m.sandbox.api = async () => { throw new Error(401); };
  await m.sandbox.window.loadFlowWatchlist();
  const h = m.byId("wlChips").firstChild;
  check("lane hong -> hint loi, khong crash, khong con 'Đang tải…'",
    !!h && h.className === "hint" && /could not load/i.test(h.textContent), h && h.textContent);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
