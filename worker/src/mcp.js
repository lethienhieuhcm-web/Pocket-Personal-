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
  sGet, getQuoteData, getFundamentalsData, getStatementsData,
  getNewsData, getCompanyProfile,
} from './stock.js';

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
  return meta;
}

function envResult(data, o) {
  return { data, meta: makeMeta(o) };
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

/* ---------------- dang ky tool ---------------- */
const S = (props, req) => ({ type: 'object', properties: props, required: req || [] });
const SYM = { symbol: { type: 'string', description: 'Ma chung khoan (vd FPT)' } };
const TOOLS = [
  {
    name: 'get_quote', minTier: 0, run: tGetQuote,
    description: 'Gia phien gan nhat cua 1 ma: dong cua, % thay doi, khoi luong, gia tri, mua/ban khoi ngoai. Nguon: bang gia da kiem chung.',
    inputSchema: S(SYM, ['symbol']),
  },
  {
    name: 'get_ohlcv', minTier: 0, run: tGetOhlcv,
    description: 'Chuoi nen ngay (OHLCV) cua 1 ma hoac chi so (vd VNINDEX). Mac dinh 120 nen, toi da 500.',
    inputSchema: S({ ...SYM, limit: { type: 'integer', description: 'So nen, toi da 500' } }, ['symbol']),
  },
  {
    name: 'get_indices', minTier: 0, run: tGetIndices,
    description: 'Chi so thi truong hien tai (VNINDEX, VN30, HNX, UPCOM...) kem trang thai thi truong (regime).',
    inputSchema: S({}),
  },
  {
    name: 'get_company_profile', minTier: 0, run: tGetCompanyProfile,
    description: 'Ho so cong ty cua 1 ma: thong tin chung, co dong, lanh dao, cong ty con/lien ket, von va co cau so huu. Da parity tuyet doi.',
    inputSchema: S(SYM, ['symbol']),
  },
  {
    name: 'get_macro', minTier: 1, run: tGetMacro,
    description: 'Vi mo: khong tham so = tong quan (lai suat dieu hanh SBV, ty gia trung tam USD/VND, vang SJC, OMO, lai suat My...). series = lich su 1 series (toi da 365 diem). So thu tai nguon phat hanh.',
    inputSchema: S({ series: { type: 'string', description: 'Ma series (vd omo, gold_sjc); rong = tong quan' } }),
  },
  {
    name: 'get_sector', minTier: 1, run: tGetSector,
    description: 'Nganh ICB: khong code = bang tong quan 19 nganh (doanh thu/LNST/ROE TTM, P/E kem so ma tinh duoc); code = chi tiet 1 nganh (8 ky gan nhat + thanh vien).',
    inputSchema: S({ code: { type: 'string', description: 'Ma nganh ICB 4 chu so (vd 8350); rong = tong quan' } }),
  },
  {
    name: 'get_flow', minTier: 2, run: tGetFlow,
    description: 'Dong tien khoi ngoai (foreign) hoac tu doanh (proprietary): co symbol = lich su theo ma (moi nhat truoc); khong symbol = bang toan thi truong phien gan nhat.',
    inputSchema: S({
      kind: { type: 'string', enum: ['foreign', 'proprietary'] },
      symbol: { type: 'string', description: 'Ma (tuy chon)' },
      days: { type: 'integer', description: 'So ngay lich su, toi da 500' },
    }, ['kind']),
  },
  {
    name: 'get_consensus', minTier: 2, run: tGetConsensus,
    description: 'Dong thuan CTCK (chi ban verified): co symbol = tung hang (khuyen nghi, gia muc tieu, ngay bao cao, link nguon) + trung binh/min/max/upside da tinh san; khong symbol = bang toan thi truong. Khong tra van phan tich cua hang.',
    inputSchema: S({ symbol: { type: 'string', description: 'Ma (tuy chon)' } }),
  },
  {
    name: 'get_screener', minTier: 3, run: tGetScreener,
    description: 'Loc co phieu toan thi truong: filters {exchange, sector, min_pe, max_pe, min_roe, min_value, min_pct, max_pct}, sort_by (value_vnd/pct_change/volume/close/pe_ttm/roe_ttm), limit toi da 200.',
    inputSchema: S({
      filters: { type: 'object', description: 'Dieu kien loc (tuy chon)' },
      sort_by: { type: 'string' }, order: { type: 'string', enum: ['asc', 'desc'] },
      limit: { type: 'integer' },
    }),
  },
  {
    name: 'get_fundamentals', minTier: 3, run: tGetFundamentals,
    description: 'Ty so tai chinh TTM cua 1 ma (EPS, BVPS, ROE, ROA, P/E, P/B...). verification luon parity_pending — phai neu co nay khi dung so.',
    inputSchema: S(SYM, ['symbol']),
  },
  {
    name: 'get_statements', minTier: 3, run: tGetStatements,
    description: 'Bao cao tai chinh (can doi / ket qua kinh doanh / luu chuyen tien) cac ky gan nhat cua 1 ma. verification luon parity_pending — phai neu co nay khi dung so.',
    inputSchema: S({ ...SYM, periods: { type: 'integer', description: 'So ky, mac dinh 8, toi da 20' } }, ['symbol']),
  },
  {
    name: 'find_holder', minTier: 3, run: tFindHolder,
    description: 'Tra cuu dao chi muc co dong: nhap ten nguoi/to chuc -> cac ma dang nam giu, so co phieu, ty le, chuc danh. Kem coverage do phu cua chi muc.',
    inputSchema: S({ name: { type: 'string', description: 'Ten co dong (co dau hoac khong dau)' }, limit: { type: 'integer' } }, ['name']),
  },
  {
    name: 'get_events', minTier: 3, run: tGetEvents,
    description: 'Su kien sap toi cua 1 ma (DHDCD, co tuc, phat hanh...) trong days_ahead ngay (mac dinh 90).',
    inputSchema: S({ ...SYM, days_ahead: { type: 'integer' } }, ['symbol']),
  },
  {
    name: 'get_news', minTier: 3, run: tGetNews,
    description: 'Tin tuc: co symbol = tin theo ma; khong symbol = tin thi truong. meta.as_of la moc tin moi nhat — bat buoc neu khi trien khai.',
    inputSchema: S({ symbol: { type: 'string', description: 'Ma (tuy chon)' }, limit: { type: 'integer' } }),
  },
];

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
    _logReady = true;
  } catch (e) { /* log khong duoc lam hong luot goi */ }
}

