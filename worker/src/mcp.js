// worker/src/mcp.js — MCP server khai thac kho du lieu tu chu,
// GIAI DOAN 1 (Henrry Chot thiet ke nguyen van 05:58 22/10/2026,
// ban thiet ke mcp-stock-design.md).
//
// POST /api/mcp — MCP Streamable HTTP (JSON-RPC 2.0), stateless,
// tap con: initialize / tools/list / tools/call / ping. Khong SSE.
//
// Nguyen tac cung theo thiet ke:
// - MCP KHONG co duong du lieu rieng: 14 tool doc dung snapshot R2
//   (stock/market/*.json qua sGet cua stock.js) ma REST /api/stock/*
//   dang doc. Cam tool goi API ngoai tai thoi diem truy van.
// - Phong bi dau ra bat buoc cho moi tool: data + meta{source,
//   as_of, retrieved_at, coverage, missing, verification, stale}.
//   Thieu du lieu -> missing, KHONG dien 0 lam le (hop dong bang
//   cua kho, QD7).
// - Co kiem chung di theo du lieu (Phu luc A cua thiet ke):
//   BCTC + ty so (DN_BCTC, DN_CHI_SO) = parity_pending kem
//   verification_note; dao chi muc co dong = building (registry
//   dang cap nhat) kem coverage day du.
// - Phan goi theo muc 2.5 da Chot: free = gia + ho so; hocsinh
//   + vi mo, nganh; sinhvien + dong tien, dong thuan; dilam tro
//   len = toan bo GD1. Moi tools/call thanh cong tru 1 don vi
//   agent_calls trong han muc ngay cua goi (billing.getUsage /
//   incrUsage — co che D1 san co, khong che khoa moi).
// - Moi luot tools/call ghi 1 dong mcp_log (ke ca refused /
//   quota_exceeded / error) de truy vet cau tra loi cua AI.
// - Tu choi co cau truc: plan_restricted / quota_exceeded /
//   unknown_tool / invalid_params / symbol_not_found /
//   series_not_found. MCP la tang SO LIEU: khong tool du doan
//   gia, khong du lieu ca nhan cua user, khong van phan tich
//   cua hang chung khoan (tran ban quyen lop dong thuan).

import { getSession, getUser, getActivePlan, PLANS } from './auth.js';
import { getUsage, incrUsage } from './billing.js';
import {
  sGet, sPut, getQuoteData, getFundamentalsData, getStatementsData,
  getNewsData, getCompanyProfile,
} from './stock.js';
import { ANALYSIS_CATALOG } from './analysis_catalog.js';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'pocket-personal-stock-mcp', version: '1.0.0' };
// MO FULL giai doan thu nghiem (Henrry sua lenh 10:07 22/10/2026,
// Dot A the hien MCP ra frontend): true = bo phan goi muc 2.5 + bo
// quota agent_calls cho MOI user (tools/list tra du 14 tool, khong
// tru usage). Khi Henrry lenh dong, gat ve false la phan goi + quota
// ap dung lai nguyen ven (khong sua them cho nao khac).
const MCP_DEV_OPEN = true;
const SCOPE_NOTE =
  'MCP Pocket Personal chi tra SO LIEU THI TRUONG da publish trong ' +
  'app (gia, ho so, dong tien, vi mo, dong thuan dang so + link ' +
  'nguon). Khong du doan gia, khong khuyen nghi mua/ban, khong du ' +
  'lieu ca nhan cua user, khong van phan tich cua hang chung khoan. ' +
  'Moi ket qua kem meta: source, as_of, coverage, missing, ' +
  'verification, stale — hay neu cac co nay khi dung so.';
// Ban do chu de -> tool + quy uoc chung (GD2 Bai 6 + G1/G10;
// tong instructions giu <= 2048 ky tu).
const INSTRUCTIONS = SCOPE_NOTE +
  ' Ban do chu de: gia hom nay -> get_quote; nen/dien bien gia -> get_ohlcv; ' +
  'chi so -> get_indices; ho so/co dong lon -> get_company_profile; ai nam ma nao -> find_holder; ' +
  'dong tien khoi ngoai/tu doanh -> get_flow, tong hop theo dich den -> get_flow_summary; ' +
  'PHAN TICH 1 nganh -> analyze_sector; PHAN TICH 1 ma -> analyze_symbol; ' +
  'SO SANH 2 ma/2 nganh -> analyze_compare; TOAN CANH thi truong -> analyze_market; ' +
  'vi mo -> get_macro; bang nganh/P-E nganh -> get_sector; dong thuan -> get_consensus; ' +
  'loc co phieu -> get_screener; ty so -> get_fundamentals; BCTC -> get_statements; ' +
  'su kien -> get_events; tin -> get_news; cong thuc/chi bao -> get_analysis_catalog; ' +
  'tong dong tien theo cua so -> calc_flow_sum (AI khong tu tinh so).' +
  ' Quy uoc: tien = VND (rieng screener close = nghin dong); ngay YYYY-MM-DD; ' +
  'days = so phien nhin lai; tran tham so theo goi. Gap loi thi LAM THEO truong hint. ' +
  'So nam trong meta.missing[] nghia la CHUA CO — noi thieu, khong tu lap. ' +
  'Phan tich = mo ta bang so da do, khong du bao, khong khuyen nghi.';

// Cap goi (muc 2.5 ban thiet ke da Chot): so cang cao quyen cang rong.
const TIER = { free: 0, hocsinh: 1, sinhvien: 2, dilam: 3, nhadautu: 4, admin: 99 };
const TIER_NAME = ['free', 'hocsinh', 'sinhvien', 'dilam', 'nhadautu'];

const PARITY_NOTE =
  'So tu nguon hien hanh (vnstock). Nguon tu chu thay the (VCI IQ) ' +
  'chua qua cong parity vi con 19 o lech dau o 4 muc — co ' +
  'parity_pending, khong phai so sai, nhung chua duoc ket luan tu chu.';
const HOLDER_NOTE =
  'Dao chi muc co dong (DN_HOLDER_INDEX) da active trong registry ' +
  '(cap nhat 22/10/2026 sau khi phu du 1.519/1.519 ma); do phu ' +
  'van di kem moi ket qua trong meta.coverage.';
const SCREENER_RATIO_NOTE =
  'pe_ttm/pb/roe_ttm cua screener tinh tu fundamentals (DN_CHI_SO, ' +
  'parity_pending); cac truong gia/khoi luong/von hoa la du lieu ' +
  'bang gia da kiem chung.';

class ToolError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra || {};
  }
}

/* -------- hint trong loi (GD2 Bai 4 + Phu luc G2) -------- */
// hint = 1 cau hanh dong cu the cho AI; extra.hint cua tung loi
// (sinh tu buoc tinh) thang ban do tinh nay.
const HINTS = {
  unknown_tool: 'Chon 1 tool trong truong available; goi dung ten tool.',
  plan_restricted: 'Tool nay can goi cao hon; dung tool o goi hien tai hoac bao user nang goi. Khong thu lai voi cung tham so.',
  quota_exceeded: 'Quota hom nay da het, reset 00:00 ICT; dung so da co trong phien, khong goi lai lien tuc. Khong thu lai voi cung tham so.',
  invalid_params: 'Kiem tra lai tham so theo inputSchema cua tool (ten, kieu, mien gia tri).',
  symbol_not_found: 'Thu 1 ma trong suggestions, hoac tra danh muc ma bang get_screener.',
  series_not_found: 'Goi tool tong quan tuong ung khong tham so (get_sector / get_macro) de xem danh sach dang co.',
  data_unavailable: 'Du lieu chua publish/dang xay dung; neu tool khac co meta.as_of thi neu ro moc do, khong dien so thay.',
  internal_error: 'Loi phia server; thu lai 1 lan sau it phut, neu van loi thi bao user kem ma loi nay.',
  result_expired: 'Ket qua tam da het han 24h hoac khong ton tai; goi lai tool goc de lay ket qua moi, hoac goi tool tinh voi symbol/days truc tiep.',
  choice_not_open: 'Chon 1 gia tri trong mien duoc mo cua goi hien tai (ghi trong hint). Khong thu lai voi cung tham so.',
};
function hintFor(code, extra) {
  if (extra && extra.hint) return extra.hint;
  return HINTS[code] || null;
}

/* ---------------- thoi gian ICT (UTC+7, khong phu thuoc tzdata) ------------ */
function ictParts(ms) {
  const d = new Date(ms + 7 * 3600 * 1000);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth(), da: d.getUTCDate(),
    dow: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes(),
  };
}
function isoICT(ms) {
  return new Date(ms + 7 * 3600 * 1000).toISOString().replace('Z', '+07:00');
}
function dateICT(ms) { return isoICT(ms).slice(0, 10); }
function nextResetISO() {
  const p = ictParts(Date.now());
  const midnightUTC = Date.UTC(p.y, p.mo, p.da) - 7 * 3600 * 1000;
  return isoICT(midnightUTC + 24 * 3600 * 1000);
}
// Ngay giao dich hoan tat gan nhat (bo qua T7/CN; truoc 15:30 ICT
// thi phien hom nay chua xong -> lay phien truoc).
function lastCompletedTradingDay() {
  let ms = Date.now();
  const p = ictParts(ms);
  if (p.h * 60 + p.mi < 15 * 60 + 30) ms -= 24 * 3600 * 1000;
  for (let i = 0; i < 7; i++) {
    const q = ictParts(ms);
    if (q.dow !== 0 && q.dow !== 6) return dateICT(ms);
    ms -= 24 * 3600 * 1000;
  }
  return dateICT(ms);
}

/* ---------------- phong bi chong bia ---------------- */
function staleFor(kind, updated) {
  if (!updated) return true; // khong ro tuoi = phai khai la khong tuoi
  const t = Date.parse(updated);
  if (isNaN(t)) return true;
  if (kind === 'news') return Date.now() - t > 24 * 3600 * 1000;
  if (kind === 'market') {
    return dateICT(t) < lastCompletedTradingDay()
      && Date.now() - t > 30 * 3600 * 1000;
  }
  return Date.now() - t > 10 * 24 * 3600 * 1000; // daily/static
}

function stripStamps(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return d;
  const o = { ...d };
  delete o.updated;
  delete o._prov;
  return o;
}

function makeMeta(o) {
  const meta = {
    source: {
      dataset: o.dataset,
      publisher_chain: (o.prov && o.prov.source) || o.chain || null,
      api_route: o.route,
    },
    as_of: o.updated || null,
    retrieved_at: new Date().toISOString(),
    coverage: o.coverage || { returned: null, universe: null, note: null },
    missing: o.missing || [],
    verification: o.verification || 'verified',
    stale: staleFor(o.staleKind || 'daily', o.updated),
  };
  if (o.verificationNote) meta.verification_note = o.verificationNote;
  if (o.result) meta.result = o.result;
  if (o.reproduce) meta.reproduce = o.reproduce;
  return meta;
}

function envResult(data, o) {
  return { data, meta: makeMeta(o) };
}

/* -------- handle ket qua + cat hien thi + reproduce (GD2 Bai 1/2 + G3/G4) -------- */
// Handle la CACHE TAM tren R2 (TTL 24h), khong phai nguon su that:
// mat handle khong mat du lieu. Cap handle khi: ket qua bang bi cat
// > 60 dong, hoac tool thuoc nhom analyze_*/calc_*/screen_advanced.
const HANDLE_TOOLS = new Set([
  'analyze_sector', 'analyze_symbol', 'analyze_compare', 'analyze_market',
  'calc_flow_sum', 'get_analysis_catalog',
]);
function newResultId() {
  const d = dateICT(Date.now()).replace(/-/g, '');
  const r = Math.random().toString(36).slice(2, 8);
  return `r_${d}_${r}`;
}
async function readResultHandle(env, id) {
  if (!/^r_[0-9]{8}_[a-z0-9]{6}$/.test(id)) {
    throw new ToolError('result_expired', `Handle '${id}' khong dung dinh dang.`);
  }
  const o = await sGet(env, 'market/mcp_results/' + id + '.json');
  if (!o || !o.created || Date.now() - Date.parse(o.created) > 24 * 3600 * 1000) {
    throw new ToolError('result_expired', `Ket qua tam ${id} da het han 24h hoac khong ton tai.`);
  }
  return o;
}
// Hau xu ly moi ket qua tool (dung chung handleToolsCall + chatToolRun):
// cat hien thi 60 dong cho bang, ghi ban day du vao R2 khi can handle,
// gan meta.result + meta.reproduce. Tra {resultId}.
async function finalizeResult(env, tool, args, r) {
  const envObj = r.env;
  if (!envObj || !envObj.meta) return { resultId: null };
  const data = envObj.data;
  let arr = null, arrKey = null;
  if (data && Array.isArray(data.rows)) { arr = data.rows; arrKey = 'rows'; }
  else if (data && Array.isArray(data.items)) { arr = data.items; arrKey = 'items'; }
  let result = null, resultId = null;
  if (arr) {
    result = { rows_total: arr.length, returned: Math.min(arr.length, 60), truncated: arr.length > 60 };
    if (result.truncated) {
      result.note = `Chi hien 60/${arr.length} dong; dung source_result de tinh tren du du lieu.`;
    }
  }
  const needHandle = (result && result.truncated) || HANDLE_TOOLS.has(tool.name);
  if (needHandle && data) {
    resultId = newResultId();
    try {
      await sPut(env, 'market/mcp_results/' + resultId + '.json', {
        created: new Date().toISOString(), tool: tool.name, args: args || {},
        as_of: envObj.meta.as_of, data,
      });
    } catch (e) { resultId = null; }
    if (resultId) {
      result = result || { rows_total: arr ? arr.length : null, returned: arr ? arr.length : null, truncated: false };
      result.id = resultId;
    }
  }
  if (result && result.truncated && arr) {
    // Chuoi theo thoi gian giu 60 dong GAN NHAT: mang tang dan theo
    // ngay -> lay 60 cuoi; con lai giu 60 dong dau theo thu tu nguon.
    const keyOf = (x) => (x && (x.date || x.trade_date || x.time)) || null;
    const k0 = keyOf(arr[0]), k1 = keyOf(arr[arr.length - 1]);
    const ascending = k0 && k1 && String(k0) < String(k1);
    envObj.data = { ...data, [arrKey]: ascending ? arr.slice(-60) : arr.slice(0, 60) };
  }
  if (result) envObj.meta.result = result;
  envObj.meta.reproduce = {
    rest_route: tool.rest || null,
    params: args || {},
    as_of: envObj.meta.as_of,
    formula_ref: tool.formulaRef || null,
    limits: 'Ket qua phu thuoc goi cua nguoi goi va trang thai snapshot tai as_of; muon co dinh cua so thi truyen days/start ro rang thay vi de mac dinh.',
  };
  return { resultId };
}

