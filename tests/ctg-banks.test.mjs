// tests/ctg-banks.test.mjs — CTG + 28 ma ngan hang (v-ctg, js/stocks/ctg.js).
// Chung minh: 17 ma cong bo duoc + 11 ma blocked + nhan "1,3272 PROVEN
// UNRECONCILABLE" thuc su render ra DOM, duoc duyet TU FILE THAT
// js/stocks/ctg-banks.json (khong phai mock — so doi chieu nguyen van
// REPORT-GD2-28.md §4.1/§4.2). Mock chi la DOM stub + fetch doc file dia.
// Run: node tests/ctg-banks.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const DATA_FILE = path.join(root, "js", "stocks", "ctg-banks.json");
const MOD_FILE = path.join(root, "js", "stocks", "ctg.js");
const HTML_FILE = path.join(root, "stocks.html");

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}

const RAW = fs.readFileSync(DATA_FILE, "utf8");
const DATA = JSON.parse(RAW);

// ---- 1. file du lieu THAT khong phai mock: du 17 + 11, so khop §4.1 -------
{
  check("ctg-banks.json parse duoc, as_of 2026-10-28", DATA.as_of === "2026-10-28", DATA.as_of);
  check("17 ma cong bo duoc (khop counts.publishable)",
    DATA.publishable.length === 17 && DATA.counts.publishable === 17,
    { rows: DATA.publishable.length, counts: DATA.counts });
  check("11 ma blocked (khop counts.blocked)",
    DATA.blocked.length === 11 && DATA.counts.blocked === 11,
    { rows: DATA.blocked.length, counts: DATA.counts });
  const codes = DATA.publishable.map(r => r.code).join(" ");
  check("danh sach 17 ma dung §4.1",
    codes === "CTG VCB STB BID NVB LPB EIB HDB ACB MBB VIB VPB TCB SHB BAB TPB KLB", codes);
  const blocked = DATA.blocked.map(r => r.code).join(" ");
  check("danh sach 11 ma blocked dung §4.2",
    blocked === "PCB VAB SSB OCB ABB PGB MSB NAB SGB BVB VBB", blocked);
  const ctg = DATA.publishable.find(r => r.code === "CTG");
  check("CTG canary: P/B A 1,3272 · P/B B 1,1909 · percentile 4,85/3,50",
    ctg.pb_a === 1.3272 && ctg.pb_b === 1.1909 && ctg.cheap_a_pct === 4.85 && ctg.cheap_b_pct === 3.50,
    ctg);
  check("CTG p80 A 0,9551 / 22.092,0 · p80 B 0,9367 / 24.145,3 · 3152/3197 phien",
    ctg.p80_a_mult === 0.9551 && ctg.p80_a_dong === 22092.0 && ctg.p80_b_mult === 0.9367 &&
    ctg.p80_b_dong === 24145.3 && ctg.sessions_a === 3152 && ctg.sessions_b === 3197, ctg);
  const overrides = DATA.publishable.filter(r => r.shares_override)
    .map(r => r.code + "=" + r.shares_override).join(" ");
  check("4 ma override so cp kiem toan @2025-12-31 (EIB/KLB/NVB/SHB)",
    overrides === "NVB=1924632751 EIB=1862720607 SHB=4593703838 KLB=578370526", overrides);
  check("chuoi B cua 4 ma override duoc danh dau CHUA KIEM CHUNG (pb_b_unaudited)",
    DATA.publishable.every(r => !!r.pb_b_unaudited === !!r.shares_override),
    DATA.publishable.map(r => [r.code, !!r.shares_override, r.pb_b_unaudited]));
  check("11 ma blocked: input shares+equity OK, P/B null (khong co so de bia)",
    DATA.blocked.every(r => r.inputs_shares_ok && r.inputs_equity_ok && r.pb_a === null && r.pb_b === null),
    DATA.blocked.map(r => [r.code, r.pb_a]));
  check("so phien 11 ma blocked dung §4.2 (PCB 55 … VBB 1803)",
    DATA.blocked.map(r => r.sessions).join(",") === "55,1310,1399,1433,1455,1457,1458,1505,1506,1568,1803",
    DATA.blocked.map(r => r.sessions));
  check("CTG detail: BVPS 2025 = 23.130,72đ (PwC, H7 dong)",
    DATA.ctg_detail.bvps_2025_dong === 23130.72 && /PwC/.test(DATA.ctg_detail.bvps_source),
    DATA.ctg_detail);
  check("CTG detail: nhan PB A = PROVEN UNRECONCILABLE, khong phai 1,22",
    DATA.ctg_detail.pb_a === 1.3272 && DATA.ctg_detail.pb_a_label === "PROVEN UNRECONCILABLE",
    DATA.ctg_detail.pb_a_label);
  check("CTG detail: band mau 1,22 doi 7.080.865.248–7.197.903.992 cp vs kiem toan 7.766.944.637, 19 ung vien 0 dat",
    DATA.ctg_detail.pb_a_template.pb === 1.22 &&
    DATA.ctg_detail.pb_a_template.shares_needed_min === 7080865248 &&
    DATA.ctg_detail.pb_a_template.shares_needed_max === 7197903992 &&
    DATA.ctg_detail.pb_a_template.audited_shares === 7766944637 &&
    DATA.ctg_detail.pb_a_template.candidates_tested === 19 &&
    DATA.ctg_detail.pb_a_template.candidates_pass === 0, DATA.ctg_detail.pb_a_template);
  check("D1–D7 du 7 quyet dinh",
    DATA.decisions.map(d => d.id).join(",") === "D1,D2,D3,D4,D5,D6,D7", DATA.decisions.map(d => d.id));
}

