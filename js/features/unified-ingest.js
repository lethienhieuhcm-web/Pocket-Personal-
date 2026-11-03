/* H1 staging — module ingest HOP NHAT (thiet ke doi ung §2.2/§2.3,
 * Chot 16:20 29/10/2026). Thay the 2 module cu (push-ingest.js Ably-only
 * + do-ingest.js DO-only): 1 bien ingestMode + lastSeq CHUNG cho ca 2
 * duong; DO chinh -> Ably khi gay/im lang >5s -> pull 60s; resume theo
 * seq; lastSeq luu sessionStorage. Frame co seq moi tinh la song;
 * ping khong seq -> bo; frame trung seq -> bo. Delta-apply truc tiep
 * vao DOM (the chi so, topMovers, khoi gia Chi tiet); reload toan view
 * chi khi resume/snapshot. Loi KHONG nuot im lang: log + dem + chi bao
 * bang chu thuong (PUSH_I18N). ?pushchan=staging-h1-YYYYMMDD (staging)
 * ep Ably-only + kenh thu (tuong thich driver chung minh Ably cu).
 * stocks-v2.html CHUA noi module nay (khoang ho tich hop rieng).
 */
(function(){
  "use strict";
  var SILENCE_MS = 5000, CONNECT_MS = 30000, MAX_RETRY = 3;
  var POLL_RETRY_MS = 5*60*1000, RETRY_DELAYS = [1000, 2000, 5000];
  var VIEW_WATCH_MS = 2000, TEST_RE = /^staging-h1-\d{8}$/;
  var SEQ_KEY = "ingest_last_seq";
  /* P1-4 (§8 muc 10) — TACH HAI DONG HO. Truoc day SILENCE_MS=5s du dung
   * lam ca bang chung "dut link" lan "thi truong im", nen mot phien yen
   * lang bi gan toi thanh onBreak -> Ably -> poll (vong quay vong). Nay:
   *  - LINK-ALIVE: chi duoc reset bang `hb` (server phat ~30s, hoac ping
   *    ~25s cua ta duoc tra loi) hoac frame moi. Qua HB_LINK_DEAD_MS khong
   *    co bang chung nao -> link chet that -> onBreak.
   *  - DATA-STALE: chi duoc reset bang frame hop le (seq + ts dung phien).
   *    Qua SILENCE_MS chua co frame nhung link van song -> nhan "quiet"
   *    (thi truong yen lang), chu KHONG phai "retry". Qua DATA_STALE_MS
   *    -> nhan "stale" (so lieu cu).
   * IDLE_CLOSE_MS phia DO cung theo do (market-room.js): socket da kich
   * hoat khong bi vo chi vi phia client im lang. */
  var HB_PING_MS = 25000, HB_LINK_DEAD_MS = 70000;
  var DATA_STALE_MS = 5 * 60 * 1000, POLL_FETCH_MS = 60000;

  /* ---------- Ham thuan (test duoc bang Node, khong DOM) ---------- */
  function shouldAcceptSeq(seq, lastSeq){
    return Number.isInteger(seq) && seq > 0 && seq > lastSeq;
  }
  /* Ngay phien theo gio ICT (+07) — trung cach Worker dat ten phong DO
   * (stock.js hStockStream: Date.now()+7h -> "YYYY-MM-DD"). */
  function ictDay(ms){
    var n = Number(ms);
    if(!Number.isFinite(n)) return null;
    try{ return new Date(n + 7 * 3600 * 1000).toISOString().slice(0, 10); }catch(e){ return null; }
  }
  function sessionDay(now){ return ictDay(now === undefined ? Date.now() : now); }
  /* P1-2 (§8 muc 7): frame phai mang `ts` = moc THI TRUONG va thuoc DUNG
   * ngay phien. Thieu ts / sai dinh dang / khac phien -> tu choi (khong co
   * bang chung cu thi khong duoc in ra nhu so live). */
  function frameInSession(d, day){
    if(!d || day === undefined || day === null) return true;
    if(d.ts === undefined || d.ts === null) return false;
    var t = Number(d.ts);
    if(!Number.isFinite(t)) return false;
    return ictDay(t) === day;
  }
  function parseFrame(raw, opts){
    var d = raw;
    if(typeof d === "string"){ try{ d = JSON.parse(d); }catch(e){ return null; } }
    if(!d || typeof d !== "object") return null;
    if(typeof d.seq !== "number") return null; // ping/control khong seq
    var shaped = false;
    if(d.t === "q") shaped = (typeof d.s === "string" && d.s.length > 0);
    else if(d.t === "idx") shaped = Array.isArray(d.rows);
    if(!shaped) return null;
    if(opts && opts.sessionDate !== undefined && !frameInSession(d, opts.sessionDate)){
      if(typeof opts.onStale === "function"){ try{ opts.onStale(d); }catch(e){} }
      return null; // ngoai phien -> bo, chi de lai nhan "stale"
    }
    return d;
  }
  function nextRetryDelay(attempt){ return RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)] || 5000; }
  function channelFor(search, host){
    try{ var q = new URLSearchParams(search || "").get("pushchan") || ""; if(TEST_RE.test(q)) return q; }catch(e){}
    /* Tach kenh theo moi truong (burst 02/11: subscriber staging nhan batch
     * live production qua kenh chung `market`). Hostname staging bat dau
     * bang "staging." hoac chua "-staging" (workers.dev) -> `market-staging`
     * (khop ablyMarketChannel ben worker); production giu `market`. */
    var h = "";
    try{ h = String(host !== undefined ? host : (typeof location !== "undefined" ? location.hostname : "")).toLowerCase(); }catch(e){}
    if(h.indexOf("staging.") === 0 || h.indexOf("-staging") >= 0) return "market-staging";
    return "market";
  }
  function isTestChannel(ch){ return TEST_RE.test(ch || ""); }
  function buildDoSub(viewId, sym){
    if(viewId === "v-detail" && sym) return { syms: [String(sym).toUpperCase()] };
    return { syms: [], view: "market" };
  }
  function deltaPlan(frame, viewId, sym, idxMode){
    if(!frame) return "ignore";
    if(frame.t === "idx") return "idx";
    if(frame.t !== "q" || typeof frame.s !== "string") return "ignore";
    if(viewId === "v-market") return "q-market";
    if(viewId === "v-detail" && !idxMode && sym && String(frame.s).toUpperCase() === String(sym).toUpperCase()) return "q-detail";
    return "ignore";
  }

  /* ---------- Trang thai ---------- */
  var mode = "poll", path = "do", retries = 0;
  var errDo = 0, errAbly = 0, gotFrame = false;
  var lastErr = ""; // DEBUG TAM: loi gan nhat de browser task doc duoc
  var lastSeq = 0, lastFrameAt = 0;
  var linkAliveAt = 0;   // P1-4: reset bang hb HOAC frame moi
  var lastDataAt = 0;    // P1-4: CHI reset bang frame hop le (ts dung phien)
  var wsDo = null, ablyClient = null, ablyChannel = null;
  var silenceTimer = null, connectTimer = null, retryTimer = null, pollTimer = null, viewTimer = null;
  var hbTimer = null, linkTimer = null, staleTimer = null, pollFetchTimer = null;
  var lastView = null, lastSym = null, lastDeltaErrAt = 0, started = false;
  var handshaked = false;  // DO đã trả {t:"ok"} = link sống, chưa cần dữ liệu
  try{ lastSeq = parseInt(sessionStorage.getItem(SEQ_KEY) || "0", 10) || 0; }catch(e){ lastSeq = 0; }
  function errCount(){ return errDo + errAbly; }
  function chanName(){
    try{ return channelFor(location.search); }catch(e){ return "market"; }
  }
  function testMode(){ return isTestChannel(chanName()); }
  /* P1-2 (§8 muc 7): ca hai duong (DO + Ably) deu bo frame khac ngay
   * phien va gan nhan "so lieu cu" thay vi in ra nhu so live. */
  function frameOpts(){
    return {
      sessionDate: sessionDay(),
      onStale: function(d){
        try{ console.warn("[ingest] frame ngoai phien (ts=" + d.ts + ") -> bo, nhan stale"); }catch(e){}
        setStatus("stale");
      }
    };
  }

  function lang(){
    try{ if(typeof curLang !== "undefined" && curLang) return curLang; }catch(e){}
    try{ return (document.documentElement.lang || "vi").slice(0, 2); }catch(e){ return "vi"; }
  }
  function setStatus(key){
    var el = null;
    try{ el = document.getElementById("pushStatus"); }catch(e){}
    if(!el) return;
    var d = null;
    try{ d = (typeof PUSH_I18N !== "undefined" && PUSH_I18N[key]) || null; }catch(e){}
    el.textContent = d ? (d[lang()] || d.vi) : key;
    // DEBUG TAM 03/11 (chan doan stream): ghi state ingest vao #ingestDbg
    // de browser task doc duoc (khong mo duoc DevTools). XOA SAU KHI XONG.
    try{
      var dbg = document.getElementById("ingestDbg");
      if(!dbg){
        dbg = document.createElement("div");
        dbg.id = "ingestDbg";
        dbg.style.cssText = "font-size:10px;color:#888;padding:2px 8px;";
        var foot = document.querySelector("footer") || document.body;
        foot.appendChild(dbg);
      }
      dbg.textContent = "INGEST mode=" + mode + " path=" + path + " lastSeq=" + lastSeq + " gotFrame=" + (gotFrame ? "1" : "0") + " err=" + errCount() + " lastErr=" + lastErr;
    }catch(e){}
  }
  function logErr(p, msg){
    if(p === "do") errDo++; else errAbly++;
    try{ lastErr = p + ":" + String(msg || "").slice(0, 60); }catch(e){}
    try{ console.error("[ingest:" + p + "] " + msg + " (err #" + errCount() + ")"); }catch(e){}
  }
  function logDeltaErr(msg){
    var now = Date.now();
    if(now - lastDeltaErrAt < 10000) return;
    lastDeltaErrAt = now;
    try{ console.error("[ingest:delta] " + msg); }catch(e){}
  }
  function token(){
    try{ return localStorage.getItem("elab_authToken") || localStorage.getItem("elab_token"); }catch(e){ return null; }
  }
  function saveSeq(){ try{ sessionStorage.setItem(SEQ_KEY, String(lastSeq)); }catch(e){} }
  function clearTimers(){
    clearTimeout(silenceTimer); clearTimeout(connectTimer);
    silenceTimer = connectTimer = null;
  }
  /* P1-4: dong ho heartbeat + watchdog link/stale đi theo socket DO. */
  function clearHb(){
    clearInterval(hbTimer); clearTimeout(linkTimer); clearTimeout(staleTimer);
    hbTimer = linkTimer = staleTimer = null;
  }
  function closeDo(){
    clearTimers(); clearHb();
    try{ if(wsDo) wsDo.close(); }catch(e){}
    wsDo = null;
  }
  function closeAbly(){
    clearTimers();
    try{ if(ablyChannel) ablyChannel.unsubscribe(); }catch(e){}
    try{ if(ablyClient) ablyClient.close(); }catch(e){}
    ablyChannel = null; ablyClient = null;
  }
  function closeAll(){ closeDo(); closeAbly(); }

  /* ---------- Dinh dang (dung helper cua trang neu co) ---------- */
  function fNum(v){
    try{ if(typeof fmtN === "function") return fmtN(v); }catch(e){}
    if(v == null) return "—";
    var n = Number(v); return isFinite(n) ? n.toLocaleString("vi-VN") : "—";
  }
  function fPct(v){
    try{ if(typeof fmtPct === "function") return fmtPct(v); }catch(e){}
    if(v == null) return "—";
    var n = Number(v); return isFinite(n) ? (n > 0 ? "+" : "") + n.toFixed(2) + "%" : "—";
  }
  function fTy(v){
    try{ if(typeof fmtTy === "function") return fmtTy(v); }catch(e){}
    if(v == null) return "—";
    var n = Number(v); return isFinite(n) ? (n > 0 ? "+" : "") + (n / 1e9).toFixed(0) + " tỷ" : "—";
  }
  function upDownCls(pc){ return pc > 0 ? "up" : (pc < 0 ? "down" : ""); }

  /* ---------- View / symbol hien tai ---------- */
  function currentViewId(){
    try{
      var on = document.querySelector(".view.on");
      return on ? on.id : null;
    }catch(e){ return null; }
  }
  function readSym(){
    try{ if(typeof curSym !== "undefined" && curSym) return curSym; }catch(e){}
    try{
      var el = document.getElementById("dSym");
      if(el){ var t = (el.textContent || "").trim().split(/\s+/)[0]; if(t) return t; }
    }catch(e){}
    return null;
  }
  function readIdxMode(){
    try{ if(typeof _idxMode !== "undefined") return !!_idxMode; }catch(e){}
    return false;
  }
  function currentView(){
    var v = currentViewId();
    return { view: v, sym: v === "v-detail" ? readSym() : null, idxMode: readIdxMode() };
  }

  /* ---------- Delta-apply ---------- */
  function applyIdx(rows){
    var ids = ["idxRow", "idxSecRow"];
    for(var i = 0; i < rows.length; i++){
      var r = rows[i];
      if(!r || typeof r.s !== "string") continue;
      for(var j = 0; j < ids.length; j++){
        var box = document.getElementById(ids[j]);
        if(!box) continue;
        var cards = box.querySelectorAll(".idxcard");
        for(var k = 0; k < cards.length; k++){
          var sEl = cards[k].querySelector(".s");
          if(!sEl || sEl.textContent.trim() !== r.s) continue;
          var pEl = cards[k].querySelector(".p"), cEl = cards[k].querySelector(".c");
          if(pEl && typeof r.p === "number") pEl.textContent = fNum(r.p);
          if(cEl && typeof r.pc === "number"){
            cEl.className = "c " + upDownCls(r.pc);
            cEl.textContent = (r.pc > 0 ? "▲" : r.pc < 0 ? "▼" : "") + " " + fPct(r.pc);
          }
        }
      }
    }
  }
  function applyQMarket(f){
    try{
      if(typeof SS_PX === "object" && SS_PX){
        var cur = SS_PX[f.s] || {};
        if(typeof f.p === "number") cur.c = f.p;
        if(typeof f.pc === "number") cur.p = f.pc;
        SS_PX[f.s] = cur;
      }
    }catch(e){}
    var tb = null;
    try{ tb = document.getElementById("topMovers"); }catch(e){}
    if(!tb) return;
    var trs = tb.querySelectorAll("tr");
    for(var i = 0; i < trs.length; i++){
      var b = trs[i].querySelector("b");
      if(!b || b.textContent.trim() !== f.s) continue;
      var tds = trs[i].querySelectorAll("td");
      if(tds[1] && typeof f.p === "number") tds[1].textContent = fNum(f.p);
      if(tds[2] && typeof f.pc === "number"){
        tds[2].className = upDownCls(f.pc);
        tds[2].textContent = fPct(f.pc);
      }
      if(tds[3] && typeof f.fn === "number"){
        tds[3].className = upDownCls(f.fn);
        tds[3].textContent = fTy(f.fn);
      }
      return;
    }
  }
  function applyQDetail(f){
    try{
      if(typeof _lastQuote === "object" && _lastQuote){
        if(typeof f.p === "number") _lastQuote.close = f.p;
        if(typeof f.c === "number") _lastQuote.change = f.c;
        if(typeof f.pc === "number") _lastQuote.pct_change = f.pc;
        if(typeof f.v === "number") _lastQuote.volume = f.v;
        if(typeof f.fb === "number") _lastQuote.foreign_buy_value = f.fb;
        if(typeof f.fs === "number") _lastQuote.foreign_sell_value = f.fs;
      }
    }catch(e){}
    var box = null;
    try{ box = document.getElementById("dQuote"); }catch(e){}
    if(!box) return;
    var rows = box.querySelectorAll(".row");
    for(var i = 0; i < rows.length; i++){
      var kEl = rows[i].querySelector(".k"), vEl = rows[i].querySelector(".v");
      if(!kEl || !vEl) continue;
      var k = kEl.textContent.trim();
      if(k === "Giá khớp" && typeof f.p === "number"){ vEl.textContent = fNum(f.p); }
      else if(k === "Thay đổi" && (typeof f.c === "number" || typeof f.pc === "number")){
        var pc = typeof f.pc === "number" ? f.pc : null;
        vEl.className = "v " + (pc == null ? "" : upDownCls(pc));
        vEl.textContent = (typeof f.c === "number" ? fNum(f.c) + " (" + fPct(pc) + ")" : fPct(pc));
      }
      else if(k === "NN mua / bán (hôm nay)" && typeof f.fb === "number" && typeof f.fs === "number"){
        vEl.innerHTML = '<span class="up">' + fTy(f.fb) + '</span> / <span class="down">−' + fTy(f.fs).replace("-", "") + "</span>";
      }
    }
  }
  function applyFrame(d){
    try{
      var cv = currentView();
      var plan = deltaPlan(d, cv.view, cv.sym, cv.idxMode);
      if(plan === "idx") applyIdx(d.rows);
      else if(plan === "q-market") applyQMarket(d);
      else if(plan === "q-detail") applyQDetail(d);
    }catch(e){ logDeltaErr("apply loi: " + (e && e.message)); }
  }
  function reloadMarketView(){
    try{ if(typeof reloadCurrentView === "function") reloadCurrentView(); }catch(e){ logDeltaErr("reloadCurrentView loi: " + (e && e.message)); }
  }

  /* ---------- May trang thai ---------- */
  function armSilence(){
    clearTimeout(silenceTimer);
    // P1-4: mok 5s KHONG con là bang chứng "dut". Chua co frame sau 5s ma
    // link van con hb -> thi truong chi yen lang, doi nhan, khong onBreak.
    silenceTimer = setTimeout(function(){
      if(Date.now() - linkAliveAt <= HB_LINK_DEAD_MS){ setStatus("quiet"); }
      armStale();
    }, SILENCE_MS);
  }
  function armStale(){
    clearTimeout(staleTimer);
    var age = Date.now() - lastDataAt;
    if(age >= DATA_STALE_MS){ setStatus("stale"); return; }
    staleTimer = setTimeout(function(){
      if(Date.now() - lastDataAt >= DATA_STALE_MS) setStatus("stale");
    }, DATA_STALE_MS - age);
  }
  /* P1-4: LINK-ALIVE. Bang chứng = hb (server phat ~30s hoac ping ~25s
   * duoc tra loi) hoac frame moi. hb KHONG duoc tính la duoc tuoi. */
  function markLinkAlive(){
    linkAliveAt = Date.now();
    clearTimeout(linkTimer);
    linkTimer = setTimeout(function(){
      if(Date.now() - linkAliveAt >= HB_LINK_DEAD_MS) onBreak(path, "khong hb >" + Math.round(HB_LINK_DEAD_MS / 1000) + "s");
    }, HB_LINK_DEAD_MS);
  }
  /* P1-4: client gui ping ~25s khi socket DO mo (DO tra hb -> link song). */
  function armHb(){
    clearInterval(hbTimer);
    hbTimer = setInterval(function(){
      if(!wsDo || wsDo.readyState !== 1) return;
      try{ wsDo.send(JSON.stringify({ t: "ping" })); }catch(e){ onBreak("do", "gui ping loi"); }
    }, HB_PING_MS);
  }
  function onFrame(d){
    if(!shouldAcceptSeq(d.seq, lastSeq)) return; // trung/cu -> bo
    lastSeq = d.seq; lastFrameAt = Date.now(); gotFrame = true;
    lastDataAt = Date.now();  // dong ho DATA: chi frame hop le moi reset
    saveSeq();
    clearTimeout(connectTimer); connectTimer = null;
    markLinkAlive();          // frame moi cung là bang chứng link song
    if(mode === path) setStatus("live");
    applyFrame(d);
    armSilence();
  }
  function onBreak(p, why){
    if(p !== path) return; // su kien muon cua duong cu -> bo
    if(mode !== p && mode !== "retry") return;
    logErr(p, "duong dut (" + (why || "?") + ")");
    if(p === "do") closeDo(); else closeAbly();
    if(retries < MAX_RETRY){
      retries++; mode = "retry"; setStatus("retry");
      clearTimeout(retryTimer);
      retryTimer = setTimeout(function(){ startPath(p); }, nextRetryDelay(retries - 1));
    }else if(p === "do" && !testMode()){
      retries = 0;
      startPath("ably");
    }else{
      enterPoll();
    }
  }
  /* P1-3 (§8 muc 6): poll PHAI fetch that. Truoc day enterPoll() chi gan
   * chu "poll" roi ngon im 5 phut — khong phat request nao. Here goi duong
   * nap cua chinh trang (reloadCurrentView, stocks.html:448) de so tai ve
   * tu endpoint cong cong. */
  function refreshSnapshot(){
    try{
      if(typeof reloadCurrentView === "function"){
        Promise.resolve(reloadCurrentView()).catch(function(){});
        return true;
      }
    }catch(e){ logDeltaErr("refreshSnapshot loi: " + (e && e.message)); }
    logDeltaErr("reloadCurrentView khong ton tai -> poll khong fetch duoc");
    return false;
  }
  function enterPoll(){
    closeAll(); mode = "poll"; setStatus("poll");
    refreshSnapshot();                                            // lap tuc
    clearTimeout(pollTimer); clearInterval(pollFetchTimer);
    pollFetchTimer = setInterval(refreshSnapshot, POLL_FETCH_MS);  // moi 60s
    pollTimer = setTimeout(function(){
      clearInterval(pollFetchTimer); pollFetchTimer = null;
      retries = 0; startPath(firstPath());
    }, POLL_RETRY_MS);
  }
  function firstPath(){ return testMode() ? "ably" : "do"; }
  function startPath(p){
    clearTimeout(retryTimer); clearTimeout(pollTimer); clearInterval(pollFetchTimer);
    retryTimer = pollTimer = pollFetchTimer = null;
    if(p === "do" && testMode()) p = "ably";
    path = p; mode = p; gotFrame = false; handshaked = false; setStatus("retry");
    // Mốc cho đồng hồ DATA: lay = luc bat dau noi (mot lan/page-load), de
    // nhan "yên ắng" xuat hien truoc, "số liệu cũ" sau DATA_STALE_MS —
    // KHONG reset moi lan reconnect (se khong bao giờ in ra "cu").
    if(!lastDataAt) lastDataAt = Date.now();
    // P1-3: KHONG con chan realtime theo token. Duong chi-đoc (WS DO +
    // Ably subscribe-only) mo cho khach chua dang nhap; cac thao van ghi
    // (watchlist/portfolio/token ghi) van di qua route 'user' nhu cu.
    if(p === "do") connectDo(); else connectAbly();
    // P1-4: watchdog 30s chi lap khi handshake CHUA xong. Duong DO da
    // handshake (nb {t:"ok"} + hb ~30s) ma chua co duoc = thi truong YEN
    // LANG, khong phai dut -> khong duoc pha socket (armSilence se doi
    // nhan "quiet"). Ably khong co hb -> giu nguyen hanh vi cu.
    connectTimer = setTimeout(function(){
      if(p === "do" && handshaked) return;
      if(!gotFrame) onBreak(p, "khong noi duoc sau 30s");
    }, CONNECT_MS);
  }
  function reconnectCurrent(){
    // Tab hien lai sau khi an: chi noi lai khi LINK that chet. Link con hb
    // ma chua co duoc = thi truong yen lang -> giu socket nguyen (P1-4).
    if(mode !== "do" && mode !== "ably") return;
    if(Date.now() - linkAliveAt <= HB_LINK_DEAD_MS) return;
    var p = path;
    if(p === "do") closeDo(); else closeAbly();
    retries = 0;
    startPath(p);
  }

  /* ---------- Duong DO ---------- */
  function sendDoSub(){
    if(!wsDo || wsDo.readyState !== 1) return;
    try{
      var cv = currentView();
      var sub = buildDoSub(cv.view, cv.sym);
      wsDo.send(JSON.stringify({ t: "sub", syms: sub.syms, view: sub.view || undefined }));
    }catch(e){ logErr("do", "gui sub loi: " + (e && e.message)); }
  }
  function connectDo(){
    closeDo();
    var proto = "wss:";
    try{ proto = location.protocol === "https:" ? "wss:" : "ws:"; }catch(e){}
    var url = proto + "//" + location.host + "/api/stock/stream";
    var ws;
    try{ ws = new WebSocket(url); }catch(e){ logErr("do", "tao WebSocket loi: " + (e && e.message)); onBreak("do", "tao socket"); return; }
    wsDo = ws;
    ws.onopen = function(){
      // P1-4: mo ping ~25s ngay khi socket mở; link clock bat dau tinh.
      markLinkAlive(); armHb();
      try{ ws.send(JSON.stringify({ t: "auth", token: token() || "" })); }catch(e){ onBreak("do", "gui auth"); }
    };
    ws.onmessage = function(ev){
      var m = null;
      try{ m = JSON.parse(ev.data); }catch(e){ return; }
      if(!m || typeof m !== "object") return;
      if(m.t === "ok"){ handshaked = true; markLinkAlive(); sendDoSub(); armSilence(); return; }
      if(m.t === "subbed"){
        try{ ws.send(JSON.stringify({ t: "resume", since: lastSeq })); }catch(e){}
        armSilence();
        return;
      }
      // DO mat state socket (evict) nhung WebSocket van song: DO tra
      // "auth-required" vi no khong nho client da handshake. Day la
      // tinh huong KHOI PHUC DUOC — gui lai auth, khong phai dut duong.
      // Truoc day goi onBreak("do","auth") -> retry -> het MAX_RETRY
      // -> roi sang Ably, khong bao gio nhan frame (10:56 03/11:
      // lastErr=do:duong dut (auth), gotFrame=0). Chi 4401 that
      // (token sai bi tu choi) moi la loi auth va can onBreak.
      if(m.t === "auth-required"){
        try{ ws.send(JSON.stringify({ t: "auth", token: token() || "" })); }catch(e){ onBreak("do", "gui auth"); }
        return;
      }
      if(m.t === "error" && m.code === 4401){ onBreak("do", "auth"); return; }
      if(m.t === "resumed"){
        // DO restart: DO bi evict thi seq quay ve 0, nhung client giu
        // lastSeq cu (cao) trong sessionStorage -> moi frame moi deu bi
        // shouldAcceptSeq loai (seq <= lastSeq) -> trang ket "quiet" mai
        // du DO dang phat frame. Neu resumed seq < lastSeq thi DO da
        // restart -> reset lastSeq ve resumed seq de nhan frame moi.
        // An toan: DO khong restart thi lastSeq cua no luon >= lastSeq
        // client (client chi nhan seq DO da cap), nen resumed seq < lastSeq
        // chi xay ra khi DO restart.
        if(typeof m.seq === "number" && m.seq < lastSeq){
          lastSeq = m.seq; saveSeq();
        }
        var cv = currentView();
        if(cv.view === "v-market") reloadMarketView();
        armSilence();
        return;
      }
      if(m.t === "hb"){ markLinkAlive(); return; } // P1-4: hb = LINK song, khong phai duoc tuoi
      var d = parseFrame(m, frameOpts());
      if(d) onFrame(d);
    };
    ws.onclose = function(){ if(wsDo === ws) onBreak("do", "socket dong"); };
    ws.onerror = function(){ if(wsDo === ws) onBreak("do", "socket loi"); };
  }

  /* ---------- Duong Ably ---------- */
  function fetchTokenDetails(ch){
    return fetch("/api/ably-token?channel=" + encodeURIComponent(ch), {
      method: "POST",
      headers: token() ? { "Authorization": "Bearer " + token() } : {}
    }).then(function(r){
      if(!r.ok) throw new Error("ably-token HTTP " + r.status);
      return r.json();
    });
  }
  function connectAbly(){
    closeAbly();
    if(typeof Ably === "undefined"){ logErr("ably", "Ably SDK chua tai duoc (CDN/CSP)"); enterPoll(); return; }
    var ch = chanName();
    var client;
    try{
      client = new Ably.Realtime({ authCallback: function(tp, cb){
        fetchTokenDetails(ch).then(function(td){ cb(null, td); }).catch(function(e){ cb(e); });
      }});
    }catch(e){ logErr("ably", "tao Ably client loi: " + (e && e.message)); enterPoll(); return; }
    ablyClient = client;
    client.connection.on("failed", function(st){ logErr("ably", "connection failed: " + (st && st.reason && st.reason.message)); onBreak("ably", "connection failed"); });
    client.connection.on("suspended", function(){ logErr("ably", "connection suspended"); onBreak("ably", "suspended"); });
    client.connection.on("disconnected", function(){ onBreak("ably", "disconnected"); });
    try{
      ablyChannel = client.channels.get(ch);
      ablyChannel.subscribe(function(msg){
        var d = parseFrame(msg && msg.data, frameOpts());
        if(d) onFrame(d);
      });
    }catch(e){ logErr("ably", "subscribe loi: " + (e && e.message)); onBreak("ably", "subscribe"); return; }
  }

  /* ---------- Theo doi view/symbol + tab an/hien ---------- */
  function watchView(){
    var cv = currentView();
    if(cv.view !== lastView || cv.sym !== lastSym){
      lastView = cv.view; lastSym = cv.sym;
      // DO sub la cong don: gui them sub moi khi doi view/ma, khong can
      // noi lai socket; loc cuoi o client (deltaPlan). Ably khong can.
      if(mode === "do" && cv.view) sendDoSub();
    }
  }
  function init(){
    if(started) return;
    var hasMarket = false, hasDetail = false;
    try{ hasMarket = !!document.getElementById("v-market"); hasDetail = !!document.getElementById("v-detail"); }catch(e){}
    if(!hasMarket && !hasDetail) return;
    started = true;
    var cv = currentView();
    lastView = cv.view; lastSym = cv.sym;
    startPath(firstPath());
    try{
      viewTimer = setInterval(watchView, VIEW_WATCH_MS);
      document.addEventListener("visibilitychange", function(){
        if(!document.hidden) reconnectCurrent();
      });
    }catch(e){}
  }

  /* ---------- Mat ngoai (tuong thich driver chung minh cu) ---------- */
  var api = {
    init: init,
    start: function(){ retries = 0; startPath(firstPath()); },
    stop: function(){ clearTimeout(retryTimer); clearTimeout(pollTimer); clearInterval(pollFetchTimer); clearHb(); closeAll(); mode = "poll"; setStatus("poll"); },
    mode: function(){ return mode; },
    path: function(){ return path; },
    lastSeq: function(){ return lastSeq; },
    errCount: errCount,
    channel: chanName
  };
  if(typeof window !== "undefined"){
    window.UnifiedIngest = api;
    window.PushIngest = api;
    window.DoIngest = { mode: api.mode, lastSeq: api.lastSeq, errCount: api.errCount };
  }
  if(typeof module !== "undefined" && module.exports){
    module.exports = { shouldAcceptSeq: shouldAcceptSeq, parseFrame: parseFrame, nextRetryDelay: nextRetryDelay, channelFor: channelFor, isTestChannel: isTestChannel, buildDoSub: buildDoSub, deltaPlan: deltaPlan, ictDay: ictDay, sessionDay: sessionDay, frameInSession: frameInSession };
  }
  if(typeof document !== "undefined"){
    if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }
})();