/* ---------------- tien ich du lieu ---------------- */
async function listingSymbols(env) {
  const d = await sGet(env, 'market/listing.json');
  if (!d) return [];
  if (Array.isArray(d.symbols)) return d.symbols;
  if (Array.isArray(d.listing)) return d.listing.map((r) => r.s || r.symbol).filter(Boolean);
  if (Array.isArray(d.rows)) return d.rows.map((r) => r.symbol || r.s).filter(Boolean);
  return [];
}

async function symbolOrThrow(env, raw) {
  const sym = String(raw || '').toUpperCase().trim();
  if (!sym) throw new ToolError('invalid_params', 'Thieu tham so symbol.');
  return sym;
}

async function notFound(env, sym) {
  const all = await listingSymbols(env);
  const sug = all.filter((s) => s.startsWith(sym.slice(0, 2)) || s.includes(sym)).slice(0, 5);
  return new ToolError('symbol_not_found', `Khong co du lieu cho ma ${sym}.`, {
    symbol: sym, suggestions: sug,
  });
}

function clampLimit(v, def, max, note, notes) {
  let n = parseInt(v, 10);
  if (isNaN(n) || n <= 0) n = def;
  if (n > max) { notes.push(note || `limit cat ve tran ${max}`); return max; }
  return n;
}

// Chuan hoa ten co dong giong warehouse (NFD -> bo dau -> d/D -> UPPER)
function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/\s+/g, ' ').trim().toUpperCase();
}

/* ---------------- 14 tool GD1 ---------------- */
// Moi tool tra {env: envelope, rows: so dong (cho log)} hoac nem ToolError.

async function tGetQuote(env, a) {
  const sym = await symbolOrThrow(env, a.symbol);
  const q = await getQuoteData(env, sym);
  if (!q) throw await notFound(env, sym);
  const { data_updated, _prov, ...data } = q;
  return {
    rows: 1,
    env: envResult(data, {
      dataset: 'market/quotes.json', route: '/api/stock/quote',
      updated: data_updated, prov: _prov, verification: 'verified',
      staleKind: 'market', coverage: { returned: 1, universe: 1519, note: null },
    }),
  };
}

async function tGetOhlcv(env, a) {
  const sym = await symbolOrThrow(env, a.symbol);
  const notes = [];
  const limit = clampLimit(a.limit, 120, 500, null, notes);
  const d = await sGet(env, 'market/ohlcv/' + sym + '.json');
  if (!d || !Array.isArray(d.rows)) throw await notFound(env, sym);
  const rows = d.rows.slice(-limit);
  return {
    rows: rows.length,
    env: envResult({ symbol: sym, interval: '1D', rows }, {
      dataset: 'market/ohlcv/' + sym + '.json', route: '/api/stock/ohlcv',
      updated: d.updated, prov: d._prov, verification: 'verified',
      staleKind: 'market',
      coverage: { returned: rows.length, universe: d.rows.length, note: notes.join('; ') || null },
    }),
  };
}

async function tGetIndices(env) {
  const idx = await sGet(env, 'market/indices.json');
  if (!idx) throw new ToolError('data_unavailable', 'Chua co snapshot chi so.');
  const regime = await sGet(env, 'market/regime.json');
  const rows = Array.isArray(idx.rows) ? idx.rows : null;
  return {
    rows: rows ? rows.length : 1,
    env: envResult(
      { indices: stripStamps(idx), regime: regime ? stripStamps(regime) : null },
      {
        dataset: 'market/indices.json + market/regime.json',
        route: '/api/stock/indices', updated: idx.updated, prov: idx._prov,
        verification: 'verified', staleKind: 'market',
        coverage: { returned: rows ? rows.length : null, universe: null, note: null },
        missing: regime ? [] : ['regime'],
      }),
  };
}

async function tGetScreener(env, a) {
  const f = a.filters || {};
  const notes = [];
  const limit = clampLimit(a.limit, 50, 200, null, notes);
  const d = await sGet(env, 'market/screener.json');
  if (!d || !Array.isArray(d.rows)) throw new ToolError('data_unavailable', 'Chua co snapshot screener.');
  let rows = d.rows.map((r) => ({ ...r }));
  // Ghep pe_ttm/pb/roe_ttm tu fundamentals — cung cong thuc REST
  // /api/stock/screener dang dung: screener.json close la NGHIN
  // dong (FPT 57,4) nen *1000/eps; quotes.json thi close la DONG
  // — hai nguon hai don vi, dung tron se lech 1000 lan.
  try {
    const fd = await sGet(env, 'market/fundamentals.json');
    const funds = (fd && fd.by_symbol) || {};
    for (const r of rows) {
      const fu = funds[r.symbol];
      if (fu) {
        if (fu.eps > 0 && r.close) r.pe_ttm = Math.round((r.close * 1000) / fu.eps * 100) / 100;
        if (fu.bvps > 0 && r.close) r.pb = Math.round((r.close * 1000) / fu.bvps * 100) / 100;
        if (fu.roe != null) r.roe_ttm = fu.roe;
      }
    }
  } catch (e) { /* fundamentals thieu -> cac truong ty so vao missing */ }
  const ex = String(f.exchange || '').toUpperCase();
  if (ex) rows = rows.filter((r) => String(r.exchange || '').toUpperCase() === ex);
  if (f.sector) {
    const want = normName(f.sector);
    rows = rows.filter((r) => normName(r.sector || r.industry || '').includes(want));
  }
  const num = (v) => (v == null || isNaN(parseFloat(v)) ? null : parseFloat(v));
  const minPe = num(f.min_pe), maxPe = num(f.max_pe), minRoe = num(f.min_roe);
  const minVal = num(f.min_value), minPct = num(f.min_pct), maxPct = num(f.max_pct);
  if (minPe != null) rows = rows.filter((r) => r.pe_ttm != null && r.pe_ttm >= minPe);
  if (maxPe != null) rows = rows.filter((r) => r.pe_ttm != null && r.pe_ttm <= maxPe);
  if (minRoe != null) rows = rows.filter((r) => r.roe_ttm != null && r.roe_ttm >= minRoe);
  if (minVal != null) rows = rows.filter((r) => (r.value_vnd || 0) >= minVal);
  if (minPct != null) rows = rows.filter((r) => r.pct_change != null && r.pct_change >= minPct);
  if (maxPct != null) rows = rows.filter((r) => r.pct_change != null && r.pct_change <= maxPct);
  const sortBy = ['value_vnd', 'pct_change', 'volume', 'close', 'pe_ttm', 'roe_ttm'].includes(a.sort_by)
    ? a.sort_by : 'value_vnd';
  // Xep hang theo truong ty so: loai ma khong co gia tri cua
  // chinh truong sap xep (thieu so thi khong the xep hang — neu
  // giu, chung se dung dau bang gia tri ao -1e18 va lam sai thu
  // hang P/E thap nhat; phat hien o bo cau hoi vang Q14).
  if (sortBy === 'pe_ttm' || sortBy === 'roe_ttm') {
    const before = rows.length;
    rows = rows.filter((r) => r[sortBy] != null && (sortBy !== 'pe_ttm' || r[sortBy] > 0));
    if (rows.length < before) {
      notes.push(`loai ${before - rows.length} ma khong co ${sortBy} khoi bang xep hang`);
    }
  }
  const order = a.order === 'asc' || a.order === 'desc' ? a.order
    : (sortBy === 'pe_ttm' ? 'asc' : 'desc');
  rows.sort((x, y) => {
    const av = x[sortBy] ?? -1e18, bv = y[sortBy] ?? -1e18;
    return order === 'asc' ? av - bv : bv - av;
  });
  const out = rows.slice(0, limit);
  const missing = out.some((r) => r.pe_ttm == null) ? [] : [];
  return {
    rows: out.length,
    env: envResult({ rows: out }, {
      dataset: 'market/screener.json', route: '/api/stock/screener',
      updated: d.updated, prov: d._prov, verification: 'verified',
      verificationNote: SCREENER_RATIO_NOTE, staleKind: 'market',
      coverage: { returned: out.length, universe: d.rows.length, note: notes.join('; ') || null },
      missing,
    }),
  };
}

async function tGetFundamentals(env, a) {
  const sym = await symbolOrThrow(env, a.symbol);
  const f = await getFundamentalsData(env, sym);
  if (!f) throw await notFound(env, sym);
  const data = { ...f };
  // Ghep pe_ttm/pb tu gia hien tai: quotes.json close la DONG
  // (do that: FPT 57400), eps/bvps la dong/co phieu -> chia truc
  // tiep nhu REST /fundamentals. KHAC voi screener.json (close
  // bang nghin dong, phai *1000) — xem ghi chu o tGetScreener.
  try {
    const q = await getQuoteData(env, sym);
    if (q && q.close) {
      if (data.eps > 0) data.pe_ttm = Math.round(q.close / data.eps * 100) / 100;
      if (data.bvps > 0) data.pb = Math.round(q.close / data.bvps * 100) / 100;
    }
  } catch (e) { /* khong co gia -> pe/pb vao missing */ }
  if (data.roe != null) data.roe_ttm = data.roe;
  if (data.roa != null) data.roa_ttm = data.roa;
  if (data.debt_to_equity != null) data.de_ratio = data.debt_to_equity;
  const d = await sGet(env, 'market/fundamentals.json');
  const missing = [];
  if (data.pe_ttm == null) missing.push('pe_ttm');
  if (data.pb == null) missing.push('pb');
  return {
    rows: 1,
    env: envResult(data, {
      dataset: 'market/fundamentals.json', route: '/api/stock/fundamentals',
      updated: d ? d.updated : null, prov: d ? d._prov : null,
      verification: 'parity_pending', verificationNote: PARITY_NOTE,
      staleKind: 'daily', missing,
      coverage: { returned: 1, universe: 1519, note: null },
    }),
  };
}

async function tGetStatements(env, a) {
  const sym = await symbolOrThrow(env, a.symbol);
  const notes = [];
  const periods = clampLimit(a.periods, 8, 20, null, notes);
  const d = await getStatementsData(env, sym);
  if (!d || !d.types) throw await notFound(env, sym);
  const allPeriods = Array.isArray(d.periods) ? d.periods : [];
  const keep = allPeriods.slice(0, periods); // periods DESC: moi nhat truoc
  if (periods > allPeriods.length) {
    notes.push(`chi co ${allPeriods.length} ky da publish (xin ${periods})`);
  }
  const types = {};
  for (const k of Object.keys(d.types)) {
    types[k] = d.types[k].map((row) => {
      const v = {};
      for (const p of keep) if (row.v && row.v[p] != null) v[p] = row.v[p];
      return { id: row.id, name: row.name, v };
    });
  }
  return {
    rows: keep.length,
    env: envResult({ symbol: sym, periods: keep, types }, {
      dataset: 'market/statements/' + sym + '.json', route: '/api/stock/statements',
      updated: d.updated, prov: d._prov,
      verification: 'parity_pending', verificationNote: PARITY_NOTE,
      staleKind: 'daily',
      coverage: { returned: keep.length, universe: allPeriods.length, note: notes.join('; ') || null },
    }),
  };
}

async function tGetCompanyProfile(env, a) {
  const sym = await symbolOrThrow(env, a.symbol);
  const p = await getCompanyProfile(env, sym);
  if (!p || (!p.profile && !p.shareholders && !p.holders && Object.keys(p).length <= 1)) {
    throw await notFound(env, sym);
  }
  return {
    rows: 1,
    env: envResult(stripStamps(p), {
      dataset: 'market/company_profile/' + sym + '.json',
      route: '/api/stock/company/profile',
      updated: p.updated, prov: p._prov, verification: 'verified',
      staleKind: 'daily', coverage: { returned: 1, universe: 1519, note: null },
    }),
  };
}

async function tFindHolder(env, a) {
  const name = String(a.name || '').trim();
  if (!name) throw new ToolError('invalid_params', 'Thieu tham so name.');
  const notes = [];
  const limit = clampLimit(a.limit, 50, 200, null, notes);
  const idx = await sGet(env, 'market/holders_index.json');
  if (!idx || !Array.isArray(idx.rows)) throw new ToolError('data_unavailable', 'Chua co dao chi muc co dong.');
  const q = normName(name);
  const ql = name.toLowerCase();
  let matches = idx.rows.filter((r) => (r.q && r.q.includes(q)) || (r.name && r.name.toLowerCase().includes(ql)));
  matches = matches.slice(0, limit);
  // Ghep chi tiet nam giu tu shard (nhom theo 2 ky tu dau cua id)
  const byShard = {};
  for (const m of matches) {
    const sh = String(m.id || '').slice(0, 2);
    if (sh) (byShard[sh] = byShard[sh] || []).push(m);
  }
  for (const sh of Object.keys(byShard)) {
    const shard = await sGet(env, 'market/holders/' + sh + '.json');
    if (!shard) continue;
    for (const m of byShard[sh]) {
      const det = shard[m.id];
      if (det && Array.isArray(det.holds)) m.holdings = det.holds;
    }
  }
  const metaCov = idx.meta || {};
  return {
    rows: matches.length,
    env: envResult({ holders: matches }, {
      dataset: 'market/holders_index.json + market/holders/<shard>.json',
      route: '/api/stock/holders', updated: idx.updated, prov: idx._prov,
      verification: 'verified', verificationNote: HOLDER_NOTE,
      staleKind: 'daily',
      coverage: {
        returned: matches.length,
        universe: metaCov.holders != null ? metaCov.holders : idx.rows.length,
        note: metaCov.covered != null
          ? `chi muc phu ${metaCov.covered}/${metaCov.total} ma niem yet`
          : (notes.join('; ') || null),
      },
    }),
  };
}