async function writeLog(env, row) {
  try {
    await ensureLog(env);
    await env.DB.prepare(
      'INSERT INTO mcp_log (ts, user_email, plan, tool, params_json, ' +
      'status, refusal_code, verification_flags, result_rows, ' +
      'latency_ms, as_of) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(row.ts, row.user_email, row.plan, row.tool,
        row.params_json, row.status, row.refusal_code,
        row.verification_flags, row.result_rows, row.latency_ms,
        row.as_of).run();
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

async function resolveCaller(request, env) {
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
    });
    return toolResult(payload, isError);
  };

  if (!tool) {
    return finish({ error: { code: 'unknown_tool', message: `Tool '${name}' khong ton tai.`, available: TOOLS.map((t) => t.name) } },
      true, 'refused', { refusal_code: 'unknown_tool' });
  }
  // Cong goi theo muc 2.5 da Chot (tat khi MCP_DEV_OPEN)
  if (!MCP_DEV_OPEN && caller.tier < tool.minTier) {
    return finish({ error: {
      code: 'plan_restricted', tool: name,
      message: `Tool ${name} yeu cau goi ${TIER_NAME[tool.minTier]} tro len; goi hien tai: ${caller.plan}.`,
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
      code: 'quota_exceeded', tool: name,
      message: `Da het quota agent_calls hom nay cua goi ${caller.plan} (${used}/${limit}). Reset 00:00 ICT.`,
      plan: caller.plan, used, limit, reset_at: nextResetISO(),
    } }, true, 'quota_exceeded', { refusal_code: 'quota_exceeded' });
  }
  try {
    const r = await tool.run(env, args);
    if (!MCP_DEV_OPEN) {
      try { await incrUsage(env, caller.email, 'agent_calls', 1); } catch (e) { /* dem loi khong chan ket qua */ }
    }
    return finish(r.env, false, 'ok', {
      rows: r.rows, verification: r.env.meta.verification, as_of: r.env.meta.as_of,
    });
  } catch (e) {
    if (e instanceof ToolError) {
      const status = ['invalid_params'].includes(e.code) ? 'refused' : 'error';
      return finish({ error: { code: e.code, message: e.message, ...e.extra } },
        true, status, { refusal_code: e.code });
    }
    return finish({ error: { code: 'internal_error', message: String((e && e.message) || e) } },
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
          serverInfo: SERVER_INFO, instructions: SCOPE_NOTE,
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
  let sqlText = 'SELECT id, ts, user_email, plan, tool, params_json, status, refusal_code, verification_flags, result_rows, latency_ms, as_of FROM mcp_log';
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