// ---- DOM stub (du cho module: getElementById + innerHTML/textContent) -----
class El{
  constructor(tag){ this.tagName = tag.toUpperCase(); this.children = []; this._t = ""; this._html = ""; this.className = ""; this.style = {}; this.dataset = {}; }
  set textContent(v){ this._t = String(v); this.children = []; }
  get textContent(){ return this._t + this.children.map(c => c.textContent).join(""); }
  set innerHTML(v){ this._html = String(v); this._t = ""; }
  get innerHTML(){ return this._html; }
  appendChild(n){ this.children.push(n); return n; }
  get firstChild(){ return this.children[0] || null; }
}
const CTG_IDS = ["ctgSrc","ctgHead","ctgCtgT","ctgCtg","ctgPubT","ctgPubHead","ctgPubBody",
  "ctgBlockT","ctgBlockHead","ctgBlockBody","ctgBlockNote","ctgDecT","ctgDec","ctgNotes"];
function bootCtg(lang, fetchImpl){
  const src = fs.readFileSync(MOD_FILE, "utf8");
  const els = new Map(CTG_IDS.map(id => [id, new El("div")]));
  const sandbox = {
    document: { getElementById: (id) => els.get(id) || null, createElement: (tag) => new El(tag), querySelector: () => null },
    console, fetch: fetchImpl,
    curLang: lang || "vi",
    $: (id) => els.get(id) || null,
    esc: (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "js/stocks/ctg.js" });
  return { byId: (id) => els.get(id) || null, sandbox };
}
// fetch doc file dia that (khong mock so lieu)
const fileFetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(RAW)) });

// ---- 2. module nap duoc (khong bi try{}catch{} an loi) --------------------
{
  const m = bootCtg("vi", fileFetch);
  check("ctg.js nap va export loadCtg/renderCtg/__ctgTest",
    typeof m.sandbox.loadCtg === "function" && typeof m.sandbox.renderCtg === "function" && !!m.sandbox.__ctgTest,
    Object.keys(m.sandbox).filter(k => /^loadCtg|^renderCtg|^__ctg/.test(k)));
}

// ---- 3. loadCtg() doc dung duong JSON cua repo ----------------------------
{
  const calls = [];
  const m = bootCtg("vi", (u) => { calls.push(u); return fileFetch(); });
  await m.sandbox.loadCtg();
  check("loadCtg() fetch /english/js/stocks/ctg-banks.json (duong tinh, khong lane API moi)",
    calls.length === 1 && calls[0] === "/english/js/stocks/ctg-banks.json", calls);
  const held = m.sandbox.__ctgTest.data();
  check("loadCtg() giu nguyen du lieu da doc (17 hang, khong tinh lai so)",
    !!held && (held.publishable || []).length === 17 && held.publishable[0].pb_a === 1.3272, held && held.publishable && held.publishable.length);
}