async function tGetSector(env, a) {
  const code = String(a.code || '').trim();
  if (!code) {
    const d = await sGet(env, 'market/sectors.json');
    if (!d) throw new ToolError('data_unavailable', 'Chua co snapshot nganh.');
    const rows = Array.isArray(d.rows) ? d.rows : [];
    return {
      rows: rows.length,
      env: envResult({ rows }, {
        dataset: 'market/sectors.json', route: '/api/stock/sectors',
        updated: d.updated, prov: d._prov, verification: 'verified',
        staleKind: 'daily',
        coverage: { returned: rows.length, universe: 19, note: null },
      }),
    };
  }
  if (!/^[0-9]{4}$/.test(code)) {
    throw new ToolError('invalid_params', 'code nganh phai la 4 chu so ICB (vd 8350).');
  }
  const d = await sGet(env, 'market/sectors/' + code + '.json');
  if (!d || !d.code) {
    const ov = await sGet(env, 'market/sectors.json');
    const codes = ov && Array.isArray(ov.rows) ? ov.rows.map((r) => `${r.code} ${r.name}`) : [];
    throw new ToolError('series_not_found', `Khong co nganh ${code}.`, { available: codes });
  }
  const series = Array.isArray(d.series) ? d.series.slice(-8) : [];
  const data = { ...stripStamps(d), series };
  return {
    rows: 1,
    env: envResult(data, {
      dataset: 'market/sectors/' + code + '.json', route: '/api/stock/sectors/detail',
      updated: d.updated, prov: d._prov, verification: 'verified',
      staleKind: 'daily',
      coverage: {
        returned: 1, universe: 19,
        note: `pe tinh tren ${d.n_pe != null ? d.n_pe : '?'}/${d.n_members} ma thanh vien co EPS duong; series cat 8 ky gan nhat trong ${Array.isArray(d.series) ? d.series.length : 0} ky`,
      },
    }),
  };
}

async function tGetFlow(env, a) {
  const kind = String(a.kind || '').toLowerCase();
  if (kind !== 'foreign' && kind !== 'proprietary') {
    throw new ToolError('invalid_params', "kind phai la 'foreign' hoac 'proprietary'.");
  }
  const notes = [];
  const days = clampLimit(a.days, 90, 500, null, notes);
  const base = kind === 'foreign' ? 'foreign_flow' : 'proprietary_flow';
  const chain = kind === 'foreign'
    ? 'FINFO -> VCI Trading (lich su backfill CafeF)'
    : 'FINFO -> Vietstock -> PDF HOSE doi chieu';
  if (a.symbol) {
    const sym = await symbolOrThrow(env, a.symbol);
    const d = await sGet(env, `market/${base}_history/` + sym + '.json');
    if (!d) throw await notFound(env, sym);
    const all = Array.isArray(d.rows) ? d.rows : [];
    const rows = all.slice(-days).reverse(); // moi nhat truoc nhu REST
    return {
      rows: rows.length,
      env: envResult({ symbol: sym, kind, rows }, {
        dataset: `market/${base}_history/` + sym + '.json',
        route: kind === 'foreign' ? '/api/stock/foreign-flow/history' : '/api/stock/proprietary-flow/history',
        updated: d.updated, prov: d._prov, verification: 'verified',
        staleKind: 'market', chain,
        coverage: { returned: rows.length, universe: all.length, note: notes.join('; ') || null },
      }),
    };
  }
  const d = await sGet(env, `market/${base}.json`);
  if (!d) throw new ToolError('data_unavailable', 'Chua co snapshot dong tien.');
  const n = Array.isArray(d.rows) ? d.rows.length
    : (d.by_symbol ? Object.keys(d.by_symbol).length : null);
  return {
    rows: n,
    env: envResult(stripStamps(d), {
      dataset: `market/${base}.json`,
      route: kind === 'foreign' ? '/api/stock/foreign-flow' : '/api/stock/proprietary-flow',
      updated: d.updated, prov: d._prov, verification: 'verified',
      staleKind: 'market', chain,
      coverage: { returned: n, universe: 1519, note: null },
    }),
  };
}

/* ---------------- tool 15: tong hop dong tien theo dich den ---------------- */
// Chuan hoa rows cua snapshot dong tien: rows[] hoac by_symbol{}.
function flowRowsOf(d) {
  if (!d) return [];
  if (Array.isArray(d.rows)) return d.rows;
  if (d.by_symbol && typeof d.by_symbol === 'object') {
    return Object.keys(d.by_symbol).map((k) => ({ symbol: k, ...(d.by_symbol[k] || {}) }));
  }
  return [];
}
function flowNetOf(r) {
  const ks = ['net_value_vnd', 'net_value_est', 'net_value', 'net'];
  for (const k of ks) {
    if (r[k] != null && isFinite(parseFloat(r[k]))) return parseFloat(r[k]);
  }
  // Snapshot khoi ngoai khong co truong net va khong hau to _vnd:
  // net = buy_value - sell_value (dung hinh dang tai market/foreign_flow.json).
  const b = r.buy_value_vnd != null ? parseFloat(r.buy_value_vnd)
    : (r.buy_value != null ? parseFloat(r.buy_value) : null);
  const s = r.sell_value_vnd != null ? parseFloat(r.sell_value_vnd)
    : (r.sell_value != null ? parseFloat(r.sell_value) : null);
  if (b != null && s != null && isFinite(b) && isFinite(s)) return b - s;
  return null;
}

async function tGetFlowSummary(env, a) {
  const kind = String(a.kind || 'both').toLowerCase();
  if (!['foreign', 'proprietary', 'both'].includes(kind)) {
    throw new ToolError('invalid_params', "kind phai la 'foreign', 'proprietary' hoac 'both'.");
  }
  const groupBy = String(a.group_by || 'sector').toLowerCase();
  if (!['sector', 'exchange', 'market'].includes(groupBy)) {
    throw new ToolError('invalid_params', "group_by phai la 'sector', 'exchange' hoac 'market'.");
  }
  const sectorCode = String(a.sector_code || '').trim();
  if (sectorCode && !/^[0-9]{4}$/.test(sectorCode)) {
    throw new ToolError('invalid_params', 'sector_code phai la ma ICB 4 chu so (vd 8300).');
  }
  const useF = kind !== 'proprietary';
  const useP = kind !== 'foreign';
  const snaps = {};
  if (useF) {
    snaps.foreign = await sGet(env, 'market/foreign_flow.json');
    if (!snaps.foreign) throw new ToolError('data_unavailable', 'Chua co snapshot dong tien khoi ngoai.');
  }
  if (useP) {
    snaps.proprietary = await sGet(env, 'market/proprietary_flow.json');
    if (!snaps.proprietary) throw new ToolError('data_unavailable', 'Chua co snapshot dong tien tu doanh.');
  }
  const scr = await sGet(env, 'market/screener.json');
  if (!scr || !Array.isArray(scr.rows)) throw new ToolError('data_unavailable', 'Chua co snapshot screener.');
  const scrMap = {};
  for (const r of scr.rows) {
    if (r && r.symbol) scrMap[String(r.symbol).toUpperCase()] = r;
  }
  // Anh xa ma -> nganh: screener KHONG co truong nganh; thanh vien nganh
  // nam o market/sectors/<code>.json (truong members). Chi tai khi can.
  const effGroupBy = sectorCode ? 'sector' : groupBy;
  let sectorMap = null; // sym -> {code, name}
  let sectorMembers = null; // code -> [sym]
  if (effGroupBy === 'sector') {
    const ovS = await sGet(env, 'market/sectors.json');
    if (!ovS || !Array.isArray(ovS.rows)) {
      throw new ToolError('data_unavailable', 'Chua co snapshot nganh (market/sectors.json).');
    }
    sectorMap = {};
    sectorMembers = {};
    for (const row of ovS.rows) {
      const code = String(row.code || '');
      if (!/^[0-9]{4}$/.test(code)) continue;
      const det = await sGet(env, 'market/sectors/' + code + '.json');
      const mem = det && Array.isArray(det.members) ? det.members : [];
      sectorMembers[code] = [];
      for (const m of mem) {
        const s = String((m && m.symbol) || '').toUpperCase();
        if (!s) continue;
        sectorMembers[code].push(s);
        if (!sectorMap[s]) sectorMap[s] = { code, name: row.name || (det && det.name) || code };
      }
    }
  }
  // Gop net theo ma tu cac snapshot da chon (phien gan nhat)
  const perSym = {}; // sym -> {f: net khoi ngoai|null, p: net tu doanh|null}
  const addRows = (rows, slot) => {
    for (const r of rows) {
      const sym = String((r && r.symbol) || '').toUpperCase();
      if (!sym) continue;
      const net = flowNetOf(r);
      if (net == null) continue;
      if (!perSym[sym]) perSym[sym] = { f: null, p: null };
      perSym[sym][slot] = (perSym[sym][slot] || 0) + net;
    }
  };
  if (useF) addRows(flowRowsOf(snaps.foreign), 'f');
  if (useP) addRows(flowRowsOf(snaps.proprietary), 'p');
  const syms = Object.keys(perSym);
  if (!syms.length) throw new ToolError('data_unavailable', 'Snapshot dong tien khong co ma nao co so net.');

  // Loc 1 nganh: ma ICB -> ten nganh (sectors.json, fallback snapshot
  // chi tiet nhu tGetSector); screener gan ma theo TEN nganh nen phai
  // doi chieu bang ten da chuan hoa.
  let sectorName = null;
  if (sectorCode) {
    const ov = await sGet(env, 'market/sectors.json');
    const row = ov && Array.isArray(ov.rows)
      ? ov.rows.find((r) => String(r.code) === sectorCode) : null;
    if (row) sectorName = row.name;
    if (!sectorName) {
      const det = await sGet(env, 'market/sectors/' + sectorCode + '.json');
      if (det && det.name) sectorName = det.name;
    }
    if (!sectorName) {
      const codes = ov && Array.isArray(ov.rows) ? ov.rows.map((r) => `${r.code} ${r.name}`) : [];
      throw new ToolError('series_not_found', `Khong co nganh ${sectorCode}.`, { available: codes });
    }
  }

  const NONE_KEY = '__none';
  const NONE_NAME = effGroupBy === 'exchange' ? 'Chua phan san' : 'Chua phan nganh';
  const newGroup = (key, name) => ({
    key, name, net_foreign: null, net_proprietary: null, net_total: 0,
    value_vnd: 0, n_symbols: 0,
  });
  const accNet = (g, slot, net) => {
    if (slot === 'f') g.net_foreign = (g.net_foreign || 0) + net;
    else g.net_proprietary = (g.net_proprietary || 0) + net;
  };
  const sectorOfSym = (sym) => (sectorMap ? sectorMap[sym] || null : null);
  const valOfSym = (sym) => {
    const sr = scrMap[sym];
    const v = sr ? parseFloat(sr.value_vnd) : NaN;
    return isFinite(v) ? v : 0;
  };
  const groups = {};
  const flowVal = {};
  let nNone = 0;
  const total = newGroup('ALL', 'Toan thi truong');
  for (const sym of syms) {
    const rec = perSym[sym];
    const netT = (rec.f || 0) + (rec.p || 0);
    let key, name;
    if (effGroupBy === 'market') { key = 'ALL'; name = 'Toan thi truong'; }
    else if (effGroupBy === 'exchange') {
      const sr = scrMap[sym];
      const ex = sr && sr.exchange ? String(sr.exchange).toUpperCase() : null;
      key = ex || NONE_KEY; name = ex || NONE_NAME;
    } else {
      const sec = sectorOfSym(sym);
      key = sec ? sec.code : NONE_KEY; name = sec ? sec.name : NONE_NAME;
    }
    if (key === NONE_KEY) nNone++;
    if (!groups[key]) groups[key] = newGroup(key, name);
    const g = groups[key];
    if (rec.f != null) { accNet(g, 'f', rec.f); accNet(total, 'f', rec.f); }
    if (rec.p != null) { accNet(g, 'p', rec.p); accNet(total, 'p', rec.p); }
    g.net_total += netT; total.net_total += netT;
    flowVal[key] = (flowVal[key] || 0) + valOfSym(sym);
    g.n_symbols++; total.n_symbols++;
  }
  const groupList = Object.values(groups).sort((x, y) => y.net_total - x.net_total);
  // value_vnd cua nhom = tong GTGD cua TOAN BO thanh vien nhom (tu screener),
  // khong chi cac ma co dong tien; nhom __none giu tong cua cac ma co dong tien.
  const scrVal = (r) => { const v = parseFloat(r && r.value_vnd); return isFinite(v) ? v : 0; };
  if (effGroupBy === 'market') {
    total.value_vnd = scr.rows.reduce((acc, r) => acc + scrVal(r), 0);
    if (groups.ALL) groups.ALL.value_vnd = total.value_vnd;
  } else if (effGroupBy === 'exchange') {
    const exVal = {};
    for (const r of scr.rows) {
      const ex = r.exchange ? String(r.exchange).toUpperCase() : NONE_KEY;
      exVal[ex] = (exVal[ex] || 0) + scrVal(r);
    }
    for (const g of groupList) g.value_vnd = exVal[g.key] != null ? exVal[g.key] : (flowVal[g.key] || 0);
    total.value_vnd = groupList.reduce((acc, g) => acc + g.value_vnd, 0);
  } else {
    for (const g of groupList) {
      if (g.key !== NONE_KEY && sectorMembers[g.key]) {
        g.value_vnd = sectorMembers[g.key].reduce((acc, s) => acc + valOfSym(s), 0);
      } else g.value_vnd = flowVal[g.key] || 0;
    }
    total.value_vnd = groupList.reduce((acc, g) => acc + g.value_vnd, 0);
  }

  const parts = [];
  if (useF) parts.push('market/foreign_flow.json');
  if (useP) parts.push('market/proprietary_flow.json');
  parts.push('market/screener.json');
  if (effGroupBy === 'sector') parts.push('market/sectors.json + market/sectors/<code>.json (thanh vien nganh)');
  let updated = null, updatedMs = -Infinity;
  for (const d of [snaps.foreign, snaps.proprietary, scr]) {
    if (d && d.updated) {
      const t = Date.parse(d.updated);
      if (!isNaN(t) && t > updatedMs) { updatedMs = t; updated = d.updated; }
      else if (isNaN(t) && !updated) updated = d.updated;
    }
  }
  const prov = (snaps.foreign && snaps.foreign._prov)
    || (snaps.proprietary && snaps.proprietary._prov) || scr._prov || null;
  const notes = [];
  if (nNone) notes.push(`${nNone} ma chua noi duoc ${effGroupBy === 'exchange' ? 'san' : 'nganh'} (gom nhom ${NONE_NAME})`);
  const metaBase = {
    dataset: parts.join(' + '), route: '/api/stock/flow-summary',
    updated, prov, verification: 'verified', staleKind: 'market',
    chain: 'FINFO -> VCI Trading / Vietstock (snapshot dong tien phien gan nhat)',
  };

  if (sectorCode) {
    const g = groupList.find((x) => x.key === sectorCode);
    if (!g) {
      throw new ToolError('series_not_found',
        `Nganh ${sectorCode} (${sectorName}) khong co ma nao co dong tien phien gan nhat.`);
    }
    const topSymbols = syms
      .filter((sym) => { const sc2 = sectorOfSym(sym); return sc2 && sc2.code === sectorCode; })
      .map((sym) => ({
        symbol: sym,
        net_foreign: perSym[sym].f,
        net_proprietary: perSym[sym].p,
        net_total: (perSym[sym].f || 0) + (perSym[sym].p || 0),
      }))
      .sort((x, y) => Math.abs(y.net_total) - Math.abs(x.net_total))
      .slice(0, 15);
    const data = {
      kind, group_by: 'sector', sector_code: sectorCode,
      sector: {
        code: sectorCode, name: sectorName,
        net_foreign: g.net_foreign, net_proprietary: g.net_proprietary,
        net_total: g.net_total, value_vnd: g.value_vnd, n_symbols: g.n_symbols,
      },
      top_symbols: topSymbols,
      total,
    };
    return {
      rows: topSymbols.length,
      env: envResult(data, {
        ...metaBase,
        coverage: { returned: 1, universe: syms.length, note: notes.join('; ') || null },
      }),
    };
  }

  const data = { kind, group_by: effGroupBy, sector_code: null, groups: groupList, total };
  return {
    rows: groupList.length,
    env: envResult(data, {
      ...metaBase,
      coverage: { returned: groupList.length, universe: syms.length, note: notes.join('; ') || null },
    }),
  };
}

