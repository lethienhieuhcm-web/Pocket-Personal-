/* PP_CHART — adapter ve bieu do bang Lightweight Charts v5.0.8 (vendor,
 * Apache-2.0, js/vendor/lightweight-charts.js).
 *
 * KHAI BAO TU CHE (theo phuong an bieu do the he 2, muc 4):
 * - Renderer loi (nen, truc, crosshair, zoom) dung SAN cua thu vien.
 * - Adapter nay TU CHE: map ket qua PP_IND -> series/pane cua thu vien.
 * - Custom Series to nen band (Bollinger/Keltner) + may Ichimoku TU CHE
 *   theo mau plugin Custom Series chinh thuc cua thu vien (interface
 *   ICustomSeriesPaneView: renderer/update/priceValueBuilder/isWhitespace).
 *
 * API:
 *   PP_CHART.render(container, model) -> true/false (false = goi fallback)
 *     model: { bars:[{t,o,h,l,c,v}] (tang dan), scale (1000 ma / 1 chi so),
 *              pricePrecision, intraday:bool,
 *              studies:[{st:{name,inputs}, spec, res:{plots,bands}}],
 *              volLines:[{color, vals}] }
 *   PP_CHART.destroy()
 *   Cac ham map du lieu thuan (test bang node, khong can DOM):
 *     toTime, candleData, volumeData, plotData, bandData, fillFor
 *
 * Quy uoc don vi giong ban SVG: gia nhan scale khi ve (ma x1000, chi so x1);
 * pane chi nhan scale voi cac study trong PRICE_UNIT (giong IND_PRICE_UNIT
 * o stocks.html). Volume giu nguyen so co phieu.
 */
