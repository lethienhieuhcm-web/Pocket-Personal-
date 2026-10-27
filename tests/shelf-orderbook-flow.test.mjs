// Unit test mock-R2 cho ke shelf 27/10 (worker/src/stock.js):
// hStockOrderbook, hStockOrderbookDates, hStockFlowHistory + nhanh
// flow_history cua hStockPublish. Chay: node tests/shelf-orderbook-flow.test.mjs
// (loader stub drizzle vi handler moi khong dung D1).
import { register } from 'node:module';
import { gzipSync } from 'node:zlib';
register('./shelf-loader.mjs', import.meta.url);
const stock = await import('../worker/src/stock.js');
const { hStockOrderbook, hStockOrderbookDates, hStockFlowHistory, hStockPublish,
  obCleanBook, obPickSnapshot, obNormalizeFlowRow } = stock;

let pass = 0, fail = 0;
function check(name, cond, extra){
  if(cond){ pass++; console.log('PASS', name); }
  else{ fail++; console.log('FAIL', name, extra ?? ''); }
}

class MockObj{
  constructor(v){ this.v = v; }
  async json(){ return typeof this.v === 'string' ? JSON.parse(this.v) : this.v; }
  async text(){ return typeof this.v === 'string' ? this.v : JSON.stringify(this.v); }
  async arrayBuffer(){
    if(Buffer.isBuffer(this.v)) return this.v.buffer.slice(this.v.byteOffset, this.v.byteOffset + this.v.byteLength);
    const b = Buffer.from(typeof this.v === 'string' ? this.v : JSON.stringify(this.v));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
}
function mockEnv(){
  const store = new Map();
  const DATA = {
    async get(k){ const v = store.get(k); return v === undefined ? null : new MockObj(v); },
    async put(k, v){ store.set(k, v); },
    async list({prefix}){ return {objects: [...store.keys()].filter(k => k.startsWith(prefix)).map(k => ({key: k})), truncated: false}; },
  };
  const AUTHDB = {
    async get(k){
      if(k.includes('test-token')) return new MockObj(JSON.stringify({email: 'test8b@local.test', exp: Date.now() + 3600e3, token: 'test-token'}));
      return null;
    },
    async put(){}, async delete(){},
  };
  return {env: {DATA, AUTHDB, STOCK_PUBLISH_SECRET: 's3cret'}, store};
}
const req = (url, body) => new Request(url, {
  method: body ? 'POST' : 'GET',
  headers: {Authorization: 'Bearer test-token', 'Content-Type': 'application/json',
    'X-Publish-Secret': 's3cret'},
  body: body ? JSON.stringify(body) : undefined,
});
const SNAP = 'stock/market/shadow_tick/src/orderbook-20261027/snapshot.json';
const book = (last) => ({last,
  bids: [[21.15, 25800], [21.10, 77400], [21.05, 84100], [null, null], [null, null], [null, null], [null, null], [null, null], [null, null], [null, null]],
  asks: [[21.20, 21900], [21.25, 35700], [21.30, 73100], [null, null], [null, null], [null, null], [null, null], [null, null], [null, null], [null, null]]});

// 1. Latest snapshot: null levels bi loai, tong la tong cac muc hien co.
{
  const {env} = mockEnv();
  env.DATA.put(SNAP, JSON.stringify({updated: '2026-10-27T10:00:05+07:00', by_symbol: {ACB: book(21.2)}}));
  const r = await hStockOrderbook(req('https://x/api/stock/orderbook?symbol=ACB&date=2026-10-27'), env);
  const j = await r.json();
  check('latest: 3 bid / 3 ask (null bi loai)', j.bids.length === 3 && j.asks.length === 3, JSON.stringify(j));
  check('latest: tong mua/ban = tong muc', j.total_bid_vol === 187300 && j.total_ask_vol === 130700, JSON.stringify(j));
  check('latest: spread 0.05, totals_are_sums, live', j.spread === 0.05 && j.totals_are_sums === true && j.live === true, JSON.stringify(j));
}
// 2. History: 3 snapshot/phut, chon gan nhat tai/truoc moc + fallback.
{
  const {env} = mockEnv();
  const lines = ['09:40', '09:41', '09:42'].map(t => JSON.stringify({t: `2026-10-27T${t}:00+07:00`, kind: 'book_minute', books: {ACB: book(21.2)}})).join('\n');
  env.DATA.put('stock/market/shadow_tick/raw/2026-10-27/orderbook-20261027/09/1.jsonl.gz', gzipSync(lines));
  const at = async (time) => {
    const r = await hStockOrderbook(req(`https://x/api/stock/orderbook?symbol=ACB&date=2026-10-27&time=${encodeURIComponent(time)}`), env);
    return r.json();
  };
  const mid = await at('09:41:30');
  check('history: 09:41:30 -> snapshot 09:41', mid.time === '2026-10-27T09:41:00+07:00' && mid.live === false, JSON.stringify(mid));
  const after = await at('09:45');
  check('history: 09:45 -> snapshot cuoi 09:42', after.time === '2026-10-27T09:42:00+07:00', JSON.stringify(after));
  const before = await at('09:39');
  check('history: 09:39 -> empty', before.empty === true && before.time === null, JSON.stringify(before));
}
// 3. Dates: parse YYYYMMDD tu snapshot keys, moi nhat truoc.
{
  const {env} = mockEnv();
  env.DATA.put(SNAP, JSON.stringify({by_symbol: {}}));
  env.DATA.put('stock/market/shadow_tick/src/orderbook-20261028/snapshot.json', JSON.stringify({by_symbol: {}}));
  env.DATA.put('stock/market/shadow_tick/src/orderbook-20261028/health.json', JSON.stringify({}));
  const r = await hStockOrderbookDates(req('https://x/api/stock/orderbook/dates?symbol=ACB'), env);
  const j = await r.json();
  check('dates: 2 ngay, moi nhat truoc, health khong tinh', JSON.stringify(j.dates) === JSON.stringify(['2026-10-28', '2026-10-27']), JSON.stringify(j));
}
// 4. Flow history: gia tri co va thieu, sap xep giam dan, net tinh san.
{
  const {env} = mockEnv();
  env.DATA.put('stock/flow/foreign/ACB.json', JSON.stringify({updated: '2026-10-27T18:00:00+07:00', symbol: 'ACB', group: 'foreign', rows: [
    {date: '2026-10-27', buy_vol: 2083900, sell_vol: 5069200, buy_val: 44000000000, sell_val: 107000000000},
    {date: '2026-10-28', buy_vol: 100, sell_vol: 50, buy_val: null, sell_val: null},
  ]}));
  const r = await hStockFlowHistory(req('https://x/api/stock/flow-history?symbol=ACB&group=foreign&days=90'), env);
  const j = await r.json();
  check('flow: giam dan theo date', j.rows[0].date === '2026-10-28' && j.rows[1].date === '2026-10-27', JSON.stringify(j));
  check('flow: net_vol co, net_val null khi thieu', j.rows[0].net_vol === 50 && j.rows[0].net_val === null && j.rows[1].net_vol === -2985300, JSON.stringify(j));
  const nodata = await (await hStockFlowHistory(req('https://x/api/stock/flow-history?symbol=ACB&group=individual&days=90'), env)).json();
  check('flow: nhom chua co -> no-data, khong dong gia', nodata.available === false && nodata.rows.length === 0 && nodata.note === 'no-data', JSON.stringify(nodata));
}
// 5. Publish flow_history: merge theo ngay, giu ngay cu, sap xep tang dan.
{
  const {env, store} = mockEnv();
  const r = await hStockPublish(req('https://x/api/internal/stock-publish', {flow_history: {foreign: {ACB: [
    {date: '2026-10-27', buy_vol: 10, sell_vol: 4, buy_val: null, sell_val: null},
    {date: '2026-10-28', buy_vol: 20, sell_vol: 5, buy_val: 100, sell_val: 50},
  ]}, proprietary: {}}}), env);
  const pub = await r.json();
  check('publish: ok, written>=1', pub.ok === true && pub.written >= 1, JSON.stringify(pub));
  const stored = JSON.parse(store.get('stock/flow/foreign/ACB.json'));
  check('publish: file stock/flow/foreign/ACB.json, 2 ngay tang dan', stored.rows.length === 2 && stored.rows[0].date === '2026-10-27' && stored.rows[1].net_val === 50, JSON.stringify(stored));
  // Publish lai cung ngay -> ghi de, khong trung.
  await hStockPublish(req('https://x/api/internal/stock-publish', {flow_history: {foreign: {ACB: [
    {date: '2026-10-27', buy_vol: 11, sell_vol: 4, buy_val: null, sell_val: null},
  ]}}}), env);
  const stored2 = JSON.parse(store.get('stock/flow/foreign/ACB.json'));
  check('publish lai cung ngay: ghi de, van 2 ngay', stored2.rows.length === 2 && stored2.rows[0].buy_vol === 11, JSON.stringify(stored2));
}
// 6. Ham thuan: null levels + pick + normalize.
{
  const c = obCleanBook({last: 56.3, bids: [[56.2, 41900], [null, null]], asks: []});
  check('pure obCleanBook: loai null, spread null khi thieu ask', c.bids.length === 1 && c.spread === null && c.total_bid_vol === 41900, JSON.stringify(c));
  const p = obPickSnapshot([
    {t: '2026-10-27T09:40:00+07:00', kind: 'book_minute', books: {ACB: book(21.1)}},
    {t: '2026-10-27T09:41:00+07:00', kind: 'trade', books: {ACB: book(21.2)}},
    {t: '2026-10-27T09:41:00+07:00', kind: 'book_minute', books: {ACB: book(21.2)}},
  ], 'ACB', '2026-10-27T09:41:30+07:00');
  check('pure obPickSnapshot: bo dong kind khac, chon 09:41', p && p.t === '2026-10-27T09:41:00+07:00' && p.book.last === 21.2, JSON.stringify(p));
  const n = obNormalizeFlowRow({date: '2026-10-27', buy_vol: 5, sell_vol: 2});
  check('pure obNormalizeFlowRow: thieu value -> null, net_vol tinh', n.net_vol === 3 && n.net_val === null, JSON.stringify(n));
  check('pure obNormalizeFlowRow: date sai -> null', obNormalizeFlowRow({date: 'x', buy_vol: 1}) === null);
}
// 7. Validation: symbol sai -> 400.
{
  const {env} = mockEnv();
  const r = await hStockOrderbook(req('https://x/api/stock/orderbook?symbol=ACB1!'), env);
  check('validation: symbol sai -> 400', r.status === 400, String(r.status));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