const MACRO_ALIAS = { vm_omo: 'omo', omo: 'omo' };
async function tGetMacro(env, a) {
  const sid = String(a.series || '').toLowerCase().trim();
  if (!sid) {
    const d = await sGet(env, 'market/macro/overview.json');
    if (!d) throw new ToolError('data_unavailable', 'Chua co snapshot vi mo.');
    const n = d.series ? Object.keys(d.series).length : null;
    return {
      rows: n,
      env: envResult(stripStamps(d), {
        dataset: 'market/macro/overview.json', route: '/api/stock/macro',
        updated: d.updated, prov: d._prov, verification: 'verified',
        staleKind: 'daily',
        coverage: { returned: n, universe: n, note: null },
      }),
    };
  }
  const key = MACRO_ALIAS[sid] || sid;
  const d = await sGet(env, 'market/macro/history/' + key + '.json');
  if (!d || !Array.isArray(d.rows)) {
    const ov = await sGet(env, 'market/macro/overview.json');
    const avail = ov && ov.series ? Object.keys(ov.series) : [];
    throw new ToolError('series_not_found', `Khong co series vi mo '${sid}'.`, { available: avail });
  }
  const rows = d.rows.slice(-365);
  return {
    rows: rows.length,
    env: envResult({ series: key, rows }, {
      dataset: 'market/macro/history/' + key + '.json', route: '/api/stock/macro/history',
      updated: d.updated, prov: d._prov, verification: 'verified',
      staleKind: 'daily',
      coverage: { returned: rows.length, universe: d.rows.length, note: null },
    }),
  };
}

async function tGetConsensus(env, a) {
  if (!a.symbol) {
    const d = await sGet(env, 'market/consensus.json');
    if (!d) throw new ToolError('data_unavailable', 'Chua co snapshot dong thuan.');
    const rows = Array.isArray(d.rows) ? d.rows : [];
    return {
      rows: rows.length,
      env: envResult({ rows, window_since: d.window_since || null }, {
        dataset: 'market/consensus.json', route: '/api/stock/consensus',
        updated: d.updated, prov: d._prov, verification: 'verified',
        staleKind: 'daily',
        coverage: { returned: rows.length, universe: 1519, note: 'chi ma co bao cao verified trong 12 thang' },
      }),
    };
  }
  const sym = await symbolOrThrow(env, a.symbol);
  const d = await sGet(env, 'market/consensus/' + sym + '.json');
  if (!d || !Array.isArray(d.firms) || !d.firms.length) {
    return {
      rows: 0,
      env: envResult({ symbol: sym, firms: [] }, {
        dataset: 'market/consensus/' + sym + '.json', route: '/api/stock/consensus/detail',
        updated: d ? d.updated : null, prov: d ? d._prov : null,
        verification: 'verified', staleKind: 'daily',
        coverage: { returned: 0, universe: 1519, note: null },
        missing: ['consensus:' + sym],
      }),
    };
  }
  return {
    rows: d.firms.length,
    env: envResult(stripStamps(d), {
      dataset: 'market/consensus/' + sym + '.json', route: '/api/stock/consensus/detail',
      updated: d.updated, prov: d._prov, verification: 'verified',
      staleKind: 'daily',
      coverage: { returned: d.firms.length, universe: null, note: 'chi tinh ban verified moi nhat cua tung hang' },
    }),
  };
}

async function tGetEvents(env, a) {
  const sym = await symbolOrThrow(env, a.symbol);
  const daysAhead = clampLimit(a.days_ahead, 90, 365, null, []);
  const d = await sGet(env, 'market/events/' + sym + '.json');
  const items = d && Array.isArray(d.items) ? d.items
    : (Array.isArray(d) ? d : []);
  if (!d) throw await notFound(env, sym);
  const today = dateICT(Date.now());
  const until = dateICT(Date.now() + daysAhead * 24 * 3600 * 1000);
  const dated = items.filter((it) => it && typeof it.date === 'string');
  let out = items;
  if (dated.length) {
    out = dated.filter((it) => it.date.slice(0, 10) >= today && it.date.slice(0, 10) <= until);
  }
  return {
    rows: out.length,
    env: envResult({ symbol: sym, items: out }, {
      dataset: 'market/events/' + sym + '.json', route: '/api/stock/events',
      updated: d.updated, prov: d._prov, verification: 'verified',
      staleKind: 'daily',
      coverage: {
        returned: out.length, universe: items.length,
        note: dated.length ? `loc su kien tu ${today} toi ${until}` : 'su kien khong co ngay chuan hoa — tra toan bo',
      },
    }),
  };
}

async function tGetNews(env, a) {
  const notes = [];
  const limit = clampLimit(a.limit, 20, 50, null, notes);
  if (a.symbol) {
    const sym = await symbolOrThrow(env, a.symbol);
    const d = await getNewsData(env, sym, limit);
    const items = d.items || [];
    return {
      rows: items.length,
      env: envResult({ symbol: sym, items }, {
        dataset: 'market/news/' + sym + '.json', route: '/api/stock/news',
        updated: d.updated || null, prov: d._prov || null,
        verification: 'verified', staleKind: 'news',
        coverage: { returned: items.length, universe: null, note: notes.join('; ') || null },
        missing: items.length ? [] : ['news:' + sym],
      }),
    };
  }
  const d = await sGet(env, 'market/market_news.json');
  if (!d) throw new ToolError('data_unavailable', 'Chua co snapshot tin thi truong.');
  const all = Array.isArray(d.items) ? d.items : (Array.isArray(d.rows) ? d.rows : []);
  const items = all.slice(0, limit);
  let latest = null;
  for (const it of all) {
    const t = it && (it.publish_time || it.time || it.date || it.published_at);
    if (t && (!latest || String(t) > String(latest))) latest = t;
  }
  return {
    rows: items.length,
    env: envResult({ items, latest_published_at: latest }, {
      dataset: 'market/market_news.json', route: '/api/stock/news/market',
      updated: d.updated, prov: d._prov, verification: 'verified',
      staleKind: 'news',
      coverage: { returned: items.length, universe: all.length, note: notes.join('; ') || null },
    }),
  };
}