(function () {
  'use strict';

  var UP = '#16a34a', DOWN = '#dc2626';
  var PRICE_UNIT = {
    'Average True Range': 1, 'Standard Deviation': 1,
    'Detrended Price Oscillator': 1, 'Price Oscillator': 1,
    'Linear Regression Slope': 1
  };

  // ---------------- map du lieu thuan ----------------
  function toTime(t) {
    if (typeof t === 'number') return t > 1e12 ? Math.floor(t / 1000) : t;
    if (typeof t === 'string' && t.indexOf('T') >= 0) {
      var ms = Date.parse(t);
      if (!isNaN(ms)) return Math.floor(ms / 1000);
    }
    return t; // 'YYYY-MM-DD' (business day) hoac chuoi thoi gian khac
  }
  function timeKey(t) {
    var x = toTime(t);
    if (typeof x === 'number') return x;
    var ms = Date.parse(String(x) + 'T00:00:00Z');
    return isNaN(ms) ? 0 : ms / 1000;
  }
  function sortedDedup(items) {
    var m = new Map();
    items.forEach(function (it) { m.set(timeKey(it.time), it); });
    return Array.from(m.values()).sort(function (a, b) {
      return timeKey(a.time) - timeKey(b.time);
    });
  }
  function candleData(bars, scale) {
    return sortedDedup(bars.map(function (b) {
      return {
        time: toTime(b.t),
        open: b.o * scale, high: b.h * scale,
        low: b.l * scale, close: b.c * scale
      };
    }));
  }
  function volumeData(bars) {
    return sortedDedup(bars.map(function (b) {
      var up = b.c >= b.o;
      return {
        time: toTime(b.t), value: b.v || 0,
        color: up ? 'rgba(22,163,74,0.5)' : 'rgba(220,38,38,0.5)'
      };
    }));
  }
  function plotData(bars, values, mul) {
    var out = [];
    for (var i = 0; i < bars.length; i++) {
      var v = values ? values[i] : null;
      if (v == null || !isFinite(v)) continue;
      out.push({ time: toTime(bars[i].t), value: v * mul });
    }
    return sortedDedup(out);
  }
  function bandData(bars, upperValues, lowerValues, mul) {
    var out = [];
    for (var i = 0; i < bars.length; i++) {
      var u = upperValues ? upperValues[i] : null;
      var l = lowerValues ? lowerValues[i] : null;
      if (u == null || l == null || !isFinite(u) || !isFinite(l)) continue;
      out.push({ time: toTime(bars[i].t), top: u * mul, bottom: l * mul });
    }
    return sortedDedup(out);
  }
  // Quy tac to nen: theo ten study + title plot trong spec.
  function fillFor(studyName, plots) {
    function byTitle(t) {
      for (var i = 0; i < (plots || []).length; i++) {
        if (plots[i].title === t) return plots[i];
      }
      return null;
    }
    if (studyName === 'Bollinger Bands' || studyName === 'Keltner Channels') {
      var u = byTitle('Upper'), l = byTitle('Lower');
      if (u && l) {
        return { upper: u, lower: l, cloud: false,
                 color: studyName === 'Bollinger Bands'
                   ? 'rgba(41,98,255,0.09)' : 'rgba(126,87,194,0.09)' };
      }
    }
    if (studyName === 'Ichimoku Cloud') {
      var a = byTitle('Leading Span A'), b = byTitle('Leading Span B');
      if (a && b) return { upper: a, lower: b, cloud: true, color: null };
    }
    return null;
  }

  // ---------------- Custom Series to nen band / may ----------------
  function BandRenderer() { this._data = null; this._options = null; }
  BandRenderer.prototype.draw = function (target, priceToCoordinate) {
    var data = this._data, opts = this._options;
    if (!data || !data.bars || !data.bars.length || !opts) return;
    var bars = data.bars, vr = data.visibleRange || { from: 0, to: bars.length };
    target.useBitmapCoordinateSpace(function (scope) {
      var ctx = scope.context;
      var hr = scope.horizontalPixelRatio, vratio = scope.verticalPixelRatio;
      function X(bar) { return bar.x * hr; }
      function Y(v) { return priceToCoordinate(v) * vratio; }
      var i, bar;
      if (opts.cloud) {
        // May Ichimoku: to tung doan, mau theo A >= B hay A < B.
        for (i = vr.from; i < vr.to - 0; i++) {
          bar = bars[i];
          var nxt = bars[i + 1];
          if (!nxt) break;
          var o1 = bar.originalData, o2 = nxt.originalData;
          ctx.fillStyle = o1.top >= o1.bottom ? opts.fillUpColor : opts.fillDownColor;
          ctx.beginPath();
          ctx.moveTo(X(bar), Y(o1.top));
          ctx.lineTo(X(nxt), Y(o2.top));
          ctx.lineTo(X(nxt), Y(o2.bottom));
          ctx.lineTo(X(bar), Y(o1.bottom));
          ctx.closePath();
          ctx.fill();
        }
      } else {
        ctx.fillStyle = opts.fillColor;
        ctx.beginPath();
        var started = false;
        for (i = vr.from; i < vr.to; i++) {
          bar = bars[i];
          var y = Y(bar.originalData.top);
          if (!started) { ctx.moveTo(X(bar), y); started = true; }
          else ctx.lineTo(X(bar), y);
        }
        for (i = vr.to - 1; i >= vr.from; i--) {
          bar = bars[i];
          ctx.lineTo(X(bar), Y(bar.originalData.bottom));
        }
        ctx.closePath();
        ctx.fill();
      }
    });
  };

  function BandSeries() {
    this._renderer = new BandRenderer();
  }
  BandSeries.prototype.renderer = function () { return this._renderer; };
  BandSeries.prototype.update = function (data, options) {
    this._renderer._data = data;
    this._renderer._options = options || this.defaultOptions();
  };
  BandSeries.prototype.priceValueBuilder = function (item) {
    return [item.top, item.bottom];
  };
  BandSeries.prototype.isWhitespace = function (item) {
    return item == null || item.top == null || item.bottom == null;
  };
  BandSeries.prototype.defaultOptions = function () {
    var base = (typeof window !== 'undefined' && window.LightweightCharts)
      ? window.LightweightCharts.customSeriesDefaultOptions : {};
    var out = {};
    Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
    out.fillColor = 'rgba(41,98,255,0.09)';
    out.fillUpColor = 'rgba(22,163,74,0.14)';
    out.fillDownColor = 'rgba(220,38,38,0.14)';
    out.cloud = false;
    out.priceLineVisible = false;
    out.lastValueVisible = false;
    out.crosshairMarkerVisible = false;
    return out;
  };

  // ---------------- theme ----------------
  function themeColors() {
    var fb = { bg: '#ffffff', ink: '#222222', mut: '#888888', line: 'rgba(140,140,140,0.25)' };
    try {
      var cs = getComputedStyle(document.body);
      function v(n, d) { var x = (cs.getPropertyValue(n) || '').trim(); return x || d; }
      return {
        bg: v('--pp-card', fb.bg), ink: v('--pp-ink', fb.ink),
        mut: v('--pp-mut', fb.mut), line: v('--pp-line', fb.line)
      };
    } catch (e) { return fb; }
  }
  function hexToRgba(hex, a) {
    if (typeof hex !== 'string') return hex;
    var m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' +
      (n & 255) + ',' + a + ')';
  }

  // ---------------- render chinh ----------------
  var state = { chart: null, container: null, legendEl: null, ro: null, mo: null, lastRange: null, lastBarCount: 0 };

  function destroy() {
    if (state.ro) { try { state.ro.disconnect(); } catch (e) {} state.ro = null; }
    if (state.chart) { try { state.chart.remove(); } catch (e) {} state.chart = null; }
    state.container = null; state.legendEl = null;
  }

  function fmtVal(v, mul) {
    if (v == null || !isFinite(v)) return '';
    var x = v * (mul || 1);
    return Math.abs(x) >= 1000
      ? Math.round(x).toLocaleString('vi-VN')
      : String(Math.round(x * 100) / 100);
  }

  function render(container, model) {
    var LWC = (typeof window !== 'undefined') ? window.LightweightCharts : null;
    if (!LWC || !container || !model || !model.bars || model.bars.length < 2) return false;
    var bars = model.bars, scale = model.scale || 1;
    var studies = (model.studies || []).filter(function (s) {
      return s && s.res && s.res.plots && s.res.plots.length && s.spec;
    });
    var overlays = studies.filter(function (s) { return s.spec.priceStudy; });
    var paneStudies = studies.filter(function (s) { return !s.spec.priceStudy; });

    // Giu nguyen khoang nhin khi ve lai cung so nen (sua tham so/them bot).
    var prevRange = null;
    if (state.chart && state.lastBarCount === bars.length) {
      try { prevRange = state.chart.timeScale().getVisibleLogicalRange(); } catch (e) {}
    }
    destroy();
    state.container = container;
    container.innerHTML = '';

    var legend = document.createElement('div');
    legend.id = 'ppChartLegend';
    legend.style.cssText = 'font-size:11.5px;line-height:1.5;color:var(--pp-mut);' +
      'min-height:18px;margin:2px 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    container.appendChild(legend);
    state.legendEl = legend;

    var holder = document.createElement('div');
    holder.style.cssText = 'position:relative;width:100%';
    container.appendChild(holder);

    var credit = document.createElement('div');
    credit.style.cssText = 'font-size:10px;color:var(--pp-mut);margin-top:3px;text-align:right';
    credit.innerHTML = 'Powered by <a href="https://www.tradingview.com/" target="_blank" rel="noopener" style="color:var(--pp-mut);text-decoration:underline">TradingView</a>';
    container.appendChild(credit);

    var tc = themeColors();
    var paneCount = paneStudies.length;
    var height = 330 + paneCount * 105;
    var width = container.clientWidth || holder.clientWidth || 340;
    var chart = LWC.createChart(holder, {
      width: width, height: height,
      layout: {
        background: { type: LWC.ColorType.Solid, color: tc.bg },
        textColor: tc.ink, fontSize: 11,
        attributionLogo: false
      },
      grid: {
        vertLines: { color: tc.line }, horzLines: { color: tc.line }
      },
      crosshair: {
        vertLine: { color: tc.mut, labelBackgroundColor: tc.mut },
        horzLine: { color: tc.mut, labelBackgroundColor: tc.mut }
      },
      rightPriceScale: { borderColor: tc.line },
      timeScale: {
        borderColor: tc.line, timeVisible: !!model.intraday,
        secondsVisible: false, rightOffset: 2
      }
    });
    state.chart = chart;
    state.lastBarCount = bars.length;

    var priceFmt = { type: 'price', precision: model.pricePrecision != null ? model.pricePrecision : 0, minMove: model.pricePrecision ? 0.01 : 1 };

    // (1) Band/may truoc de nam duoi nen.
    var registry = []; // {series,label,color,mul,kind} cho legend crosshair
    function addBand(study) {
      var fill = fillFor(study.st.name, study.spec.plots);
      if (!fill) return;
      var up = fill.upper, lo = fill.lower;
      var upPlot = study.res.plots.filter(function (p) { return p.id === up.id; })[0];
      var loPlot = study.res.plots.filter(function (p) { return p.id === lo.id; })[0];
      if (!upPlot || !loPlot) return;
      var view = new BandSeries();
      var s = chart.addCustomSeries(view, {
        cloud: !!fill.cloud,
        fillColor: fill.color || 'rgba(41,98,255,0.09)',
        priceFormat: priceFmt
      }, 0);
      s.setData(bandData(bars, upPlot.values, loPlot.values, scale));
    }
    overlays.forEach(addBand);

    // (2) Nen chinh.
    var candleSeries = chart.addSeries(LWC.CandlestickSeries, {
      upColor: UP, downColor: DOWN,
      wickUpColor: UP, wickDownColor: DOWN,
      borderVisible: false, priceFormat: priceFmt
    }, 0);
    var candles = candleData(bars, scale);
    candleSeries.setData(candles);
    registry.push({ series: candleSeries, kind: 'candles', label: '', color: '', mul: 1 });

    // (3) Volume tren thang gia an 'vol' cua pane 0 + 2 duong MA khoi luong.
    var volSeries = chart.addSeries(LWC.HistogramSeries, {
      priceScaleId: 'vol', priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false
    }, 0);
    volSeries.setData(volumeData(bars));
    try {
      chart.priceScale('vol', 0).applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      chart.priceScale('right', 0).applyOptions({ scaleMargins: { top: 0.02, bottom: 0.18 } });
    } catch (e) {}
    (model.volLines || []).forEach(function (L) {
      var s = chart.addSeries(LWC.LineSeries, {
        priceScaleId: 'vol', color: L.color, lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
      }, 0);
      s.setData(plotData(bars, L.vals, 1));
    });

    // (4) Overlay lines/areas/dots.
    overlays.forEach(function (study) {
      study.res.plots.forEach(function (p) {
        var data = plotData(bars, p.values, scale);
        var label = (study.spec.short || study.st.name) + ' ' + (p.title || p.id);
        var s;
        if (p.kind === 'area') {
          s = chart.addSeries(LWC.AreaSeries, {
            lineColor: p.color, topColor: hexToRgba(p.color, 0.28),
            bottomColor: hexToRgba(p.color, 0.02), lineWidth: 1,
            priceLineVisible: false, lastValueVisible: true, priceFormat: priceFmt
          }, 0);
        } else if (study.st.name === 'Parabolic SAR') {
          s = chart.addSeries(LWC.LineSeries, {
            color: p.color, lineVisible: false, pointMarkersVisible: true,
            pointMarkersRadius: 2, priceLineVisible: false,
            lastValueVisible: false, priceFormat: priceFmt
          }, 0);
        } else if (p.kind === 'histogram') {
          s = chart.addSeries(LWC.HistogramSeries, {
            color: p.color, priceLineVisible: false, lastValueVisible: true,
            priceFormat: priceFmt
          }, 0);
          s.setData(data.map(function (d) { return { time: d.time, value: d.value, color: hexToRgba(p.color, 0.75) }; }));
          registry.push({ series: s, kind: 'plot', label: label, color: p.color, mul: 1, rawMul: scale });
          return;
        } else {
          s = chart.addSeries(LWC.LineSeries, {
            color: p.color, lineWidth: 1, priceLineVisible: false,
            lastValueVisible: true, crosshairMarkerVisible: true, priceFormat: priceFmt
          }, 0);
        }
        s.setData(data);
        registry.push({ series: s, kind: 'plot', label: label, color: p.color, mul: 1, rawMul: scale });
      });
    });

    // (5) Pane rieng cho tung study khong phai price study.
    // LWC v5: addPane() tra ve IPaneApi (khong phai index) — lay index qua panes().
    paneStudies.forEach(function (study) {
      var paneApi = chart.addPane();
      var paneIdx = chart.panes().indexOf(paneApi);
      if (paneIdx < 0) paneIdx = chart.panes().length - 1;
      try { paneApi.setStretchFactor(1); } catch (e) {}
      var mul = PRICE_UNIT[study.st.name] ? scale : 1;
      var firstSeries = null;
      study.res.plots.forEach(function (p) {
        var data = plotData(bars, p.values, mul);
        var label = (study.spec.short || study.st.name) + ' ' + (p.title || p.id);
        var s;
        if (p.kind === 'histogram') {
          s = chart.addSeries(LWC.HistogramSeries, {
            color: p.color, priceLineVisible: false, lastValueVisible: true
          }, paneIdx);
          s.setData(data.map(function (d) { return { time: d.time, value: d.value, color: hexToRgba(p.color, 0.75) }; }));
        } else if (p.kind === 'area') {
          s = chart.addSeries(LWC.AreaSeries, {
            lineColor: p.color, topColor: hexToRgba(p.color, 0.28),
            bottomColor: hexToRgba(p.color, 0.02), lineWidth: 1,
            priceLineVisible: false, lastValueVisible: true
          }, paneIdx);
          s.setData(data);
        } else {
          s = chart.addSeries(LWC.LineSeries, {
            color: p.color, lineWidth: 1, priceLineVisible: false,
            lastValueVisible: true, crosshairMarkerVisible: true
          }, paneIdx);
          s.setData(data);
        }
        if (!firstSeries) firstSeries = s;
        registry.push({ series: s, kind: 'plot', label: label, color: p.color, mul: 1, rawMul: mul });
      });
      // Duong muc ngang (bands kieu RSI 70/50/30) -> price line cham.
      if (firstSeries && study.res.bands && study.res.bands.length) {
        study.res.bands.forEach(function (b) {
          try {
            firstSeries.createPriceLine({
              price: b.value * mul, color: b.color || '#787B86',
              lineWidth: 1, lineStyle: LWC.LineStyle.Dashed,
              axisLabelVisible: true, title: ''
            });
          } catch (e) {}
        });
      }
    });
    try { chart.panes()[0].setStretchFactor(3.2); } catch (e) {}

    // Legend crosshair: OHLC + gia tri moi plot tai nen dang tro.
    var byTime = new Map();
    candles.forEach(function (c) { byTime.set(timeKey(c.time), c); });
    var rawByTime = new Map();
    bars.forEach(function (b) { rawByTime.set(timeKey(b.t), b); });
    function legendFor(time) {
      var c = time != null ? byTime.get(timeKey(time)) : candles[candles.length - 1];
      if (!c) c = candles[candles.length - 1];
      if (!c) { legend.textContent = ''; return; }
      var raw = rawByTime.get(timeKey(c.time));
      var chg = raw && raw.o ? (raw.c / raw.o - 1) * 100 : 0;
      var parts = [];
      parts.push(String(c.time));
      parts.push('O ' + fmtVal(c.open, 1) + ' · H ' + fmtVal(c.high, 1) +
        ' · L ' + fmtVal(c.low, 1) + ' · C ' + fmtVal(c.close, 1) +
        ' (' + (chg >= 0 ? '+' : '') + (Math.round(chg * 100) / 100) + '%)');
      if (raw) parts.push('Vol ' + fmtVal(raw.v || 0, 1));
      // Gia tri plot lay tu registry: tim trong du lieu da nap theo thoi gian.
      registry.forEach(function (r) {
        if (r.kind !== 'plot') return;
        var d = r._byTime ? r._byTime.get(timeKey(c.time)) : null;
        if (d) parts.push(r.label + ': ' + fmtVal(d.value, 1));
      });
      legend.innerHTML = parts.join(' &nbsp;|&nbsp; ');
    }
    // Nap chi so theo thoi gian cho tung series plot de legend doc nhanh.
    registry.forEach(function (r) {
      if (r.kind !== 'plot') return;
      try {
        var d = r.series.data();
        var m = new Map();
        (d || []).forEach(function (it) { if (it && it.value != null) m.set(timeKey(it.time), it); });
        r._byTime = m;
      } catch (e) { r._byTime = new Map(); }
    });
    legendFor(null);
    chart.subscribeCrosshairMove(function (param) {
      if (!param || param.time == null) { legendFor(null); return; }
      legendFor(param.time);
    });

    // Khoang nhin ban dau: 120 nen cuoi (keo/zoom thay du 400), hoac giu
    // nguyen khoang cu khi ve lai.
    try {
      if (prevRange) chart.timeScale().setVisibleLogicalRange(prevRange);
      else if (bars.length > 120) {
        chart.timeScale().setVisibleLogicalRange({ from: bars.length - 120, to: bars.length - 1 });
      } else {
        chart.timeScale().fitContent();
      }
    } catch (e) {}

    // Resize theo container + doi theme (class pp-dark/dark tren html/body).
    if (typeof ResizeObserver !== 'undefined') {
      state.ro = new ResizeObserver(function () {
        if (!state.chart) return;
        var w = container.clientWidth || 340;
        try { state.chart.applyOptions({ width: w }); } catch (e) {}
      });
      state.ro.observe(container);
    }
    if (!state.mo) {
      state.mo = new MutationObserver(function () {
        if (!state.chart) return;
        var c2 = themeColors();
        try {
          state.chart.applyOptions({
            layout: { background: { type: LWC.ColorType.Solid, color: c2.bg }, textColor: c2.ink },
            grid: { vertLines: { color: c2.line }, horzLines: { color: c2.line } }
          });
        } catch (e) {}
      });
      try {
        state.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        state.mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      } catch (e) {}
    }

    state.lastRange = null;
    return true;
  }

  var api = {
    render: render,
    destroy: destroy,
    toTime: toTime,
    candleData: candleData,
    volumeData: volumeData,
    plotData: plotData,
    bandData: bandData,
    fillFor: fillFor,
    _BandSeries: BandSeries
  };
  if (typeof window !== 'undefined') window.PP_CHART = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
