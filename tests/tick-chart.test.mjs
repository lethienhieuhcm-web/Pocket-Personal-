import fs from 'node:fs';
import vm from 'node:vm';
// Load stock-chart.js in a vm with minimal browser globals.
const src = fs.readFileSync('js/features/stock-chart.js', 'utf8');
const sandbox = {
  window: {}, document: { body: {} }, console,
  module: { exports: {} }, setTimeout, clearTimeout,
};
sandbox.window.LightweightCharts = undefined;
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch (e) { /* render path needs LWC; api still exported */ }
const api = sandbox.module.exports;
let pass = 0, fail = 0;
function t(name, cond) { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } }
t('api exposes applyTick', typeof api.applyTick === 'function');
t('api exposes planTick', typeof api.planTick === 'function');
t('api exposes bucketStart', typeof api.bucketStart === 'function');
t('api exposes lastCandleTime', typeof api.lastCandleTime === 'function');
// bucketStart
t('bucket 60s', api.bucketStart(540, 60) === 540);
t('bucket 60s mid', api.bucketStart(575, 60) === 540);
t('bucket 300s', api.bucketStart(1500, 300) === 1500);
t('bucket 300s mid', api.bucketStart(1600, 300) === 1500);
t('bucket bad -> null', api.bucketStart(NaN, 60) === null);
// planTick merge
const live = { time: 540, open: 50, high: 51, low: 49, close: 50.4, volume: 1000 };
let p = api.planTick(live, { time: 540, price: 52 });
t('merge action', p.action === 'merge');
t('merge close=52', p.candle.close === 52);
t('merge high=max', p.candle.high === 52);
t('merge low=min', p.candle.low === 49);
t('merge open kept', p.candle.open === 50);
t('merge time kept', p.candle.time === 540);
t('merge volume null when tick has no volume', p.volume === null);
let p2 = api.planTick(live, { time: 540, price: 48, volume: 200 });
t('merge low updates', p2.candle.low === 48);
t('merge volume adds when tick has volume', p2.volume === 1200);
// new minute -> 'new', old candle untouched
let p3 = api.planTick(live, { time: 600, price: 55 });
t('new minute -> new', p3.action === 'new');
t('old candle untouched on new', live.close === 50.4 && live.high === 51);
// old tick -> 'old'
let p4 = api.planTick(live, { time: 480, price: 55 });
t('old tick -> old', p4.action === 'old');
// bad price -> skip
let p5 = api.planTick(live, { time: 540, price: NaN });
t('bad price -> skip', p5.action === 'skip');
let p6 = api.planTick(live, { time: 540, price: 600 }); // > 10x close
t('unit outlier -> unit', p6.action === 'unit');
console.log(`tick-chart: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