/* ---------------- GD2: helpers phan tich ---------------- */
const _r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const _r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10000) / 10000);
function _median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function _stdev(arr) {
  if (arr.length < 2) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (arr.length - 1));
}
function _smaAt(closes, i, n) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += closes[k];
  return s / n;
}
function _emaSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < n) return out;
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += closes[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < closes.length; i++) { e = closes[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function _rsiWilder(closes, n) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function _macd(closes) {
  if (closes.length < 35) return null;
  const e12 = _emaSeries(closes, 12), e26 = _emaSeries(closes, 26);
  const line = closes.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
  const vals = line.filter((v) => v != null);
  if (vals.length < 9) return null;
  const sig = _emaSeries(vals, 9);
  const li = vals.length - 1;
  return { macd: vals[li], signal: sig[li], hist: sig[li] != null ? vals[li] - sig[li] : null };
}
function _atr(rows, n) {
  if (rows.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const h = rows[i].high, l = rows[i].low, pc = rows[i - 1].close;
    if (h == null || l == null || pc == null) return null;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = 0;
  for (let i = 0; i < n; i++) a += trs[i];
  a /= n;
  for (let i = n; i < trs.length; i++) a = (a * (n - 1) + trs[i]) / n;
  return a;
}
// Tai vu tru nganh 1 lan: names/members/map (theo members cua
// market/sectors/<code>.json — cung cach tGetFlowSummary dung).
async function loadSectorUniverse(env) {
  const ov = await sGet(env, 'market/sectors.json');
  if (!ov || !Array.isArray(ov.rows)) return null;
  const names = {}, members = {}, map = {};
  for (const row of ov.rows) {
    const code = String(row.code || '');
    if (!/^[0-9]{4}$/.test(code)) continue;
    names[code] = row.name || code;
    const det = await sGet(env, 'market/sectors/' + code + '.json');
    const mem = det && Array.isArray(det.members) ? det.members : [];
    members[code] = [];
    for (const m of mem) {
      const s = String((m && m.symbol) || '').toUpperCase();
      if (!s) continue;
      members[code].push(s);
      if (!map[s]) map[s] = { code, name: names[code] };
    }
  }
  return { names, members, map, overview: ov };
}
// Lich su dong tien 1 ma: rows tang dan theo trade_date (dang luu R2).
async function flowHistRows(env, kind, sym) {
  const base = kind === 'foreign' ? 'foreign_flow' : 'proprietary_flow';
  const d = await sGet(env, `market/${base}_history/` + sym + '.json');
  if (!d || !Array.isArray(d.rows)) return null;
  return { rows: d.rows, updated: d.updated, prov: d._prov };
}
// Tong rong cua so + chuoi phien lien tiep cung dau (tu phien moi nhat).
function flowWindow(rows, days) {
  const nets = rows.map((r) => flowNetOf(r));
  const win = nets.slice(-days);
  const sum = win.reduce((a, b) => a + (b || 0), 0);
  let streak = { dir: 'flat', sessions: 0 };
  for (let i = nets.length - 1; i >= 0; i--) {
    const v = nets[i];
    if (v == null || v === 0) break;
    const dir = v > 0 ? 'buy' : 'sell';
    if (!streak.sessions) streak = { dir, sessions: 1 };
    else if (streak.dir === dir) streak.sessions++;
    else break;
  }
  return { sum, streak, n: win.length };
}
async function flowSumsFor(env, sym) {
  const out = {};
  for (const kind of ['foreign', 'proprietary']) {
    const h = await flowHistRows(env, kind, sym);
    if (!h || !h.rows.length) { out[kind] = null; continue; }
    out[kind] = {
      d5: Math.round(flowWindow(h.rows, 5).sum),
      d20: Math.round(flowWindow(h.rows, 20).sum),
      d60: Math.round(flowWindow(h.rows, 60).sum),
      streak: flowWindow(h.rows, 1).streak,
      updated: h.updated,
    };
  }
  return out;
}
const SECTOR_INDEX_CODE = {
  '8300': 'VNFIN', '8600': 'VNREAL', '9500': 'VNIT',
  '2700': 'VNIND', '1700': 'VNMAT', '2300': 'VNCONS',
};

/* ---------------- GD2: analyze_sector (Phu luc G5 + H1.1) ---------------- */
async function tAnalyzeSector(env, a) {
  const code = String(a.code || '').trim();
  if (!/^[0-9]{4}$/.test(code)) {
    throw new ToolError('invalid_params', 'code phai la ma ICB 4 chu so (vd 8600).',
      { hint: 'Tra ma ICB o get_sector (khong tham so) hoac get_analysis_catalog.' });
  }
  const notes = [];
  const days = clampLimit(a.days, 20, 60, null, notes);
  const topN = Math.min(Math.max(parseInt(a.top_n, 10) || 15, 1), 30);
  const uni = await loadSectorUniverse(env);
  if (!uni) throw new ToolError('data_unavailable', 'Chua co snapshot nganh.');
  if (!uni.names[code]) {
    throw new ToolError('series_not_found', `Khong co nganh ${code}.`, {
      available: Object.keys(uni.names).map((c) => `${c} ${uni.names[c]}`),
    });
  }
  const members = uni.members[code] || [];
  const det = await sGet(env, 'market/sectors/' + code + '.json');
  const fSnap = await sGet(env, 'market/foreign_flow.json');
  const pSnap = await sGet(env, 'market/proprietary_flow.json');
  if (!fSnap && !pSnap) throw new ToolError('data_unavailable', 'Chua co snapshot dong tien.');
  const scr = await sGet(env, 'market/screener.json');
  if (!scr || !Array.isArray(scr.rows)) throw new ToolError('data_unavailable', 'Chua co snapshot screener.');
  const scrMap = {};
  for (const r of scr.rows) if (r && r.symbol) scrMap[String(r.symbol).toUpperCase()] = r;
  // Dong tien phien gan nhat theo ma trong nganh
  const perSym = {};
  const addRows = (rows, slot) => {
    for (const r of flowRowsOf(rows)) {
      const sym = String((r && r.symbol) || '').toUpperCase();
      if (!sym || !members.includes(sym)) continue;
      const net = flowNetOf(r);
      if (net == null) continue;
      if (!perSym[sym]) perSym[sym] = { f: null, p: null };
      perSym[sym][slot] = (perSym[sym][slot] || 0) + net;
    }
  };
  if (fSnap) addRows(fSnap, 'f');
  if (pSnap) addRows(pSnap, 'p');
  const contrib = Object.keys(perSym).map((sym) => {
    const rec = perSym[sym];
    return {
      symbol: sym, foreign_net: rec.f, proprietary_net: rec.p,
      combined_net: (rec.f || 0) + (rec.p || 0),
    };
  }).sort((x, y) => Math.abs(y.combined_net) - Math.abs(x.combined_net));
  const fTot = contrib.reduce((s, c) => s + (c.foreign_net || 0), 0);
  const pTot = contrib.reduce((s, c) => s + (c.proprietary_net || 0), 0);
  const grossAbs = contrib.reduce((s, c) => s + Math.abs(c.combined_net), 0);
  const top3Abs = contrib.slice(0, 3).reduce((s, c) => s + Math.abs(c.combined_net), 0);
  const concTop3 = grossAbs > 0 ? _r4(top3Abs / grossAbs) : null;
  let hhi = null;
  if (grossAbs > 0) {
    hhi = contrib.reduce((s, c) => s + Math.pow(Math.abs(c.combined_net) / grossAbs, 2), 0);
  }
  const byKind = (key) => contrib.filter((c) => c[key] != null)
    .sort((x, y) => Math.abs(y[key]) - Math.abs(x[key])).slice(0, 5)
    .map((c) => ({ symbol: c.symbol, value: Math.round(c[key]) }));
  const leaders = {
    by_foreign: byKind('foreign_net'),
    by_proprietary: byKind('proprietary_net'),
    by_turnover: members.map((s) => ({ symbol: s, value: parseFloat(scrMap[s] && scrMap[s].value_vnd) || 0 }))
      .sort((x, y) => y.value - x.value).slice(0, 5),
    by_pct_gain: members.map((s) => ({ symbol: s, value: scrMap[s] ? parseFloat(scrMap[s].pct_change) : null }))
      .filter((x) => x.value != null && isFinite(x.value))
      .sort((x, y) => y.value - x.value).slice(0, 5),
  };
  const flowDate = (fSnap && fSnap.date) || (pSnap && pSnap.date) || null;
  const flowLatest = {
    date: flowDate,
    foreign_net_total: Math.round(fTot), proprietary_net_total: Math.round(pTot),
    concentration_top3: concTop3,
    concentration: { cr3: concTop3, hhi: hhi != null ? _r4(hhi) : null, n_eff: hhi ? _r2(1 / hhi) : null },
    top_contributors: contrib.slice(0, topN).map((c) => ({
      symbol: c.symbol,
      foreign_net: c.foreign_net != null ? Math.round(c.foreign_net) : null,
      proprietary_net: c.proprietary_net != null ? Math.round(c.proprietary_net) : null,
      combined_net: Math.round(c.combined_net),
    })),
    leaders,
  };
  // Do rong phien tu screener (mau so = thanh vien co du kien gia)
  let adv = 0, dec = 0, unc = 0, turn = 0, mktTurn = 0;
  for (const r of scr.rows) mktTurn += parseFloat(r.value_vnd) || 0;
  for (const s of members) {
    const r = scrMap[s];
    if (!r) continue;
    turn += parseFloat(r.value_vnd) || 0;
    const pc = parseFloat(r.pct_change);
    if (isNaN(pc)) continue;
    if (pc > 0) adv++; else if (pc < 0) dec++; else unc++;
  }
  const nBreadth = adv + dec + unc;
  const breadthLatest = {
    date: flowDate, advancers: adv, decliners: dec, unchanged: unc,
    pct_advancers: nBreadth ? _r2(adv / nBreadth * 100) : null,
    members_with_data: nBreadth, members_total: members.length,
    turnover_value: Math.round(turn), turnover_share_pct: mktTurn ? _r2(turn / mktTurn * 100) : null,
  };
  // Boi canh: P/E + series tai chinh + chi so nganh (neu co)
  const missing = [];
  const peSeries = det && Array.isArray(det.series)
    ? det.series.slice(-8).map((s) => ({ period: s.period || s.label || null, value: s.pe != null ? s.pe : null })) : [];
  const context = {
    pe: { current: det && det.pe != null ? det.pe : null, series: peSeries },
    financials: det && Array.isArray(det.series) ? det.series.slice(-8) : [],
    index: null,
  };
  const idxCode = SECTOR_INDEX_CODE[code];
  if (idxCode) {
    const si = await sGet(env, 'market/sector_indices.json');
    const row = si && Array.isArray(si.rows)
      ? si.rows.find((r) => String(r.code || r.symbol || '') === idxCode) : null;
    if (row) {
      context.index = {
        code: idxCode,
        close: row.close != null ? row.close : (row.value != null ? row.value : null),
        pct_change: row.pct_change != null ? row.pct_change : (row.change_pct != null ? row.change_pct : null),
      };
    } else missing.push('sector_index');
  } else missing.push('sector_index');
  // Xu huong nhieu phien (Dot C): sector_flow_history + sector_breadth
  let trend = null;
  const sfh = await sGet(env, 'market/sector_flow_history.json');
  const sb = await sGet(env, 'market/sector_breadth.json');
  const sfhSec = sfh && sfh.sectors ? sfh.sectors[code] : null;
  const sbSec = sb && sb.sectors ? sb.sectors[code] : null;
  if (sfhSec || sbSec) {
    trend = {};
    if (sfhSec) {
      trend.flow = {
        sums: sfhSec.sums || null,
        sessions: Array.isArray(sfhSec.sessions) ? sfhSec.sessions.slice(-days) : [],
      };
    } else missing.push('sector_flow_history');
    if (sbSec) {
      trend.breadth = {
        latest: sbSec.latest || null,
        series: Array.isArray(sbSec.series) ? sbSec.series.slice(-days) : [],
      };
    } else missing.push('sector_breadth');
  } else {
    missing.push('sector_flow_history', 'sector_breadth');
    notes.push('chua co du lieu nhieu phien — Dot C (sector_flow_history/sector_breadth)');
  }
  notes.push('breadth tinh tren vu tru thanh vien hien tai (survivorship bias)');
  const updated = (fSnap && fSnap.updated) || (pSnap && pSnap.updated) || (det && det.updated);
  return {
    rows: contrib.length,
    env: envResult({
      sector: { code, name: uni.names[code] },
      flow_latest: flowLatest, breadth_latest: breadthLatest, context, trend,
    }, {
      dataset: 'market/foreign_flow.json + proprietary_flow.json + sectors/' + code + '.json + screener.json',
      route: '/api/mcp (analyze_sector)',
      updated, prov: (fSnap && fSnap._prov) || (det && det._prov),
      verification: 'verified', staleKind: 'market', missing,
      coverage: { returned: 1, universe: 19, note: notes.join('; ') || null },
    }),
  };
}

/* ---------------- GD2: analyze_symbol (Phu luc G6 + H1.2/1.5) ---------------- */
async function tAnalyzeSymbol(env, a) {
  const sym = await symbolOrThrow(env, a.symbol);
  const notes = [];
  const days = clampLimit(a.days, 20, 60, null, notes);
  const od = await sGet(env, 'market/ohlcv/' + sym + '.json');
  if (!od || !Array.isArray(od.rows) || !od.rows.length) throw await notFound(env, sym);
  // File nen tren kho co 2 dang: rut gon {t,o,h,l,c,v} (gia NGHIN dong —
  // producer dchart) va day du {date,open,high,low,close,volume} (gia
  // dong). Chuan hoa ve DONG cho ma co phieu; chi so giu nguyen diem.
  const INDEX_SYMS = new Set(['VNINDEX', 'VN30', 'HNX', 'UPCOM', 'VNFIN', 'VNREAL', 'VNIT', 'VNIND', 'VNMAT', 'VNCONS']);
  const compact = od.rows[0] && od.rows[0].c != null && od.rows[0].close == null;
  const px = compact && !INDEX_SYMS.has(sym) ? 1000 : 1;
  const rows = od.rows.map((r) => ({
    date: r.date || r.t || r.time || null,
    open: (parseFloat(r.open != null ? r.open : r.o)) * px,
    high: (parseFloat(r.high != null ? r.high : r.h)) * px,
    low: (parseFloat(r.low != null ? r.low : r.l)) * px,
    close: (parseFloat(r.close != null ? r.close : r.c)) * px,
    volume: parseFloat(r.volume != null ? r.volume : r.v) || 0,
  })).filter((r) => isFinite(r.close));
  const closes = rows.map((r) => r.close);
  const li = closes.length - 1;
  const close = closes[li];
  const missing = [];
  const ma = {}, pctVs = {};
  for (const n of [10, 20, 50, 150, 200]) {
    const v = _smaAt(closes, li, n);
    const key = 'ma' + n;
    if (n <= 50 || n === 200) { /* G6 chi ten ma10/20/50/200; ma150 dung noi bo cho trend template */ }
    if (v == null) { if ([10, 20, 50, 200].includes(n)) { ma[key] = null; pctVs[key] = null; missing.push('ma' + n); } }
    else if ([10, 20, 50, 200].includes(n)) { ma[key] = _r2(v); pctVs[key] = _r2((close / v - 1) * 100); }
  }
  const sma150 = _smaAt(closes, li, 150), sma200 = _smaAt(closes, li, 200);
  const sma50 = _smaAt(closes, li, 50);
  const w52 = rows.slice(-250);
  const low52 = Math.min(...w52.map((r) => r.low).filter(isFinite));
  const high52 = Math.max(...w52.map((r) => r.high).filter(isFinite));
  // Bo chi bao pp_common_v1 (H1.2)
  const ind = {};
  const ema20 = _emaSeries(closes, 20)[li];
  ind.ema_20 = ema20 != null ? _r2(ema20) : null;
  ind.rsi_14 = _r2(_rsiWilder(closes, 14));
  if (ind.rsi_14 == null) missing.push('indicator:rsi_14');
  const mc = _macd(closes);
  ind.macd = mc ? { macd: _r2(mc.macd), signal: _r2(mc.signal), hist: _r2(mc.hist) } : null;
  if (!mc) missing.push('indicator:macd');
  const bbMid = _smaAt(closes, li, 20);
  if (bbMid != null) {
    const sd = _stdev(closes.slice(-20));
    const up = bbMid + 2 * sd, lo = bbMid - 2 * sd;
    ind.bbands = {
      mid: _r2(bbMid), upper: _r2(up), lower: _r2(lo),
      pct_b: up > lo ? _r4((close - lo) / (up - lo)) : null,
      bandwidth_pct: bbMid ? _r2((up - lo) / bbMid * 100) : null,
    };
  } else ind.bbands = null;
  const atr = _atr(rows, 14);
  ind.atr_14 = atr != null ? _r2(atr) : null;
  ind.atr_pct = atr != null && close ? _r2(atr / close * 100) : null;
  const volSma = _smaAt(rows.map((r) => r.volume), li, 20);
  ind.volume_sma_20 = volSma != null ? Math.round(volSma) : null;
  ind.volume_ratio = volSma ? _r2(rows[li].volume / volSma) : null;
  ind.roc = {
    roc_5: li >= 5 ? _r2((close / closes[li - 5] - 1) * 100) : null,
    roc_20: li >= 20 ? _r2((close / closes[li - 20] - 1) * 100) : null,
    roc_60: li >= 60 ? _r2((close / closes[li - 60] - 1) * 100) : null,
  };
  // Trend Template Minervini (8 tieu chi; tieu chi 6 = 25% ban 2017 — H5)
  const rsD = await sGet(env, 'market/rs_universe.json');
  const rsRow = rsD && rsD.rows ? rsD.rows[sym] : null;
  const sma200Prev = closes.length >= 220 ? _smaAt(closes, li - 20, 200) : null;
  const ttCrit = [
    { key: 'price_above_ma150_ma200', pass: (sma150 != null && sma200 != null) ? (close > sma150 && close > sma200) : null, value: { close: _r2(close), ma150: _r2(sma150), ma200: _r2(sma200) } },
    { key: 'ma150_above_ma200', pass: (sma150 != null && sma200 != null) ? sma150 > sma200 : null, value: { ma150: _r2(sma150), ma200: _r2(sma200) } },
    { key: 'ma200_rising', pass: (sma200 != null && sma200Prev != null) ? sma200 > sma200Prev : null, value: { ma200: _r2(sma200), ma200_20d_ago: _r2(sma200Prev) } },
    { key: 'ma50_above_ma150_ma200', pass: (sma50 != null && sma150 != null && sma200 != null) ? (sma50 > sma150 && sma50 > sma200) : null, value: { ma50: _r2(sma50) } },
    { key: 'price_above_ma50', pass: sma50 != null ? close > sma50 : null, value: { ma50: _r2(sma50) } },
    { key: 'price_25pct_above_52w_low', pass: isFinite(low52) ? close >= low52 * 1.25 : null, value: { pct_above_low: isFinite(low52) ? _r2((close / low52 - 1) * 100) : null } },
    { key: 'price_within_25pct_of_52w_high', pass: isFinite(high52) ? close >= high52 * 0.75 : null, value: { pct_from_high: isFinite(high52) ? _r2((close / high52 - 1) * 100) : null } },
    { key: 'rs_percentile_gte_70', pass: rsRow && rsRow.rs_pct_20 != null ? rsRow.rs_pct_20 >= 70 : null, value: { rs_pct_20: rsRow ? rsRow.rs_pct_20 : null } },
  ];
  if (!rsRow) missing.push('rs_universe');
  const trendTemplate = {
    strategy_id: 'minervini_trend_template', version: 'pp_v1',
    formula_ref: 'trend_template_minervini',
    met: ttCrit.filter((c) => c.pass === true).length,
    evaluable: ttCrit.filter((c) => c.pass !== null).length,
    criteria: ttCrit,
  };
  // Dong tien cua so + streak
  const fs = await flowSumsFor(env, sym);
  const flow = {
    foreign_net: fs.foreign ? { d5: fs.foreign.d5, d20: fs.foreign.d20, d60: fs.foreign.d60 } : null,
    proprietary_net: fs.proprietary ? { d5: fs.proprietary.d5, d20: fs.proprietary.d20, d60: fs.proprietary.d60 } : null,
    streaks: {
      foreign: fs.foreign ? fs.foreign.streak : null,
      proprietary: fs.proprietary ? fs.proprietary.streak : null,
    },
  };
  if (!fs.foreign) missing.push('foreign_flow_history');
  if (!fs.proprietary) missing.push('proprietary_flow_history');
  // Dong thuan: phan tan chi khi n>=3 hang (H1.5)
  let consensus = null;
  const cd = await sGet(env, 'market/consensus/' + sym + '.json');
  if (cd && Array.isArray(cd.firms) && cd.firms.length) {
    const cutoff = Date.now() - 365 * 24 * 3600 * 1000;
    const firms12 = cd.firms.filter((f) => !f.date || Date.parse(f.date) >= cutoff);
    const tgts = firms12.map((f) => parseFloat(f.tgt)).filter((v) => isFinite(v) && v > 0);
    const labels = { buy: 0, hold: 0, sell: 0, other: 0 };
    for (const f of firms12) {
      const kn = normName(f.kn || '');
      if (/MUA|BUY|OUTPERFORM|TANG TY TRONG|KHA QUAN/.test(kn)) labels.buy++;
      else if (/BAN|SELL|UNDERPERFORM|GIAM TY TRONG|TIEM AN/.test(kn)) labels.sell++;
      else if (/NAM GIU|HOLD|NEUTRAL|TRUNG LAP/.test(kn)) labels.hold++;
      else labels.other++;
    }
    if (tgts.length >= 3) {
      const med = _median(tgts);
      const sd = _stdev(tgts);
      consensus = {
        firms_12m: firms12.length,
        target: {
          min: Math.min(...tgts), median: med, max: Math.max(...tgts),
          stdev: sd != null ? Math.round(sd) : null,
          spread_pct: med ? _r2((Math.max(...tgts) - Math.min(...tgts)) / med * 100) : null,
          cv: med && sd != null ? _r4(sd / Math.abs(med)) : null,
        },
        upside_median_pct: med && close ? _r2((med / close - 1) * 100) : null,
        labels,
      };
    } else {
      consensus = {
        firms_12m: firms12.length, dispersion: null,
        note: 'chua du 3 hang trong 12 thang — liet ke tung gia muc tieu, khong tinh phan tan',
        targets: firms12.map((f) => ({ firm: f.src, target: f.tgt, date: f.date, label: f.kn })),
        labels,
      };
    }
  }
  // Co dong lon (tu ho so cong ty)
  let holders = null;
  try {
    const p = await getCompanyProfile(env, sym);
    const sh = p && (p.shareholders || p.holders);
    if (Array.isArray(sh) && sh.length) {
      const top = sh.map((h) => ({
        name: h.name || h.holder || null,
        shares: h.shares != null ? h.shares : (h.quantity != null ? h.quantity : null),
        pct: h.pct != null ? h.pct : (h.percent != null ? h.percent : (h.ownership != null ? h.ownership : null)),
      })).sort((x, y) => (y.pct || 0) - (x.pct || 0)).slice(0, 5);
      holders = { count: sh.length, top };
    }
  } catch (e) { /* holders vao missing ben duoi */ }
  if (!holders) missing.push('holders');
  // Fundamentals (nhu get_fundamentals + pe/pb tu quote)
  let fundamentals = null;
  let fundVerification = 'verified';
  try {
    const f = await getFundamentalsData(env, sym);
    if (f) {
      fundamentals = { ...f };
      const q = await getQuoteData(env, sym);
      if (q && q.close) {
        if (fundamentals.eps > 0) fundamentals.pe_ttm = _r2(q.close / fundamentals.eps);
        if (fundamentals.bvps > 0) fundamentals.pb = _r2(q.close / fundamentals.bvps);
      }
      if (fundamentals.roe != null) fundamentals.roe_ttm = fundamentals.roe;
      fundVerification = 'parity_pending';
    }
  } catch (e) { /* fundamentals giu null */ }
  if (!fundamentals) missing.push('fundamentals');
  const data = {
    symbol: sym,
    price_position: {
      close, ma: { ma10: ma.ma10, ma20: ma.ma20, ma50: ma.ma50, ma200: ma.ma200 },
      pct_vs_ma: { ma10: pctVs.ma10, ma20: pctVs.ma20, ma50: pctVs.ma50, ma200: pctVs.ma200 },
      range_52w: {
        low: isFinite(low52) ? low52 : null, high: isFinite(high52) ? high52 : null,
        pct_from_low: isFinite(low52) ? _r2((close / low52 - 1) * 100) : null,
        pct_from_high: isFinite(high52) ? _r2((close / high52 - 1) * 100) : null,
      },
    },
    indicators: ind,
    trend_template: trendTemplate,
    flow, consensus, holders, fundamentals,
  };
  return {
    rows: 1,
    env: envResult(data, {
      dataset: 'market/ohlcv/' + sym + '.json + flow history + consensus + profile',
      route: '/api/mcp (analyze_symbol)',
      updated: od.updated, prov: od._prov,
      verification: fundVerification,
      verificationNote: fundVerification === 'parity_pending' ? PARITY_NOTE : null,
      staleKind: 'market', missing,
      coverage: { returned: 1, universe: 1519, note: notes.join('; ') || null },
    }),
  };
}

/* ---------------- GD2: analyze_compare (Phu luc G6 + I3) ---------------- */
async function tAnalyzeCompare(env, a) {
  const kind = String(a.kind || '').toLowerCase();
  if (kind !== 'symbols' && kind !== 'sectors') {
    throw new ToolError('invalid_params', "kind phai la 'symbols' hoac 'sectors'.",
      { hint: 'analyze_compare chi so 2 ma (symbols) hoac 2 nganh (sectors).' });
  }
  const items = Array.isArray(a.items) ? a.items.map((x) => String(x || '').trim()) : [];
  if (items.length !== 2 || items.some((x) => !x)) {
    throw new ToolError('invalid_params', 'items phai gom dung 2 phan tu.',
      { hint: 'Vi du: items=["FPT","HPG"] hoac items=["8300","8600"] voi kind tuong ung.' });
  }
  const notes = [];
  const days = clampLimit(a.days, 20, 60, null, notes);
  const criteria = [], unilateral = [];
  const crit = (key, label, unit, va, vb) => {
    va = va != null && isFinite(va) ? _r4(va) : va;
    vb = vb != null && isFinite(vb) ? _r4(vb) : vb;
    if (va != null && vb != null && isFinite(va) && isFinite(vb)) {
      criteria.push({ key, label, unit, a: va, b: vb, diff: _r4(va - vb) });
    } else {
      if (va != null && isFinite(va)) unilateral.push({ key, side: 'a', value: va, reason: 'phia b khong co du kien' });
      if (vb != null && isFinite(vb)) unilateral.push({ key, side: 'b', value: vb, reason: 'phia a khong co du kien' });
      if (va == null && vb == null) unilateral.push({ key, side: 'both', value: null, reason: 'ca 2 phia khong co du kien' });
    }
  };
  let asOf = null, comparability = null;
  if (kind === 'symbols') {
    const [sa, sb] = items.map((s) => s.toUpperCase());
    const scr = await sGet(env, 'market/screener.json');
    const scrMap = {};
    if (scr && Array.isArray(scr.rows)) for (const r of scr.rows) scrMap[String(r.symbol).toUpperCase()] = r;
    const uni = await loadSectorUniverse(env);
    const side = async (sym) => {
      const q = await getQuoteData(env, sym);
      if (!q) throw await notFound(env, sym);
      const f = await getFundamentalsData(env, sym).catch(() => null);
      const fs = await flowSumsFor(env, sym);
      const scrR = scrMap[sym] || {};
      return {
        sym, close: q.close != null ? q.close : null,
        pct: scrR.pct_change != null ? parseFloat(scrR.pct_change) : null,
        value: scrR.value_vnd != null ? parseFloat(scrR.value_vnd) : null,
        pe: f && f.eps > 0 && q.close ? _r2(q.close / f.eps) : null,
        pb: f && f.bvps > 0 && q.close ? _r2(q.close / f.bvps) : null,
        roe: f && f.roe != null ? f.roe : null,
        fnet: fs.foreign ? fs.foreign['d' + Math.min(days, 60)] != null ? fs.foreign['d' + Math.min(days, 60)] : fs.foreign.d20 : null,
        pnet: fs.proprietary ? (fs.proprietary['d' + Math.min(days, 60)] != null ? fs.proprietary['d' + Math.min(days, 60)] : fs.proprietary.d20) : null,
        sector: uni && uni.map[sym] ? uni.map[sym] : null,
        updated: q.updated || null,
      };
    };
    const A = await side(sa), B = await side(sb);
    crit('close', 'Gia dong cua', 'VND', A.close, B.close);
    crit('pct_change', '% thay doi phien', 'pp', A.pct, B.pct);
    crit('value_vnd', 'Gia tri giao dich phien', 'VND', A.value, B.value);
    crit('pe_ttm', 'P/E TTM', 'lan', A.pe, B.pe);
    crit('pb', 'P/B', 'lan', A.pb, B.pb);
    crit('roe_ttm', 'ROE TTM', 'pp', A.roe, B.roe);
    crit('foreign_net_window', `Rong khoi ngoai ${days} phien`, 'VND', A.fnet, B.fnet);
    crit('proprietary_net_window', `Rong tu doanh ${days} phien`, 'VND', A.pnet, B.pnet);
    comparability = {
      same_sector: A.sector && B.sector ? A.sector.code === B.sector.code : null,
      sector_a: A.sector ? A.sector.code : null, sector_b: B.sector ? B.sector.code : null,
      note: 'so sanh truc tiep 1-1 la ky thuat yeu nhat (Damodaran) — doc kem comparability, khong gop diem tong',
    };
    asOf = [A.updated, B.updated].filter(Boolean).sort()[0] || null;
  } else {
    const [ca, cb] = items;
    const ra = await tAnalyzeSector(env, { code: ca, days, top_n: 1 });
    const rb = await tAnalyzeSector(env, { code: cb, days, top_n: 1 });
    const A = ra.env.data, B = rb.env.data;
    crit('foreign_net_latest', 'Rong khoi ngoai phien gan nhat', 'VND', A.flow_latest.foreign_net_total, B.flow_latest.foreign_net_total);
    crit('proprietary_net_latest', 'Rong tu doanh phien gan nhat', 'VND', A.flow_latest.proprietary_net_total, B.flow_latest.proprietary_net_total);
    crit('pct_advancers', '% ma tang trong nganh', 'pp', A.breadth_latest.pct_advancers, B.breadth_latest.pct_advancers);
    crit('turnover_value', 'GTGD nganh phien gan nhat', 'VND', A.breadth_latest.turnover_value, B.breadth_latest.turnover_value);
    crit('pe_current', 'P/E nganh hien tai', 'lan', A.context.pe.current, B.context.pe.current);
    crit('index_close', 'Diem chi so nganh', 'diem',
      A.context.index ? A.context.index.close : null, B.context.index ? B.context.index.close : null);
    asOf = [ra.env.meta.as_of, rb.env.meta.as_of].filter(Boolean).sort()[0] || null;
    if (ra.env.meta.as_of !== rb.env.meta.as_of) {
      notes.push('as_of 2 phia lech nhau — dung moc cu hon lam moc chung');
    }
  }
  const data = {
    kind, items, as_of: asOf,
    fairness: {
      common_as_of: asOf,
      common_window: { requested_days: days, effective_days: days, limited_by: null },
      delta_basis: 'so % chenh nhau tinh bang diem phan tram (pp); he so (P/E, P/B) tinh bang lan; tien tinh bang VND',
    },
    criteria, unilateral, comparability,
  };
  return {
    rows: criteria.length,
    env: envResult(data, {
      dataset: 'snapshot MCP (nhu analyze_symbol/analyze_sector)',
      route: '/api/mcp (analyze_compare)',
      updated: asOf, verification: 'verified', staleKind: 'market',
      coverage: { returned: criteria.length, universe: null, note: notes.join('; ') || null },
    }),
  };
}

/* ---------------- GD2: analyze_market (Phu luc G6 + I1) ---------------- */
async function tAnalyzeMarket(env, a) {
  const notes = [];
  const days = clampLimit(a.days, 20, 60, null, notes);
  const missing = [];
  const idx = await sGet(env, 'market/indices.json');
  if (!idx) throw new ToolError('data_unavailable', 'Chua co snapshot chi so.');
  const indices = (Array.isArray(idx.rows) ? idx.rows : []).map((r) => ({
    code: r.code || r.symbol || null,
    close: r.close != null ? r.close : (r.value != null ? r.value : null),
    pct_change: r.pct_change != null ? r.pct_change : (r.change_pct != null ? r.change_pct : null),
  }));
  const regimeD = await sGet(env, 'market/regime.json');
  const scr = await sGet(env, 'market/screener.json');
  if (!scr || !Array.isArray(scr.rows)) throw new ToolError('data_unavailable', 'Chua co snapshot screener.');
  const byEx = {};
  let advV = 0, decV = 0, advN = 0, decN = 0, turnTotal = 0;
  for (const r of scr.rows) {
    const ex = String(r.exchange || '').toUpperCase() || 'UNKNOWN';
    if (!byEx[ex]) byEx[ex] = { advancers: 0, decliners: 0, unchanged: 0 };
    const pc = parseFloat(r.pct_change);
    if (!isNaN(pc)) {
      if (pc > 0) { byEx[ex].advancers++; advN++; } else if (pc < 0) { byEx[ex].decliners++; decN++; } else byEx[ex].unchanged++;
    }
    const vol = parseFloat(r.volume) || 0;
    if (!isNaN(pc) && pc > 0) advV += vol;
    if (!isNaN(pc) && pc < 0) decV += vol;
    turnTotal += parseFloat(r.value_vnd) || 0;
  }
  const trin = advN && decN && decV ? _r4((advN / decN) / (advV / decV)) : null;
  if (trin == null) missing.push('trin');
  missing.push('market_cap_weights'); // kho chua co von hoa tung ma -> khong tinh CW/divergence vo
  // Dong tien toan san + tach san
  const fSnap = await sGet(env, 'market/foreign_flow.json');
  const pSnap = await sGet(env, 'market/proprietary_flow.json');
  const scrEx = {};
  for (const r of scr.rows) scrEx[String(r.symbol).toUpperCase()] = String(r.exchange || '').toUpperCase();
  const flowTotals = { foreign_net: null, proprietary_net: null, by_exchange: {} };
  const addFlow = (snap, slot) => {
    if (!snap) return;
    let tot = 0;
    for (const r of flowRowsOf(snap)) {
      const net = flowNetOf(r);
      if (net == null) continue;
      tot += net;
      const ex = scrEx[String((r && r.symbol) || '').toUpperCase()] || 'UNKNOWN';
      if (!flowTotals.by_exchange[ex]) flowTotals.by_exchange[ex] = { foreign_net: 0, proprietary_net: 0 };
      flowTotals.by_exchange[ex][slot] += net;
    }
    flowTotals[slot] = Math.round(tot);
  };
  addFlow(fSnap, 'foreign_net');
  addFlow(pSnap, 'proprietary_net');
  for (const ex of Object.keys(flowTotals.by_exchange)) {
    flowTotals.by_exchange[ex].foreign_net = Math.round(flowTotals.by_exchange[ex].foreign_net);
    flowTotals.by_exchange[ex].proprietary_net = Math.round(flowTotals.by_exchange[ex].proprietary_net);
  }
  // Vi mo tom tat (dung lai tool GD1)
  let macro = null;
  try { const mr = await tGetMacro(env, {}); macro = mr.env.data; } catch (e) { missing.push('macro'); }
  // Xu huong (Dot C)
  let trend = null;
  const mfh = await sGet(env, 'market/market_flow_history.json');
  const sb = await sGet(env, 'market/sector_breadth.json');
  if (mfh || (sb && sb.market)) {
    trend = {};
    if (mfh) trend.flow = { sums: mfh.sums || null, sessions: Array.isArray(mfh.sessions) ? mfh.sessions.slice(-days) : [] };
    if (sb && sb.market) trend.breadth = { latest: sb.market.latest || null, series: Array.isArray(sb.market.series) ? sb.market.series.slice(-days) : [] };
  } else missing.push('market_trend_series');
  const data = {
    indices,
    regime: regimeD ? stripStamps(regimeD) : null,
    breadth: { by_exchange: byEx, turnover_total: Math.round(turnTotal) },
    divergence: {
      equal_weight_pct_advancers: (advN + decN) ? _r2(advN / (advN + decN) * 100) : null,
      cap_weighted: null,
      note: 'chua co trong so von hoa tung ma trong kho — khong tinh ban vo hoa, chi tra phien ban trong so deu',
    },
    trin: trin != null ? { value: trin, formula_ref: 'trin_arms', note: 'TRIN = (Adv/Dec)/(AdvVol/DecVol), mau so la khoi luong CP' } : null,
    flow_totals: flowTotals, macro, trend,
  };
  return {
    rows: indices.length,
    env: envResult(data, {
      dataset: 'market/indices.json + regime.json + screener.json + flow + macro',
      route: '/api/mcp (analyze_market)',
      updated: idx.updated, prov: idx._prov, verification: 'verified',
      staleKind: 'market', missing,
      coverage: { returned: indices.length, universe: 1519, note: notes.join('; ') || null },
    }),
  };
}

/* ---------------- GD2: calc_flow_sum (Phu luc G7) ---------------- */
async function tCalcFlowSum(env, a) {
  const hasSym = !!(a.symbol && String(a.symbol).trim());
  const hasSrc = !!(a.source_result && String(a.source_result).trim());
  if (hasSym === hasSrc) {
    throw new ToolError('invalid_params', 'Chi chon dung 1 trong 2: symbol hoac source_result.',
      { hint: 'symbol = server tu nap lich su dong tien cua ma; source_result = tinh tren ket qua truoc (handle r_...).' });
  }
  const kind = String(a.kind || 'both').toLowerCase();
  if (!['foreign', 'proprietary', 'both'].includes(kind)) {
    throw new ToolError('invalid_params', "kind phai la 'foreign', 'proprietary' hoac 'both'.");
  }
  if (hasSrc) {
    if (a.days != null) {
      throw new ToolError('invalid_params', 'Dung source_result thi khong truyen days — phep tinh chay tren toan bo ket qua da luu.',
        { hint: 'Bo tham so days, hoac dung symbol + days.' });
    }
    const stored = await readResultHandle(env, String(a.source_result).trim());
    const rows = stored.data && Array.isArray(stored.data.rows) ? stored.data.rows : null;
    if (!rows) {
      throw new ToolError('invalid_params', 'Ket qua da luu khong phai bang dong tien (khong co rows).',
        { hint: 'source_result chi tinh duoc tren ket qua cua get_flow (lich su theo ma).' });
    }
    const sum = rows.reduce((s, r) => s + (flowNetOf(r) || 0), 0);
    return {
      rows: rows.length,
      env: envResult({
        source_result: String(a.source_result).trim(), tool_origin: stored.tool,
        sessions: rows.length, net_total: Math.round(sum),
      }, {
        dataset: 'mcp_results handle', route: '/api/mcp (calc_flow_sum)',
        updated: stored.as_of || stored.created, verification: 'verified',
        staleKind: 'market',
        coverage: { returned: rows.length, universe: rows.length, note: 'tinh tren toan bo ket qua da luu' },
      }),
    };
  }
  const sym = await symbolOrThrow(env, a.symbol);
  const notes = [];
  const days = clampLimit(a.days, 20, 500, null, notes);
  const out = { symbol: sym, days, formula_ref: 'flow_sum' };
  let any = false;
  for (const k of ['foreign', 'proprietary']) {
    if (kind !== 'both' && kind !== k) continue;
    const h = await flowHistRows(env, k, sym);
    if (!h || !h.rows.length) { out[k] = null; continue; }
    const w = flowWindow(h.rows, days);
    out[k] = { net: Math.round(w.sum), sessions: w.n, streak: w.streak };
    any = true;
  }
  if (!any) throw await notFound(env, sym);
  return {
    rows: 1,
    env: envResult(out, {
      dataset: 'market/{foreign,proprietary}_flow_history/' + sym + '.json',
      route: '/api/mcp (calc_flow_sum)',
      updated: null, verification: 'verified', staleKind: 'market',
      coverage: { returned: 1, universe: 1519, note: notes.join('; ') || null },
    }),
  };
}

/* ---------------- GD2: get_analysis_catalog (Phu luc G8) ---------------- */
async function tGetAnalysisCatalog(env, a) {
  const kind = String(a.kind || '').toLowerCase();
  if (!['indicators', 'ratios', 'formulas'].includes(kind)) {
    throw new ToolError('invalid_params', "kind phai la 'indicators', 'ratios' hoac 'formulas'.",
      { hint: 'get_analysis_catalog(kind) tra danh muc phep tinh cac tool analyze/calc dung.' });
  }
  let entries = ANALYSIS_CATALOG[kind] || [];
  const name = String(a.name || '').trim().toLowerCase();
  const query = String(a.query || '').trim().toLowerCase();
  if (name) entries = entries.filter((e) => e.name === name);
  if (query) entries = entries.filter((e) => (e.name + ' ' + (e.label || '')).toLowerCase().includes(query));
  return {
    rows: entries.length,
    env: envResult({ kind, entries }, {
      dataset: 'analysis_catalog (ban cung trong server)', route: '/api/mcp (get_analysis_catalog)',
      updated: null, verification: 'verified', staleKind: 'static',
      coverage: { returned: entries.length, universe: (ANALYSIS_CATALOG[kind] || []).length, note: null },
    }),
  };
}

/* ---------------- dang ky tool ---------------- */
const S = (props, req) => ({ type: 'object', properties: props, required: req || [] });
const SYM = { symbol: { type: 'string', description: 'Ma chung khoan (vd FPT)' } };
const TOOLS = [
  {
    name: 'get_quote', minTier: 0, run: tGetQuote, rest: '/api/stock/quote',
    description: 'Chu de: gia hom nay cua 1 ma. Gia phien gan nhat cua 1 ma: dong cua, % thay doi, khoi luong, gia tri, mua/ban khoi ngoai. Nguon: bang gia da kiem chung.',
    inputSchema: S(SYM, ['symbol']),
  },
  {
    name: 'get_ohlcv', minTier: 0, run: tGetOhlcv, rest: '/api/stock/ohlcv',
    description: 'Chu de: bieu do nen, dien bien gia theo thoi gian. Chuoi nen ngay (OHLCV) cua 1 ma hoac chi so (vd VNINDEX). Mac dinh 120 nen, toi da 500.',
    inputSchema: S({ ...SYM, limit: { type: 'integer', description: 'So nen, toi da 500' } }, ['symbol']),
  },
  {
    name: 'get_indices', minTier: 0, run: tGetIndices, rest: '/api/stock/indices',
    description: 'Chu de: chi so thi truong hom nay. Chi so thi truong hien tai (VNINDEX, VN30, HNX, UPCOM...) kem trang thai thi truong (regime).',
    inputSchema: S({}),
  },
  {
    name: 'get_company_profile', minTier: 0, run: tGetCompanyProfile, rest: '/api/stock/company/profile',
    description: 'Chu de: ho so cong ty, co dong, lanh dao cua 1 ma. Ho so cong ty cua 1 ma: thong tin chung, co dong, lanh dao, cong ty con/lien ket, von va co cau so huu. Da parity tuyet doi.',
    inputSchema: S(SYM, ['symbol']),
  },
  {
    name: 'get_macro', minTier: 1, run: tGetMacro, rest: '/api/stock/macro',
    description: 'Chu de: vi mo — lai suat, ty gia, vang, OMO. Vi mo: khong tham so = tong quan (lai suat dieu hanh SBV, ty gia trung tam USD/VND, vang SJC, OMO, lai suat My...). series = lich su 1 series (toi da 365 diem). So thu tai nguon phat hanh.',
    inputSchema: S({ series: { type: 'string', description: 'Ma series (vd omo, gold_sjc); rong = tong quan' } }),
  },
  {
    name: 'get_sector', minTier: 1, run: tGetSector, rest: '/api/stock/sectors',
    description: 'Chu de: bang nganh ICB, P/E va tai chinh nganh. Nganh ICB: khong code = bang tong quan 19 nganh (doanh thu/LNST/ROE TTM, P/E kem so ma tinh duoc); code = chi tiet 1 nganh (8 ky gan nhat + thanh vien).',
    inputSchema: S({ code: { type: 'string', description: 'Ma nganh ICB 4 chu so (vd 8350); rong = tong quan' } }),
  },
  {
    name: 'get_flow', minTier: 2, run: tGetFlow, rest: '/api/stock/foreign-flow',
    description: 'Chu de: khoi ngoai/tu doanh mua ban gi (theo ma hoac toan thi truong). Dong tien khoi ngoai (foreign) hoac tu doanh (proprietary): co symbol = lich su theo ma (moi nhat truoc); khong symbol = bang toan thi truong phien gan nhat.',
    inputSchema: S({
      kind: { type: 'string', enum: ['foreign', 'proprietary'] },
      symbol: { type: 'string', description: 'Ma (tuy chon)' },
      days: { type: 'integer', description: 'So ngay lich su, toi da 500' },
    }, ['kind']),
  },
  {
    name: 'get_flow_summary', minTier: 2, run: tGetFlowSummary, rest: null,
    description: 'Chu de: tien do ve nganh/san nao — dich den cua dong tien. Tong hop dong tien theo DICH DEN (phien gan nhat): cong rong khoi ngoai + tu doanh theo nganh ICB / theo san / toan thi truong, kem GTGD tung nhom. sector_code = chi tiet 1 nganh + top ma trong nganh. Dung cho cau hoi "tien do ve dau / dong tien theo nganh".',
    inputSchema: S({
      kind: { type: 'string', enum: ['foreign', 'proprietary', 'both'], description: 'Loai dong tien, mac dinh both' },
      group_by: { type: 'string', enum: ['sector', 'exchange', 'market'], description: 'Chieu tong hop, mac dinh sector' },
      sector_code: { type: 'string', description: 'Ma nganh ICB 4 chu so (tuy chon, vd 8300)' },
    }),
  },
  {
    name: 'get_consensus', minTier: 2, run: tGetConsensus, rest: '/api/stock/consensus',
    description: 'Chu de: cac hang chung khoan khuyen nghi gi, gia muc tieu bao nhieu. Dong thuan CTCK (chi ban verified): co symbol = tung hang (khuyen nghi, gia muc tieu, ngay bao cao, link nguon) + trung binh/min/max/upside da tinh san; khong symbol = bang toan thi truong. Khong tra van phan tich cua hang.',
    inputSchema: S({ symbol: { type: 'string', description: 'Ma (tuy chon)' } }),
  },
  {
    name: 'get_screener', minTier: 3, run: tGetScreener, rest: '/api/stock/screener',
    description: 'Chu de: loc co phieu toan thi truong theo dieu kien. Loc co phieu toan thi truong: filters {exchange, sector, min_pe, max_pe, min_roe, min_value, min_pct, max_pct}, sort_by (value_vnd/pct_change/volume/close/pe_ttm/roe_ttm), limit toi da 200.',
    inputSchema: S({
      filters: { type: 'object', description: 'Dieu kien loc (tuy chon)' },
      sort_by: { type: 'string' }, order: { type: 'string', enum: ['asc', 'desc'] },
      limit: { type: 'integer' },
    }),
  },
  {
    name: 'get_fundamentals', minTier: 3, run: tGetFundamentals, rest: '/api/stock/fundamentals',
    description: 'Chu de: ty so tai chinh TTM cua 1 ma. Ty so tai chinh TTM cua 1 ma (EPS, BVPS, ROE, ROA, P/E, P/B...). verification luon parity_pending — phai neu co nay khi dung so.',
    inputSchema: S(SYM, ['symbol']),
  },
  {
    name: 'get_statements', minTier: 3, run: tGetStatements, rest: '/api/stock/statements',
    description: 'Chu de: bao cao tai chinh cac ky gan nhat. Bao cao tai chinh (can doi / ket qua kinh doanh / luu chuyen tien) cac ky gan nhat cua 1 ma. verification luon parity_pending — phai neu co nay khi dung so.',
    inputSchema: S({ ...SYM, periods: { type: 'integer', description: 'So ky, mac dinh 8, toi da 20' } }, ['symbol']),
  },
  {
    name: 'find_holder', minTier: 3, run: tFindHolder, rest: '/api/stock/holders',
    description: 'Chu de: mot nguoi/to chuc dang nam nhung ma nao. Tra cuu dao chi muc co dong: nhap ten nguoi/to chuc -> cac ma dang nam giu, so co phieu, ty le, chuc danh. Kem coverage do phu cua chi muc.',
    inputSchema: S({ name: { type: 'string', description: 'Ten co dong (co dau hoac khong dau)' }, limit: { type: 'integer' } }, ['name']),
  },
  {
    name: 'get_events', minTier: 3, run: tGetEvents, rest: '/api/stock/events',
    description: 'Chu de: su kien sap toi cua 1 ma. Su kien sap toi cua 1 ma (DHDCD, co tuc, phat hanh...) trong days_ahead ngay (mac dinh 90).',
    inputSchema: S({ ...SYM, days_ahead: { type: 'integer' } }, ['symbol']),
  },
  {
    name: 'get_news', minTier: 3, run: tGetNews, rest: '/api/stock/news',
    description: 'Chu de: tin tuc moi nhat. Tin tuc: co symbol = tin theo ma; khong symbol = tin thi truong. meta.as_of la moc tin moi nhat — bat buoc neu khi trien khai.',
    inputSchema: S({ symbol: { type: 'string', description: 'Ma (tuy chon)' }, limit: { type: 'integer' } }),
  },
  {
    name: 'analyze_sector', minTier: 1, run: tAnalyzeSector, rest: null, formulaRef: 'flow_sum',
    description: 'Chu de: Phan tich nganh — dong tien, do rong, dinh gia cua mot nganh. analyze_sector(code, days=20, top_n=15): 4 khoi tu snapshot — dong tien phien gan nhat theo ma, do rong phien, P/E + chi so nganh (neu co), xu huong nhieu phien (Dot C). code = ma ICB 4 so (tra o get_sector). So la so do, khong du bao/khuyen nghi.',
    inputSchema: S({
      code: { type: 'string', description: 'Ma nganh ICB 4 chu so (vd 8600)' },
      days: { type: 'integer', description: 'So phien cho khoi xu huong, mac dinh 20, toi da 60' },
      top_n: { type: 'integer', description: 'So ma keo chinh tra ve, mac dinh 15, toi da 30' },
    }, ['code']),
  },
  {
    name: 'analyze_symbol', minTier: 2, run: tAnalyzeSymbol, rest: null, formulaRef: 'trend_template_minervini',
    description: 'Chu de: Phan tich mot ma — gia so voi duong trung binh, dong tien, dong thuan. analyze_symbol(symbol, days=20): gia-MA + bo chi bao pp_common_v1 + Trend Template 8 tieu chi + rong ngoai/tu doanh 5/20/60 phien + phan tan gia muc tieu dong thuan + co dong lon + ty so. So la so do, khong du bao/khuyen nghi.',
    inputSchema: S({ ...SYM, days: { type: 'integer', description: 'So phien nhin lai (khai truoc), mac dinh 20' } }, ['symbol']),
  },
  {
    name: 'analyze_compare', minTier: 2, run: tAnalyzeCompare, rest: null,
    description: 'Chu de: So sanh 2 ma hoac 2 nganh tren cung mot bo tieu chi. analyze_compare(kind, items[2], days=20): bang tieu chi chuan hoa + chenh lech do code tinh + khoi fairness (cung as_of, cua so chung). Khong ket luan nen chon phia nao.',
    inputSchema: S({
      kind: { type: 'string', enum: ['symbols', 'sectors'], description: 'symbols = 2 ma; sectors = 2 ma nganh ICB' },
      items: { type: 'array', items: { type: 'string' }, description: 'Dung 2 phan tu' },
      days: { type: 'integer', description: 'Cua so tinh (phien), mac dinh 20' },
    }, ['kind', 'items']),
  },
  {
    name: 'analyze_market', minTier: 1, run: tAnalyzeMarket, rest: null, formulaRef: 'trin_arms',
    description: 'Chu de: Toan canh thi truong hom nay — chi so, do rong, dong tien toan san. analyze_market(days=20): chi so + regime + do rong theo 3 san + TRIN + tong rong ngoai/tu doanh (tach san) + tom tat vi mo + xu huong (Dot C). So la so do, khong du bao/khuyen nghi.',
    inputSchema: S({ days: { type: 'integer', description: 'So phien cho khoi xu huong, mac dinh 20' } }),
  },
  {
    name: 'calc_flow_sum', minTier: 2, run: tCalcFlowSum, rest: null, formulaRef: 'flow_sum',
    description: 'Chu de: Tong dong tien rong theo cua so phien (server tinh, AI khong tu cong). calc_flow_sum: truyen symbol + days (server tu nap lich su) HOAC source_result (handle r_... cua get_flow — tinh tren toan bo ket qua da luu, khong kem days). kind = foreign/proprietary/both.',
    inputSchema: S({
      symbol: { type: 'string', description: 'Ma (cach 1)' },
      source_result: { type: 'string', description: 'Handle ket qua truoc r_yyyymmdd_xxxxxx (cach 2, XOR voi symbol)' },
      kind: { type: 'string', enum: ['foreign', 'proprietary', 'both'] },
      days: { type: 'integer', description: 'So phien (chi voi symbol), mac dinh 20, toi da 500' },
    }),
  },
  {
    name: 'get_analysis_catalog', minTier: 1, run: tGetAnalysisCatalog, rest: null,
    description: 'Chu de: Danh muc phep tinh — chi bao, ty so, cong thuc cac tool phan tich dung. get_analysis_catalog(kind, name?, query?): indicators (bo pp_common_v1: SMA/EMA/RSI/MACD/BBANDS/ATR/ROC + min_bars), ratios, formulas (formula_ref, cong thuc, quy uoc). Tra cuu truoc khi dung chi so de ket luan.',
    inputSchema: S({
      kind: { type: 'string', enum: ['indicators', 'ratios', 'formulas'] },
      name: { type: 'string', description: 'Ten chinh xac (tuy chon)' },
      query: { type: 'string', description: 'Tu khoa tim trong ten/nhan (tuy chon)' },
    }, ['kind']),
  },
];

/* ---------------- chay tool noi bo cho AI Chat (Dot B) ---------------- */
// Tang dieu phoi LLM trong ai_chat.js goi thang ham tool o day
// (khong qua JSON-RPC, khong tru quota agent_calls — luot chat ghi
// log rieng o ai_chat_log). ToolError nem nguyen trang de tang tren
// xu ly theo code.
export async function chatToolRun(env, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    throw new ToolError('unknown_tool', `Tool '${name}' khong ton tai.`, { hint: hintFor('unknown_tool') });
  }
  const r = await tool.run(env, args || {});
  await finalizeResult(env, tool, args || {}, r);
  return r.env;
}

/* ---------------- mcp_log (D1) ---------------- */
let _logReady = false;
async function ensureLog(env) {
  if (_logReady) return;
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS mcp_log (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, ' +
      'user_email TEXT NOT NULL, plan TEXT, tool TEXT, ' +
      'params_json TEXT, status TEXT NOT NULL, refusal_code TEXT, ' +
      'verification_flags TEXT, result_rows INTEGER, ' +
      'latency_ms INTEGER, as_of TEXT)').run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_mcp_log_ts ON mcp_log(ts)').run();
    // GD2 G4(e): truy vet chuoi tinh — cot them bang ALTER mem
    // (bang cu da ton tai o production, loi trung cot thi bo qua).
    for (const col of ['result_id TEXT', 'source_result TEXT']) {
      try { await env.DB.prepare('ALTER TABLE mcp_log ADD COLUMN ' + col).run(); } catch (e) { /* da co */ }
    }
    _logReady = true;
  } catch (e) { /* log khong duoc lam hong luot goi */ }
}

async function writeLog(env, row) {
  try {
    await ensureLog(env);
    await env.DB.prepare(
      'INSERT INTO mcp_log (ts, user_email, plan, tool, params_json, ' +
      'status, refusal_code, verification_flags, result_rows, ' +
      'latency_ms, as_of, result_id, source_result) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(row.ts, row.user_email, row.plan, row.tool,
        row.params_json, row.status, row.refusal_code,
        row.verification_flags, row.result_rows, row.latency_ms,
        row.as_of, row.result_id || null, row.source_result || null).run();
    // Giu 90 ngay (don co hoi theo tung luot ghi, nhu rate_limits)
    const cutoff = isoICT(Date.now() - 90 * 24 * 3600 * 1000);
    await env.DB.prepare('DELETE FROM mcp_log WHERE ts < ?')
      .bind(cutoff).run();
  } catch (e) { /* logging fail-open */ }
}

/* ---------------- JSON-RPC / MCP ---------------- */
function rpcResult(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
function rpcError(id, code, message, status) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status: status || 200, headers: { 'Content-Type': 'application/json' },
  });
}
function toolResult(payload, isError) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: !!isError,
  };
}

