/* js/stocks/detail.js — P5 module 12: Chi tiet ma tach tu stocks.html, giu nguyen hanh vi. LAZY qua loadStockMod (lan dau mo ma). */
/* Ho so (profile) DA tach thanh js/stocks/profile.js, LAZY (loadStockMod — loadDetail nap khi mo ma, goi window.loadProfile/loadEvents/loadTarget/loadCost/loadFund). */
/* O LAI CORE (dung dong bo truoc khi detail.js nap, khong tach duoc): IDX_META/IDX_LIST/IDX_SEC_LIST + idxFileSym (market.js eager + chat dung) + fmtTyAbs (chat dung) + nut wlAddBtn (view Cua toi). */
/* openSym/openIndex/loadWatchlist: entry lazy — stub o core (cung ten) nap module roi uy quyen window.__dtOpenSym/__dtOpenIndex/__dtLoadWatchlist; moi onclick o 7 module + chat + palette + mine goi stub, khong doi. */
// __DT_BEGIN__
try{
(function(){
// ---- Chi tiết mã ----
let curSym=null;
function openSym(sym){
  curSym=sym;
  _lastQuote=null; _lastFund=null; _lastProfile=null;
  _idxMode=false; curIdx=null;
  $("dWatch").style.display="";
  if($("dNav"))$("dNav").style.display=""; if($("dNavTitle"))$("dNavTitle").style.display="";
  ["dTargetSec","dTarget","dEventsSec","dEventsCard"].forEach(k=>{if($(k))$(k).style.display="";});
  if($("dIdxBar"))$("dIdxBar").style.display="none";
  document.querySelectorAll("#dIv button").forEach(b=>b.style.display="");
  document.querySelectorAll(".view").forEach(s=>s.classList.remove("on"));
  $("v-detail").classList.add("on");window.scrollTo(0,0);
  $("aiFab").style.display="";
  $("dSym").innerHTML=esc(sym)+' <span style="font-size:12px;color:var(--pp-mut)">HOSE</span>';
  renderDNav();
  dShow(null);
  loadDetail(sym);
}
// ===== Bieu do chi so (22/10): bam the chi so o tab Thi truong mo
// DUNG khung chi tiet/bieu do cua ma, du lieu qua /ohlcv nhu ma
// (market/ohlcv/<IDX>.json, 320 phien). Che do chi so an cac muc
// chi danh cho ma (watchlist, tab con, muc tieu, su kien) va khoa
// khung thoi gian o 1D (chi so chi co nen ngay).
let _idxMode=false, curIdx=null;
function openIndex(fs){
  if(!IDX_META[fs])return;
  _lastQuote=null; _lastFund=null; _lastProfile=null;
  _idxMode=true; curIdx=fs; curSym=null;
  document.querySelectorAll(".view").forEach(s=>s.classList.remove("on"));
  $("v-detail").classList.add("on");window.scrollTo(0,0);
  $("aiFab").style.display="";
  $("dSym").innerHTML=esc(fs)+' <span style="font-size:12px;color:var(--pp-mut)">'+IDX_META[fs]+'</span>';
  $("dWatch").style.display="none";
  dShow(null);
  if($("dNav"))$("dNav").style.display="none"; if($("dNavTitle"))$("dNavTitle").style.display="none";
  ["dTargetSec","dTarget","dCostSec","dCost","dEventsSec","dEventsCard"].forEach(k=>{if($(k))$(k).style.display="none";});
  document.querySelectorAll("#dIv button").forEach(b=>{b.style.display=b.textContent==="1D"?"":"none";});
  const bar=$("dIdxBar"); bar.style.display=""; bar.style.flexWrap="wrap";
  bar.innerHTML=IDX_LIST.concat(IDX_SEC_LIST).map(x=>`<button class="${x===fs?"on":""}" onclick="openIndex('${x}')">${x}</button>`).join("");
  loadIndexQuote(fs);
  loadChart(fs,"1D");
}
async function loadIndexQuote(fs){
  const box=$("dQuote"); box.innerHTML='<div class="hint">Đang tải…</div>';
  try{
    const j=await api("/indices"); let rows=j.rows||[];
    let r=rows.find(x=>idxFileSym(x.symbol)===fs);
    if(!r && IDX_SEC_LIST.includes(fs)){
      const j2=await api("/sector-indices"); const rows2=j2.rows||[];
      r=rows2.find(x=>x.symbol===fs);
    }
    if(!r){ box.innerHTML='<div class="hint">Chưa có dữ liệu</div>'; return; }
    const pc=r.pct_change, cls=pc>0?"up":pc<0?"down":"";
    let h=`<div class="row"><span class="k">Điểm</span><span class="v" style="font-size:17px">${fmtN(r.close)}</span></div>`;
    h+=`<div class="row"><span class="k">Thay đổi</span><span class="v ${cls}">${r.stale?"— · số liệu cũ":(r.change!=null?fmtN(r.change)+" ("+fmtPct(pc)+")":fmtPct(pc))}</span></div>`;
    if(r.volume!=null) h+=`<div class="row"><span class="k">Khối lượng</span><span class="v">${fmtN(r.volume)}</span></div>`;
    box.innerHTML=h;
    if(j._prov){_lastDSrc=j._prov.source;_lastDAsOf=j._prov.retrieved_at||j.updated||null;_lastDstale=!!j.stale;refreshSrc();}
  }catch(e){ box.innerHTML='<div class="hint">Lỗi tải</div>'; }
}
// Nhan quyen (Phuong an B, Chot Q1-Q7 29/10): hien khi q.corp_action
// khac null; het cua so [ex_date, ex_date+1 phien] thi refresher gui
// null -> tu mat. Tham chieu lay tu board live, khong tu chia close cu.
const CA_I18N={
vi:{stock_div:"Cổ tức cổ phiếu {pct}%",cash_div:"Cổ tức tiền mặt {amt} đồng/cp",split:"Chia tách {f} lần",exdate:"GDKHQ {date}",ref_adj:"Giá tham chiếu hôm nay {ref} (đã điều chỉnh)",ref_line:"Tham chiếu: {ref}"},
en:{stock_div:"Stock dividend {pct}%",cash_div:"Cash dividend {amt} VND/share",split:"Split {f}-for-1",exdate:"Ex-date {date}",ref_adj:"Today's reference price {ref} (adjusted)",ref_line:"Reference: {ref}"},
zh:{stock_div:"股票股息 {pct}%",cash_div:"现金股息每股 {amt} 越南盾",split:"拆股 {f} 倍",exdate:"除权日 {date}",ref_adj:"今日参考价 {ref}（已调整）",ref_line:"参考价：{ref}"},
ko:{stock_div:"주식 배당 {pct}%",cash_div:"현금 배당 주당 {amt} VND",split:"액면분할 {f}배",exdate:"권리락일 {date}",ref_adj:"오늘 기준가 {ref} (조정됨)",ref_line:"기준가: {ref}"}};
// Ve lai hop quote tu _lastQuote khi doi ngon ngu (V10 30/10: note
// quyen chi render 1 lan o loadDetail, doi EN khong ve lai #dQuote —
// cung ho loi i18n Lich quyen: renderCA(_caData) o setStkLang).
// Giu nguyen noi dung #dOb (so lenh) qua lan ve lai.
function renderQuote(q){
  const _ob=$("dOb"), _obHtml=_ob?_ob.innerHTML:"";
  const pc=q.pct_change,cls=pc>0?"up":pc<0?"down":"";
  let h=`<div class="row"><span class="k">Giá khớp</span><span class="v" style="font-size:17px">${fmtN(q.close)}</span></div>`;
  h+=`<div class="row"><span class="k">Thay đổi</span><span class="v ${cls}">${q.change!=null?fmtN(q.change)+" ("+fmtPct(pc)+")":fmtPct(pc)}</span></div>`;
  // Nhan quyen + tham chieu (Phuong an B): chi hien khi co du lieu.
  if(q.corp_action||(q.reference!=null&&q.reference>0)){
    const ca=q.corp_action, L=CA_I18N[curLang]||CA_I18N.vi;
    let caTxt="";
    if(ca){
      const d=(ca.ex_date||"").slice(0,10).split("-").reverse().join("/");
      let kind="";
      if(ca.kind==="stock_dividend") kind=L.stock_div.replace("{pct}",String(Math.round(((ca.factor||1)-1)*100)));
      else if(ca.kind==="cash_dividend") kind=L.cash_div.replace("{amt}",fmtN(ca.cash||0));
      else if(ca.kind==="split") kind=L.split.replace("{f}",String(ca.factor||""));
      caTxt=kind+" — "+L.exdate.replace("{date}",d);
      if(q.reference!=null&&q.reference>0) caTxt+=" · "+L.ref_adj.replace("{ref}",fmtN(q.reference));
    }else{
      caTxt=L.ref_line.replace("{ref}",fmtN(q.reference));
    }
    if(caTxt) h+=`<div class="hint" style="margin-top:4px">${esc(caTxt)}</div>`;
  }
  if(q.foreign_buy_value!=null||q.foreign_sell_value!=null){
    h+=`<div class="row"><span class="k">NN mua / bán (hôm nay)</span><span class="v"><span class="up">${fmtTy(q.foreign_buy_value)}</span> / <span class="down">−${fmtTy(q.foreign_sell_value).replace("-","")}</span></span></div>`;
  }
  if(q.bid||q.ask){
    const stepP=x=>Array.isArray(x)?+x[0]:(x&&typeof x==="object"?+(x.price??x.p):+x);
    const side=a=>{ if(!Array.isArray(a)) return "—";
      const s=a.slice(0,3).map(x=>fmtN(stepP(x))).filter(t=>t!=="—");
      return s.length? s.join(" / ") : "—"; };
    const bp=side(q.bid),ap=side(q.ask);
    h+=`<div class="bidask"><div class="ba"><div class="t">Mua 1/2/3</div><div class="pr up">${bp}</div></div><div class="ba"><div class="t">Bán 1/2/3</div><div class="pr down">${ap}</div></div></div>`;
  }
  h+='<div id="dOb"></div>';
  $("dQuote").innerHTML=h;
  const _ob2=$("dOb");
  if(_ob2&&_obHtml) _ob2.innerHTML=_obHtml;
  if(q._prov){_lastDSrc=q._prov.source;_lastDAsOf=q._prov.retrieved_at||q.data_updated||null;_lastDstale=false;refreshSrc();}
}
async function loadDetail(sym){
  $("dQuote").innerHTML='<div class="hint">Đang tải…</div>';
  try{
    const j=await api("/quote?symbol="+encodeURIComponent(sym));
    const q=j.quote||j; _lastQuote=q; renderFaPctGrid(); renderQuote(q);
  }catch(e){$("dQuote").innerHTML='<div class="hint">Lỗi tải</div>';}
  loadOrderbook(sym);
  loadFlow(sym);loadNews(sym);loadChart(sym);loadTape(sym);
  loadStockMod("/english/js/stocks/profile.js?v=__BUILD__",function(){ return typeof window.loadProfile==="function"; },function(){ window.loadProfile(sym); window.loadEvents(sym); window.loadTarget(sym); window.loadCost(sym); window.loadFund(sym); });
  loadStockMod("/english/js/stocks/consensus.js?v=__BUILD__",function(){ return typeof window.loadConsDetail==="function"; },function(){ window.loadConsDetail(sym); });
  wlLoad().then(paintWatchBtn);
}
// ===== Trang con chi tiet ma: muc luc the lien ket thay thanh tab
// (Lenh Henrry 11:03 22/10 — cung khuon trang Thi truong). Trang tong
// quan la goc; moi muc con la trang rieng co back "< <Ma>".
const DT_I18N={
  flow:{vi:"Dòng tiền",en:"Money flow",zh:"资金流",ko:"자금 흐름"},
  news:{vi:"Tin tức",en:"News",zh:"新闻",ko:"뉴스"},
  fund:{vi:"Cơ bản",en:"Fundamentals",zh:"基本面",ko:"펀더멘털"},
  prof:{vi:"Hồ sơ",en:"Profile",zh:"公司资料",ko:"기업 프로필"},
  cons:{vi:"Đồng thuận",en:"Consensus",zh:"一致预期",ko:"컨센서스"},
  tape:{vi:"Khớp lệnh",en:"Trades",zh:"逐笔成交",ko:"체결 내역"},
  idx:{vi:"Mục lục",en:"Contents",zh:"目录",ko:"목차"}};
const DKEYMAP={flow:"Flow",news:"News",fund:"Fund",prof:"Prof",cons:"Cons",tape:"Tape"};
const DKEYS=["Flow","News","Fund","Prof","Cons","Tape"];
function dShow(key){
  $("dOv").style.display=key?"none":"";
  DKEYS.forEach(k=>{
    const on=(k===key), h=$("d"+k+"H"), b=$("d"+k);
    if(h)h.style.display=on?"":"none";
    if(b)b.style.display=on?"":"none";
  });
  window.scrollTo(0,0);
}
function dOpen(k){ renderDNav(); dShow(k); }
function dBack(){ dShow(null); }
function renderDNav(){
  const nav=$("dNav"); if(!nav) return;
  nav.innerHTML=Object.keys(DKEYMAP).map(k=>`<div class="navcard" onclick="dOpen('${DKEYMAP[k]}')"><span>${DT_I18N[k][curLang]||DT_I18N[k].vi}</span><span class="nchev">›</span></div>`).join("");
  const t=$("dNavTitle"); if(t) t.textContent=DT_I18N.idx[curLang]||DT_I18N.idx.vi;
  document.querySelectorAll(".dtitle").forEach(e=>{ const d=DT_I18N[e.dataset.k]; if(d) e.textContent=d[curLang]||d.vi; });
  document.querySelectorAll(".dbacksym").forEach(e=>{ e.textContent=curSym||""; });
}
function renderFlowBars(rows, valKey, barId, lblId, sumId){
  const vals=rows.map(r=>r[valKey]||0);
  const max=Math.max(...vals.map(v=>Math.abs(v)),1);
  $(barId).innerHTML=rows.map(r=>{const v=r[valKey]||0;return `<div class="bar ${v>=0?"p":"n"}" style="height:${Math.max(4,Math.abs(v)/max*100)}%"></div>`;}).join("");
  $(lblId).innerHTML=rows.map((r,i)=>`<span>${i===0||i===rows.length-1?esc((r.trade_date||"").slice(5)):""}</span>`).join("");
  const sum=vals.reduce((a,v)=>a+v,0);
  $(sumId).innerHTML=`<span class="${sum>=0?"up":"down"}">${fmtTy(sum)} (${sum>=0?"mua":"bán"} ròng)</span>`;
}
async function loadFlow(sym){
  // Endpoint dung: /foreign-flow/history (rows moi nhat truoc, field net_value_est).
  // Ban cu goi /foreign_flow (404) + doc net_value/date -> chet im lang.
  try{
    const j=await api("/foreign-flow/history?symbol="+encodeURIComponent(sym)+"&limit=20");
    const rows=(j.rows||[]).slice(0,20).reverse();
    if(rows.length) renderFlowBars(rows, "net_value_est", "dFf", "dFfLbl", "dFfSum");
  }catch(e){}
  try{
    const j=await api("/proprietary-flow/history?symbol="+encodeURIComponent(sym)+"&limit=20");
    const rows=(j.rows||[]).slice(0,20).reverse();
    if(rows.length) renderFlowBars(rows, "net_value_vnd", "dPf", "dPfLbl", "dPfSum");
  }catch(e){}
}
// ===== Khop lenh chi tiet (tape, chan DNSE; phia M/B suy luat tick) =====
const TP_I18N={
vi:{tot:"Tổng KL khớp",buy:"MUA chủ động",sell:"BÁN chủ động",more:"Xem đầy đủ",lvl:"Phân bổ khối lượng theo giá",list:"Chi tiết từng lệnh",time:"Thời gian",price:"Giá",vol:"KL",side:"M/B",none:"Chưa có dữ liệu khớp lệnh chi tiết cho mã này.",note:"Phía M/B ước lượng theo luật tick (giá lên = mua chủ động, giá xuống = bán chủ động).",partial:"Dữ liệu từ giữa phiên (bộ thu khởi động lại) — tổng có thể thiếu đầu phiên."},
en:{tot:"Total matched",buy:"Active buy",sell:"Active sell",more:"See all",lvl:"Volume by price",list:"Trade details",time:"Time",price:"Price",vol:"Vol",side:"B/S",none:"No detailed trade data for this symbol yet.",note:"Buy/sell side estimated by the tick rule (uptick = active buy, downtick = active sell).",partial:"Data starts mid-session (collector restarted) — totals may miss the open."},
zh:{tot:"总成交量",buy:"主动买入",sell:"主动卖出",more:"查看全部",lvl:"按价格的成交量分布",list:"逐笔明细",time:"时间",price:"价格",vol:"量",side:"买/卖",none:"该股票暂无逐笔成交数据。",note:"买卖方向按逐笔规则估算(上涨=主动买入,下跌=主动卖出)。",partial:"数据从盘中开始(采集器重启)—总量可能缺少开盘部分。"},
ko:{tot:"총 체결량",buy:"능동 매수",sell:"능동 매도",more:"전체 보기",lvl:"가격별 거래량 분포",list:"체결 상세",time:"시간",price:"가격",vol:"수량",side:"매수/매도",none:"이 종목의 체결 상세 데이터가 아직 없습니다.",note:"매수/매도 방향은 틱 규칙으로 추정합니다(상승=능동 매수, 하락=능동 매도).",partial:"장중에 시작된 데이터입니다(수집기 재시작)—합계에 시가 부분이 누락될 수 있습니다."}};
function TPL(){return TP_I18N[curLang]||TP_I18N.vi;}
let _tape=null;
function fmtK(v){ if(v==null) return "—"; const a=Math.abs(v); if(a>=1e6) return (v/1e6).toFixed(1).replace(".",",")+"M"; if(a>=1e3) return (v/1e3).toFixed(1).replace(".",",")+"K"; return String(v); }
function tapeRef(){ const q=_lastQuote||{}; if(q.close!=null&&q.change!=null) return q.close-q.change; return null; }
function tapePCls(p){ const r=tapeRef(); if(r==null||p==null) return ""; return p>r?"up":p<r?"down":""; }
function tapeBadge(s){ if(s==="M") return '<span style="display:inline-block;min-width:22px;text-align:center;padding:1px 5px;border-radius:9px;background:#e5f6ec;color:#0a7a42;font-weight:700;font-size:11px">M</span>'; if(s==="B") return '<span style="display:inline-block;min-width:22px;text-align:center;padding:1px 5px;border-radius:9px;background:#fdecec;color:#c22727;font-weight:700;font-size:11px">B</span>'; return ""; }
function tapeLevelsHtml(levels,lastP){
  if(!levels||!levels.length) return '<div class="hint">—</div>';
  const max=Math.max(...levels.map(l=>l.v||0),1);
  const rows=[...levels].sort((a,b)=>b.p-a.p).slice(0,48);
  return rows.map(l=>{const w=Math.max(2,(l.v||0)/max*100);const hot=lastP!=null&&l.p===lastP;
    return `<div style="display:flex;align-items:center;gap:8px;padding:1.5px 0"><span style="width:64px;text-align:right;font-weight:${hot?"800":"600"}" class="${tapePCls(l.p)}">${fmtN(l.p)}</span><div style="flex:1;background:var(--pp-bg2);border-radius:3px"><div style="width:${w}%;height:11px;border-radius:3px;background:${hot?"#d6336c":"var(--pp-accent)"}"></div></div><span style="width:58px;font-size:12px;color:var(--pp-mut)">${fmtK(l.v)}</span></div>`;}).join("");
}
async function loadTape(sym){
  _tape=null;
  const sec=$("dTapeSec"),card=$("dTapeCard");
  try{
    const j=await api("/trades?symbol="+encodeURIComponent(sym)+"&limit=300");
    if(j.empty){ if(sec)sec.style.display="none"; if(card)card.style.display="none"; return; }
    if(j.trades) j.trades.sort((a,b)=>(a.ts||0)-(b.ts||0));
    _tape=j;
    if(sec)sec.style.display=""; if(card)card.style.display="";
    renderTapeMini(); renderTapePage();
  }catch(e){
    if(sec)sec.style.display="none"; if(card)card.style.display="none";
    const l=$("dTapeList"); if(l) l.innerHTML='<div class="hint">'+esc(TPL().none)+'</div>';
    const c=$("dTapeCards"); if(c) c.innerHTML="";
    const lv=$("dTapeLevels"); if(lv) lv.innerHTML="";
  }
}
function renderTapeMini(){
  const el=$("dTapeMini"); if(!el||!_tape) return;
  const tr=(_tape.trades||[]).slice(-10).reverse();
  const lastP=(_tape.trades&&_tape.trades.length)?_tape.trades[_tape.trades.length-1].p:null;
  const list=tr.map(t=>`<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--pp-line)"><span style="color:var(--pp-mut)">${esc((t.time||"").slice(0,5))}</span><span class="${tapePCls(t.p)}" style="font-weight:700">${fmtN(t.p)}</span><span>${fmtK(t.v)}</span></div>`).join("");
  el.innerHTML=`<div style="display:flex;gap:10px"><div style="flex:1.1">${list||'<div class="hint">—</div>'}</div><div style="flex:1">${tapeLevelsHtml(_tape.levels,lastP)}</div></div>`;
  const m=$("dTapeMore"); if(m) m.textContent=TPL().more;
  const s=$("dTapeSec"); if(s) s.textContent=(DT_I18N.tape[curLang]||DT_I18N.tape.vi);
}
function renderTapePage(){
  if(!_tape) return;
  const L=TPL();
  const cards=$("dTapeCards");
  if(cards) cards.innerHTML=`<div style="display:flex;gap:8px">
    <div class="card" style="flex:1;text-align:center;margin:0"><div style="font-size:12px;color:var(--pp-mut)">${esc(L.tot)}</div><div style="font-size:17px;font-weight:800;color:var(--pp-accent)">${fmtN(_tape.total_vol)}</div></div>
    <div class="card" style="flex:1;text-align:center;margin:0"><div style="font-size:12px;color:var(--pp-mut)">${esc(L.buy)} <span style="color:#0a7a42;font-weight:700">M</span></div><div style="font-size:17px;font-weight:800" class="up">${fmtN(_tape.buy_vol)}</div></div>
    <div class="card" style="flex:1;text-align:center;margin:0"><div style="font-size:12px;color:var(--pp-mut)">${esc(L.sell)} <span style="color:#c22727;font-weight:700">B</span></div><div style="font-size:17px;font-weight:800" class="down">${fmtN(_tape.sell_vol)}</div></div></div>`;
  const lt=$("dTapeLvlT"); if(lt) lt.textContent=L.lvl;
  const lst=$("dTapeListT"); if(lst) lst.textContent=L.list;
  const lastP=(_tape.trades&&_tape.trades.length)?_tape.trades[_tape.trades.length-1].p:null;
  const lv=$("dTapeLevels"); if(lv) lv.innerHTML=tapeLevelsHtml(_tape.levels,lastP);
  const ref=tapeRef();
  const rows=(_tape.trades||[]).slice().reverse().map(t=>{
    const chg=(ref!=null&&t.p!=null)?t.p-ref:null;
    return `<div style="display:flex;align-items:center;padding:4px 0;border-bottom:1px solid var(--pp-line)"><span style="width:70px;color:var(--pp-mut)">${esc(t.time||"")}</span><span class="${tapePCls(t.p)}" style="width:76px;text-align:right;font-weight:700">${fmtN(t.p)}</span><span class="${tapePCls(t.p)}" style="width:70px;text-align:right">${chg==null?"":(chg>0?"+":"")+fmtN(chg)}</span><span style="flex:1;text-align:right">${fmtN(t.v)}</span><span style="width:34px;text-align:right">${tapeBadge(t.s)}</span></div>`;}).join("");
  const l=$("dTapeList");
  if(l) l.innerHTML=`<div style="display:flex;padding:2px 0;color:var(--pp-mut);font-size:12px"><span style="width:70px">${esc(L.time)}</span><span style="width:76px;text-align:right">${esc(L.price)}</span><span style="width:70px;text-align:right">+/−</span><span style="flex:1;text-align:right">${esc(L.vol)}</span><span style="width:34px;text-align:right">${esc(L.side)}</span></div>`+(rows||'<div class="hint">—</div>');
  const n=$("dTapeNote");
  if(n) n.textContent=L.note+(_tape.partial?" "+L.partial:"");
}

async function loadNews(sym){
  try{
    const j=await api("/news?symbol="+encodeURIComponent(sym));
    const items=j.items||[];
    $("dNewsList").innerHTML=items.length?items.slice(0,15).map(n=>`<div style="padding:8px 0;border-bottom:1px solid var(--pp-line)"><a href="${esc(n.url||"#")}" target="_blank" rel="noopener" style="color:var(--pp-ink);text-decoration:none;font-size:14px;font-weight:600">${esc(n.title||"")}</a><div style="font-size:12px;color:var(--pp-mut);margin-top:2px">${esc((n.publish_time||"").slice(0,10))}</div></div>`).join(""):'<div class="hint">Chưa có tin</div>';
  }catch(e){ $("dNewsList").innerHTML='<div class="hint">Chưa có tin</div>'; }
}
// ===== Dot B (20/10): watchlist · targets · events · compare · cost history =====
const B_I18N={
vi:{noEv:"Chưa có sự kiện",evAll:"Tất cả",evCorp:"Doanh nghiệp",evIns:"Nội bộ",evMore:"Xem thêm",evPay:"Chi trả",tpPh:"Chốt lời % (vd 15)",slPh:"Cắt lỗ % (vd 5)",save:"Lưu mục tiêu",del:"Xoá",curNone:"Chưa đặt mục tiêu cho mã này.",saved:"Đã lưu mục tiêu.",wlEmpty:"Chưa theo dõi mã nào. Mở trang chi tiết một mã và bấm ☆, hoặc nhập mã ở ô dưới.",avgCost:"Giá vốn TB",mktClose:"Giá đóng cửa",cmpNeed:"Nhập ít nhất 2 mã để so sánh.",cmpErr:"Chưa có dữ liệu so sánh."},
en:{noEv:"No events yet",evAll:"All",evCorp:"Corporate",evIns:"Insider",evMore:"Show more",evPay:"Payout",tpPh:"Take profit % (e.g. 15)",slPh:"Stop loss % (e.g. 5)",save:"Save target",del:"Delete",curNone:"No target set for this symbol.",saved:"Target saved.",wlEmpty:"No symbols watched yet. Open a symbol and tap ☆, or type one below.",avgCost:"Avg cost",mktClose:"Close",cmpNeed:"Enter at least 2 symbols.",cmpErr:"No comparison data."},
zh:{noEv:"暂无事件",evAll:"全部",evCorp:"公司",evIns:"内部交易",evMore:"查看更多",evPay:"派付",tpPh:"止盈 % (如 15)",slPh:"止损 % (如 5)",save:"保存目标",del:"删除",curNone:"尚未为此股设置目标。",saved:"已保存目标。",wlEmpty:"尚未关注任何股票。打开个股页面点击 ☆,或在下方输入。",avgCost:"平均成本",mktClose:"收盘价",cmpNeed:"至少输入 2 只股票。",cmpErr:"暂无对比数据。"},
ko:{noEv:"이벤트가 없습니다",evAll:"전체",evCorp:"기업",evIns:"내부자",evMore:"더 보기",evPay:"지급",tpPh:"익절 % (예: 15)",slPh:"손절 % (예: 5)",save:"목표 저장",del:"삭제",curNone:"이 종목에 설정된 목표가 없습니다.",saved:"목표가 저장되었습니다.",wlEmpty:"아직 관심 종목이 없습니다. 종목 상세에서 ☆를 누르거나 아래에 입력하세요.",avgCost:"평균 단가",mktClose:"종가",cmpNeed:"최소 2개 종목을 입력하세요.",cmpErr:"비교 데이터가 없습니다."}};
function BL(){return B_I18N[curLang]||B_I18N.vi;}
let WLSET=null;
async function wlLoad(force){
  if(WLSET&&!force)return WLSET;
  try{const j=await api("/watchlist");WLSET=new Set((j||[]).map(x=>String(x).toUpperCase()));}
  catch(e){WLSET=new Set();}
  return WLSET;
}
function paintWatchBtn(){
  const b=$("dWatch");if(!b)return;
  const on=WLSET&&curSym&&WLSET.has(curSym);
  b.textContent=on?"★":"☆";b.style.color=on?"#f59e0b":"var(--pp-mut)";
}
$("dWatch").onclick=async()=>{
  if(!curSym)return;
  await wlLoad();
  try{
    if(WLSET.has(curSym)){await apip("/watchlist/"+curSym,"DELETE");WLSET.delete(curSym);}
    else{await apip("/watchlist","POST",{symbol:curSym});WLSET.add(curSym);}
  }catch(e){}
  paintWatchBtn();
};
async function loadWatchlist(){
  const box=$("wlList");if(!box)return;
  try{
    const syms=await wlLoad(true);
    const arr=[...syms];
    if(!arr.length){box.innerHTML='<div class="hint">'+BL().wlEmpty+'</div>';return;}
    const rows=await Promise.all(arr.map(async s=>{
      try{const j=await api("/quote?symbol="+s);const q=j.quote||j;return{s,c:q.close,pc:q.pct_change};}
      catch(e){return{s};}
    }));
    box.innerHTML=rows.map(r=>`<div class="row"><span class="k" style="font-weight:700;color:var(--pp-ink);cursor:pointer" onclick="openSym('${r.s}')">${r.s}</span><span class="v">${r.c!=null?fmtN(r.c):"—"}${r.pc!=null?` <span class="${r.pc>0?"up":r.pc<0?"down":""}">(${fmtPct(r.pc)})</span>`:""} <span style="color:var(--pp-mut);margin-left:8px;cursor:pointer" onclick="wlRemove('${r.s}')">✕</span></span></div>`).join("");
  }catch(e){box.innerHTML='<div class="hint">—</div>';}
}
async function wlRemove(s){
  try{await apip("/watchlist/"+s,"DELETE");if(WLSET)WLSET.delete(s);loadWatchlist();paintWatchBtn();}catch(e){}
}
const CMP_COLORS=["#2563eb","#dc2626","#16a34a","#f59e0b","#7c3aed"];
let CMP_CNT=120;
document.querySelectorAll("#cmpIv button").forEach(b=>b.onclick=()=>{
  document.querySelectorAll("#cmpIv button").forEach(x=>x.classList.remove("on"));
  b.classList.add("on");CMP_CNT=parseInt(b.dataset.cnt,10)||120;
  if($("cmpInp").value.trim())doCompare();
});
async function doCompare(){
  const inp=$("cmpInp").value.toUpperCase().split(",").map(x=>x.trim()).filter(Boolean).slice(0,5);
  const out=$("cmpOut"),L=BL();
  if(inp.length<2){out.innerHTML='<div class="hint">'+L.cmpNeed+'</div>';return;}
  out.innerHTML='<div class="hint">Đang tải…</div>';
  try{
    const j=await api("/compare?symbols="+inp.join(",")+"&count="+CMP_CNT);
    const series=j.series||{},syms=Object.keys(series);
    if(!syms.length){out.innerHTML='<div class="hint">'+L.cmpErr+'</div>';return;}
    const all=syms.flatMap(s=>series[s].map(p=>p.v));
    let hi=Math.max(...all,1),lo=Math.min(...all,-1);const pad=(hi-lo)*0.1||1;hi+=pad;lo-=pad;
    const W=340,H=150,maxLen=Math.max(...syms.map(s=>series[s].length));
    const Y=v=>H-(v-lo)/(hi-lo)*H;
    let svg=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block"><line x1="0" y1="${Y(0).toFixed(1)}" x2="${W}" y2="${Y(0).toFixed(1)}" stroke="rgba(140,140,140,.4)"/>`;
    syms.forEach((s,si)=>{
      const pts=series[s];
      const d=pts.map((p,i)=>(i?"L":"M")+(maxLen<2?0:i/(maxLen-1)*W).toFixed(1)+","+Y(p.v).toFixed(1)).join(" ");
      svg+=`<path d="${d}" fill="none" stroke="${CMP_COLORS[si%5]}" stroke-width="1.6"/>`;
    });
    svg+="</svg>";
    const legend=syms.map((s,si)=>{
      const pts=series[s],last=pts[pts.length-1];
      return `<span style="color:${CMP_COLORS[si%5]};font-weight:700">${esc(s)}</span> <span class="${last.v>0?"up":last.v<0?"down":""}">${last.v>0?"+":""}${Number(last.v.toFixed(2))}%</span>`;
    }).join(" · ");
    const s0=series[syms[0]];
    out.innerHTML=svg+`<div style="font-size:12px;margin-top:4px">${legend}</div><div style="font-size:12px;color:var(--pp-mut)">${esc(s0[0].t)} → ${esc(s0[s0.length-1].t)}</div>`;
  }catch(e){out.innerHTML='<div class="hint">'+L.cmpErr+'</div>';}
}
$("cmpBtn").onclick=doCompare;
// ---- Bieu do nen (SVG nhe, du lieu /ohlcv) ----
let _chartSym="";
function chartSvg(rows,scale){
  const W=340,H=150,volH=26,priceH=H-volH-2;
  let hi=-1e18,lo=1e18,vmax=0;
  for(const r of rows){hi=Math.max(hi,r.h);lo=Math.min(lo,r.l);vmax=Math.max(vmax,r.v||0);}
  const rawHi=hi,rawLo=lo,pad=(hi-lo)*0.06||1; hi+=pad; lo-=pad;
  const xw=W/rows.length, Y=v=>priceH-(v-lo)/(hi-lo)*priceH;
  let s=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">`;
  for(let i=1;i<4;i++){const y=(priceH*i/4).toFixed(1); s+=`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(140,140,140,.25)" stroke-width="1"/>`;}
  rows.forEach((r,i)=>{
    const x=i*xw+xw/2, up=r.c>=r.o, col=up?"#16a34a":"#dc2626";
    s+=`<line x1="${x.toFixed(1)}" y1="${Y(r.h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${Y(r.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    const yO=Y(r.o),yC=Y(r.c);
    s+=`<rect x="${(i*xw+1).toFixed(1)}" y="${Math.min(yO,yC).toFixed(1)}" width="${Math.max(2,xw-2).toFixed(1)}" height="${Math.max(1,Math.abs(yC-yO)).toFixed(1)}" fill="${col}"/>`;
    const vh=vmax?(r.v||0)/vmax*volH:0;
    s+=`<rect x="${(i*xw+1).toFixed(1)}" y="${(H-vh).toFixed(1)}" width="${Math.max(2,xw-2).toFixed(1)}" height="${vh.toFixed(1)}" fill="${col}" opacity=".5"/>`;
  });
  const lastR=rows[rows.length-1];
  if(lastR){ const ly=Y(lastR.c), lc=lastR.c>=lastR.o?"#16a34a":"#dc2626";
    s+=`<line x1="0" y1="${ly.toFixed(1)}" x2="${W}" y2="${ly.toFixed(1)}" stroke="${lc}" stroke-width="0.7" stroke-dasharray="4 3" opacity="0.85"/><text x="${W-3}" y="${(ly-3).toFixed(1)}" font-size="8.5" text-anchor="end" font-weight="700" fill="${lc}">${fmtN(lastR.c*(scale||1000))}</text>`;
  }
  s+=`<text x="2" y="10" font-size="8" fill="var(--pp-mut)">${fmtN(rawHi*(scale||1000))}</text><text x="2" y="${priceH}" font-size="8" fill="var(--pp-mut)">${fmtN(rawLo*(scale||1000))}</text>`;
  return s+"</svg>"+`<div style="font-size:12px;color:var(--pp-mut);margin-top:4px">${esc(rows[0].t)} → ${esc(rows[rows.length-1].t)}</div>`;
}
async function loadChart(sym, iv){
  _chartSym=sym; iv=iv||"1D"; _chartIv=iv;
  document.querySelectorAll("#dIv button").forEach(b=>b.classList.toggle("on", b.textContent===iv));
  const box=$("dChart"); if(window.PP_CHART)PP_CHART.destroy(); box.innerHTML='<div class="hint">Đang tải…</div>';
  ["dFaLegend","dFaPct","dFaGrid"].forEach(k=>{ const e=$(k); if(e) e.innerHTML=""; });
  const pnl=$("dIndPanel"); if(pnl) pnl.style.display="none";
  try{
    const cnt = iv==="1D" ? 400 : 200;
    const j=await api("/ohlcv?symbol="+encodeURIComponent(sym)+"&count="+cnt+"&interval="+iv);
    _chartRows=(j.rows||[]);
    if(_chartRows.length<2){ box.innerHTML='<div class="hint">Chưa có dữ liệu biểu đồ</div>'; const pn=$("dIndPanes"); if(pn) pn.innerHTML=""; const cp=$("dIndChips"); if(cp) cp.innerHTML=""; return; }
    renderIndChart();
  }catch(e){
    box.innerHTML='<div class="hint">'+(String(e.message)==="402"?"Biểu đồ trong phiên cần gói trả phí":String(e.message)==="404"?"Chưa có dữ liệu biểu đồ":"Lỗi tải biểu đồ")+'</div>';
  }
}
// ---- Chi bao ky thuat (engine client-side, spec theo TradingView/FireAnt) ----
let _chartRows=[], _chartIv="1D";
function studySpec(name){ if(!window.PP_STUDIES) return null; return PP_STUDIES.find(s=>s.name===name)||null; }
function getStudies(){
  try{ const v=JSON.parse(localStorage.getItem("pp_studies_v1")||"null"); if(Array.isArray(v)) return v.filter(x=>x&&x.name); }catch(e){}
  return [{name:"Moving Average",inputs:{length:10}},{name:"Moving Average",inputs:{length:50}}];
}
function saveStudies(list){ try{ localStorage.setItem("pp_studies_v1", JSON.stringify(list)); }catch(e){} }
function indInputVal(inputs, inp){ const v=inputs?inputs[inp.id]:undefined; return (v===undefined||v===null)?inp.defval:v; }
function indParamSummary(st){
  const spec=studySpec(st.name); if(!spec) return "";
  const nums=[];
  for(const inp of spec.inputs){ if(inp.id==="offset"||inp.id.indexOf("smoothing")===0) continue; if(inp.type==="integer"||inp.type==="float") nums.push(indInputVal(st.inputs, inp)); if(nums.length>=3) break; }
  return nums.length?(" ("+nums.join(", ")+")"):"";
}
function fmtIndVal(v, mul){ const x=v*mul; return Math.abs(x)>=1000?fmtN(Math.round(x)):String(Math.round(x*100)/100); }
function indLastText(res, mul){
  if(!res||!res.plots) return "";
  const parts=[];
  for(const p of res.plots.slice(0,3)){
    let v=null; for(let i=p.values.length-1;i>=0;i--){ if(p.values[i]!=null){ v=p.values[i]; break; } }
    if(v!=null) parts.push('<span style="color:'+(p.color||"#888")+'">'+esc(p.title||p.id)+": "+fmtIndVal(v, mul)+"</span>");
  }
  return parts.join(" ");
}
const VOL_MA5_COL="#f59e0b",VOL_MA10_COL="#c084fc";
function chartSvgInd(disp, overlays, off, scale, volLines){
  const W=340,H=150,volH=26,priceH=H-volH-2;
  let hi=-1e18,lo=1e18,vmax=0;
  for(const r of disp){hi=Math.max(hi,r.h);lo=Math.min(lo,r.l);vmax=Math.max(vmax,r.v||0);}
  for(const L of (volLines||[])) for(const v of L.vals){ if(v!=null&&v>vmax) vmax=v; }
  for(const ov of overlays){ for(const p of ov.res.plots){ if(p.kind==="histogram") continue; for(let i=0;i<disp.length;i++){ const v=p.values[off+i]; if(v!=null){ if(v>hi)hi=v; if(v<lo)lo=v; } } } }
  const rawHi=hi,rawLo=lo,pad=(hi-lo)*0.06||1; hi+=pad; lo-=pad;
  const xw=W/disp.length, Y=v=>priceH-(v-lo)/(hi-lo)*priceH;
  let s=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">`;
  for(let i=1;i<4;i++){const y=(priceH*i/4).toFixed(1); s+=`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(140,140,140,.25)" stroke-width="1"/>`;}
  disp.forEach((r,i)=>{
    const x=i*xw+xw/2, up=r.c>=r.o, col=up?"#16a34a":"#dc2626";
    s+=`<line x1="${x.toFixed(1)}" y1="${Y(r.h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${Y(r.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    const yO=Y(r.o),yC=Y(r.c);
    s+=`<rect x="${(i*xw+1).toFixed(1)}" y="${Math.min(yO,yC).toFixed(1)}" width="${Math.max(2,xw-2).toFixed(1)}" height="${Math.max(1,Math.abs(yC-yO)).toFixed(1)}" fill="${col}"/>`;
    const vh=vmax?(r.v||0)/vmax*volH:0;
    s+=`<rect x="${(i*xw+1).toFixed(1)}" y="${(H-vh).toFixed(1)}" width="${Math.max(2,xw-2).toFixed(1)}" height="${vh.toFixed(1)}" fill="${col}" opacity=".5"/>`;
  });
  for(const ov of overlays){
    for(const p of ov.res.plots){
      if(p.kind==="histogram") continue;
      const col=p.color||"#2962FF";
      if(ov.st.name==="Parabolic SAR"){
        for(let i=0;i<disp.length;i++){ const v=p.values[off+i]; if(v!=null) s+=`<circle cx="${(i*xw+xw/2).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="1.3" fill="${col}"/>`; }
        continue;
      }
      let d="",pen=false;
      for(let i=0;i<disp.length;i++){ const v=p.values[off+i]; if(v==null){ pen=false; continue; } d+=(pen?"L":"M")+(i*xw+xw/2).toFixed(1)+" "+Y(v).toFixed(1)+" "; pen=true; }
      if(d) s+=`<path d="${d}" fill="none" stroke="${col}" stroke-width="1.2"/>`;
    }
  }
  for(const L of (volLines||[])){
    let run=[];
    const flush=()=>{ if(run.length>1) s+=`<polyline points="${run.join(" ")}" fill="none" stroke="${L.color}" stroke-width="1"/>`; run=[]; };
    L.vals.forEach((v,i)=>{ if(v==null||!vmax){ flush(); return; } run.push((i*xw+xw/2).toFixed(1)+","+(H-(v/vmax)*volH).toFixed(1)); });
    flush();
  }
  const lastR=disp[disp.length-1];
  if(lastR){ const ly=Y(lastR.c), lc=lastR.c>=lastR.o?"#16a34a":"#dc2626";
    s+=`<line x1="0" y1="${ly.toFixed(1)}" x2="${W}" y2="${ly.toFixed(1)}" stroke="${lc}" stroke-width="0.7" stroke-dasharray="4 3" opacity="0.85"/><text x="${W-3}" y="${(ly-3).toFixed(1)}" font-size="8.5" text-anchor="end" font-weight="700" fill="${lc}">${fmtN(lastR.c*scale)}</text>`;
  }
  s+=`<text x="2" y="10" font-size="8" fill="var(--pp-mut)">${fmtN(rawHi*scale)}</text><text x="2" y="${priceH}" font-size="8" fill="var(--pp-mut)">${fmtN(rawLo*scale)}</text>`;
  return s+"</svg>"+`<div style="font-size:12px;color:var(--pp-mut);margin-top:4px">${esc(disp[0].t)} → ${esc(disp[disp.length-1].t)}</div>`;
}
const IND_PRICE_UNIT={"Average True Range":1,"Standard Deviation":1,"Detrended Price Oscillator":1,"Price Oscillator":1,"Linear Regression Slope":1};
function paneSvgInd(item, off, dispLen, scale){
  const W=340,H=64,padT=4,plotH=H-8;
  let mn=1e18,mx=-1e18;
  const bands=item.res.bands||[];
  for(const p of item.res.plots){ for(let i=0;i<dispLen;i++){ const v=p.values[off+i]; if(v!=null){ if(v<mn)mn=v; if(v>mx)mx=v; } } }
  for(const b of bands){ if(b.value<mn)mn=b.value; if(b.value>mx)mx=b.value; }
  if(mx<mn) return "";
  if(mx===mn){ mx+=1; mn-=1; }
  const pd=(mx-mn)*0.08; mx+=pd; mn-=pd;
  const xw=W/dispLen, Y=v=>padT+plotH-(v-mn)/(mx-mn)*plotH;
  let s=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">`;
  if(mn<0&&mx>0){ const y=Y(0).toFixed(1); s+=`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(140,140,140,.4)" stroke-width="1"/>`; }
  for(const b of bands){ const y=Y(b.value); s+=`<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="${b.color||"#787B86"}" stroke-width="1" stroke-dasharray="3 3"/><text x="2" y="${Math.max(8,y-2).toFixed(1)}" font-size="7" fill="var(--pp-mut)">${b.value}</text>`; }
  for(const p of item.res.plots){
    const col=p.color||"#2962FF";
    if(p.kind==="histogram"){
      const base=(mn<0&&mx>0)?0:mn;
      for(let i=0;i<dispLen;i++){ const v=p.values[off+i]; if(v==null) continue; const y1=Y(Math.max(v,base)), y2=Y(Math.min(v,base)); s+=`<rect x="${(i*xw+0.5).toFixed(1)}" y="${y1.toFixed(1)}" width="${Math.max(1.5,xw-1).toFixed(1)}" height="${Math.max(1,y2-y1).toFixed(1)}" fill="${col}" opacity=".75"/>`; }
    } else {
      let d="",pen=false;
      for(let i=0;i<dispLen;i++){ const v=p.values[off+i]; if(v==null){ pen=false; continue; } d+=(pen?"L":"M")+(i*xw+xw/2).toFixed(1)+" "+Y(v).toFixed(1)+" "; pen=true; }
      if(d) s+=`<path d="${d}" fill="none" stroke="${col}" stroke-width="1.2"/>`;
    }
  }
  s+="</svg>";
  const mul=IND_PRICE_UNIT[item.st.name]?scale:1;
  const legend=`<div style="font-size:11px;margin:6px 0 2px"><b>${esc(item.spec&&item.spec.short?item.spec.short:item.st.name)}${esc(indParamSummary(item.st))}</b> ${indLastText(item.res, mul)}</div>`;
  return legend+s;
}
function smaSeries(vals,n){
  const out=new Array(vals.length).fill(null); let sum=0;
  for(let i=0;i<vals.length;i++){ sum+=vals[i]||0; if(i>=n) sum-=vals[i-n]||0; if(i>=n-1) out[i]=sum/n; }
  return out;
}
let _lastQuote=null,_lastFund=null,_lastProfile=null;
function renderFaLegend(overlays,volLines,scale){
  const el=$("dFaLegend"); if(!el) return;
  const items=[];
  (overlays||[]).forEach(ov=>{
    ov.res.plots.forEach(p=>{
      if(p.kind==="histogram") return;
      let last=null; for(let i=p.values.length-1;i>=0;i--){ if(p.values[i]!=null){ last=p.values[i]; break; } }
      const lbl=(ov.spec&&ov.spec.short?ov.spec.short:ov.st.name)+indParamSummary(ov.st);
      items.push(`<span class="fi"><span class="dot" style="background:${p.color||"#2962FF"}"></span>${esc(lbl)}${last!=null?` <b>${fmtIndVal(last,scale)}</b>`:""}</span>`);
    });
  });
  (volLines||[]).forEach((L,i)=>{
    let last=null; for(let j=L.vals.length-1;j>=0;j--){ if(L.vals[j]!=null){ last=L.vals[j]; break; } }
    items.push(`<span class="fi"><span class="dot" style="background:${L.color}"></span>${i===0?"MA5":"MA10"} KL${last!=null?` <b>${fmtN(last)}</b>`:""}</span>`);
  });
  el.innerHTML=items.length?`<div class="faleg">${items.join("")}</div>`:"";
}
function renderFaPctGrid(){
  const pctEl=$("dFaPct"), gridEl=$("dFaGrid");
  if(pctEl){
    let h="";
    if(_chartIv==="1D"&&_chartRows.length>=2){
      const rows=_chartRows, last=rows[rows.length-1], scale=IDX_LIST.includes(_chartSym)?1:1000;
      const defs=[["1D",1],["1W",5],["1M",21],["3M",63],["6M",126],["1Y",252]];
      h='<div class="fapct">'+defs.map(([k,n])=>{
        const ref=rows[rows.length-1-n];
        const v=(ref&&ref.c)?(last.c/ref.c-1)*100:null;
        return `<span class="pc"><span class="k">${k}</span><span class="v">${v==null?"—":`<span class="${v>=0?"up":"dn"}">${fmtPct(v)}</span>`}</span></span>`;
      }).join("")+"</div>";
    }
    pctEl.innerHTML=h;
  }
  if(gridEl){
    let h="";
    if(_chartIv==="1D"&&!(IDX_LIST.includes(_chartSym)||IDX_SEC_LIST.includes(_chartSym))&&_chartRows.length>=2){
      const rows=_chartRows, last=rows[rows.length-1], prev=rows[rows.length-2];
      const q=_lastQuote||{}, f=_lastFund||{};
      let shares=null;
      const ch=(_lastProfile&&_lastProfile.capital_history)||[];
      if(ch.length){ const cc=Number(ch[0].charter_capital); if(cc>0) shares=cc/10000; }
      const mcap=(shares!=null)?shares*last.c*1000:null;
      const val=(q.value_vnd!=null)?q.value_vnd:(last.v||0)*last.c*1000;
      const cell=(k,v)=>`<div class="fr"><span class="k">${esc(T(k))}</span><span class="v">${v}</span></div>`;
      h='<div class="fagrid">'
        +cell("Tham chiếu",fmtN(prev.c*1000))
        +cell("Mở cửa",fmtN(last.o*1000))
        +cell("Cao nhất",fmtN(last.h*1000))
        +cell("Thấp nhất",fmtN(last.l*1000))
        +cell("Khối lượng",fmtN(last.v||0))
        +cell("Giá trị",fmtTyAbs(val))
        +cell("Vốn hoá",fmtTyAbs(mcap))
        +cell("CP lưu hành",shares!=null?fmtN(shares):"—")
        +cell("P/E",f.pe_ttm!=null?Number(f.pe_ttm).toFixed(2).replace(".",","):"—")
        +cell("EPS",f.eps!=null?fmtN(Math.round(f.eps)):"—")
        +"</div>";
    }
    gridEl.innerHTML=h;
  }
}
function renderIndChart(){
  const box=$("dChart"), panes=$("dIndPanes"), chips=$("dIndChips");
  if(!box) return;
  const full=_chartRows, scale=(IDX_LIST.includes(_chartSym)||IDX_SEC_LIST.includes(_chartSym))?1:1000;
  const disp=full.slice(-60), off=full.length-disp.length;
  const volFull=full.map(r=>r.v||0);
  const volLines=[
    {color:VOL_MA5_COL, vals:smaSeries(volFull,5).slice(off)},
    {color:VOL_MA10_COL, vals:smaSeries(volFull,10).slice(off)},
  ];
  const studies=getStudies();
  if(!window.PP_IND||!window.PP_STUDIES){
    if(window.PP_CHART)PP_CHART.destroy();
    box.innerHTML=chartSvg(disp, scale); if(panes)panes.innerHTML=""; if(chips)chips.innerHTML="";
    renderFaLegend([], volLines, scale); renderFaPctGrid(); return;
  }
  const bars=full.map(r=>({t:r.t,o:r.o,h:r.h,l:r.l,c:r.c,v:r.v||0}));
  const results=studies.map(st=>{
    let res=null;
    try{ res=PP_IND.compute(st.name, bars, st.inputs||{}); }catch(e){ res=null; }
    return {st, res, spec:studySpec(st.name)};
  });
  const overlays=results.filter(x=>x.res&&x.res.plots&&x.res.plots.length&&x.spec&&x.spec.priceStudy);
  const paneItems=results.filter(x=>x.res&&x.res.plots&&x.res.plots.length&&x.spec&&!x.spec.priceStudy);
  // GĐ2 lật live (port từ stocks-v2.html GĐ1, đã kiểm chứng staging):
  // vẽ bằng PP_CHART/Lightweight Charts; lỗi tải thư viện hoặc adapter
  // -> rơi về SVG như bản live cũ. pricePrecision theo cùng quy tắc
  // scale của main (chỉ số chính + chỉ số phụ -> 2, mã -> 0).
  if(window.PP_CHART&&window.LightweightCharts){
    let ok=false;
    try{
      ok=PP_CHART.render(box,{bars:full,scale:scale,pricePrecision:(IDX_LIST.includes(_chartSym)||IDX_SEC_LIST.includes(_chartSym))?2:0,intraday:_chartIv!=="1D",studies:results,volLines:[
        {color:VOL_MA5_COL, vals:smaSeries(volFull,5)},
        {color:VOL_MA10_COL, vals:smaSeries(volFull,10)},
      ]});
    }catch(e){ ok=false; }
    if(ok){
      if(panes)panes.innerHTML="";
      renderIndChips(studies);
      renderFaLegend(overlays, volLines, scale);
      renderFaPctGrid();
      return;
    }
  }
  box.innerHTML=chartSvgInd(disp, overlays, off, scale, volLines);
  if(panes) panes.innerHTML=paneItems.map(p=>paneSvgInd(p, off, disp.length, scale)).join("");
  renderIndChips(studies);
  renderFaLegend(overlays, volLines, scale);
  renderFaPctGrid();
}
function renderIndChips(studies){
  const el=$("dIndChips"); if(!el) return;
  let h="";
  studies.forEach((st,i)=>{
    const spec=studySpec(st.name);
    const label=(spec&&spec.short?spec.short:st.name)+indParamSummary(st);
    h+=`<span style="display:inline-flex;margin:0 6px 6px 0"><button data-ind="${i}" style="font-size:12px;padding:5px 9px;border-radius:6px 0 0 6px;background:var(--pp-bg2);border:1px solid var(--pp-line);border-right:none;cursor:pointer">${esc(label)}</button><button data-indx="${i}" aria-label="${esc(T("Xoá chỉ báo"))}" style="font-size:12px;padding:5px 7px;border-radius:0 6px 6px 0;background:var(--pp-bg2);border:1px solid var(--pp-line);cursor:pointer;color:var(--pp-mut)">×</button></span>`;
  });
  h+=`<button data-indadd="1" style="font-size:12px;padding:5px 9px;border-radius:6px;background:var(--pp-accent);color:#fff;border:1px solid var(--pp-accent);cursor:pointer;margin:0 6px 6px 0">${esc(T("+ Chỉ báo"))}</button>`;
  el.innerHTML=h;
  el.querySelectorAll("button[data-ind]").forEach(b=>b.onclick=()=>openIndEdit(Number(b.dataset.ind)));
  el.querySelectorAll("button[data-indx]").forEach(b=>b.onclick=()=>{ const sts=getStudies(); sts.splice(Number(b.dataset.indx),1); saveStudies(sts); const p=$("dIndPanel"); if(p) p.style.display="none"; renderIndChart(); });
  const add=el.querySelector("button[data-indadd]"); if(add) add.onclick=openIndList;
}
function openIndList(){
  const p=$("dIndPanel"); if(!p) return; p.style.display="";
  const impl=(window.PP_IND&&PP_IND.implemented)||[];
  const btnStyle="font-size:12px;padding:5px 9px;border-radius:6px;background:var(--pp-bg2);border:1px solid var(--pp-line);cursor:pointer";
  p.innerHTML=`<div style="display:flex;gap:6px;align-items:center"><input id="indSearch" type="text" placeholder="${esc(T("Tìm chỉ báo…"))}" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--pp-line);background:var(--pp-bg2);color:inherit;font-size:13px"><button id="indClose" style="${btnStyle}">${esc(T("Đóng"))}</button></div><div id="indList" style="max-height:260px;overflow:auto;margin-top:6px"></div>`;
  const sameAsFresh=(st,spec)=>{ if(!spec||!spec.inputs) return false; for(const inp of spec.inputs){ if(inp.type==="symbol") continue; if(String(indInputVal(st.inputs,inp))!==String(indInputVal({},inp))) return false; } return true; };
  const draw=q=>{
    const list=(window.PP_STUDIES||[]).filter(s=>!q||s.name.toLowerCase().includes(q)||(s.short||"").toLowerCase().includes(q));
    const box=$("indList"); if(!box) return;
    const stsNow=getStudies();
    box.innerHTML=list.map(s=>{
      const ok=impl.includes(s.name);
      const act=stsNow.filter(x=>x.name===s.name);
      const dup=ok&&act.some(x=>sameAsFresh(x,studySpec(s.name)));
      const state=act.length?` <span style="color:var(--pp-mut);font-size:11px">· ${esc(T("đang bật"))}${act.length>1?" ×"+act.length:""}</span>`:"";
      const btn=!ok?`<span style="font-size:11px;color:var(--pp-mut)">${esc(T("Sắp có"))}</span>`:dup?`<button data-del="${esc(s.name)}" style="${btnStyle};color:#dc2626">${esc(T("Tắt"))}</button>`:`<button data-add="${esc(s.name)}" style="${btnStyle}">${esc(T("Thêm"))}</button>`;
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 2px;border-bottom:1px solid var(--pp-line)"><span style="font-size:13px">${esc(s.name)}${s.short&&s.short!==s.name?` <span style="color:var(--pp-mut);font-size:11px">${esc(s.short)}</span>`:""}${state}</span>${btn}</div>`;
    }).join("")||`<div class="hint">${esc(T("Không tìm thấy"))}</div>`;
    box.querySelectorAll("button[data-add]").forEach(b=>b.onclick=()=>{ const sts=getStudies(); sts.push({name:b.dataset.add, inputs:{}}); saveStudies(sts); renderIndChart(); draw(($("indSearch").value||"").trim().toLowerCase()); });
    box.querySelectorAll("button[data-del]").forEach(b=>b.onclick=()=>{ const nm=b.dataset.del; const sp=studySpec(nm); const sts=getStudies().filter(x=>!(x.name===nm&&sameAsFresh(x,sp))); saveStudies(sts); renderIndChart(); draw(($("indSearch").value||"").trim().toLowerCase()); });
  };
  draw("");
  $("indSearch").oninput=e=>draw(e.target.value.trim().toLowerCase());
  $("indClose").onclick=()=>{ p.style.display="none"; };
}
function openIndEdit(i){
  const studies=getStudies(); const st=studies[i]; if(!st) return;
  const spec=studySpec(st.name); const p=$("dIndPanel"); if(!p) return; p.style.display="";
  const inputs=(spec?spec.inputs:[]).filter(inp=>inp.type!=="symbol");
  const inStyle="width:100px;padding:4px 6px;border-radius:6px;border:1px solid var(--pp-line);background:var(--pp-bg2);color:inherit";
  let h=`<div style="font-weight:700;font-size:13px">${esc(st.name)}${spec&&spec.short?" — "+esc(spec.short):""}</div>`;
  for(const inp of inputs){
    const v=indInputVal(st.inputs, inp);
    if(inp.type==="integer"||inp.type==="float"){
      h+=`<div class="row"><span class="k">${esc(inp.name)}</span><span class="v"><input data-inp="${esc(inp.id)}" type="number" step="${inp.type==="integer"?"1":"any"}" value="${v}" style="${inStyle}"></span></div>`;
    } else if(inp.options){
      h+=`<div class="row"><span class="k">${esc(inp.name)}</span><span class="v"><select data-inp="${esc(inp.id)}" style="${inStyle}">${inp.options.map(o=>`<option value="${esc(o)}" ${String(o)===String(v)?"selected":""}>${esc(o)}</option>`).join("")}</select></span></div>`;
    } else if(inp.type==="bool"||inp.type==="boolean"){
      h+=`<div class="row"><span class="k">${esc(inp.name)}</span><span class="v"><input data-inp="${esc(inp.id)}" type="checkbox" ${v?"checked":""}></span></div>`;
    } else {
      h+=`<div class="row"><span class="k">${esc(inp.name)}</span><span class="v"><input data-inp="${esc(inp.id)}" type="text" value="${esc(String(v))}" style="${inStyle}"></span></div>`;
    }
  }
  h+=`<div style="margin-top:8px;display:flex;gap:6px"><button id="indDel" style="font-size:12px;padding:5px 9px;border-radius:6px;background:var(--pp-bg2);border:1px solid var(--pp-line);cursor:pointer;color:#dc2626">${esc(T("Xoá chỉ báo"))}</button><button id="indDone" style="font-size:12px;padding:5px 9px;border-radius:6px;background:var(--pp-bg2);border:1px solid var(--pp-line);cursor:pointer">${esc(T("Đóng"))}</button></div>`;
  p.innerHTML=h;
  p.querySelectorAll("[data-inp]").forEach(el2=>{
    el2.onchange=()=>{
      const inp=inputs.find(x=>x.id===el2.dataset.inp);
      let val;
      if(el2.type==="checkbox") val=el2.checked;
      else if(inp&&inp.type==="integer") val=parseInt(el2.value,10);
      else if(inp&&inp.type==="float") val=parseFloat(el2.value);
      else val=el2.value;
      if(typeof val==="number"&&isNaN(val)) return;
      st.inputs=st.inputs||{}; st.inputs[el2.dataset.inp]=val;
      studies[i]=st; saveStudies(studies); renderIndChart();
    };
  });
  $("indDel").onclick=()=>{ studies.splice(i,1); saveStudies(studies); p.style.display="none"; renderIndChart(); };
  $("indDone").onclick=()=>{ p.style.display="none"; };
}
document.querySelectorAll("#dIv button").forEach(b=>b.onclick=()=>{ if(_chartSym) loadChart(_chartSym, b.textContent); });
  if(typeof window!=="undefined"){
    window.DT_I18N=DT_I18N; window.TP_I18N=TP_I18N; window.B_I18N=B_I18N; window.CA_I18N=CA_I18N; window.DKEYMAP=DKEYMAP; window.DKEYS=DKEYS; window.CMP_COLORS=CMP_COLORS; window.VOL_MA5_COL=VOL_MA5_COL; window.VOL_MA10_COL=VOL_MA10_COL; window.IND_PRICE_UNIT=IND_PRICE_UNIT;
    Object.defineProperty(window,"curSym",{get:function(){ return curSym; },set:function(v){ curSym=v; },configurable:true});
    Object.defineProperty(window,"_idxMode",{get:function(){ return _idxMode; },set:function(v){ _idxMode=v; },configurable:true});
    Object.defineProperty(window,"curIdx",{get:function(){ return curIdx; },set:function(v){ curIdx=v; },configurable:true});
    Object.defineProperty(window,"_lastQuote",{get:function(){ return _lastQuote; },set:function(v){ _lastQuote=v; },configurable:true});
    Object.defineProperty(window,"_lastFund",{get:function(){ return _lastFund; },set:function(v){ _lastFund=v; },configurable:true});
    Object.defineProperty(window,"_lastProfile",{get:function(){ return _lastProfile; },set:function(v){ _lastProfile=v; },configurable:true});
    Object.defineProperty(window,"WLSET",{get:function(){ return WLSET; },set:function(v){ WLSET=v; },configurable:true});
    window.__dtOpenSym=openSym; window.__dtOpenIndex=openIndex; window.__dtLoadWatchlist=loadWatchlist;
    window.loadDetail=loadDetail; window.loadChart=loadChart; window.loadIndexQuote=loadIndexQuote; window.renderDNav=renderDNav; window.renderQuote=renderQuote; window.renderFaPctGrid=renderFaPctGrid;
    window.dOpen=dOpen; window.dBack=dBack; window.dShow=dShow; window.wlRemove=wlRemove; window.paintWatchBtn=paintWatchBtn; window.BL=BL;
    window.__dtTest={open:openSym,openIndex:openIndex,load:loadDetail,chart:loadChart,quote:renderQuote,dShow:dShow,dOpen:dOpen,dBack:dBack,watchlist:loadWatchlist}; }
})();
}catch(e){}
// __DT_END__