// ---- 4. render: 17 ma cong bo + 11 ma blocked + nhan PROVEN UNRECONCILABLE --
{
  const m = bootCtg("vi", fileFetch);
  await m.sandbox.loadCtg();
  const pub = m.byId("ctgPubBody").innerHTML;
  const blk = m.byId("ctgBlockBody").innerHTML;
  const ctg = m.byId("ctgCtg").innerHTML;
  const codes = (pub.match(/<b>([A-Z]{3})<\/b>/g) || []).map(s => s.replace(/<\/?b>/g, ""));
  check("bang 17 ma cong bo duoc render du 17 dong", codes.length === 17, codes);
  check("17 ma render dung danh sach §4.1",
    codes.join(" ") === "CTG VCB STB BID NVB LPB EIB HDB ACB MBB VIB VPB TCB SHB BAB TPB KLB", codes);
  check("so cua CTG hien dung: 1,3272 / 1,1909 / 4,85% / 3,50% / 0,9551 / 22.092,0",
    /1,3272/.test(pub) && /1,1909/.test(pub) && /4,85%/.test(pub) && /3,50%/.test(pub) &&
    /0,9551/.test(pub) && /22\.092,0/.test(pub), pub.slice(0, 400));
  const blkCodes = (blk.match(/<b>([A-Z]{3})<\/b>/g) || []).map(s => s.replace(/<\/?b>/g, ""));
  check("bang 11 ma blocked duoc render du 11 dong", blkCodes.length === 11, blkCodes);
  check("11 ma blocked hien '—' o cot P/B, khong co so gia",
    blkCodes.length === 11 && /—<\/td>/.test(blk) && !/1,\d{4}/.test(blk), blk.slice(0, 300));
  check("CTG detail hien 1,3272 KEM nhan PROVEN UNRECONCILABLE",
    /1,3272/.test(ctg) && /PROVEN UNRECONCILABLE/.test(ctg), ctg.slice(0, 300));
  check("CTG detail ghi ro BVPS 23.130,72đ va P/B B 1,1909 DAT",
    /23\.130,72/.test(ctg) && /1,1909/.test(ctg), ctg.slice(0, 300));
  check("CTG detail trinh mau so 1,22 khong tai tao duoc (7.080.865.248–7.197.903.992 vs 7.766.944.637, 19/0)",
    /1,22/.test(ctg) && /7\.080\.865\.248/.test(ctg) && /7\.197\.903\.992/.test(ctg) &&
    /7\.766\.944\.637/.test(ctg) && /19/.test(ctg), ctg.slice(-500));
  check("bang cong bo danh dau 4 ma dung so cp kiem toan (KT + so cp)",
    /1\.924\.632\.751/.test(pub) && /1\.862\.720\.607/.test(pub) &&
    /4\.593\.703\.838/.test(pub) && /578\.370\.526/.test(pub), pub.slice(0, 200));
  check("4 ma override co nhan 'so chua kiem chung' o cot P/B B",
    (pub.match(/chưa kiểm chứng/g) || []).length === 4, (pub.match(/chưa kiểm chứng/g) || []).length);
  check("D1–D7 render du 7 dong quyet dinh",
    ["D1","D2","D3","D4","D5","D6","D7"].every(d => m.byId("ctgDec").innerHTML.includes(">" + d + "<")),
    m.byId("ctgDec").innerHTML.slice(0, 200));
  check("header tom tat 17/11 + as_of",
    m.byId("ctgHead").textContent.includes("2026-10-28") && /17/.test(m.byId("ctgHead").textContent) && /11/.test(m.byId("ctgHead").textContent),
    m.byId("ctgHead").textContent);
}

// ---- 5. du 4 ngon ngu VI/EN/zh/ko (RULES §6) ------------------------------
{
  const I = bootCtg("vi", fileFetch).sandbox.__ctgTest.i18n;
  const keys = (o) => Object.keys(o || {}).sort().join(",");
  const ref = keys(I.vi);
  const langs = ["vi","en","zh","ko"];
  check("I18N co du 4 ngon ngu, cung bo key (khong thieu key)",
    langs.every(l => keys(I[l]) === ref), langs.map(l => [l, keys(I[l])]));
}
{
  for(const [lang, probe] of [["en","PROVEN UNRECONCILABLE"], ["zh","PROVEN UNRECONCILABLE"], ["ko","PROVEN UNRECONCILABLE"]]){
    const m = bootCtg(lang, fileFetch);
    await m.sandbox.loadCtg();
    const ctg = m.byId("ctgCtg").innerHTML;
    check(lang.toUpperCase() + ": van hien 1,3272 + nhan PROVEN UNRECONCILABLE",
      /1,3272/.test(ctg) && ctg.includes(probe), ctg.slice(0, 200));
    const pub = m.byId("ctgPubBody").innerHTML;
    check(lang.toUpperCase() + ": du 17 dong cong bo", (pub.match(/<b>[A-Z]{3}<\/b>/g) || []).length === 17);
  }
}

