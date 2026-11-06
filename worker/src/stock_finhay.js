// Lớp dữ liệu bổ sung từ Finhay (bản NHÁP — chưa deploy, TASK 03/11).
// Hai lane mới, KHÔNG đụng lane quotes/indices/ohlcv hiện có:
//   GET  /api/stock/finhay/<path>      -> đọc R2 stock/market/finhay/<path>.json (public, edge-cache)
//   POST /api/internal/finhay-put      -> cron ghi {key, doc} vào cùng vị trí (X-Publish-Secret)
// Ghi chỉ giới hạn trong prefix market/finhay/ và có trần dung lượng.
// Reader thật cho nen 1D (duy nhat co trong R2): cuoi file — hFinhayOhlcv, hFinhayCompare.
import { jerr, sJson } from './utils.js';
import { sGet, sPut, cachedMarket } from './stock.js';

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\/-]{0,79}$/;       // không "." / "..", không dấu cách; A-Z cho mã CK (reports/FPT)
const MAX_DOC_BYTES = 3 * 1024 * 1024;                   // 3MB/lượt ghi
const MAX_KEYS_PER_PUT = 8;

function finhayKey(rawKey) {
  if (typeof rawKey !== 'string') return null;
  const key = rawKey.replace(/^\/+/, '').replace(/\.json$/, '');
  if (!KEY_RE.test(key) || key.includes('..')) return null;
  return `market/finhay/${key}.json`;
}

const READ_PREFIX = '/api/stock/finhay/';

export async function hStockFinhay(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(READ_PREFIX)) return jerr('Invalid key', 400);
  const rest = decodeURIComponent(url.pathname.slice(READ_PREFIX.length)).replace(/\/+$/, '');
  const key = finhayKey(rest);
  if (!key) return jerr('Invalid key', 400);
  const ttl = Number(url.searchParams.get('ttl') || 300);
  return cachedMarket(request, env, key, Math.max(60, Math.min(ttl, 3600)));
}

export async function hFinhayPut(request, env) {
  const got = request.headers.get('X-Publish-Secret') || request.headers.get('X-Internal-Secret') || '';
  const want = env.STOCK_PUBLISH_SECRET || env.INTERNAL_SECRET || '';
  if (!want || got !== want) return jerr('Forbidden', 403);
  let body;
  try { body = await request.json(); } catch (e) { return jerr('Bad JSON', 400); }
  const items = body.docs && typeof body.docs === 'object'
    ? Object.entries(body.docs)
    : [['key' in body ? body.key : null, body.doc]];
  if (items.length > MAX_KEYS_PER_PUT) return jerr('Too many keys (max 8)', 400);
  const prov = body._prov && typeof body._prov === 'object' ? body._prov : null;
  const now = new Date().toISOString();
  const written = [];
  const rejected = [];
  for (const [rawKey, doc] of items) {
    const key = finhayKey(rawKey);
    if (!key) { rejected.push({ key: String(rawKey), reason: 'invalid key (chỉ a-z0-9/_-, không "..")' }); continue; }
    if (doc === null || doc === undefined || typeof doc !== 'object') { rejected.push({ key: rawKey, reason: 'doc phải là object' }); continue; }
    const payload = prov ? Object.assign({ updated: now, _prov: prov }, doc) : Object.assign({ updated: now }, doc);
    const text = JSON.stringify(payload);
    if (text.length > MAX_DOC_BYTES) { rejected.push({ key: rawKey, reason: `vượt trần ${MAX_DOC_BYTES} bytes` }); continue; }
    await sPut(env, key, payload);
    written.push({ key: rawKey, bytes: text.length });
  }
  return sJson({ ok: rejected.length === 0, written, rejected, at: now });
}

export async function hFinhayGetRaw(request, env) {
  const url = new URL(request.url);
  const key = finhayKey(url.searchParams.get('key') || '');
  if (!key) return jerr('Invalid key', 400);
  return sJson(await sGet(env, key));
}

/* ---------- NEN 1D Finhay -> shape cua lane `ohlcv` (duoc doc bang reader that) ----------
 * R2 chi co MOT kieu du lieu Finhay: `market/finhay/candles/<SYM>.json`
 * (1517 ma, ~108 MB, schema `finhay.ohlcv_1d.v1`, 5 nam nen 1D). Lane doc
 * `hStockFinhay` o tren tra nguyen blob nay, nen khong code nao dung duoc:
 * no dung `bars[]` + `t` = unix giây, con toan bo nen cua he thongo (chart,
 * indicators, getOhlcvSummary) doc `rows[]` + `t` = "YYYY-MM-DD" tu
 * `market/ohlcv/<SYM>.json` (xem hStockOhlcv, stock.js:560).
 * Ba ham duoi dich sang shape do va doi chieu voi nen chinh — KHONG ghi R2,
 * KHONG doi lane cua. */

const CANDLES_PREFIX = 'market/finhay/candles/';
const DAY_MS = 86400000;
// gia VN buoc nhay 0.1 NGHIN_VND; kenh chinh luu 3 le, Finhay 2 le -> lech
// < 1/2 buoc nhay la NHU NHAU, khong phai sai lech. Do bang so tuyet doi
// (ty le se bao dong khi gia ret, nhu FPT 44 -> 0.008% = 0.0035 = < 1 tick).
const CMP_TICK = 0.05;
const CMP_TOL_REL = 1; // chan du cho ma lech thuc (>=1% = khong con buoc nhay)

