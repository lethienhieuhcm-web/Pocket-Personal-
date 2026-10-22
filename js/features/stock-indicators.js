/* PP_IND — client-side technical indicator engine.
 *
 * Implements standard, publicly documented TradingView/textbook indicator
 * formulas (Wilder smoothing for RSI/ATR/ADX/SAR, etc.) driven by the study
 * catalog in stock-indicators-spec.js (window.PP_STUDIES). Written from the
 * standard definitions + the spec's parameter metadata only.
 *
 * API:
 *   PP_IND.compute(studyName, bars, inputs) -> { plots: [...], bands: [...] }
 *     bars: [{t,o,h,l,c,v}] ascending; plot values are arrays aligned 1:1
 *     with bars (null where the indicator is not yet defined).
 *   PP_IND.implemented -> [studyName, ...]
 *   PP_IND.helpers -> { sma, ema, wma, rma, stdev, atr }
 */
(function () {
  'use strict';

  // ---------------- generic utilities ----------------
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function nul(n) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = null; return a; }
  function num(v, d) { var x = (typeof v === 'string') ? parseFloat(v) : v; return isNum(x) ? x : d; }
  function intv(v, d) { var x = num(v, d); return Math.max(1, Math.floor(x)); }
  function map1(a, f) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i++) { var v = a[i]; out[i] = (v == null || !isFinite(v)) ? null : f(v, i); }
    return out;
  }
  function binop(a, b, f) {
    var n = a.length, out = new Array(n);
    for (var i = 0; i < n; i++) {
      var x = a[i], y = Array.isArray(b) ? b[i] : b;
      out[i] = (x == null || y == null || !isFinite(x) || !isFinite(y)) ? null : f(x, y);
    }
    return out;
  }
  function add(a, b) { return binop(a, b, function (x, y) { return x + y; }); }
  function sub(a, b) { return binop(a, b, function (x, y) { return x - y; }); }
  function mul(a, b) { return binop(a, b, function (x, y) { return x * y; }); }
  function div(a, b) { return binop(a, b, function (x, y) { return y === 0 ? null : x / y; }); }
  function shiftArr(a, by) {
    var n = a.length, out = nul(n);
    for (var i = 0; i < n; i++) { var j = i - by; if (j >= 0 && j < n) out[i] = a[j]; }
    return out;
  }

  // ---------------- primitive helpers (null-padded, aligned) ----------------
  function sma(src, len) {
    len = Math.max(1, Math.floor(num(len, 1)));
    var n = src.length, out = nul(n), sum = 0, cnt = 0;
    for (var i = 0; i < n; i++) {
      var v = src[i];
      if (v == null || !isFinite(v)) { sum = 0; cnt = 0; continue; }
      sum += v; cnt++;
      if (cnt > len) sum -= src[i - len];
      if (cnt >= len) out[i] = sum / len;
    }
    return out;
  }
  function ema(src, len) {
    len = Math.max(1, Math.floor(num(len, 1)));
    var n = src.length, out = nul(n), k = 2 / (len + 1), prev = null;
    for (var i = 0; i < n; i++) {
      var v = src[i];
      if (v == null || !isFinite(v)) { out[i] = prev; continue; }
      prev = (prev === null) ? v : k * v + (1 - k) * prev;
      out[i] = prev;
    }
    return out;
  }
  function wma(src, len) {
    len = Math.max(1, Math.floor(num(len, 1)));
    var n = src.length, out = nul(n), den = len * (len + 1) / 2;
    for (var i = 0; i < n; i++) {
      if (i < len - 1) continue;
      var s = 0, ok = true;
      for (var j = 0; j < len; j++) {
        var v = src[i - len + 1 + j];
        if (v == null || !isFinite(v)) { ok = false; break; }
        s += v * (j + 1);
      }
      if (ok) out[i] = s / den;
    }
    return out;
  }
  function rma(src, len) { // Wilder moving average
    len = Math.max(1, Math.floor(num(len, 1)));
    var n = src.length, out = nul(n), sum = 0, cnt = 0, prev = null;
    for (var i = 0; i < n; i++) {
      var v = src[i];
      if (v == null || !isFinite(v)) { out[i] = prev; continue; }
      if (prev === null) {
        sum += v; cnt++;
        if (cnt >= len) { prev = sum / len; out[i] = prev; }
      } else {
        prev = (prev * (len - 1) + v) / len;
        out[i] = prev;
      }
    }
    return out;
  }
  function stdev(src, len) { // population stdev (TradingView default, biased)
    len = Math.max(1, Math.floor(num(len, 1)));
    var n = src.length, out = nul(n), sum = 0, sq = 0, cnt = 0;
    for (var i = 0; i < n; i++) {
      var v = src[i];
      if (v == null || !isFinite(v)) { sum = 0; sq = 0; cnt = 0; continue; }
      sum += v; sq += v * v; cnt++;
      if (cnt > len) { var o = src[i - len]; sum -= o; sq -= o * o; }
      if (cnt >= len) {
        var m = sum / len, va = sq / len - m * m;
        out[i] = Math.sqrt(Math.max(0, va));
      }
    }
    return out;
  }
  function trueRange(bars) {
    var n = bars.length, out = nul(n);
    for (var i = 0; i < n; i++) {
      var b = bars[i]; if (!b) continue;
      if (i === 0 || bars[i - 1] == null || !isNum(bars[i - 1].c)) { out[i] = b.h - b.l; continue; }
      var pc = bars[i - 1].c;
      out[i] = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    }
    return out;
  }
  function atr(bars, len) { return rma(trueRange(bars), len); }
  function highest(src, len) {
    len = Math.max(1, Math.floor(num(len, 1)));
    var n = src.length, out = nul(n);
    for (var i = 0; i < n; i++) {
      if (i < len - 1) continue;
      var m = -Infinity, ok = true;
      for (var j = i - len + 1; j <= i; j++) { var v = src[j]; if (v == null || !isFinite(v)) { ok = false; break; } if (v > m) m = v; }
      if (ok) out[i] = m;
    }
    return out;
  }
  function lowest(src, len) {
    len = Math.max(1, Math.floor(num(len, 1)));
    var n = src.length, out = nul(n);
    for (var i = 0; i < n; i++) {
      if (i < len - 1) continue;
      var m = Infinity, ok = true;
      for (var j = i - len + 1; j <= i; j++) { var v = src[j]; if (v == null || !isFinite(v)) { ok = false; break; } if (v < m) m = v; }
      if (ok) out[i] = m;
    }
    return out;
  }
  function sumArr(src, len) {
    len = Math.max(1, Math.floor(num(len, 1)));
    var n = src.length, out = nul(n), sum = 0, cnt = 0;
    for (var i = 0; i < n; i++) {
      var v = src[i];
      if (v == null || !isFinite(v)) { sum = 0; cnt = 0; continue; }
      sum += v; cnt++;
      if (cnt > len) sum -= src[i - len];
      if (cnt >= len) out[i] = sum;
    }
    return out;
  }
  function change(src, len) {
    len = Math.max(1, Math.floor(num(len, 1)));
    var n = src.length, out = nul(n);
    for (var i = 0; i < n; i++) {
      if (i < len) continue;
      if (src[i] != null && src[i - len] != null) out[i] = src[i] - src[i - len];
    }
    return out;
  }
  function rocPct(src, len) {
    len = Math.max(1, Math.floor(num(len, 1)));
    var n = src.length, out = nul(n);
    for (var i = 0; i < n; i++) {
      if (i < len) continue;
      var p = src[i - len];
      if (src[i] != null && p != null && p !== 0) out[i] = 100 * (src[i] - p) / p;
    }
    return out;
  }
  function linreg(src, len) { // returns {end, slope} — least-squares fit per window
    len = Math.max(2, Math.floor(num(len, 2)));
    var n = src.length, end = nul(n), slope = nul(n);
    var sx = len * (len - 1) / 2, sxx = (len - 1) * len * (2 * len - 1) / 6;
    var den = len * sxx - sx * sx;
    for (var i = 0; i < n; i++) {
      if (i < len - 1) continue;
      var sy = 0, sxy = 0, ok = true;
      for (var j = 0; j < len; j++) {
        var v = src[i - len + 1 + j];
        if (v == null || !isFinite(v)) { ok = false; break; }
        sy += v; sxy += j * v;
      }
      if (!ok || den === 0) continue;
      var sl = (len * sxy - sx * sy) / den;
      var ic = (sy - sl * sx) / len;
      slope[i] = sl;
      end[i] = ic + sl * (len - 1);
    }
    return { end: end, slope: slope };
  }
  function maByType(type, src, len) {
    var t = String(type || 'SMA').toUpperCase();
    if (t === 'EMA') return ema(src, len);
    if (t === 'WMA') return wma(src, len);
    if (t === 'RMA' || t === 'SMMA') return rma(src, len);
    return sma(src, len);
  }
  function swma4(src) { // symmetric WMA over 4 bars (weights 1,2,2,1)
    var n = src.length, out = nul(n);
    for (var i = 3; i < n; i++) {
      var a = src[i - 3], b = src[i - 2], c = src[i - 1], d = src[i];
      if (a == null || b == null || c == null || d == null) continue;
      out[i] = (a + 2 * b + 2 * c + d) / 6;
    }
    return out;
  }
  function rsiCalc(src, len) { // Wilder RSI
    len = Math.max(1, Math.floor(num(len, 14)));
    var n = src.length, out = nul(n);
    var gains = 0, losses = 0, cnt = 0, avgG = null, avgL = null;
    for (var i = 1; i < n; i++) {
      if (src[i] == null || src[i - 1] == null || !isFinite(src[i]) || !isFinite(src[i - 1])) continue;
      var ch = src[i] - src[i - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
      if (avgG === null) {
        gains += g; losses += l; cnt++;
        if (cnt >= len) {
          avgG = gains / len; avgL = losses / len;
          out[i] = (avgL === 0) ? 100 : 100 - 100 / (1 + avgG / avgL);
        }
      } else {
        avgG = (avgG * (len - 1) + g) / len;
        avgL = (avgL * (len - 1) + l) / len;
        out[i] = (avgL === 0) ? 100 : 100 - 100 / (1 + avgG / avgL);
      }
    }
    return out;
  }
  function wilderSum(src, len) { // Wilder cumulative smoothing used by DMI/ADX
    len = Math.max(1, Math.floor(num(len, 14)));
    var n = src.length, out = nul(n), prev = null, sum = 0, cnt = 0;
    for (var i = 0; i < n; i++) {
      var v = src[i];
      if (v == null || !isFinite(v)) { out[i] = prev; continue; }
      if (prev === null) {
        sum += v; cnt++;
        if (cnt >= len) { prev = sum; out[i] = prev; }
      } else {
        prev = prev - prev / len + v;
        out[i] = prev;
      }
    }
    return out;
  }
  function dmiCalc(ctx, diLen, adxLen) {
    var n = ctx.n, H = ctx.H, L = ctx.L, C = ctx.C;
    var tr = trueRange(ctx.bars);
    var plusDM = nul(n), minusDM = nul(n);
    plusDM[0] = 0; minusDM[0] = 0;
    for (var i = 1; i < n; i++) {
      var up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
      plusDM[i] = (up > dn && up > 0) ? up : 0;
      minusDM[i] = (dn > up && dn > 0) ? dn : 0;
    }
    var smTR = wilderSum(tr, diLen), smP = wilderSum(plusDM, diLen), smM = wilderSum(minusDM, diLen);
    var pDI = nul(n), mDI = nul(n), dx = nul(n);
    for (var j = 0; j < n; j++) {
      if (smTR[j] != null && smTR[j] !== 0 && smP[j] != null && smM[j] != null) {
        pDI[j] = 100 * smP[j] / smTR[j];
        mDI[j] = 100 * smM[j] / smTR[j];
        var den = pDI[j] + mDI[j];
        dx[j] = den === 0 ? 0 : 100 * Math.abs(pDI[j] - mDI[j]) / den;
      }
    }
    var adx = rma(dx, adxLen);
    var adxr = nul(n);
    for (var k = 0; k < n; k++) {
      if (adx[k] != null && k - diLen >= 0 && adx[k - diLen] != null) adxr[k] = (adx[k] + adx[k - diLen]) / 2;
    }
    return { plusDI: pDI, minusDI: mDI, dx: dx, adx: adx, adxr: adxr };
  }

  // ---------------- bar context ----------------
  function barDate(t) {
    if (t == null) return null;
    if (typeof t === 'number') { var d = new Date(t > 1e12 ? t : t * 1000); return isNaN(d.getTime()) ? null : d; }
    if (typeof t === 'string') { var d2 = new Date(t); return isNaN(d2.getTime()) ? null : d2; }
    if (t instanceof Date) return isNaN(t.getTime()) ? null : t;
    return null;
  }
  function buildCtx(bars, spec, merged, rawInputs) {
    var n = bars.length;
    var O = nul(n), H = nul(n), L = nul(n), C = nul(n), V = nul(n);
    for (var i = 0; i < n; i++) {
      var b = bars[i] || {};
      O[i] = num(b.o, null); H[i] = num(b.h, null); L[i] = num(b.l, null);
      C[i] = num(b.c, null); V[i] = num(b.v, 0);
    }
    var hl2 = binop(H, L, function (a, b) { return (a + b) / 2; });
    var hlc3 = new Array(n), ohlc4 = new Array(n);
    for (var j = 0; j < n; j++) {
      hlc3[j] = (H[j] != null && L[j] != null && C[j] != null) ? (H[j] + L[j] + C[j]) / 3 : null;
      ohlc4[j] = (O[j] != null && H[j] != null && L[j] != null && C[j] != null) ? (O[j] + H[j] + L[j] + C[j]) / 4 : null;
    }
    var ctx = {
      bars: bars, n: n, O: O, H: H, L: L, C: C, V: V, hl2: hl2, hlc3: hlc3, ohlc4: ohlc4,
      spec: spec,
      get: function (id) {
        if (merged && merged[id] !== undefined) return merged[id];
        if (rawInputs && rawInputs[id] !== undefined) return rawInputs[id];
        return undefined;
      },
      src: function (inputId) { return ctx.sourceOf(ctx.get(inputId)); },
      sourceOf: function (name) {
        switch (String(name || 'close')) {
          case 'open': return O;
          case 'high': return H;
          case 'low': return L;
          case 'hl2': return hl2;
          case 'hlc3': return hlc3;
          case 'ohlc4': return ohlc4;
          default: return C;
        }
      }
    };
    return ctx;
  }
  function crossPlot(a, b) { // value of `a` at bars where a crosses b, else null
    var n = a.length, out = nul(n);
    for (var i = 1; i < n; i++) {
      if (a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) continue;
      var d0 = a[i - 1] - b[i - 1], d1 = a[i] - b[i];
      if ((d0 <= 0 && d1 > 0) || (d0 >= 0 && d1 < 0)) out[i] = a[i];
    }
    return out;
  }
  function kamaCalc(src, len, fastLen, slowLen) {
    var n = src.length, out = nul(n);
    var fastA = 2 / (fastLen + 1), slowA = 2 / (slowLen + 1);
    var vol = nul(n); // sum of |change| over len
    var chg = change(src, 1);
    var absChg = map1(chg, function (v) { return Math.abs(v); });
    vol = sumArr(absChg, len);
    var prev = null;
    for (var i = 0; i < n; i++) {
      if (src[i] == null || i < len || src[i - len] == null || vol[i] == null || vol[i] === 0) { out[i] = prev; continue; }
      var er = Math.abs(src[i] - src[i - len]) / vol[i];
      var sc = Math.pow(er * (fastA - slowA) + slowA, 2);
      prev = (prev === null) ? src[i] : prev + sc * (src[i] - prev);
      out[i] = prev;
    }
    return out;
  }
  function donchianMid(H, L, len) {
    var hh = highest(H, len), ll = lowest(L, len);
    return binop(hh, ll, function (a, b) { return (a + b) / 2; });
  }

  // ---------------- study implementations ----------------
  // Each returns { plotId: valuesArray } (values aligned to bars).
  var IMPL = {};

  function smoothedOf(ctx, base, lineId, lenId) {
    var t = ctx.get(lineId), l = intv(ctx.get(lenId), 9);
    if (t === undefined && l === undefined) return null;
    return maByType(t || 'SMA', base, l);
  }

  // ---- moving-average family ----
  IMPL['Moving Average'] = function (ctx) {
    var src = ctx.src('source'), len = intv(ctx.get('length'), 9);
    var base = shiftArr(sma(src, len), intv(ctx.get('offset'), 0));
    var r = { plot_0: base };
    var sm = smoothedOf(ctx, base, 'smoothingLine', 'smoothingLength');
    if (sm) r.smoothedMA = sm;
    return r;
  };
  IMPL['Moving Average Exponential'] = function (ctx) {
    var src = ctx.src('source'), len = intv(ctx.get('length'), 9);
    var base = shiftArr(ema(src, len), intv(ctx.get('offset'), 0));
    var r = { plot_0: base };
    var sm = smoothedOf(ctx, base, 'smoothingLine', 'smoothingLength');
    if (sm) r.smoothedMA = sm;
    return r;
  };
  IMPL['Moving Average Weighted'] = function (ctx) {
    var src = ctx.src('in_1');
    return { plot_0: shiftArr(wma(src, intv(ctx.get('in_0'), 9)), intv(ctx.get('in_2'), 0)) };
  };
  IMPL['Moving Average Double'] = function (ctx) {
    // Spec carries a single Length/Source/Offset; two plots = SMA and EMA of it.
    var src = ctx.src('in_1'), len = intv(ctx.get('in_0'), 9), off = intv(ctx.get('in_2'), 0);
    return { plot_0: shiftArr(sma(src, len), off), plot_1: shiftArr(ema(src, len), off) };
  };
  IMPL['Moving Average Triple'] = function (ctx) {
    // Spec carries no inputs; standard triple-SMA set 14/21/35.
    return { plot_0: sma(ctx.C, 14), plot_1: sma(ctx.C, 21), plot_2: sma(ctx.C, 35) };
  };
  IMPL['Moving Average Multiple'] = function (ctx) {
    // Spec carries no inputs; six SMAs 14/21/35/50/100/200.
    var lens = [14, 21, 35, 50, 100, 200], r = {};
    for (var i = 0; i < 6; i++) r['plot_' + i] = sma(ctx.C, lens[i]);
    return r;
  };
  IMPL['Moving Average Channel'] = function (ctx) {
    var up = shiftArr(sma(ctx.H, intv(ctx.get('in_0'), 20)), intv(ctx.get('in_2'), 0));
    var lo = shiftArr(sma(ctx.L, intv(ctx.get('in_1'), 20)), intv(ctx.get('in_3'), 0));
    return { plot_0: up, plot_1: lo };
  };
  IMPL['Moving Average Adaptive'] = function (ctx) {
    // Kaufman Adaptive MA (ER period 10, fast 2, slow 30).
    return { plot_0: kamaCalc(ctx.C, 10, 2, 30) };
  };
  IMPL['Triple EMA'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 9);
    var e1 = ema(ctx.C, len), e2 = ema(e1, len), e3 = ema(e2, len);
    return { plot_0: add(sub(mul(e1, 3), mul(e2, 3)), e3) };
  };
  IMPL['Double Exponential Moving Average'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 9);
    var e1 = ema(ctx.C, len), e2 = ema(e1, len);
    return { plot_0: sub(mul(e1, 2), e2) };
  };
  IMPL['Hull MA'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 9);
    var half = Math.max(1, Math.round(len / 2)), sq = Math.max(1, Math.round(Math.sqrt(len)));
    var diff = sub(mul(wma(ctx.C, half), 2), wma(ctx.C, len));
    return { plot_0: wma(diff, sq) };
  };
  IMPL['Least Squares Moving Average'] = function (ctx) {
    var lr = linreg(ctx.C, intv(ctx.get('in_0'), 25));
    return { plot_0: shiftArr(lr.end, intv(ctx.get('in_1'), 0)) };
  };
  IMPL['Smoothed Moving Average'] = function (ctx) {
    return { plot_0: rma(ctx.src('in_1'), intv(ctx.get('in_0'), 7)) };
  };
  IMPL['McGinley Dynamic'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 14), C = ctx.C, n = ctx.n, out = nul(n), prev = null;
    for (var i = 0; i < n; i++) {
      if (C[i] == null) { out[i] = prev; continue; }
      if (prev === null || prev === 0) { prev = C[i]; out[i] = prev; continue; }
      var ratio = C[i] / prev;
      prev = prev + (C[i] - prev) / (len * Math.pow(ratio, 4));
      out[i] = prev;
    }
    return { plot_0: out };
  };
  IMPL['Guppy Multiple Moving Average'] = function (ctx) {
    var lens = [3, 5, 8, 10, 12, 15, 30, 35, 40, 45, 50, 60], r = {};
    for (var i = 0; i < 12; i++) {
      var id = (i < 6 ? 'traderEMA' : 'investorEMA') + ((i % 6) + 1);
      r[id] = ema(ctx.C, lens[i]);
    }
    return r;
  };
  IMPL['MA Cross'] = function (ctx) {
    var a = sma(ctx.C, intv(ctx.get('in_0'), 9)), b = sma(ctx.C, intv(ctx.get('in_1'), 26));
    return { plot_0: a, plot_1: b, plot_2: crossPlot(a, b) };
  };
  IMPL['EMA Cross'] = function (ctx) {
    var a = ema(ctx.C, intv(ctx.get('in_0'), 9)), b = ema(ctx.C, intv(ctx.get('in_1'), 26));
    return { plot_0: a, plot_1: b, plot_2: crossPlot(a, b) };
  };
  IMPL['MA with EMA Cross'] = function (ctx) {
    var a = sma(ctx.C, intv(ctx.get('in_0'), 10)), b = ema(ctx.C, intv(ctx.get('in_1'), 10));
    return { plot_0: a, plot_1: b, plot_2: crossPlot(a, b) };
  };

  // ---- bands & channels ----
  IMPL['Bollinger Bands'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 20), m = num(ctx.get('in_1'), 2);
    var mid = sma(ctx.C, len), sd = stdev(ctx.C, len);
    return { plot_0: mid, plot_1: add(mid, mul(sd, m)), plot_2: sub(mid, mul(sd, m)) };
  };
  IMPL['Bollinger Bands %B'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 20), m = num(ctx.get('in_1'), 2);
    var mid = sma(ctx.C, len), sd = stdev(ctx.C, len);
    var up = add(mid, mul(sd, m)), lo = sub(mid, mul(sd, m));
    return { plot_0: div(sub(ctx.C, lo), sub(up, lo)) };
  };
  IMPL['Donchian Channels'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 20), off = intv(ctx.get('offset'), 0);
    var hh = highest(ctx.H, len), ll = lowest(ctx.L, len);
    return {
      plot_0: shiftArr(ll, off), plot_1: shiftArr(hh, off),
      plot_2: shiftArr(binop(hh, ll, function (a, b) { return (a + b) / 2; }), off)
    };
  };
  IMPL['Price Channel'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 20), off = intv(ctx.get('in_1'), 0);
    var hh = highest(ctx.H, len), ll = lowest(ctx.L, len);
    return {
      plot_0: shiftArr(hh, off), plot_1: shiftArr(ll, off),
      plot_2: shiftArr(binop(hh, ll, function (a, b) { return (a + b) / 2; }), off)
    };
  };
  IMPL['Envelopes'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 20);
    var basis = sma(ctx.src('in_4'), len);
    var up = map1(basis, function (v) { return v * (1 + num(ctx.get('in_1'), 2) / 100); });
    var lo = map1(basis, function (v) { return v * (1 - num(ctx.get('in_2'), 2) / 100); });
    return { plot_0: basis, plot_1: up, plot_2: lo };
  };
  IMPL['Standard Error Bands'] = function (ctx) {
    // Standard defaults: regression length 21, smoothing 3, 2 standard errors.
    var len = 21, mult = 2;
    var lr = linreg(ctx.C, len);
    var n = ctx.n, se = nul(n);
    for (var i = len - 1; i < n; i++) {
      if (lr.slope[i] == null) continue;
      var endV = lr.end[i], sl = lr.slope[i], sse = 0, ok = true;
      for (var j = 0; j < len; j++) {
        var v = ctx.C[i - len + 1 + j];
        if (v == null) { ok = false; break; }
        var fit = endV - sl * (len - 1 - j);
        sse += (v - fit) * (v - fit);
      }
      if (ok) se[i] = Math.sqrt(sse / Math.max(1, len - 2));
    }
    var mid = sma(lr.end, 3), sd3 = sma(se, 3);
    return { plot_0: add(mid, mul(sd3, mult)), plot_1: mid, plot_2: sub(mid, mul(sd3, mult)) };
  };
  IMPL['Linear Regression Curve'] = function (ctx) {
    return { plot_0: linreg(ctx.C, intv(ctx.get('in_0'), 9)).end };
  };
  IMPL['Chande Kroll Stop'] = function (ctx) {
    var p = intv(ctx.get('in_0'), 10), x = num(ctx.get('in_1'), 1), q = intv(ctx.get('in_2'), 9);
    var a = atr(ctx.bars, p);
    var firstLong = sub(highest(ctx.H, p), mul(a, x));
    var firstShort = add(lowest(ctx.L, p), mul(a, x));
    return { plot_0: highest(firstLong, q), plot_1: lowest(firstShort, q) };
  };

  // ---- trend overlays ----
  IMPL['SuperTrend'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 10), factor = num(ctx.get('in_1'), 3);
    var a = atr(ctx.bars, len), n = ctx.n, C = ctx.C, hl2 = ctx.hl2;
    var out = nul(n);
    var fUp = null, fDn = null, trend = 1;
    for (var i = 0; i < n; i++) {
      if (a[i] == null || hl2[i] == null || C[i] == null) continue;
      var bUp = hl2[i] + factor * a[i], bDn = hl2[i] - factor * a[i];
      if (fUp === null) { fUp = bUp; fDn = bDn; trend = 1; out[i] = fDn; continue; }
      var pUp = fUp, pDn = fDn, pClose = C[i - 1];
      fUp = (bUp < pUp || pClose > pUp) ? bUp : pUp;
      fDn = (bDn > pDn || pClose < pDn) ? bDn : pDn;
      if (trend === -1 && C[i] > pDn) trend = 1;
      else if (trend === 1 && C[i] < pUp) trend = -1;
      out[i] = (trend === 1) ? fDn : fUp;
    }
    return { plot_0: out };
  };
  IMPL['Parabolic SAR'] = function (ctx) {
    var start = num(ctx.get('in_0'), 0.02), inc = num(ctx.get('in_1'), 0.02), maxAf = num(ctx.get('in_2'), 0.2);
    var n = ctx.n, H = ctx.H, L = ctx.L, out = nul(n);
    if (n < 2) return { plot_0: out };
    var isLong = true, sar = L[0], ep = H[0], af = start;
    for (var i = 1; i < n; i++) {
      if (H[i] == null || L[i] == null || sar == null || ep == null) continue;
      sar = sar + af * (ep - sar);
      if (isLong) {
        sar = (i >= 2 && L[i - 2] != null) ? Math.min(sar, L[i - 1], L[i - 2]) : Math.min(sar, L[i - 1]);
        if (L[i] < sar) { isLong = false; sar = ep; ep = L[i]; af = start; }
        else if (H[i] > ep) { ep = H[i]; af = Math.min(af + inc, maxAf); }
      } else {
        sar = (i >= 2 && H[i - 2] != null) ? Math.max(sar, H[i - 1], H[i - 2]) : Math.max(sar, H[i - 1]);
        if (H[i] > sar) { isLong = true; sar = ep; ep = H[i]; af = start; }
        else if (L[i] < ep) { ep = L[i]; af = Math.min(af + inc, maxAf); }
      }
      out[i] = sar;
    }
    return { plot_0: out };
  };
  IMPL['Ichimoku Cloud'] = function (ctx) {
    var convLen = intv(ctx.get('in_0'), 9), baseLen = intv(ctx.get('in_1'), 26);
    var spanLen = intv(ctx.get('in_2'), 52), lagShift = intv(ctx.get('in_3'), 26), leadShift = intv(ctx.get('in_4'), 26);
    var conv = donchianMid(ctx.H, ctx.L, convLen);
    var base = donchianMid(ctx.H, ctx.L, baseLen);
    var spanBraw = donchianMid(ctx.H, ctx.L, spanLen);
    var spanAraw = binop(conv, base, function (a, b) { return (a + b) / 2; });
    var n = ctx.n, lag = nul(n);
    for (var i = 0; i < n; i++) { if (i + lagShift < n) lag[i] = ctx.C[i + lagShift]; }
    return {
      plot_0: conv, plot_1: base, plot_2: lag,
      plot_3: shiftArr(spanAraw, leadShift), plot_4: shiftArr(spanBraw, leadShift)
    };
  };
  IMPL['VWAP'] = function (ctx) {
    var src = ctx.src('in_0');
    var anchor = String(ctx.get('in_anchor') || 'Session');
    var n = ctx.n, out = nul(n), cumPV = 0, cumV = 0, lastKey = null;
    function keyOf(d) {
      if (!d) return 'ALL';
      var y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
      if (anchor === 'Session') return y + '-' + m + '-' + day;
      if (anchor === 'Week') {
        var jan1 = Date.UTC(y, 0, 1);
        var wk = Math.floor((Date.UTC(y, m, day) - jan1) / 6048e5);
        return y + '-W' + wk;
      }
      if (anchor === 'Month') return y + '-' + m;
      if (anchor === 'Quarter') return y + '-Q' + Math.floor(m / 3);
      if (anchor === 'Year') return String(y);
      if (anchor === 'Decade') return String(Math.floor(y / 10));
      return 'ALL';
    }
    for (var i = 0; i < n; i++) {
      var key = keyOf(barDate(ctx.bars[i] && ctx.bars[i].t));
      if (key !== lastKey) { cumPV = 0; cumV = 0; lastKey = key; }
      var v = ctx.V[i] || 0, s = src[i];
      if (s != null) { cumPV += s * v; cumV += v; }
      out[i] = (cumV > 0 && s != null) ? cumPV / cumV : null;
    }
    return { plot_0: out };
  };
  IMPL['VWMA'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 20);
    var pv = mul(ctx.C, ctx.V);
    return { plot_0: div(sma(pv, len), sma(ctx.V, len)) };
  };
  IMPL['ZigZag'] = function (ctx) {
    var dev = num(ctx.get('in_0'), 5) / 100, depth = intv(ctx.get('in_1'), 10);
    var n = ctx.n, C = ctx.C, out = nul(n);
    if (n < 2 || C[0] == null) return { plot_0: out };
    var piv = [{ i: 0, v: C[0] }];
    var hiI = 0, hiV = C[0], loI = 0, loV = C[0], leg = 0; // leg: 1 up, -1 down
    for (var i = 1; i < n; i++) {
      if (C[i] == null) continue;
      if (C[i] > hiV) { hiV = C[i]; hiI = i; }
      if (C[i] < loV) { loV = C[i]; loI = i; }
      var last = piv[piv.length - 1];
      if (leg >= 0 && hiV > 0 && C[i] <= hiV * (1 - dev) && hiI > last.i) {
        if (hiI - last.i >= depth || piv.length === 1) {
          piv.push({ i: hiI, v: hiV }); leg = -1; loI = i; loV = C[i]; continue;
        }
      }
      if (leg <= 0 && loV > 0 && C[i] >= loV * (1 + dev) && loI > last.i) {
        if (loI - last.i >= depth || piv.length === 1) {
          piv.push({ i: loI, v: loV }); leg = 1; hiI = i; hiV = C[i]; continue;
        }
      }
    }
    for (var k = 0; k < piv.length; k++) out[piv[k].i] = piv[k].v;
    // extend to the current unconfirmed extreme
    if (leg >= 0 && hiI > piv[piv.length - 1].i) out[hiI] = hiV;
    if (leg <= 0 && loI > piv[piv.length - 1].i) out[loI] = loV;
    return { plot_0: out };
  };
  IMPL['Williams Alligator'] = function (ctx) {
    var med = ctx.hl2;
    var jaw = shiftArr(rma(med, intv(ctx.get('in_0'), 21)), intv(ctx.get('in_3'), 8));
    var teeth = shiftArr(rma(med, intv(ctx.get('in_1'), 13)), intv(ctx.get('in_4'), 5));
    var lips = shiftArr(rma(med, intv(ctx.get('in_2'), 8)), intv(ctx.get('in_5'), 3));
    return { plot_0: jaw, plot_1: teeth, plot_2: lips };
  };
  IMPL['Pivot Points Standard'] = function (ctx) {
    // Traditional pivots from the previous calendar month, applied per month.
    var n = ctx.n;
    var ids = ['p', 'r1', 'r2', 'r3', 's1', 's2', 's3'];
    var titles = { p: 'P', r1: 'R1', r2: 'R2', r3: 'R3', s1: 'S1', s2: 'S2', s3: 'S3' };
    var series = {};
    ids.forEach(function (id) { series[id] = nul(n); });
    var months = {}; // key -> {h,l,c, firstIdx}
    var order = [];
    for (var i = 0; i < n; i++) {
      var d = barDate(ctx.bars[i] && ctx.bars[i].t);
      if (!d) return { __empty: nul(n) };
      var key = d.getUTCFullYear() + '-' + d.getUTCMonth();
      if (!months[key]) { months[key] = { h: -Infinity, l: Infinity, c: null }; order.push(key); }
      var mo = months[key];
      if (ctx.H[i] != null) mo.h = Math.max(mo.h, ctx.H[i]);
      if (ctx.L[i] != null) mo.l = Math.min(mo.l, ctx.L[i]);
      if (ctx.C[i] != null) mo.c = ctx.C[i];
      mo['last' + i] = true;
    }
    var levels = {}; // month key -> levels from previous month
    for (var k = 1; k < order.length; k++) {
      var pm = months[order[k - 1]];
      if (pm.c == null || !isFinite(pm.h) || !isFinite(pm.l)) continue;
      var pp = (pm.h + pm.l + pm.c) / 3, range = pm.h - pm.l;
      levels[order[k]] = {
        p: pp, r1: 2 * pp - pm.l, s1: 2 * pp - pm.h,
        r2: pp + range, s2: pp - range,
        r3: pm.h + 2 * (pp - pm.l), s3: pm.l - 2 * (pm.h - pp)
      };
    }
    for (var j = 0; j < n; j++) {
      var dd = barDate(ctx.bars[j] && ctx.bars[j].t);
      var lv = levels[dd.getUTCFullYear() + '-' + dd.getUTCMonth()];
      if (!lv) continue;
      ids.forEach(function (id) { series[id][j] = lv[id]; });
    }
    var r = {};
    ids.forEach(function (id) { r[id] = { values: series[id], title: titles[id] }; });
    return r;
  };
  IMPL['52 Week High/Low'] = function (ctx) {
    return {
      plot_0: { values: highest(ctx.H, 252), title: '52W High' },
      plot_1: { values: lowest(ctx.L, 252), title: '52W Low' }
    };
  };
  IMPL['Median Price'] = function (ctx) { return { plot_0: ctx.hl2 }; };
  IMPL['Typical Price'] = function (ctx) { return { plot_0: ctx.hlc3 }; };
  IMPL['Average Price'] = function (ctx) { return { plot_0: ctx.ohlc4 }; };

  // ---- pane studies: volume & oscillators ----
  IMPL['Volume'] = function (ctx) {
    var ma = maByType(ctx.get('smoothingLine') || 'SMA', ctx.V, intv(ctx.get('length'), 20));
    return { vol: ctx.V.slice(), vol_ma: ma, smoothedMA: maByType(ctx.get('smoothingLine') || 'SMA', ma, 9) };
  };
  function moneyFlowVolume(ctx) { // per-bar money flow volume (Chaikin)
    var n = ctx.n, out = nul(n);
    for (var i = 0; i < n; i++) {
      var h = ctx.H[i], l = ctx.L[i], c = ctx.C[i];
      if (h == null || l == null || c == null) continue;
      var range = h - l;
      var mfm = range === 0 ? 0 : ((c - l) - (h - c)) / range;
      out[i] = mfm * (ctx.V[i] || 0);
    }
    return out;
  }
  function adlCalc(ctx) {
    var mfv = moneyFlowVolume(ctx), n = ctx.n, out = nul(n), cum = 0, started = false;
    for (var i = 0; i < n; i++) {
      if (mfv[i] == null) { out[i] = started ? cum : null; continue; }
      cum += mfv[i]; started = true; out[i] = cum;
    }
    return out;
  }
  IMPL['Accumulation/Distribution'] = function (ctx) { return { plot_0: adlCalc(ctx) }; };
  IMPL['Chaikin Money Flow'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 20);
    return { plot_0: div(sumArr(moneyFlowVolume(ctx), len), sumArr(ctx.V, len)) };
  };
  IMPL['Chaikin Oscillator'] = function (ctx) {
    var adl = adlCalc(ctx);
    return { plot_0: sub(ema(adl, intv(ctx.get('in_0'), 3)), ema(adl, intv(ctx.get('in_1'), 10))) };
  };
  IMPL['Chaikin Volatility'] = function (ctx) {
    var e = ema(binop(ctx.H, ctx.L, function (a, b) { return a - b; }), 10);
    var out = nul(ctx.n);
    for (var i = 10; i < ctx.n; i++) {
      if (e[i] != null && e[i - 10] != null && e[i - 10] !== 0) out[i] = 100 * (e[i] - e[i - 10]) / e[i - 10];
    }
    return { plot_0: out };
  };
  IMPL['On Balance Volume'] = function (ctx) {
    var n = ctx.n, out = nul(n), cum = 0;
    for (var i = 0; i < n; i++) {
      if (ctx.C[i] == null) { out[i] = i > 0 ? out[i - 1] : null; continue; }
      if (i > 0 && ctx.C[i - 1] != null) {
        if (ctx.C[i] > ctx.C[i - 1]) cum += ctx.V[i] || 0;
        else if (ctx.C[i] < ctx.C[i - 1]) cum -= ctx.V[i] || 0;
      }
      out[i] = cum;
    }
    var r = { plot_0: out };
    var sm = smoothedOf(ctx, out, 'smoothingLine', 'smoothingLength');
    if (sm) r.smoothedMA = sm;
    return r;
  };
  IMPL['Net Volume'] = function (ctx) {
    var n = ctx.n, out = nul(n), cum = 0;
    for (var i = 0; i < n; i++) {
      if (i > 0 && ctx.C[i] != null && ctx.C[i - 1] != null) {
        if (ctx.C[i] > ctx.C[i - 1]) cum += ctx.V[i] || 0;
        else if (ctx.C[i] < ctx.C[i - 1]) cum -= ctx.V[i] || 0;
      }
      out[i] = ctx.C[i] == null ? (i > 0 ? out[i - 1] : null) : cum;
    }
    return { plot_0: out };
  };
  IMPL['Price Volume Trend'] = function (ctx) {
    var n = ctx.n, out = nul(n), cum = 0;
    for (var i = 0; i < n; i++) {
      if (i > 0 && ctx.C[i] != null && ctx.C[i - 1] != null && ctx.C[i - 1] !== 0) {
        cum += (ctx.V[i] || 0) * (ctx.C[i] - ctx.C[i - 1]) / ctx.C[i - 1];
      }
      out[i] = ctx.C[i] == null ? (i > 0 ? out[i - 1] : null) : cum;
    }
    return { plot_0: out };
  };
  IMPL['Volume Oscillator'] = function (ctx) {
    var es = ema(ctx.V, intv(ctx.get('in_0'), 5)), el = ema(ctx.V, intv(ctx.get('in_1'), 10));
    return { plot_0: mul(div(sub(es, el), el), 100) };
  };
  IMPL['Ease of Movement'] = function (ctx) {
    var n = ctx.n, emv = nul(n), divisor = num(ctx.get('in_0'), 10000);
    for (var i = 1; i < n; i++) {
      if (ctx.hl2[i] == null || ctx.hl2[i - 1] == null || ctx.H[i] == null || ctx.L[i] == null) continue;
      var range = ctx.H[i] - ctx.L[i];
      if (range === 0) { emv[i] = 0; continue; }
      var box = (ctx.V[i] || 0) / divisor / range;
      if (box === 0) continue;
      emv[i] = (ctx.hl2[i] - ctx.hl2[i - 1]) / box;
    }
    return { plot_0: sma(emv, intv(ctx.get('in_1'), 14)) };
  };
  IMPL['Elders Force Index'] = function (ctx) {
    var force = mul(change(ctx.C, 1), ctx.V);
    return { plot_0: ema(force, intv(ctx.get('in_0'), 13)) };
  };
  IMPL['Balance of Power'] = function (ctx) {
    return { plot_0: div(sub(ctx.C, ctx.O), sub(ctx.H, ctx.L)) };
  };
  IMPL['Klinger Oscillator'] = function (ctx) {
    var n = ctx.n, H = ctx.H, L = ctx.L, C = ctx.C, V = ctx.V;
    var vf = nul(n), trendPrev = 0, cm = 0, dmPrev = 0;
    for (var i = 0; i < n; i++) {
      if (H[i] == null || L[i] == null || C[i] == null) continue;
      if (i === 0) { vf[i] = 0; dmPrev = H[i] - L[i]; cm = dmPrev; continue; }
      var tpc = H[i] + L[i] + C[i], tpp = H[i - 1] + L[i - 1] + C[i - 1];
      var trend = tpc > tpp ? 1 : -1;
      var dm = H[i] - L[i];
      cm = (trend === trendPrev) ? cm + dm : dmPrev + dm;
      var ratio = cm === 0 ? 0 : dm / cm;
      vf[i] = (V[i] || 0) * Math.abs(2 * (ratio - 1)) * trend * 100;
      trendPrev = trend; dmPrev = dm;
    }
    var ko = sub(ema(vf, 34), ema(vf, 55));
    return { plot_0: ko, plot_1: ema(ko, 13) };
  };

  // ---- momentum oscillators ----
  IMPL['Relative Strength Index'] = function (ctx) {
    var r = rsiCalc(ctx.C, intv(ctx.get('length'), 14));
    var out = { plot_0: r };
    var sm = smoothedOf(ctx, r, 'smoothingLine', 'smoothingLength');
    if (sm) out.smoothedMA = sm;
    return out;
  };
  IMPL['Stochastic'] = function (ctx) {
    var kLen = intv(ctx.get('in_0'), 14);
    var hh = highest(ctx.H, kLen), ll = lowest(ctx.L, kLen);
    var raw = div(mul(sub(ctx.C, ll), 100), sub(hh, ll));
    var k = sma(raw, intv(ctx.get('in_1'), 1));
    return { plot_0: k, plot_1: sma(k, intv(ctx.get('in_2'), 3)) };
  };
  IMPL['Stochastic RSI'] = function (ctx) {
    var r = rsiCalc(ctx.C, intv(ctx.get('in_0'), 14));
    var len = intv(ctx.get('in_1'), 14);
    var hh = highest(r, len), ll = lowest(r, len);
    var stoch = div(mul(sub(r, ll), 100), sub(hh, ll));
    var k = sma(stoch, intv(ctx.get('in_2'), 3));
    return { plot_0: k, plot_1: sma(k, intv(ctx.get('in_3'), 3)) };
  };
  IMPL['Moving Average Convergence/Divergence'] = function (ctx) {
    var src = ctx.src('in_3');
    var macd = sub(ema(src, intv(ctx.get('in_0'), 12)), ema(src, intv(ctx.get('in_1'), 26)));
    var signal = ema(macd, intv(ctx.get('in_2'), 9));
    return { plot_0: sub(macd, signal), plot_1: macd, plot_2: signal };
  };
  IMPL['Momentum'] = function (ctx) {
    return { plot_0: change(ctx.src('in_1'), intv(ctx.get('in_0'), 10)) };
  };
  IMPL['Rate Of Change'] = function (ctx) {
    return { plot_0: rocPct(ctx.C, intv(ctx.get('in_0'), 9)) };
  };
  IMPL['Average True Range'] = function (ctx) {
    return { plot_0: atr(ctx.bars, intv(ctx.get('in_0'), 14)) };
  };
  IMPL['Average Directional Index'] = function (ctx) {
    var d = dmiCalc(ctx, intv(ctx.get('in_1'), 14), intv(ctx.get('in_0'), 14));
    return { plot_0: d.adx };
  };
  IMPL['Directional Movement Index'] = function (ctx) {
    var d = dmiCalc(ctx, intv(ctx.get('in_0'), 14), intv(ctx.get('in_1'), 14));
    return { plot_0: d.plusDI, plot_1: d.minusDI, plot_2: d.dx, plot_3: d.adx, plot_4: d.adxr };
  };
  IMPL['Commodity Channel Index'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 20), tp = ctx.hlc3;
    var ma = sma(tp, len);
    var dev = map1(tp, function (v, i) { return ma[i] == null ? null : Math.abs(v - ma[i]); });
    var md = sma(dev, len);
    var cci = div(sub(tp, ma), mul(md, 0.015));
    var r = { plot_0: cci };
    var sm = smoothedOf(ctx, cci, 'smoothingLine', 'smoothingLength');
    if (sm) r.smoothedMA = sm;
    return r;
  };
  IMPL['Money Flow Index'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 14), n = ctx.n, tp = ctx.hlc3;
    var pos = nul(n), neg = nul(n);
    for (var i = 0; i < n; i++) {
      pos[i] = 0; neg[i] = 0;
      if (i > 0 && tp[i] != null && tp[i - 1] != null) {
        var rmf = tp[i] * (ctx.V[i] || 0);
        if (tp[i] > tp[i - 1]) pos[i] = rmf;
        else if (tp[i] < tp[i - 1]) neg[i] = rmf;
      }
    }
    var ps = sumArr(pos, len), ns = sumArr(neg, len), out = nul(n);
    for (var j = 0; j < n; j++) {
      if (ps[j] == null || ns[j] == null) continue;
      out[j] = ns[j] === 0 ? 100 : 100 - 100 / (1 + ps[j] / ns[j]);
    }
    return { plot_0: out };
  };
  IMPL['Awesome Oscillator'] = function (ctx) {
    return { plot_0: sub(sma(ctx.hl2, 5), sma(ctx.hl2, 34)) };
  };
  IMPL['Accelerator Oscillator'] = function (ctx) {
    var ao = sub(sma(ctx.hl2, 5), sma(ctx.hl2, 34));
    return { plot_0: sub(ao, sma(ao, 5)) };
  };
  IMPL['True Strength Index'] = function (ctx) {
    var longL = intv(ctx.get('in_0'), 25), shortL = intv(ctx.get('in_1'), 13), sigL = intv(ctx.get('in_2'), 13);
    var mom = change(ctx.C, 1);
    var numArr = ema(ema(mom, longL), shortL);
    var denArr = ema(ema(map1(mom, function (v) { return Math.abs(v); }), longL), shortL);
    var tsi = mul(div(numArr, denArr), 100);
    return { plot_0: tsi, plot_1: ema(tsi, sigL) };
  };
  IMPL['TRIX'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 18);
    var e3 = ema(ema(ema(ctx.C, len), len), len);
    return { plot_0: rocPct(e3, 1) };
  };
  IMPL['Coppock Curve'] = function (ctx) {
    var s = add(rocPct(ctx.C, intv(ctx.get('in_1'), 14)), rocPct(ctx.C, intv(ctx.get('in_2'), 11)));
    return { plot_0: wma(s, intv(ctx.get('in_0'), 10)) };
  };

  IMPL['Relative Vigor Index'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 10);
    var numS = swma4(sub(ctx.C, ctx.O)), denS = swma4(sub(ctx.H, ctx.L));
    var ratio = div(numS, denS);
    var rvgi = sma(ratio, len);
    return { plot_0: rvgi, plot_1: swma4(rvgi) };
  };
  IMPL['Relative Volatility Index'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 10), n = ctx.n;
    var sd = stdev(ctx.C, len);
    var up = nul(n), dn = nul(n);
    for (var i = 0; i < n; i++) {
      up[i] = 0; dn[i] = 0;
      if (i > 0 && ctx.C[i] != null && ctx.C[i - 1] != null && sd[i] != null) {
        if (ctx.C[i] > ctx.C[i - 1]) up[i] = sd[i];
        else if (ctx.C[i] < ctx.C[i - 1]) dn[i] = sd[i];
      }
    }
    var u = rma(up, 14), d = rma(dn, 14);
    return { plot_0: mul(div(u, add(u, d)), 100) };
  };
  IMPL['Bollinger Bands Width'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 20), m = num(ctx.get('in_1'), 2);
    var mid = sma(ctx.C, len), sd = stdev(ctx.C, len);
    return { plot_0: div(mul(sd, 2 * m), mid) };
  };
  IMPL['Aroon'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 14), n = ctx.n, up = nul(n), dn = nul(n), win = len + 1;
    for (var i = win - 1; i < n; i++) {
      var mx = -Infinity, mn = Infinity, mxI = -1, mnI = -1, ok = true;
      for (var j = i - win + 1; j <= i; j++) {
        if (ctx.H[j] == null || ctx.L[j] == null) { ok = false; break; }
        if (ctx.H[j] >= mx) { mx = ctx.H[j]; mxI = j; }
        if (ctx.L[j] <= mn) { mn = ctx.L[j]; mnI = j; }
      }
      if (!ok) continue;
      up[i] = 100 * (len - (i - mxI)) / len;
      dn[i] = 100 * (len - (i - mnI)) / len;
    }
    return { plot_0: up, plot_1: dn };
  };
  IMPL['Choppiness Index'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 14);
    var s = sumArr(trueRange(ctx.bars), len);
    var hh = highest(ctx.H, len), ll = lowest(ctx.L, len);
    var ratio = div(s, sub(hh, ll));
    return {
      plot_0: map1(ratio, function (v) {
        return v > 0 ? 100 * Math.log10(v) / Math.log10(len) : null;
      })
    };
  };
  IMPL['Vortex Indicator'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 14), n = ctx.n;
    var tr = trueRange(ctx.bars);
    var vp = nul(n), vm = nul(n);
    for (var i = 1; i < n; i++) {
      if (ctx.H[i] == null || ctx.L[i - 1] == null) continue;
      vp[i] = Math.abs(ctx.H[i] - ctx.L[i - 1]);
      vm[i] = Math.abs(ctx.L[i] - ctx.H[i - 1]);
    }
    var sTR = sumArr(tr, len);
    return { plot_0: div(sumArr(vp, len), sTR), plot_1: div(sumArr(vm, len), sTR) };
  };
  IMPL['Ultimate Oscillator'] = function (ctx) {
    var l1 = intv(ctx.get('in_0'), 7), l2 = intv(ctx.get('in_1'), 14), l3 = intv(ctx.get('in_2'), 28);
    var n = ctx.n, bp = nul(n), tr = nul(n);
    for (var i = 0; i < n; i++) {
      if (i === 0 || ctx.C[i - 1] == null) { bp[i] = 0; tr[i] = 0; continue; }
      var pc = ctx.C[i - 1];
      var lo = Math.min(ctx.L[i], pc), hi = Math.max(ctx.H[i], pc);
      bp[i] = ctx.C[i] - lo;
      tr[i] = hi - lo;
    }
    function avg(l) { return div(sumArr(bp, l), sumArr(tr, l)); }
    var a1 = avg(l1), a2 = avg(l2), a3 = avg(l3), out = nul(n);
    for (var j = 0; j < n; j++) {
      if (a1[j] == null || a2[j] == null || a3[j] == null) continue;
      out[j] = 100 * (4 * a1[j] + 2 * a2[j] + a3[j]) / 7;
    }
    return { plot_0: out };
  };
  IMPL['Fisher Transform'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 9), n = ctx.n, med = ctx.hl2;
    var hh = highest(med, len), ll = lowest(med, len);
    var fish = nul(n), prevV = 0, prevF = 0;
    for (var i = 0; i < n; i++) {
      if (hh[i] == null || ll[i] == null || med[i] == null || hh[i] === ll[i]) { fish[i] = prevF; continue; }
      var norm = (med[i] - ll[i]) / (hh[i] - ll[i]);
      var v = 0.33 * 2 * (norm - 0.5) + 0.67 * prevV;
      if (v > 0.999) v = 0.999; if (v < -0.999) v = -0.999;
      prevV = v;
      var f = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * prevF;
      prevF = f;
      fish[i] = f;
    }
    var trig = shiftArr(fish, 1);
    return { plot_0: fish, plot_1: trig };
  };
  IMPL['Connors RSI'] = function (ctx) {
    var rsiLen = intv(ctx.get('in_0'), 3), udLen = intv(ctx.get('in_1'), 2), rocLen = intv(ctx.get('in_2'), 100);
    var n = ctx.n, C = ctx.C;
    var streak = nul(n);
    for (var i = 0; i < n; i++) {
      if (i === 0 || C[i] == null || C[i - 1] == null) { streak[i] = 0; continue; }
      if (C[i] > C[i - 1]) streak[i] = streak[i - 1] > 0 ? streak[i - 1] + 1 : 1;
      else if (C[i] < C[i - 1]) streak[i] = streak[i - 1] < 0 ? streak[i - 1] - 1 : -1;
      else streak[i] = 0;
    }
    var roc1 = rocPct(C, 1);
    var rank = nul(n);
    for (var j = 0; j < n; j++) {
      if (j < rocLen || roc1[j] == null) continue;
      var cnt = 0, ok = true;
      for (var k = j - rocLen; k < j; k++) {
        if (roc1[k] == null) { ok = false; break; }
        if (roc1[k] < roc1[j]) cnt++;
      }
      if (ok) rank[j] = 100 * cnt / rocLen;
    }
    var r1 = rsiCalc(C, rsiLen), r2 = rsiCalc(streak, udLen);
    var out = nul(n);
    for (var m = 0; m < n; m++) {
      if (r1[m] == null || r2[m] == null || rank[m] == null) continue;
      out[m] = (r1[m] + r2[m] + rank[m]) / 3;
    }
    return { plot_0: out };
  };
  IMPL['Mass Index'] = function (ctx) {
    // EMA(9) of range / EMA(9) of that, summed over the length input (default 10).
    var range = sub(ctx.H, ctx.L);
    var single = ema(range, 9), dbl = ema(single, 9);
    return { plot_0: sumArr(div(single, dbl), intv(ctx.get('in_0'), 10)) };
  };
  IMPL['Know Sure Thing'] = function (ctx) {
    function part(rocId, smaId, w) {
      return mul(sma(rocPct(ctx.C, intv(ctx.get(rocId), 10)), intv(ctx.get(smaId), 10)), w);
    }
    var kst = add(add(part('in_0', 'in_4', 1), part('in_1', 'in_5', 2)), add(part('in_2', 'in_6', 3), part('in_3', 'in_7', 4)));
    return { plot_0: kst, plot_1: sma(kst, intv(ctx.get('in_8'), 9)) };
  };
  IMPL['Chande Momentum Oscillator'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 9), n = ctx.n;
    var diffs = change(ctx.C, 1);
    var up = map1(diffs, function (v) { return Math.max(v, 0); });
    var dn = map1(diffs, function (v) { return Math.max(-v, 0); });
    var su = sumArr(up, len), sd = sumArr(dn, len), out = nul(n);
    for (var i = 0; i < n; i++) {
      if (su[i] == null || sd[i] == null || su[i] + sd[i] === 0) continue;
      out[i] = 100 * (su[i] - sd[i]) / (su[i] + sd[i]);
    }
    return { plot_0: out };
  };
  IMPL['Detrended Price Oscillator'] = function (ctx) {
    var period = intv(ctx.get('in_0'), 21);
    var centered = ctx.get('in_1') === true || ctx.get('in_1') === '!0';
    var ma = sma(ctx.C, period), n = ctx.n, out = nul(n);
    var shift = Math.floor(period / 2) + 1;
    for (var i = 0; i < n; i++) {
      if (centered) {
        if (i + shift < n && ma[i + shift] != null && ctx.C[i] != null) out[i] = ctx.C[i] - ma[i + shift];
      } else {
        if (i - shift >= 0 && ma[i] != null && ctx.C[i - shift] != null) out[i] = ctx.C[i - shift] - ma[i];
      }
    }
    return { plot_0: out };
  };
  IMPL['Price Oscillator'] = function (ctx) {
    var es = ema(ctx.C, intv(ctx.get('in_0'), 10)), el = ema(ctx.C, intv(ctx.get('in_1'), 21));
    return { plot_0: mul(div(sub(es, el), el), 100) };
  };
  IMPL['Linear Regression Slope'] = function (ctx) {
    return { plot_0: linreg(ctx.C, intv(ctx.get('in_0'), 9)).slope };
  };
  IMPL['Standard Deviation'] = function (ctx) {
    return { plot_0: stdev(ctx.src('in_1'), intv(ctx.get('in_0'), 20)) };
  };
  IMPL['Historical Volatility'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 10), n = ctx.n, lr = nul(n);
    for (var i = 1; i < n; i++) {
      if (ctx.C[i] != null && ctx.C[i - 1] != null && ctx.C[i - 1] > 0 && ctx.C[i] > 0) lr[i] = Math.log(ctx.C[i] / ctx.C[i - 1]);
    }
    var sd = stdev(lr, len);
    return { plot_0: map1(sd, function (v) { return v * Math.sqrt(252) * 100; }) };
  };
  IMPL['SMI Ergodic Indicator/Oscillator'] = function (ctx) {
    var shortL = intv(ctx.get('in_0'), 5), longL = intv(ctx.get('in_1'), 20), sigL = intv(ctx.get('in_2'), 5);
    var hh = highest(ctx.H, longL), ll = lowest(ctx.L, longL);
    var diff = sub(ctx.C, binop(hh, ll, function (a, b) { return (a + b) / 2; }));
    var half = map1(sub(hh, ll), function (v) { return v / 2; });
    var numArr = ema(ema(diff, shortL), shortL);
    var denArr = ema(ema(half, shortL), shortL);
    var smi = mul(div(numArr, denArr), 100);
    var sig = ema(smi, sigL);
    return { plot_0: smi, plot_1: sig, plot_2: sub(smi, sig) };
  };
  IMPL['Volatility Close-to-Close'] = function (ctx) {
    // Zero-mean close-to-close estimator, 20 bars, annualized (sqrt(252)) in %.
    var len = 20, n = ctx.n, sq = nul(n);
    for (var i = 0; i < n; i++) {
      if (i > 0 && ctx.C[i] != null && ctx.C[i - 1] != null && ctx.C[i - 1] > 0 && ctx.C[i] > 0) {
        var r = Math.log(ctx.C[i] / ctx.C[i - 1]);
        sq[i] = r * r;
      } else sq[i] = 0;
    }
    var s = sumArr(sq, len);
    return {
      plot_0: map1(s, function (v) { return Math.sqrt(v / len) * Math.sqrt(252) * 100; })
    };
  };
  IMPL['Accumulative Swing Index'] = function (ctx) {
    var T = num(ctx.get('in_0'), 10), n = ctx.n, out = nul(n), asi = 0;
    for (var i = 1; i < n; i++) {
      var c = ctx.C[i], pc = ctx.C[i - 1], o = ctx.O[i], po = ctx.O[i - 1], h = ctx.H[i], l = ctx.L[i];
      if (c == null || pc == null || o == null || po == null || h == null || l == null) { out[i] = asi; continue; }
      var a = Math.abs(h - pc), b = Math.abs(l - pc), d = h - l;
      var K = Math.max(a, b);
      var R;
      if (a >= b && a >= d) R = a - 0.5 * b + 0.25 * Math.abs(pc - po);
      else if (b >= a && b >= d) R = b - 0.5 * a + 0.25 * Math.abs(pc - po);
      else R = d + 0.25 * Math.abs(pc - po);
      if (R !== 0 && T !== 0) {
        var si = 50 * ((c - pc) + 0.5 * (c - o) + 0.25 * (pc - po)) / R * (K / T);
        asi += si;
      }
      out[i] = asi;
    }
    return { plot_0: out };
  };
  IMPL['Willams %R'] = function (ctx) {
    var len = intv(ctx.get('in_0'), 14);
    var hh = highest(ctx.H, len), ll = lowest(ctx.L, len);
    return { plot_0: mul(div(sub(hh, ctx.C), sub(hh, ll)), -100) };
  };

  // ---- Đợt B additions ----
  // Definitions verified against the study catalog shipped in the reference
  // chart library (metainfo + study definitions) and the standard published
  // formulas; implemented here from those definitions.

  IMPL['Arnaud Legoux Moving Average'] = function (ctx) {
    // ALMA (Arnaud Legoux): Gaussian weights over the window ordered
    // oldest -> newest: m = floor(offset * (size - 1)), s = size / sigma,
    // w(k) = exp(-(k - m)^2 / (2 s^2)), normalized by the weight sum.
    var size = Math.max(1, intv(ctx.get('in_0'), 9));
    var offset = num(ctx.get('in_1'), 0.85), sigma = num(ctx.get('in_2'), 6);
    var m = Math.floor(offset * (size - 1)), s = sigma === 0 ? 1 : size / sigma;
    var w = [], wsum = 0;
    for (var k = 0; k < size; k++) { var wk = Math.exp(-((k - m) * (k - m)) / (2 * s * s)); w.push(wk); wsum += wk; }
    var n = ctx.n, out = nul(n), C = ctx.C;
    for (var i = size - 1; i < n; i++) {
      var acc = 0, ok = true;
      for (var j = 0; j < size; j++) {
        var v = C[i - size + 1 + j];
        if (v == null || !isFinite(v)) { ok = false; break; }
        acc += w[j] * v;
      }
      if (ok && wsum !== 0) out[i] = acc / wsum;
    }
    return { plot_0: out };
  };
  IMPL['Keltner Channels'] = function (ctx) {
    // Basis = EMA(close, length); range = EMA(true range, length) — or EMA
    // of (high - low) when useTrueRange is off; bands = basis ± mult * range.
    // Library defaults: useTrueRange = true, length = 20, mult = 1.
    var len = intv(ctx.get('in_1'), 20), mult = num(ctx.get('in_2'), 1);
    var useTR = ctx.get('in_0') !== false && ctx.get('in_0') !== '!1';
    var basis = ema(ctx.C, len);
    var range = useTR ? trueRange(ctx.bars) : sub(ctx.H, ctx.L);
    var rng = ema(range, len);
    return { plot_0: add(basis, mul(rng, mult)), plot_1: basis, plot_2: sub(basis, mul(rng, mult)) };
  };
  IMPL['Moving Average Hamming'] = function (ctx) {
    // Sine-taper weighted MA as defined in the reference library: the
    // weight of a bar of age a (0 = newest) in a window of length P is
    // sin((a + 2) * PI / (2P)); weights normalized by their sum.
    var P = Math.max(1, intv(ctx.get('periods'), 10));
    var n = ctx.n, out = nul(n), C = ctx.C;
    var wAge = [], wsum = 0;
    for (var a = 0; a < P; a++) { var wa = Math.sin((a + 2) * Math.PI / (2 * P)); wAge.push(wa); wsum += wa; }
    for (var i = P - 1; i < n; i++) {
      var acc = 0, ok = true;
      for (var j = 0; j < P; j++) {
        var v = C[i - j];
        if (v == null || !isFinite(v)) { ok = false; break; }
        acc += wAge[j] * v;
      }
      if (ok && wsum !== 0) out[i] = acc / wsum;
    }
    return { plot_0: out };
  };
  IMPL['Advance/Decline'] = function (ctx) {
    // Library definition: (# bars with close > open) / (# bars with
    // close < open) counted over the length window; when the down count
    // is 0 the value is the up count.
    var len = intv(ctx.get('in_0'), 10), n = ctx.n, out = nul(n);
    var up = nul(n), dn = nul(n);
    for (var i = 0; i < n; i++) {
      up[i] = (ctx.C[i] != null && ctx.O[i] != null && ctx.C[i] > ctx.O[i]) ? 1 : 0;
      dn[i] = (ctx.C[i] != null && ctx.O[i] != null && ctx.C[i] < ctx.O[i]) ? 1 : 0;
    }
    var su = sumArr(up, len), sd = sumArr(dn, len);
    for (var j = 0; j < n; j++) {
      if (su[j] == null || sd[j] == null) continue;
      out[j] = sd[j] === 0 ? su[j] : su[j] / sd[j];
    }
    return { plot_0: out };
  };
  IMPL['Majority Rule'] = function (ctx) {
    // Library definition: 100 * SMA(close > previous close, rollingPeriod)
    // — the percentage of rising bars inside the rolling window.
    var len = intv(ctx.get('rollingPeriod'), 14), n = ctx.n;
    var up = nul(n);
    up[0] = 0;
    for (var i = 1; i < n; i++) up[i] = (ctx.C[i] != null && ctx.C[i - 1] != null && ctx.C[i] > ctx.C[i - 1]) ? 1 : 0;
    return { plot_0: mul(sma(up, len), 100) };
  };
  IMPL['Standard Error'] = function (ctx) {
    // Standard error of the least-squares line fitted to close over the
    // window: SE = sqrt((SS_tot - slope^2 * SS_xx) / (N - 2)).
    var len = Math.max(3, intv(ctx.get('length'), 14)), n = ctx.n, out = nul(n), C = ctx.C;
    var sx = len * (len - 1) / 2, sxx = (len - 1) * len * (2 * len - 1) / 6;
    var den = len * sxx - sx * sx, ssx = sxx - sx * sx / len;
    for (var i = len - 1; i < n; i++) {
      var sy = 0, syy = 0, sxy = 0, ok = true;
      for (var j = 0; j < len; j++) {
        var v = C[i - len + 1 + j];
        if (v == null || !isFinite(v)) { ok = false; break; }
        sy += v; syy += v * v; sxy += j * v;
      }
      if (!ok || den === 0) continue;
      var slope = (len * sxy - sx * sy) / den;
      var sse = (syy - sy * sy / len) - slope * slope * ssx;
      out[i] = Math.sqrt(Math.max(0, sse) / (len - 2));
    }
    return { plot_0: out };
  };
  IMPL['Regression Trend'] = function (ctx) {
    // Library study (hidden, graphics output): a single least-squares line
    // fitted to the source over a selected range, plus deviation lines.
    // The engine has no range picker, so the range is the full loaded
    // series and the lines are evaluated at every bar. Library defaults:
    // source = close, deviations = ±2 population stdevs of the residuals.
    var src = ctx.C, n = ctx.n, out0 = nul(n), out1 = nul(n), out2 = nul(n);
    var first = -1, last = -1, cnt = 0;
    for (var i = 0; i < n; i++) if (src[i] != null && isFinite(src[i])) { if (first < 0) first = i; last = i; cnt++; }
    if (cnt < 2 || first < 0) return { plot_0: out0, plot_1: out1, plot_2: out2 };
    var span = last - first + 1;
    var sx = 0, sy = 0, sxx = 0, sxy = 0, ok = true;
    for (var j = 0; j < span; j++) {
      var v = src[first + j];
      if (v == null || !isFinite(v)) { ok = false; break; }
      sx += j; sy += v; sxx += j * j; sxy += j * v;
    }
    if (!ok) return { plot_0: out0, plot_1: out1, plot_2: out2 };
    var den = span * sxx - sx * sx;
    if (den === 0) return { plot_0: out0, plot_1: out1, plot_2: out2 };
    var slope = (span * sxy - sx * sy) / den;
    var intercept = (sy - slope * sx) / span;
    var sse = 0;
    for (var k = 0; k < span; k++) { var r = src[first + k] - (intercept + slope * k); sse += r * r; }
    var sd = Math.sqrt(sse / span);
    for (var t = 0; t < span; t++) {
      var base = intercept + slope * t;
      out0[first + t] = base; out1[first + t] = base + 2 * sd; out2[first + t] = base - 2 * sd;
    }
    return { plot_0: out0, plot_1: out1, plot_2: out2 };
  };
  IMPL['Chop Zone'] = function (ctx) {
    // Everget Chop Zone, library definition: the signed angle (degrees,
    // rounded) of the EMA(34) slope. With hh/ll = highest/lowest of high
    // over 30 bars and o = 25 * ll / (hh - ll):
    //   c = (ema[prev] - ema) / hlc3 * o;  angle = round(deg(atan(|c|)));
    //   value = -angle when c > 0 (falling EMA), else +angle.
    // (The library draws the value as a colorer over a constant strip; the
    // engine plots the angle itself — the study's actual quantity.)
    var n = ctx.n, out = nul(n);
    var e = ema(ctx.C, 34);
    var hh = highest(ctx.H, 30), ll = lowest(ctx.H, 30);
    for (var i = 1; i < n; i++) {
      if (e[i] == null || e[i - 1] == null || hh[i] == null || ll[i] == null) continue;
      if (ctx.hlc3[i] == null || ctx.hlc3[i] === 0) continue;
      var range = hh[i] - ll[i];
      if (range === 0) continue;
      var o = 25 / range * ll[i];
      var c = (e[i - 1] - e[i]) / ctx.hlc3[i] * o;
      var d = Math.round(180 * Math.acos(1 / Math.sqrt(1 + c * c)) / Math.PI);
      out[i] = c > 0 ? -d : d;
    }
    return { plot_0: out };
  };
  function barDeltaDays(bars, i) {
    // Calendar days between bars i-1 and i (from bar times); 1 when the
    // times are missing or non-increasing.
    if (i <= 0) return 1;
    var d1 = barDate(bars[i] && bars[i].t), d0 = barDate(bars[i - 1] && bars[i - 1].t);
    if (!d1 || !d0) return 1;
    var dd = (d1.getTime() - d0.getTime()) / 86400000;
    return (dd > 0 && isFinite(dd)) ? dd : 1;
  }
  IMPL['Volatility Zero Trend Close-to-Close'] = function (ctx) {
    // Zero-trend (zero-mean) close-to-close estimator, time-scaled as in
    // the library: each bar contributes (ln(C/Cprev))^2 * daysPerYear /
    // deltaDays; value = 100 * sqrt(mean over the Periods window).
    var periods = Math.max(1, intv(ctx.get('periods'), 10));
    var dpy = num(ctx.get('daysPerYear'), 252);
    var n = ctx.n, sq = nul(n);
    for (var i = 1; i < n; i++) {
      if (ctx.C[i] == null || ctx.C[i - 1] == null || ctx.C[i - 1] <= 0 || ctx.C[i] <= 0) continue;
      var r = Math.log(ctx.C[i] / ctx.C[i - 1]);
      sq[i] = r * r * dpy / barDeltaDays(ctx.bars, i);
    }
    var s = sumArr(sq, periods);
    return { plot_0: map1(s, function (v) { return 100 * Math.sqrt(v / periods); }) };
  };
  IMPL['Volatility O-H-L-C'] = function (ctx) {
    // Garman-Klass O-H-L-C estimator with the library's time scaling and
    // optional market-closed adjustment:
    //   g = 0.5*(ln(H/L))^2 - (ln4 - 1)*(ln(C/O))^2
    //   value = 100 * sqrt(daysPerYear * mean(g / deltaDays)) over Periods.
    var periods = Math.max(1, intv(ctx.get('periods'), 10));
    var mcp = num(ctx.get('marketClosedPercentage'), 0);
    var dpy = num(ctx.get('daysPerYear'), 252);
    var n = ctx.n, g = nul(n), LN4M1 = Math.log(4) - 1;
    for (var i = 0; i < n; i++) {
      var o = ctx.O[i], h = ctx.H[i], l = ctx.L[i], c = ctx.C[i];
      if (o == null || h == null || l == null || c == null || o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
      var v = 0.5 * Math.pow(Math.log(h / l), 2) - LN4M1 * Math.pow(Math.log(c / o), 2);
      if (mcp > 0 && i > 0 && ctx.C[i - 1] != null && ctx.C[i - 1] > 0) {
        v = 0.12 * Math.pow(Math.log(o / ctx.C[i - 1]), 2) / mcp + 0.88 * v / (1 - mcp);
      }
      g[i] = v * dpy / barDeltaDays(ctx.bars, i);
    }
    var s = sumArr(g, periods);
    return { plot_0: map1(s, function (v) { return 100 * Math.sqrt(v / periods); }) };
  };
  IMPL['Volatility Index'] = function (ctx) {
    // ATR trailing-stop index (library definition; defaults periods = 10,
    // atrMult = 3, method = Wilder Smoothing). Warmup of `periods` bars
    // (mean TR, highest close) seeds a long stop at sic - mult * ATR; each
    // later bar plots the current stop, then the stop advances with the
    // extreme close since the position started and the smoothed ATR; a
    // close through the stop flips the side.
    var P = Math.max(1, intv(ctx.get('periods'), 10));
    var mult = num(ctx.get('atrMult'), 3);
    var method = String(ctx.get('method') || 'Wilder Smoothing');
    var n = ctx.n, out = nul(n), C = ctx.C;
    if (n <= P) return { plot_0: out };
    var tr = trueRange(ctx.bars);
    var sum = 0, sic = null, wi;
    for (wi = 0; wi < P; wi++) {
      if (tr[wi] == null || C[wi] == null) return { plot_0: out };
      sum += tr[wi]; if (sic === null || C[wi] > sic) sic = C[wi];
    }
    var atrS = sum / P;
    var emaK = 2 / (P + 1), emaState = null;
    if (method === 'Exponential') {
      for (var s2 = 0; s2 < P; s2++) emaState = (emaState === null) ? tr[s2] : emaK * tr[s2] + (1 - emaK) * emaState;
    }
    var posLong = true, next = sic - atrS * mult;
    for (var j = P; j < n; j++) {
      if (C[j] == null || tr[j] == null) continue;
      var stop = next;
      out[j] = stop;
      var off;
      if (method === 'Exponential') {
        emaState = (emaState === null) ? tr[j] : emaK * tr[j] + (1 - emaK) * emaState;
        off = emaState * mult;
      } else {
        atrS = tr[j] / P + (1 - 1 / P) * atrS;
        off = atrS * mult;
      }
      if (posLong) {
        if (C[j] < stop) { posLong = false; sic = C[j]; next = sic + off; }
        else { if (C[j] > sic) sic = C[j]; next = sic - off; }
      } else {
        if (C[j] > stop) { posLong = true; sic = C[j]; next = sic - off; }
        else { if (C[j] < sic) sic = C[j]; next = sic + off; }
      }
    }
    return { plot_0: out };
  };
  IMPL['Williams Fractals'] = function (ctx) {
    // Bill Williams fractals with the library's tie handling. An up
    // fractal at bar m requires every newer bar in the window strictly
    // below H[m]; on the older side the bars must be strictly below,
    // except that up to 4 immediately-older bars may equal H[m] when a
    // strictly lower bar follows inside the extended window. Down
    // fractals mirror this on lows. A fractal is confirmed `periods`
    // bars after m; its value sits on bar m, so the last `periods` bars
    // never carry a value. plot_0 = down fractals (at low), plot_1 = up
    // fractals (at high), per the catalog's plot order.
    var P = Math.max(1, intv(ctx.get('in_0'), 2));
    var n = ctx.n, up = nul(n), dn = nul(n), H = ctx.H, L = ctx.L;
    function side(arr, m, isUp) {
      var c0 = arr[m];
      if (c0 == null) return false;
      var j;
      for (j = 1; j <= P; j++) {
        var vn = arr[m + j];
        if (vn == null || (isUp ? !(vn < c0) : !(vn > c0))) return false;
      }
      for (var k = 0; k <= 4; k++) {
        var okk = true;
        for (j = 1; j <= P + k; j++) {
          var vo = arr[m - j];
          if (vo == null) { okk = false; break; }
          if (j <= k) { if (isUp ? !(vo <= c0) : !(vo >= c0)) { okk = false; break; } }
          else if (isUp ? !(vo < c0) : !(vo > c0)) { okk = false; break; }
        }
        if (okk) return true;
      }
      return false;
    }
    for (var m = P; m + P < n; m++) {
      if (side(H, m, true)) up[m] = H[m];
      if (side(L, m, false)) dn[m] = L[m];
    }
    return { plot_0: dn, plot_1: up };
  };

  // ---------------- public API ----------------
  var SPEC_BY_NAME = {};
  (window.PP_STUDIES || []).forEach(function (s) { SPEC_BY_NAME[s.name] = s; });
  var PALETTE = ['#2196F3', '#FF6D00', '#43A047', '#E91E63', '#7E57C2', '#00BCD4', '#FFC107', '#795548', '#607D8B', '#F50057'];
  function kindOf(studyName, plotId, specType) {
    if (studyName === 'Moving Average Convergence/Divergence' && plotId === 'plot_0') return 'histogram';
    if (studyName === 'Volume' && plotId === 'vol') return 'histogram';
    if (studyName === 'SMI Ergodic Indicator/Oscillator' && plotId === 'plot_2') return 'histogram';
    if (specType === 'histogram' || specType === 'columns') return 'histogram';
    if (specType === 'area') return 'area';
    return 'line';
  }
  function compute(studyName, bars, inputs) {
    try {
      if (!Array.isArray(bars) || bars.length === 0) return { plots: [], bands: [] };
      var spec = SPEC_BY_NAME[studyName];
      if (!spec) return { plots: [], bands: [] };
      var bands = (spec.bands || []).map(function (v) { return { value: v, color: '#787B86' }; });
      var impl = IMPL[studyName];
      if (!impl) return { plots: [], bands: bands };
      var merged = {};
      (spec.inputs || []).forEach(function (inp) { merged[inp.id] = inp.defval; });
      if (inputs) { Object.keys(inputs).forEach(function (k) { merged[k] = inputs[k]; }); }
      var ctx = buildCtx(bars, spec, merged, inputs || {});
      var res = impl(ctx) || {};
      var specPlots = spec.plots || [];
      var order = specPlots.map(function (p) { return p.id; });
      var ids = Object.keys(res).filter(function (id) { return id !== '__empty'; });
      ids.sort(function (a, b) {
        var ia = order.indexOf(a), ib = order.indexOf(b);
        if (ia === -1) ia = 999; if (ib === -1) ib = 999;
        return ia - ib;
      });
      var plots = [];
      ids.forEach(function (id, idx) {
        var raw = res[id];
        var values = Array.isArray(raw) ? raw : (raw && raw.values);
        if (!Array.isArray(values)) return;
        var sp = null;
        for (var i = 0; i < specPlots.length; i++) { if (specPlots[i].id === id) { sp = specPlots[i]; break; } }
        var clean = values.slice(0, bars.length);
        while (clean.length < bars.length) clean.push(null);
        for (var j = 0; j < clean.length; j++) {
          if (typeof clean[j] !== 'number' || !isFinite(clean[j])) clean[j] = null;
        }
        plots.push({
          id: id,
          kind: kindOf(studyName, id, sp ? sp.type : null),
          color: (raw && raw.color) || (spec.colors && spec.colors[id]) || PALETTE[idx % PALETTE.length],
          title: (raw && raw.title) || (sp ? sp.title : id),
          values: clean
        });
      });
      return { plots: plots, bands: bands };
    } catch (e) {
      return { plots: [], bands: [] };
    }
  }

  window.PP_IND = {
    compute: compute,
    implemented: Object.keys(IMPL),
    helpers: { sma: sma, ema: ema, wma: wma, rma: rma, stdev: stdev, atr: atr }
  };
})();