// ---- 6. loi duong dan -> hint, khong bia so, khong crash -------------------
{
  const m = bootCtg("vi", () => Promise.reject(new Error("offline")));
  await m.sandbox.loadCtg();
  const body = m.byId("ctgPubBody").innerHTML + m.byId("ctgBlockBody").innerHTML;
  check("fetch loi -> hien hint loi, khong crash, khong co so gia nao",
    /hint/.test(body) && !/1,3272/.test(body) && !/<b>[A-Z]{3}<\/b>/.test(body), body.slice(0, 200));
}

// ---- 7. noi vao stocks.html: view + NAV + lazy loader, KHONG gate ---------
{
  const html = fs.readFileSync(HTML_FILE, "utf8");
  check("stocks.html: co view v-ctg", /<div class="view" id="v-ctg">/.test(html));
  check("stocks.html: NAV co entry v-ctg", /\["v-ctg","CTG & ngân hàng"\]/.test(html));
  check("stocks.html: VIEW_LOADERS lazy nap ctg.js (khong them <script src> tinh)",
    /"v-ctg":\(\)=>loadStockMod\("\/english\/js\/stocks\/ctg\.js\?v=__BUILD__",function\(\)\{ return typeof window\.loadCtg==="function"; \},function\(\)\{ window\.loadCtg\(\); \}\)/.test(html) &&
    !/<script src="\/english\/js\/stocks\/ctg\.js/.test(html));
  check("stocks.html: v-ctg KHONG nam trong GATED (tab free)",
    /var GATED=\["margin","foreign","prop"\];/.test(html) && !/GATED=\[[^\]]*ctg/.test(html),
    /var GATED=\[[^\]]*\];/.exec(html)[0]);
  check("stocks.html: ctgTabs duoc nap vao 3 danh sach buildNav (go/init/setLang)",
    (html.match(/"secTabs","ctgTabs"/g) || []).length === 3, (html.match(/"secTabs","ctgTabs"/g) || []).length);
  check("stocks.html: NAVLBL v-ctg duoc dich khi doi ngon ngu",
    /NAVLBL\["v-ctg"\] = L\.ctg;/.test(html));
  check("stocks.html: doi ngon ngu -> rerender view ctg khi dang mo",
    html.includes('window.__ctgTest.rerender()'));
  check("stocks.html: LANGS co key ctg cho ca 4 ngon ngu",
    (html.match(/ctg:"[^"]+"/g) || []).length === 4, (html.match(/ctg:"[^"]+"/g) || []).length);
}

// ---- 8. patch ISOLATED: vung cam van con nguyen (chart/sig/so lenh/dong tien)
{
  const html = fs.readFileSync(HTML_FILE, "utf8");
  const anchors = {
    "bieu do chi tiet": 'id="dChart"',
    "sig list": '<div id="signalsList">',
    "so lenh (shelf)": "const SHELF_I18N={",
    "lich su nhom NDT": 'id="ffHistCard"',
    "man Dong tien": '<div class="view" id="v-flow">',
    "poll tu tai 60s": "}, 60000);",
    "khon auto-reload": "__AUTO_RELOAD_END__",
    "cua GATED": 'var GATED=["margin","foreign","prop"];',
  };
  const missing = Object.entries(anchors).filter(([ , a ]) => !html.includes(a)).map(([ k ]) => k);
  check("patch khong xoa/doi khu vuc cam (chart, sig, so lenh, dong tien, poll 60s, GATED)",
    missing.length === 0, missing);
  check("v-ctg chi noi dung cua no: khong them id trung voi view khac",
    (html.match(/id="v-ctg"/g) || []).length === 1 && /id="ctgTabs"/.test(html));
  check("ctg.js khong goi lane API nao (chi doc file cong bo tinh)",
    !/api\(|apip\(|fetch\("\/api/.test(fs.readFileSync(MOD_FILE, "utf8")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