// `t` cua Finhay la unix giây nua dem UTC -> cat ISO ra dung ngay giao dich.
export function finhayBarDay(t) {
  if (typeof t !== 'number' || !isFinite(t)) return null;
  const ms = t > 1e11 ? t : t * 1000;
  const iso = new Date(ms).toISOString().slice(0, 10);
  return iso.length === 10 ? iso : null;
}

// Doc -> {symbol, updated, rows[], first, last, stale_days}; null khi khong doc duoc.
export function finhayCandlesToRows(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.bars)) return null;
  const rows = [];
  for (const b of doc.bars) {
    if (!b || typeof b !== 'object') continue;
    const t = finhayBarDay(b.t);
    if (!t) continue;
    rows.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const updated = doc.updated || null;
  const age = updated ? Date.now() - Date.parse(updated) : null;
  return {
    symbol: doc.symbol || null,
    schema: doc.schema || 'finhay.ohlcv_1d.v1',
    source: 'finhay',
    unit: doc.unit || 'NGHIN_VND',
    updated,
    first: rows[0].t,
    last: rows[rows.length - 1].t,
    count: rows.length,
    stale_days: age == null || !isFinite(age) ? null : Math.max(0, Math.round(age / DAY_MS)),
    rows,
  };
}

export async function finhayCandles(env, sym) {
  sym = String(sym || '').toUpperCase();
  if (!sym || !finhayKey('candles/' + sym)) return null;
  const doc = await sGet(env, CANDLES_PREFIX + sym + '.json');
  return finhayCandlesToRows(doc);
}

// GET /api/stock/finhay-ohlcv?symbol=FPT&count=120
// Tra dung envelope nhu /api/stock/ohlcv&interval=1D (rows[] + t ISO), nen ben
// goi hien tai co the dung thang. Khong co file -> empty shape (200), khong 500.
export async function hFinhayOhlcv(request, env) {
  const u = new URL(request.url);
  const sym = (u.searchParams.get('symbol') || '').toUpperCase();
  if (!sym) return jerr('Symbol required', 400);
  const d = await finhayCandles(env, sym);
  if (!d) return sJson({ symbol: sym, empty: true, rows: [], count: 0, updated: null, source: 'finhay' });
  const count = Math.max(1, Math.min(parseInt(u.searchParams.get('count') || '500', 10) || 500, 5000));
  return sJson({ symbol: sym, interval: '1D', source: 'finhay', unit: d.unit, schema: d.schema,
    updated: d.updated, first: d.first, last: d.last, total: d.count, stale_days: d.stale_days,
    count: Math.min(count, d.count), rows: d.rows.slice(-count) });
}

// GET /api/stock/finhay-compare?symbol=FPT&days=60
// Doi chieu gia dong nhat gitua nen chinh `market/ohlcv/` va nen Finhay.
// Day la "price comparison" duy nhat lam duoc voi du lieu Finhay THAT su co
// trong R2 (chi co nen 1D — khong co 15 phut, xem REPORT). Chi doc.
export async function hFinhayCompare(request, env) {
  const u = new URL(request.url);
  const sym = (u.searchParams.get('symbol') || '').toUpperCase();
  if (!sym) return jerr('Symbol required', 400);
  const days = Math.max(1, Math.min(parseInt(u.searchParams.get('days') || '60', 10) || 60, 2000));
  const [fh, primary] = await Promise.all([
    finhayCandles(env, sym),
    sGet(env, 'market/ohlcv/' + sym + '.json'),
  ]);
  const out = { symbol: sym, primary: null, finhay: null, compared: 0,
    within_tol: 0, mismatches: [], max_abs_diff: null, missing_in_finhay: 0,
    tick_tolerance: CMP_TICK, days };
  if (primary && Array.isArray(primary.rows) && primary.rows.length) {
    const pr = primary.rows.slice(-days);
    out.primary = { updated: primary.updated || null, first: pr[0].t, last: pr[pr.length - 1].t, count: pr.length };
  }
  if (fh) {
    out.finhay = { updated: fh.updated, first: fh.first, last: fh.last, count: fh.count, stale_days: fh.stale_days };
  }
  if (!fh || !out.primary) {
    out.partial = !fh ? 'no_finhay_candles' : 'no_primary_ohlcv';
    return sJson(out);
  }
  const pmap = new Map();
  for (const r of primary.rows) if (r && r.t) pmap.set(r.t, r);
  const fmap = new Map();
  for (const b of fh.rows) fmap.set(b.t, b);
  const window = primary.rows.slice(-days).map(r => r.t);
  let worst = null;
  for (const t of window) {
    const p = pmap.get(t);
    if (!p || p.c == null) continue;
    const f = fmap.get(t);
    // Ngay co nen chinh ma Finhay khong co = duong trong cua kenh dong (03/11).
    if (!f || f.c == null) { out.missing_in_finhay++; continue; }
    out.compared++;
    const diff = f.c - p.c;
    const rel = p.c ? Math.abs(diff) / Math.abs(p.c) * 100 : (diff === 0 ? 0 : Infinity);
    if (worst === null || Math.abs(diff) > Math.abs(worst)) worst = diff;
    if (Math.abs(diff) <= CMP_TICK && rel <= CMP_TOL_REL) { out.within_tol++; continue; }
    if (out.mismatches.length < 20) out.mismatches.push({ t, primary: p.c, finhay: f.c, diff: Math.round(diff * 1000) / 1000, diff_pct: Math.round(rel * 1000) / 1000 });
  }
  out.max_abs_diff = worst === null ? null : Math.round(worst * 1000) / 1000;
  return sJson(out);
}