export async function resolveCaller(request, env) {
  const s = await getSession(request, env);
  if (!s) return null;
  const u = await getUser(env, s.email);
  const plan = u ? getActivePlan(u).plan : 'free';
  return { email: s.email, user: u, plan, tier: TIER[plan] != null ? TIER[plan] : 0 };
}

async function handleToolsCall(env, caller, params, t0) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const tool = TOOLS.find((t) => t.name === name);
  const logBase = {
    ts: isoICT(Date.now()), user_email: caller.email, plan: caller.plan,
    tool: name || null, params_json: JSON.stringify(args).slice(0, 1000),
  };
  const finish = async (payload, isError, status, extra) => {
    await writeLog(env, {
      ...logBase, status,
      refusal_code: (extra && extra.refusal_code) || null,
      verification_flags: (extra && extra.verification) || null,
      result_rows: extra && extra.rows != null ? extra.rows : null,
      latency_ms: Date.now() - t0,
      as_of: (extra && extra.as_of) || null,
      result_id: (extra && extra.result_id) || null,
      source_result: (args && args.source_result) || null,
    });
    return toolResult(payload, isError);
  };

  if (!tool) {
    return finish({ error: { code: 'unknown_tool', error_code: 'unknown_tool', message: `Tool '${name}' khong ton tai.`, hint: hintFor('unknown_tool'), available: TOOLS.map((t) => t.name) } },
      true, 'refused', { refusal_code: 'unknown_tool' });
  }
  // Cong goi theo muc 2.5 da Chot (tat khi MCP_DEV_OPEN)
  if (!MCP_DEV_OPEN && caller.tier < tool.minTier) {
    return finish({ error: {
      code: 'plan_restricted', error_code: 'plan_restricted', tool: name,
      message: `Tool ${name} yeu cau goi ${TIER_NAME[tool.minTier]} tro len; goi hien tai: ${caller.plan}.`,
      hint: hintFor('plan_restricted'),
      required_plan: TIER_NAME[tool.minTier], current_plan: caller.plan,
    } }, true, 'refused', { refusal_code: 'plan_restricted' });
  }
  // Quota agent_calls/ngay theo goi (admin = khong gioi han;
  // MCP_DEV_OPEN = khong chan quota cho moi user)
  const limit = (MCP_DEV_OPEN || caller.plan === 'admin') ? null
    : ((PLANS[caller.plan] || PLANS.free).limits.agent_calls || 0);
  let used = 0;
  try { used = (await getUsage(env, caller.email)).agent_calls || 0; } catch (e) { /* bang usage loi -> fail-open doc */ }
  if (limit != null && used >= limit) {
    return finish({ error: {
      code: 'quota_exceeded', error_code: 'quota_exceeded', tool: name,
      message: `Da het quota agent_calls hom nay cua goi ${caller.plan} (${used}/${limit}). Reset 00:00 ICT.`,
      hint: hintFor('quota_exceeded'),
      plan: caller.plan, used, limit, reset_at: nextResetISO(),
    } }, true, 'quota_exceeded', { refusal_code: 'quota_exceeded' });
  }
  try {
    const r = await tool.run(env, args);
    const fin = await finalizeResult(env, tool, args, r);
    if (!MCP_DEV_OPEN) {
      try { await incrUsage(env, caller.email, 'agent_calls', 1); } catch (e) { /* dem loi khong chan ket qua */ }
    }
    return finish(r.env, false, 'ok', {
      rows: r.rows, verification: r.env.meta.verification, as_of: r.env.meta.as_of,
      result_id: fin.resultId,
    });
  } catch (e) {
    if (e instanceof ToolError) {
      const status = ['invalid_params'].includes(e.code) ? 'refused' : 'error';
      const extra = { ...e.extra };
      const hint = hintFor(e.code, extra);
      delete extra.hint;
      return finish({ error: { code: e.code, error_code: e.code, message: e.message, hint, ...extra } },
        true, status, { refusal_code: e.code });
    }
    return finish({ error: { code: 'internal_error', error_code: 'internal_error', message: String((e && e.message) || e), hint: hintFor('internal_error') } },
      true, 'error', { refusal_code: 'internal_error' });
  }
}

