// Lớp dữ liệu bổ sung từ Finhay (bản NHÁP — chưa deploy, TASK 03/11).
// Hai lane mới, KHÔNG đụng lane quotes/indices/ohlcv hiện có:
//   GET  /api/stock/finhay/<path>      -> đọc R2 stock/market/finhay/<path>.json (public, edge-cache)
//   POST /api/internal/finhay-put      -> cron ghi {key, doc} vào cùng vị trí (X-Publish-Secret)
// Ghi chỉ giới hạn trong prefix market/finhay/ và có trần dung lượng.
import { jerr, sJson } from './utils.js';
import { sGet, sPut, cachedMarket } from './stock.js';

const KEY_RE = /^[a-z0-9][a-z0-9_\/-]{0,79}$/;          // không "." / "..", không dấu cách
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
