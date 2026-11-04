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
  /* Fix stream 03/11 — (e) THANG CAP IM LANG TRONG PHIEN. P1-4 tach
   * link-alive khoi data-stale nhung QUEN mat rang duong DO chi phat hb
   * (MarkLinkAlive), khong co frame khi DO trong tay (ingest thieu/evict):
   * link "song" -> quiet/stale mai mai, kenh du phong Ably KHONG BAO GIO
   * duoc dung toi (triệu chung 03/11: banner "yen lang" ca phien, khong
   * co label Ably). Nay: TRONG phien giao dich, duong dang chay im lang
   * qua SILENT_ESCALATE_MS khong co frame hop le -> coi duong du lieu CHET
   * (khong phai thi truong im): do -> onBreak (thang Ably), ably -> poll.
   * Ngoai phien (dem/T7/TCN) van giu hanh vi P1-4: "quiet" la dung.
   * Ghi de: ?ingesc=<giay> (0 = tat) — test cu cua P1-4 van chay duoc.
   * Do phien 04/11 (evidence-ably-cadence.txt, 600s nam ben kenh `market`):
   * 508 frame ve thanh 6 DOT (48–103 ma/dot), gap thuc đo 8/41/126/133/134s
   * — 80% vuot 30s, 60% vuot 120s. Nguon KHONG phat deu tay theo giay, nen
   * nguong 120s NGAN HON nhip binh thuong: duong du phong bi pha truoc kip
   * nhan dot ke tiep. Nang len 180s (> max 134s, van < DATA_STALE_MS 300s)
   * de nguong bat cat ngat that, khong phai nhip cua nguon. */
  var SILENT_ESCALATE_MS = 180 * 1000;
  /* (f) SEQ THEO NGAY PHIEN: phong DO ten "market-<YYYYMMDD>" — moi ngay
   * seq BAT DAU LAI TU 1 (va DO evict trong ngay cung restart — ben worker
   * phai luu lastSeq, xem market-room.js). lastSeq cua client luu trong
   * sessionStorage KHONG reset giua hai phien -> ca phien sau bi tu choi
   * vi "seq cu" (shouldAcceptSeq false mai mai). Luu kem ngay; ngay doi
   * -> lastSeq = 0. */
  var SEQ_DAY_KEY = "ingest_last_seq_day";

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
  /* Phien giao dich HOSE theo gio ICT (+07), T2–T6, cua so 08:45–15:15
   * (tron ca ATC + chen ca nghi 11:30–12:45 — refresher van publish trong
   * cac gio nang, nen im lang ca cua so = duong chay chay, khong phai nghi
   * gio). Ham thuan, test duoc bang Node. */
  function inTradingSession(ms){
    var n = Number(ms);
    if(!Number.isFinite(n)) return false;
    var d = new Date(n + 7 * 3600 * 1000);
    var wd = d.getUTCDay();
    if(wd === 0 || wd === 6) return false;
    var mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return mins >= 8 * 60 + 45 && mins <= 15 * 60 + 15;
  }
  function escalateMsFrom(search){
    try{
      var v = new URLSearchParams(search || "").get("ingesc");
      if(v !== null && v !== ""){
        var s = parseInt(v, 10);
        if(Number.isFinite(s) && s >= 0) return s * 1000;
      }
    }catch(e){}
    return SILENT_ESCALATE_MS;
  }
  function needEscalate(now, lastDataAt, escMs){
    return escMs > 0 && inTradingSession(now) && (now - lastDataAt) >= escMs;
  }
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
  var lastSeq = 0, lastFrameAt = 0;
  var seqDay = null;       // (f) ngay phien gan nuoc ma lastSeq thuoc ve
  var escalateTimer = null; // (e) dong ho thang cap im-lang-trong-phien
  var pathStartedAt = 0;   // (e) luc duong hien tai bat dau (du "an" khi doi duong)
  var linkAliveAt = 0;   // P1-4: reset bang hb HOAC frame moi
  var lastDataAt = 0;    // P1-4: CHI reset bang frame hop le (ts dung phien)
  var wsDo = null, ablyClient = null, ablyChannel = null;
  var silenceTimer = null, connectTimer = null, retryTimer = null, pollTimer = null, viewTimer = null;
  var hbTimer = null, linkTimer = null, staleTimer = null, pollFetchTimer = null;
  var lastView = null, lastSym = null, lastDeltaErrAt = 0, started = false;
  var handshaked = false;  // DO đã trả {t:"ok"} = link sống, chưa cần dữ liệu
  /* Kiem chung "frame da toai duoc ra man hinh" (khong chi "da duoc chap
   * nhan"). Nguyen nhan 4 vong fix stream that bai 03/11: nhan hieu "live"
   * duoc gan theo seq duoc chap nhan, nen module bao "Dang cap nhat theo
   * giay" trong khi 0 o gia nao duoc ghi (#topMovers rong), va moi tan
   * so khung bi loai bo im lang (khong counter, khong log). */
  var wroteCells = 0, wroteMisses = 0, dropSeq = 0, dropTs = 0, dropView = 0;
  var seqRegression = 0, lastRebaselineAt = 0, lastNoRenderLogAt = 0;
  var REBASE_MIN_GAP_MS = 30000, REBASE_AFTER = 3;
  try{
    lastSeq = parseInt(sessionStorage.getItem(SEQ_KEY) || "0", 10) || 0;
    seqDay = sessionStorage.getItem(SEQ_DAY_KEY) || null;
  }catch(e){ lastSeq = 0; seqDay = null; }
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
        dropTs++;
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
      dbg.textContent = "INGEST mode=" + mode + " path=" + path + " lastSeq=" + lastSeq + " gotFrame=" + (gotFrame ? "1" : "0") + " err=" + errCount() +
        " wrote=" + wroteCells + "/" + wroteMisses + " drop=" + dropSeq + "/" + dropTs + "/" + dropView;
    }catch(e){}
  }
  function logErr(p, msg){
    if(p === "do") errDo++; else errAbly++;
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
  function saveSeq(){
    try{
      sessionStorage.setItem(SEQ_KEY, String(lastSeq));
      sessionStorage.setItem(SEQ_DAY_KEY, sessionDay() || "");
    }catch(e){}
  }
  /* (f) Doi phien -> seq tang lai tu 1 (phong DO moi theo ngay). Reset
   * lastSeq truoc khi cham frame, neu khong ca phien moi bi bo. */
  function rollSeqToToday(){
    var today = sessionDay();
    if(today && seqDay !== today){ seqDay = today; lastSeq = 0; saveSeq(); }
  }
  function clearTimers(){
    clearTimeout(silenceTimer); clearTimeout(connectTimer);
    silenceTimer = connectTimer = null;
  }
  /* P1-4: dong ho heartbeat + watchdog link/stale đi theo socket DO. */
  function clearHb(){
    clearInterval(hbTimer); clearTimeout(linkTimer); clearTimeout(staleTimer);
    hbTimer = linkTimer = staleTimer = null;
  }
  /* (e) Dong ho thang cap im-lang. Chi lap TRONG phien giao dich; duoc
   * nap lai moi lan co frame (armEscalate tu lay moc lastDataAt). */
  function curEscalateMs(){
    var s = "";
    try{ s = (typeof location !== "undefined" && location.search) || ""; }catch(e){}
    return escalateMsFrom(s);
  }
  function armEscalate(){
    clearTimeout(escalateTimer); escalateTimer = null;
    var esc = curEscalateMs();
    if(esc <= 0 || testMode()) return;
    if(!inTradingSession(Date.now())) return;
    // Mốc = duoc gan nhat HOAC luc duong moi bat dau (du 120s "an" cho
    // duong vua doi — neu khong, Ably vua mo ra bi dem qua poll ngay).
    var ref = Math.max(lastDataAt, pathStartedAt);
    var wait = esc - (Date.now() - ref);
    if(wait < 1000) wait = 1000;
    escalateTimer = setTimeout(function(){
      if(!needEscalate(Date.now(), Math.max(lastDataAt, pathStartedAt), curEscalateMs())){ armEscalate(); return; }
      if(mode === "do") onBreak("do", "im lang duoc " + Math.round((Date.now() - ref) / 1000) + "s trong phien");
      else if(mode === "ably") enterPoll();
    }, wait);
  }
  function closeDo(){
    clearTimers(); clearHb();
    clearTimeout(escalateTimer); escalateTimer = null;
    try{ if(wsDo) wsDo.close(); }catch(e){}
    wsDo = null;
  }
  function closeAbly(){
    clearTimers();
    clearTimeout(escalateTimer); escalateTimer = null;
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
  /* So sanh MA kieu trang: frame duoc worker hoa to symbol
   * (fanout.js: String(...).toUpperCase()) trong khi the hien thi giu nhan
   * hieu thuong mai ("HNXIndex", "UPCOMIndex", "VN30"). So sanh giong het
   * (===) -> frame idx bi loai cho các the nganh, gia khong bao gio in.
   * Bang chung 03/11 11:14: frame {"s":"HNXINDEX","p":250.12} den trong khi
   * the van hinh "HNXIndex 250,08" (gia phien truoc lay tu HTTP poll). */
  function sameSym(a, b){
    return String(a == null ? "" : a).toUpperCase().replace(/\s+/g, "") ===
           String(b == null ? "" : b).toUpperCase().replace(/\s+/g, "");
  }
  /* nhan cua the duoc dich qua T() cua trang (setStkLang EN/ZH/KO doi .k
   * thanh "Matched price"/"Change"/... ) -> so sanh theo ca goc VI lan ban
   * dich, khong khop chu VI hard-code. */
  function labelMatches(shown, vi){
    var s = String(shown == null ? "" : shown).trim();
    if(s === vi) return true;
    var t = null;
    try{ t = (typeof T === "function") ? T(vi) : null; }catch(e){}
    return typeof t === "string" && t && s === t;
  }
  /* SS_IDX — bang gia chi so LIVE (theo ma, KHONG theo nhan the) gan nhu
   * SS_PX cua co phieu: moi frame idx luu {p, pc, ts} vong bo nho nay de
   * market.js ve the tu do, va de khong cho luot poll HTTP (cache 5 phut)
   * de GIA CU UP lai gia MOI. Bang chung live 03/11: frame
   * {"s":"VNINDEX","p":1708.46} toi 06:45:17Z -> the in 1.708,46 luc
   * 06:45:18Z; luot poll 60s luc 06:45:48Z in lai 1.708,97 (ban doc R2
   * 06:40:16Z) -> man hinh quay lui 0,51 diem. */
  function rememberIdx(rows, ts){
    try{
      if(typeof window === "undefined") return;
      if(!window.SS_IDX || typeof window.SS_IDX !== "object") window.SS_IDX = {};
      var t = Number(ts);
      for(var i = 0; i < rows.length; i++){
        var r = rows[i];
        if(!r || typeof r.s !== "string") continue;
        window.SS_IDX[String(r.s).toUpperCase()] = {
          p: typeof r.p === "number" ? r.p : null,
          pc: typeof r.pc === "number" ? r.pc : null,
          ts: Number.isFinite(t) ? t : Date.now(),
        };
      }
    }catch(e){}
  }
  function applyIdx(rows, ts){
    rememberIdx(rows, ts);
    var n = 0;
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
          if(!sEl || !sameSym(sEl.textContent, r.s)) continue;
          var pEl = cards[k].querySelector(".p"), cEl = cards[k].querySelector(".c");
          if(pEl && typeof r.p === "number"){ pEl.textContent = fNum(r.p); n++; }
          if(cEl && typeof r.pc === "number"){
            cEl.className = "c " + upDownCls(r.pc);
            cEl.textContent = (r.pc > 0 ? "▲" : r.pc < 0 ? "▼" : "") + " " + fPct(r.pc);
            n++;
          }
        }
      }
    }
    return n;
  }
  function applyQMarket(f){
    var n = 0;
    try{
      if(typeof SS_PX === "object" && SS_PX){
        // Khoa SS_PX luon VIET HOA: fan-out (market.js/withLivePx) tra cuu
        // bang String(sym).toUpperCase(), frame vao day co the chua ma thuong.
        var key = String(f.s).toUpperCase();
        var cur = SS_PX[key] || {};
        if(typeof f.p === "number") cur.c = f.p;
        if(typeof f.pc === "number") cur.p = f.pc;
        SS_PX[key] = cur;
      }
    }catch(e){}
    var tb = null;
    try{ tb = document.getElementById("topMovers"); }catch(e){}
    if(!tb) return 0;
    var trs = tb.querySelectorAll("tr");
    if(!trs.length || !tb.querySelector("b")){
      // Bang chua co dong ma nao: poll /screener ve pct_change null (stale-gate)
      // hoac chua ve. Goi renderer cua trang lap bang tu chinh SS_PX ma frame
      // vua nap, neu khong thi gia live khong co cho in ra va trang ket
      // "Chưa có dữ liệu" den het chu ky poll 60s (nguyen nhan gia ding 03/11).
      try{
        if(typeof window !== "undefined" && typeof window.refreshMoversFromLive === "function"){
          if(window.refreshMoversFromLive(8) > 0) return 1;
        }
      }catch(e){ logDeltaErr("refreshMoversFromLive loi: " + (e && e.message)); }
    }
    for(var i = 0; i < trs.length; i++){
      var b = trs[i].querySelector("b");
      if(!b || !sameSym(b.textContent, f.s)) continue;
      var tds = trs[i].querySelectorAll("td");
      if(tds[1] && typeof f.p === "number"){ tds[1].textContent = fNum(f.p); n++; }
      if(tds[2] && typeof f.pc === "number"){
        tds[2].className = upDownCls(f.pc);
        tds[2].textContent = fPct(f.pc);
        n++;
      }
      if(tds[3] && typeof f.fn === "number"){
        tds[3].className = upDownCls(f.fn);
        tds[3].textContent = fTy(f.fn);
        n++;
      }
      return n;
    }
    return 0;
  }
  function applyQDetail(f){
    var q = null;
    try{
      if(typeof _lastQuote === "object" && _lastQuote){
        q = _lastQuote;
        if(typeof f.p === "number") q.close = f.p;
        if(typeof f.c === "number") q.change = f.c;
        if(typeof f.pc === "number") q.pct_change = f.pc;
        if(typeof f.v === "number") q.volume = f.v;
        if(typeof f.fb === "number") q.foreign_buy_value = f.fb;
        if(typeof f.fs === "number") q.foreign_sell_value = f.fs;
      }
    }catch(e){}
    // Du dung model cua trang roi goi renderer cua trang: o gia do trang so
    // huu (nhan dich, cap nhat ca Khoi luong / Gia von / chu ky quyen ma
    // patch theo nhan bo sot). Chi khi khong co renderQuote thi moi quay ve
    // patch theo nhan.
    if(q){
      try{
        if(typeof renderQuote === "function"){ renderQuote(q); return 1; }
      }catch(e){ logDeltaErr("renderQuote loi: " + (e && e.message)); }
    }
    var box = null;
    try{ box = document.getElementById("dQuote"); }catch(e){}
    if(!box) return 0;
    var n = 0;
    var rows = box.querySelectorAll(".row");
    for(var i = 0; i < rows.length; i++){
      var kEl = rows[i].querySelector(".k"), vEl = rows[i].querySelector(".v");
      if(!kEl || !vEl) continue;
      if(labelMatches(kEl.textContent, "Giá khớp") && typeof f.p === "number"){
        vEl.textContent = fNum(f.p); n++;
      }
      else if(labelMatches(kEl.textContent, "Thay đổi") && (typeof f.c === "number" || typeof f.pc === "number")){
        var pc = typeof f.pc === "number" ? f.pc : null;
        vEl.className = "v " + (pc == null ? "" : upDownCls(pc));
        vEl.textContent = (typeof f.c === "number" ? fNum(f.c) + " (" + fPct(pc) + ")" : fPct(pc));
        n++;
      }
      else if(labelMatches(kEl.textContent, "Khối lượng") && typeof f.v === "number"){
        vEl.textContent = fNum(f.v); n++;
      }
      else if(labelMatches(kEl.textContent, "NN mua / bán (hôm nay)") && typeof f.fb === "number" && typeof f.fs === "number"){
        vEl.innerHTML = '<span class="up">' + fTy(f.fb) + '</span> / <span class="down">−' + fTy(f.fs).replace("-", "") + "</span>";
        n++;
      }
    }
    return n;
  }
  function notifyChartTick(frame){
    try{ if(typeof window !== "undefined" && typeof window.onIngestTick === "function") window.onIngestTick(frame); }
    catch(e){ logDeltaErr("onIngestTick loi: " + (e && e.message)); }
  }
  function applyFrame(d){
    try{
      var cv = currentView();
      var plan = deltaPlan(d, cv.view, cv.sym, cv.idxMode);
      if(plan === "idx"){ var wIdx = applyIdx(d.rows, d.ts); notifyChartTick(d); return wIdx; }
      if(plan === "q-market") return applyQMarket(d);
      if(plan === "q-detail"){ var wDet = applyQDetail(d); notifyChartTick(d); return wDet; }
      dropView++;
    }catch(e){ logDeltaErr("apply loi: " + (e && e.message)); }
    return 0;
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
      // Thang cap im-lang (acct4, thay watchdog 90s fix #5): duong DO im
      // lang qua 120s TRONG phien thi armEscalate() xu ly (onBreak -> Ably);
      // khong tu pha socket o day nua, tranh 2 timer cung viec.
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
      if(Date.now() - linkAliveAt < HB_LINK_DEAD_MS) return;
      /* Duong Ably khong phat `hb` nhu DO — do sang bang chinh trang thai
       * cua no (connected + attached). Neu khong, mot DOT frame cach nhau
       * 126–134s (nhip thuc cua nguon, do 600s: evidence-ably-cadence.txt)
       * bi gan toi thanh "link chet >70s" va pha ket noi tru dot ke tiep. */
      if(path === "ably" && ablyAlive()){ markLinkAlive(); return; }
      onBreak(path, "khong hb >" + Math.round(HB_LINK_DEAD_MS / 1000) + "s");
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
    rollSeqToToday();                    // (f) phien moi -> seq tu 1, dung bo qua
    if(!shouldAcceptSeq(d.seq, lastSeq) && !noteSeqRegression(d)) return; // trung/cu -> bo
    seqRegression = 0;
    lastSeq = d.seq; lastFrameAt = Date.now(); gotFrame = true;
    lastDataAt = Date.now();  // dong ho DATA: chi frame hop le moi reset
    saveSeq();
    clearTimeout(connectTimer); connectTimer = null;
    markLinkAlive();          // frame moi cung là bang chứng link song
    var wrote = applyFrame(d);
    if(wrote > 0){
      wroteCells += wrote;
      if(mode === path) setStatus("live");
    }else{
      // Frame tren day la that nhung KHONG co o nao tren man hinh thay doi
      // (bang gia rong / view khong lien quan). Khong duoc phep bao "live".
      wroteMisses++;
      if(mode === path) setStatus(wroteCells ? "live" : "norender");
      logNoRender();
    }
    armSilence();
    armEscalate();
  }
  /* DO restart ma WebSocket khong restart: evict xoa `lastSeq` trong bo nho
   * cua DO trong khi socket cua client van song (hibernation), DO phat lai
   * tu seq 1. Client giu moc cao -> shouldAcceptSeq loai MOI frame vo hon
   * -> cac mai. Fix 51c1d46 chi reset trong handler `resumed`, tuc la chi
   * khi client noi lai tu dau; socket tro thi khong bao giờ gửi `resume`
   * nua. Sam mang regression lien tiep = doi seq epoch -> reset moc + xin
   * replay (sub lai, DO tra resumed + buffer). */
  function noteSeqRegression(d){
    if(!Number.isInteger(d.seq) || d.seq <= 0 || d.seq >= lastSeq){ dropSeq++; return false; }
    dropSeq++;
    seqRegression++;
    if(seqRegression < REBASE_AFTER) return false;
    var now = Date.now();
    if(now - lastRebaselineAt < REBASE_MIN_GAP_MS) return false;
    lastRebaselineAt = now; seqRegression = 0;
    logDeltaErr("seq regression " + d.seq + " < " + lastSeq + " -> DO doi epoch, reset moc va xin replay");
    lastSeq = 0; saveSeq();
    if(path === "do") sendDoSub();
    return true; // frame duoc khi duoc chap nhan lai (khong mat them frame)
  }
  function logNoRender(){
    var now = Date.now();
    if(now - lastNoRenderLogAt < 15000) return;
    lastNoRenderLogAt = now;
    try{
      console.warn("[ingest:delta] " + (wroteCells + wroteMisses) + " frame duoc chap nhan, " +
        wroteMisses + " khong ghi duoc o nao (view=" + currentViewId() +
        " topMovers=" + (document.getElementById("topMovers") ? document.getElementById("topMovers").querySelectorAll("tr").length : "null") +
        " rows, SS_PX=" + (typeof SS_PX === "object" && SS_PX ? Object.keys(SS_PX).length : 0) + " ma)");
    }catch(e){}
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
    path = p; mode = p; gotFrame = false; handshaked = false;
    setStatus(retries ? "retry" : "connecting"); // lan dau = "dang ket noi", khong phai "mat ket noi"
    // Mốc cho đồng hồ DATA: lay = luc bat dau noi (mot lan/page-load), de
    // nhan "yên ắng" xuat hien truoc, "số liệu cũ" sau DATA_STALE_MS —
    // KHONG reset moi lan reconnect (se khong bao giờ in ra "cu").
    if(!lastDataAt) lastDataAt = Date.now();
    pathStartedAt = Date.now();  // (e) duong nay duoc it nhat ESC giay de chung minh minh
    rollSeqToToday();   // (f) vao phien moi (kca khi tab mo tu hom qua) -> seq tu 1 duoc chap nhan
    // P1-3: KHONG con chan realtime theo token. Duong chi-đoc (WS DO +
    // Ably subscribe-only) mo cho khach chua dang nhap; cac thao van ghi
    // (watchlist/portfolio/token ghi) van di qua route 'user' nhu cu.
    if(p === "do") connectDo(); else connectAbly();
    // (e) Nap dong ho thang cap SAU khi connect (connect *Do() da clear
    // cac timer cu). Trong phien: im lang duoc >SILENT_ESCALATE_MS tren
    // duong nay = duong chay CHET (khong phai "thi truong yen lang" —
    // refresher publish tung phut) -> doi duong, dung de chay Ably/poll.
    armEscalate();
    // P1-4: watchdog 30s chi lap khi handshake CHUA xong. Duong DO da
    // handshake (nb {t:"ok"} + hb ~30s) ma chua co duoc = thi truong YEN
    // LANG, khong phai dut -> khong duoc pha socket (armSilence se doi
    // nhan "quiet").
    // Fix stream 04/11 — nhan "Ably khong co hb -> giu nguyen hanh vi cu"
    // la NGUYEN NHAN duong du phong bi pha truoc kip giao frame: watchdog
    // dem bang gotFrame, ma gotFrame chi to khi DOT frame ke tiep toi; duong
    // Ably attach xong trong ~1s nhung dot frame lai cach 8–134s -> bi
    // "khong noi duoc sau 30s" pha, mo lai, lai bi pha, khong bao gio co
    // frame (chung minh 04/11: mode=poll path=ably lastSeq=0 gotFrame=0
    // err=8 = 4 lan cascade do->ably->poll). Voi Ably, bang chung "noi duoc"
    // la attached (ablyAlive()), KHONG phai "da co duoc".
    connectTimer = setTimeout(function(){
      if(p === "do" && handshaked) return;
      if(p === "ably" && ablyAlive()) return;
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
          lastSeq = m.seq; saveSeq(); seqRegression = 0;
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
  /* Ably khong phat `hb` rieng nhu duong DO: bang chung "duong van song" la
   * chinh trang thai no — connection=connected va kenh=attached. Ably tu do
   * tim hop va tu phat hien cat ngat; moi mat ket noi that da co handler
   * failed/suspended/disconnected trong connectAbly bao. Ham nay dung de
   * chan watchdog: khong duoc coi "dot frame chua toi" la "duong chet" — do
   * nhip publish 04/11, frame ve theo DOT cach nhau toi 134s
   * (evidence-ably-cadence.txt), trong khi watchdog dem 30s/70s/120s. */
  function ablyAlive(){
    try{
      return !!(ablyClient && ablyClient.connection && ablyClient.connection.state === "connected" &&
                ablyChannel && ablyChannel.state === "attached");
    }catch(e){ return false; }
  }
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
    channel: chanName,
    /* Bang chung doc tu ngoai (console/Playwright/driver): "duoc nhan" (seq
     * duoc chap nhan) la chuyen khac "duoc toa" (o DOM thuc doi). */
    stats: function(){
      return { mode: mode, path: path, lastSeq: lastSeq, err: errCount(),
        gotFrame: gotFrame, wroteCells: wroteCells, wroteMisses: wroteMisses,
        dropSeq: dropSeq, dropTs: dropTs, dropView: dropView, channel: chanName() };
    }
  };
  if(typeof window !== "undefined"){
    window.UnifiedIngest = api;
    window.PushIngest = api;
    window.DoIngest = { mode: api.mode, lastSeq: api.lastSeq, errCount: api.errCount };
  }
  if(typeof module !== "undefined" && module.exports){
    module.exports = { shouldAcceptSeq: shouldAcceptSeq, parseFrame: parseFrame, nextRetryDelay: nextRetryDelay, channelFor: channelFor, isTestChannel: isTestChannel, buildDoSub: buildDoSub, deltaPlan: deltaPlan, ictDay: ictDay, sessionDay: sessionDay, frameInSession: frameInSession, inTradingSession: inTradingSession, escalateMsFrom: escalateMsFrom, needEscalate: needEscalate, rollSeqToToday: rollSeqToToday, seqState: function(){ return { seq: lastSeq, day: seqDay }; }, sameSym: sameSym };
  }
  if(typeof document !== "undefined"){
    if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }
})();