export async function hMcp(request, env) {
  const t0 = Date.now();
  let body;
  try { body = await request.json(); }
  catch (e) { return rpcError(null, -32700, 'Parse error', 400); }
  const msgs = Array.isArray(body) ? body : [body];
  const out = [];
  let caller = null;
  for (const m of msgs) {
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      out.push({ jsonrpc: '2.0', id: (m && m.id) || null, error: { code: -32600, message: 'Invalid Request' } });
      continue;
    }
    const isNotif = m.id === undefined || m.id === null;
    try {
      if (m.method === 'initialize') {
        out.push({ jsonrpc: '2.0', id: m.id, result: {
          protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO, instructions: INSTRUCTIONS,
        } });
      } else if (m.method === 'ping') {
        if (!isNotif) out.push({ jsonrpc: '2.0', id: m.id, result: {} });
      } else if (m.method === 'notifications/initialized' || m.method === 'notifications/cancelled') {
        // notification: khong tra loi
      } else if (m.method === 'tools/list') {
        caller = caller || (await resolveCaller(request, env));
        if (!caller) return rpcError(m.id, -32001, 'Not logged in', 401);
        const list = TOOLS.filter((t) => MCP_DEV_OPEN || caller.tier >= t.minTier).map((t) => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
          version: '1.0.0',
        }));
        out.push({ jsonrpc: '2.0', id: m.id, result: { tools: list } });
      } else if (m.method === 'tools/call') {
        caller = caller || (await resolveCaller(request, env));
        if (!caller) return rpcError(m.id, -32001, 'Not logged in', 401);
        const res = await handleToolsCall(env, caller, m.params || {}, t0);
        out.push({ jsonrpc: '2.0', id: m.id, result: res });
      } else {
        if (!isNotif) out.push({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } });
      }
    } catch (e) {
      if (!isNotif) out.push({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String((e && e.message) || e) } });
    }
  }
  if (!out.length) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// GET /api/mcp: GD1 khong mo SSE stream (thiet ke 2.2).
export async function hMcpGet() {
  return new Response(JSON.stringify({ error: 'MCP endpoint chi nhan POST (Streamable HTTP, khong SSE o Giai doan 1).' }), {
    status: 405, headers: { 'Content-Type': 'application/json' },
  });
}

// GET /api/admin/mcp-log?email=&tool=&limit= — truy vet luot goi MCP
// (route auth 'admin' o index.js da chan san).
export async function hMcpLogAdmin(request, env) {
  const u = new URL(request.url);
  const limit = Math.min(parseInt(u.searchParams.get('limit') || '100', 10) || 100, 500);
  const email = u.searchParams.get('email');
  const tool = u.searchParams.get('tool');
  await ensureLog(env);
  let sqlText = 'SELECT id, ts, user_email, plan, tool, params_json, status, refusal_code, verification_flags, result_rows, latency_ms, as_of, result_id, source_result FROM mcp_log';
  const conds = [], binds = [];
  if (email) { conds.push('user_email = ?'); binds.push(email); }
  if (tool) { conds.push('tool = ?'); binds.push(tool); }
  if (conds.length) sqlText += ' WHERE ' + conds.join(' AND ');
  sqlText += ' ORDER BY id DESC LIMIT ?';
  binds.push(limit);
  const rs = await env.DB.prepare(sqlText).bind(...binds).all();
  return new Response(JSON.stringify({ rows: rs.results || [] }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
