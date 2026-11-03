/* js/stocks/market.js — P5 module 11: v-market (view mac dinh) tach tu stocks.html, giu nguyen hanh vi. EAGER: nap cung trang qua <script src> (view mac dinh, goi loadMarket() cuoi module thay cho lenh top-level o core). */
// __MK_BEGIN__
try{
(function(){
// ---- Màn 1 ----
// i18n banner regime: backend tra CODE (TANG_NONG/TICH_LUY/GIAM/PHAN_PHOI) + desc
// tieng Viet lam fallback; frontend dich theo bang nay (chuoi dong nen translateDOM
// khong bat duoc — phai render rieng va render lai moi khi doi ngon ngu).
const REGIME_I18N = {
  TANG_NONG:{vi:["Tăng nóng","lan tỏa tốt, khối ngoại mua ròng"],en:["Overheating","broad-based gains, foreign net buying"],zh:["过热","普涨，外资净买入"],ko:["과열","광범위한 상승, 외국인 순매수"]},
  TICH_LUY:{vi:["Tích lũy","trên MA50, thị trường đang gom hàng"],en:["Accumulation","above MA50, market accumulating"],zh:["积累","在 MA50 上方，市场正在吸筹"],ko:["매집","MA50 위, 시장이 물량을 모으는 중"]},
  GIAM:{vi:["Giảm","dưới MA50, số mã giảm áp đảo"],en:["Downtrend","below MA50, decliners dominate"],zh:["下跌","在 MA50 下方，下跌股占优"],ko:["하락","MA50 아래, 하락 종목 우세"]},
  PHAN_PHOI:{vi:["Phân phối","giằng co, cần thận trọng"],en:["Distribution","choppy, stay cautious"],zh:["派发","震荡，谨慎操作"],ko:["분배","횡보 중, 신중히 대응"]}
};
const BREADTH_I18N = {vi:["tăng","giảm","trên","dưới"],en:["up","down","above","below"],zh:["涨","跌","上方","下方"],ko:["상승","하락","위","아래"]};
// i18n chi bao trang thai kenh day H1 (chu thuong, khong ten ky thuat).
const PUSH_I18N = {
  live:{vi:"Đang cập nhật theo giây",en:"Updating every second",zh:"每秒更新中",ko:"매초 업데이트 중"},
  poll:{vi:"Đang kéo lại theo phút",en:"Refreshing every minute",zh:"每分钟刷新中",ko:"매분 새로고침 중"},
  retry:{vi:"Mất kết nối, đang thử lại",en:"Connection lost, retrying",zh:"连接已断开，正在重试",ko:"연결이 끊겼습니다. 다시 시도 중입니다."},
  // Fix 03/11: lan dau ket noi (chua tung co duoc) khong phai "mat ket noi"
  // — banner "Mất kết nối" no ra tren MOI lan tai trang chi vi startPath
  // luon gan "retry". Lan 1 -> "connecting"; sau khi dut -> "retry" nhu cu.
  connecting:{vi:"Đang kết nối bảng giao dịch",en:"Connecting to live board",zh:"正在连接行情表",ko:"실시간 시세판에 연결 중"},
  // P1-4: hai trang thai tach ra — link song nhung khong co goc moi, va
  // duoc den tu khong phai cua phien hom nay.
  quiet:{vi:"Đang kết nối — thị trường yên ắng",en:"Connected — market quiet",zh:"已连接 — 市场平静",ko:"연결됨 — 시장이 조용합니다"},
  stale:{vi:"Số liệu cũ (không phải phiên hôm nay)",en:"Stale data (not today's session)",zh:"数据已过时（非今日交易时段）",ko:"오래된 데이터 (오늘 장이 아님)"},
  // Ingest dang nhan frame that nhung bang gia khong co the nao de ghi
  // (khong co dong nao) — bao thay "live", de user + chan doan biet rang
  // day la loi hien thi / du lieu, khong phai loi duong truyen.
  norender:{vi:"Đã nhận realtime — bảng giá chưa có dòng nào để hiển thị",en:"Realtime received — price table has no rows to render",zh:"已收到实时数据 — 价格表暂无可显示的行",ko:"실시간 수신 — 표시할 가격 행이 없습니다"}
};
let _regime = null;
function renderRegime(){
  if(!_regime) return;
  const j = _regime, b = j.breadth || {};
  const r = REGIME_I18N[j.regime];
  const pair = r ? (r[curLang] || r.vi) : null;
  const nm = pair ? pair[0] : j.regime;
  const ds = pair ? pair[1] : (j.desc || "");
  const w = BREADTH_I18N[curLang] || BREADTH_I18N.vi;
  $("regimeT").textContent = `${j.emoji || ""} ${nm} — ${ds}`;
  $("regimeD").textContent = `Breadth: ${b.up || 0} ${w[0]} / ${b.down || 0} ${w[1]} · VNINDEX ${j.above_ma50 ? w[2] : w[3]} MA50`;
}

/* poll-stale (hàng đợi #17d): gộp giá /screener vào SS_PX.
 * screener.json là snapshot EOD toàn thị trường; khi đường poll (reloadCurrentView
 * -> loadMarket) chạy giữa phiên, row của phiên trước vẫn giữ nguyên `close`
 * (worker applyStaleGate chỉ null hoá pct + gắn `stale:true`, không xoá close).
 * SS_PX là giá live do frame DO/Ably ghi (applyQMarket) — không để giá EOD stale
 * của poll đè lên giá live (đó là bug VCB=56.300 che mất giá burst). Chỉ ghi row
 * đúng phiên (không stale, close là số) → poll vẫn nạp được khi live im mà dữ
 * liệu tươi, mà không che giá live. */
function mergeScreenerPx(rows, sspx){
  if(!sspx || typeof sspx !== "object" || !Array.isArray(rows)) return sspx;
  for(const r of rows){
    if(!r || typeof r.symbol !== "string") continue;
    if(r.stale) continue;                        // giá ngoài phiên -> bo qua
    if(typeof r.close !== "number") continue;    // khong co gia so -> bo qua
    sspx[r.symbol] = { c: r.close, p: r.pct_change };
  }
  return sspx;
}

/* Gia live cua frame (DO/Ably) luu trong SS_PX — applyQMarket ghi, palette
 * doc, con bang "Tang manh nhat HOSE" thi KHONG doc: no in `r.close` /
 * `r.pct_change` tu payload /screener. Hai hau qua: (1) moi luot poll
 * (~30s) lay lag gia HTTP de lap gia live da in truoc do; (2) ngay screener
 * bi stale-gate (pct_change = null) thi bang rong hoan toan -> khong con
 * the nao de frame ghi vao, gia thi truong ding tren man du stream van chay
 * (do 03/11: 304 frame/90s, 1 mutation o #topMovers). */
function livePx(sym){
  const ss = (typeof window !== "undefined" && window.SS_PX) ? window.SS_PX : null;
  const e = ss ? ss[String(sym || "").toUpperCase()] : null;
  return (e && typeof e === "object") ? e : null;
}
function withLivePx(r){
  const e = livePx(r && r.symbol);
  if(!e) return r;
  const out = Object.assign({}, r);
  if(typeof e.c === "number") out.close = e.c;
  if(typeof e.p === "number") out.pct_change = e.p;
  return out;
}
/* Khi /screener khong con dong nao (pct_change null ca bang), dung chinh
 * danh sach ma stream da bao dong lam nguon cho bang — khong de "Chưa có
 * dữ liệu" trong khi gia live nam trong SS_PX. */
function moversFromLivePx(limit){
  const ss = (typeof window !== "undefined" && window.SS_PX) ? window.SS_PX : {};
  return Object.keys(ss).map(function(s){
    const e = ss[s] || {};
    return { symbol: s, close: e.c, pct_change: e.p, foreign_net_value: null };
  }).filter(function(r){ return typeof r.pct_change === "number"; })
    .sort(function(a, b){ return Math.abs(b.pct_change) - Math.abs(a.pct_change); })
    .slice(0, limit || 8);
}
function paintMovers(rows){
  const tb = $("topMovers");
  if(!tb) return 0;
  tb.innerHTML=(rows||[]).map(r=>{const pc=r.pct_change,cls=pc>0?"up":pc<0?"down":"";
    const ff=r.foreign_net_value,ffc=ff>0?"up":ff<0?"down":"";
    return `<tr><td><b onclick="openSym('${esc(r.symbol)}')" style="cursor:pointer">${esc(r.symbol)}</b></td><td>${fmtN(r.close)}</td><td class="${cls}">${fmtPct(pc)}</td><td class="${ffc}">${fmtTy(ff)}</td></tr>`;}).join("")||'<tr><td colspan="4"><div class="hint">Chưa có dữ liệu</div></td></tr>';
  return (rows||[]).length;
}
/* Frame song nap SS_PX trong khoang ~10s sau khi mo trang, con luot poll
 * /screener chay ngay luc mo thi gia van null (stale-gate) -> bang trong.
 * Goi lai tu module ingest de frame tim duoc cho in gia, thay vi trang in
 * "Chưa có dữ liệu" den het chu ky poll 60s. */
function refreshMoversFromLive(limit){
  const rows = moversFromLivePx(limit || 8);
  if(!rows.length) return 0;
  return paintMovers(rows);
}

/* CHỈ SỐ: frame `idx` (SS_IDX do module ingest ghi) là bản MỚI NHẤT; Doc
 * R2 /api/stock/indices phục vụ qua Cache-Control max-age=300 nên một lượt
 * poll 60s gần như luôn trả về bản cũ hơn. Trước khi có hàm này, poll
 * 60s VẼ LẠI giá cũ đè lên giá live vừa in — đo live 03/11: card
 * "VNINDEX 1.708,46" (frame 06:45:17Z) bị poll 06:45:48Z vẽ thành
 * "1.708,97" (doc R2 06:40:16Z), màn hình quay lui 0,51 điểm.
 * mergeIdxWithLive: chỉ nhận HTTP row khi nó MỚI HƠN frame (theo ts);
 * frame thắng thì giữ nguyên giá + % của frame. Không bịa số: SS_IDX
 * trống => trả nguyên bản rows HTTP. */
function mergeIdxWithLive(rows, docMs){
  var live = null;
  try{ live = (typeof SS_IDX === "object" && SS_IDX) ? SS_IDX : (typeof globalThis !== "undefined" ? globalThis.SS_IDX : null); }catch(e){ live = null; }
  if(!live) return rows || [];
  const out = (rows || []).map(r=>{
    const L = live[String(r.symbol||"").toUpperCase()];
    if(!L) return r;
    if(!(L.ts > (Number(docMs)||0))) return r;
    const merged = Object.assign({}, r);
    if(typeof L.p === "number") merged.close = L.p;
    if(typeof L.pc === "number"){ merged.pct_change = L.pc; merged.stale = false; }
    if(typeof L.p === "number" && typeof r.prev_close === "number") merged.change = +(L.p - r.prev_close).toFixed(2);
    return merged;
  });
  /* Mã chỉ số có trong frame nhưng chưa có trong doc HTTP (vd doc lan dau
   * trong phien la cua hom qua) -> bo qua, khong tu ve the moi. */
  return out;
}
/* ts cua ban doc R2: _prov.retrieved_at truoc, den updated; khong co => 0
 * (moi frame duoc coi la moi hon). */
function idxDocMs(j){
  const s = (j && j._prov && j._prov.retrieved_at) || (j && j.updated) || "";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

async function loadMarket(){
  try{
    const j=await api("/indices");const rows=mergeIdxWithLive(j.rows||[], idxDocMs(j));
    $("idxRow").innerHTML=rows.map(r=>{const pc=r.pct_change,cls=pc>0?"up":pc<0?"down":"";const fs=idxFileSym(r.symbol);
      return `<div class="idxcard"${fs?` style="cursor:pointer" onclick="openIndex('${fs}')" title="${esc(r.symbol)}"`:""}><div class="s">${esc(r.symbol)}</div><div class="p">${fmtN(r.close)}</div><div class="c ${cls}">${r.stale?'<span class="stale">— · số liệu cũ</span>':((pc>0?"▲":pc<0?"▼":"")+" "+fmtPct(pc))}</div></div>`;}).join("")||'<div class="hint">Chưa có dữ liệu</div>';
    if(j._prov){_lastMktSrc=j._prov.source;_lastMktAsOf=j._prov.retrieved_at||j.updated||null;_lastMktStale=!!j.stale;refreshSrc();}
  }catch(e){$("idxRow").innerHTML='<div class="hint">Lỗi tải chỉ số</div>';}
  try{
    const j=await api("/sector-indices");const rows=mergeIdxWithLive(j.rows||[], idxDocMs(j));
    $("idxSecRow").innerHTML=rows.map(r=>{const pc=r.pct_change,cls=pc>0?"up":pc<0?"down":"";
      return `<div class="idxcard" style="cursor:pointer" onclick="openIndex('${esc(r.symbol)}')" title="${esc(r.symbol)}"><div class="s">${esc(r.symbol)}</div><div class="p">${fmtN(r.close)}</div><div class="c ${cls}">${r.stale?'<span class="stale">— · số liệu cũ</span>':((pc>0?"▲":pc<0?"▼":"")+" "+fmtPct(pc))}</div></div>`;}).join("")||'<div class="hint">Chưa có dữ liệu</div>';
  }catch(e){$("idxSecRow").innerHTML='<div class="hint">Lỗi tải chỉ số</div>';}
  try{
    const j=await api("/regime");
    if(j.regime){const box=$("regimeBox");box.style.display="";
      if(j.regime==="PHAN_PHOI"||j.regime==="GIAM")box.classList.add("danger");
      else if(j.regime==="TANG_NONG")box.classList.add("warn");
      const b=j.breadth||{};
      _regime=j; renderRegime();}
  }catch(e){}
  try{
    const j=await api("/screener?sort=pct_change&order=desc&exchange=HOSE&min_value=1000000000");
    mergeScreenerPx(j.rows, window.SS_PX);
    let rows=(j.rows||[]).filter(r=>r.pct_change!=null||livePx(r.symbol)).map(withLivePx).slice(0,8);
    if(!rows.length) rows=moversFromLivePx(8);
    paintMovers(rows);
  }catch(e){$("topMovers").innerHTML='<tr><td colspan="4"><div class="hint">Lỗi tải</div></td></tr>';}
  loadFF();
  loadPF();
  loadMarketTotals();
  loadMarketOverview();
  loadMacro();
  try{ if(typeof window.loadFinhay==="function") window.loadFinhay(); }catch(e){}
  loadMN();
  loadCA();
}

// ---- Khoi ngoai hom nay (GET /foreign-flow): du lieu publish gom 30 ma
// thanh khoan cao nhat -> tong ghi dung pham vi nay, khong goi la toan
// thi truong. Top 5 mua rong / ban rong theo gia tri rong (mua - ban).
// ---- Lich quyen (Phuong an B, Chot 10:33 29/10): render tu file
// versioned, khong Telegram. Hien su kien GDKHQ trong 30 ngay toi.
const CAL_I18N={
vi:{title:"Lịch quyền",sym:"Mã",kind:"Loại",ex:"GDKHQ",rec:"Đăng ký",stock:"Cổ tức CP {pct}%",cash:"Tiền mặt {amt} đ/cp",split:"Chia tách ×{f}",empty:"Chưa có sự kiện quyền trong 30 ngày tới",note:"{n} sự kiện · cập nhật {upd}",more:"và {n} sự kiện nữa"},
en:{title:"Corporate actions",sym:"Symbol",kind:"Type",ex:"Ex-date",rec:"Record",stock:"Stock dividend {pct}%",cash:"Cash {amt} VND/share",split:"Split ×{f}",empty:"No corporate actions in the next 30 days",note:"{n} events · updated {upd}",more:"and {n} more events"},
zh:{title:"股权登记日历",sym:"代码",kind:"类型",ex:"除权日",rec:"登记日",stock:"股票股息 {pct}%",cash:"现金每股 {amt} 越南盾",split:"拆股 ×{f}",empty:"未来30天暂无股权事件",note:"{n} 个事件 · 更新于 {upd}",more:"还有 {n} 个事件"},
ko:{title:"권리 일정",sym:"종목",kind:"유형",ex:"권리락일",rec:"기준일",stock:"주식 배당 {pct}%",cash:"현금 주당 {amt} VND",split:"액면분할 ×{f}",empty:"향후 30일간 권리 이벤트 없음",note:"{n}건 · 업데이트 {upd}",more:"{n}건 더 보기"}};
let _caData=null;
async function loadCA(){
  try{ _caData=await api("/corporate-actions"); renderCA(_caData); }
  catch(e){ const c=$("caCard"); if(c) c.innerHTML='<div class="hint">Lỗi tải lịch quyền</div>'; }
}
function renderCA(j){
  const card=$("caCard"); if(!card) return;
  const L=CAL_I18N[curLang]||CAL_I18N.vi;
  const sec=$("caSec"); if(sec) sec.textContent=L.title;
  const acts=(j&&j.actions)||[];
  const today=new Date(Date.now()+7*3600e3).toISOString().slice(0,10);
  const horizon=new Date(Date.now()+7*3600e3+30*86400e3).toISOString().slice(0,10);
  const rows=acts.filter(a=>a.ex_date>=today&&a.ex_date<=horizon)
    .sort((a,b)=>a.ex_date<b.ex_date?-1:a.ex_date>b.ex_date?1:(a.symbol<b.symbol?-1:1));
  if(!rows.length){ card.innerHTML=`<div class="hint">${esc(L.empty)}</div>`; return; }
  const dFmt=s=>{ const p=String(s||"").slice(0,10).split("-"); return p.length===3?p[2]+"/"+p[1]+"/"+p[0]:"—"; };
  const kindTxt=a=>{
    if(a.kind==="stock_dividend") return L.stock.replace("{pct}",String(Math.round(((a.factor||1)-1)*100)));
    if(a.kind==="cash_dividend") return L.cash.replace("{amt}",fmtN(a.cash||0));
    if(a.kind==="split") return L.split.replace("{f}",String(a.factor||""));
    return a.kind||"";
  };
  const shown=rows.slice(0,20);
  let h=`<table><tr><th>${esc(L.sym)}</th><th>${esc(L.kind)}</th><th>${esc(L.ex)}</th><th>${esc(L.rec)}</th></tr><tbody>`;
  h+=shown.map(a=>`<tr><td><b onclick="openSym('${esc(a.symbol)}')" style="cursor:pointer">${esc(a.symbol)}</b></td><td>${esc(kindTxt(a))}</td><td>${dFmt(a.ex_date)}</td><td>${dFmt(a.record_date)}</td></tr>`).join("");
  h+=`</tbody></table>`;
  const upd=j.updated_at?String(j.updated_at).slice(0,10):"";
  h+=`<div class="hint" style="margin-top:6px">${esc(L.note.replace("{n}",String(rows.length)).replace("{upd}",upd))}`;
  if(rows.length>shown.length) h+=` · ${esc(L.more.replace("{n}",String(rows.length-shown.length)))}`;
  h+=`</div>`;
  card.innerHTML=h;
}
const FF_I18N={
  vi:{net:"Ròng 30 mã thanh khoản nhất",buy:"Mua",sell:"Bán",topBuy:"Mua ròng mạnh nhất",topSell:"Bán ròng mạnh nhất",empty:"Chưa có dữ liệu phiên này",ty:"tỷ",tr:"triệu"},
  en:{net:"Net · 30 most liquid stocks",buy:"Buy",sell:"Sell",topBuy:"Top net buys",topSell:"Top net sells",empty:"No data for this session yet",ty:"B",tr:"M"},
  zh:{net:"净额 · 30只最活跃股票",buy:"买入",sell:"卖出",topBuy:"净买入前五",topSell:"净卖出前五",empty:"本时段暂无数据",ty:"十亿",tr:"百万"},
  ko:{net:"순매수 · 유동성 상위 30종목",buy:"매수",sell:"매도",topBuy:"순매수 상위",topSell:"순매도 상위",empty:"이번 세션 데이터 없음",ty:"십억",tr:"백만"},
};
function fmtTyF(v,L,signed){
  if(v==null||!isFinite(Number(v))) return "—";
  v=Number(v);
  const a=Math.abs(v), s=v<0?"−":(signed?"+":"");
  if(a>=1e9) return s+(a/1e9).toFixed(1).replace(".",",")+" "+L.ty;
  if(a>=1e6) return s+Math.round(a/1e6)+" "+L.tr;
  return s+Math.round(a).toLocaleString("vi-VN")+" đ";
}
async function loadFF(){
  try{ renderFF(await api("/foreign-flow")); }
  catch(e){ /* giu nguyen khung, khong lam hong man thi truong */ }
}
function renderFF(j){
  const card=$("ffCard"); if(!card) return;
  const L=FF_I18N[curLang]||FF_I18N.vi;
  const by=(j&&j.by_symbol)||{};
  const rows=Object.keys(by).map(s=>{const d=by[s]||{};const bv=d.buy_value||0,sv=d.sell_value||0;return{s,bv,sv,net:bv-sv};});
  if(!rows.length){ card.innerHTML=`<div class="hint">${L.empty}</div>`; return; }
  const tot=rows.reduce((a,r)=>({bv:a.bv+r.bv,sv:a.sv+r.sv,net:a.net+r.net}),{bv:0,sv:0,net:0});
  const cls=tot.net>0?"up":tot.net<0?"down":"";
  const list=(arr)=>arr.map(r=>`<tr><td><a href="#" onclick="openSym('${r.s}');return false"><b>${r.s}</b></a></td><td class="${r.net>0?"up":"down"}" style="text-align:right">${fmtTyF(r.net,L,true)}</td></tr>`).join("");
  const buy=rows.filter(r=>r.net>0).sort((a,b)=>b.net-a.net).slice(0,5);
  const sell=rows.filter(r=>r.net<0).sort((a,b)=>a.net-b.net).slice(0,5);
  card.innerHTML=
    `<div style="display:flex;justify-content:space-between;padding:2px 0 8px"><span>${L.net}</span><b class="${cls}">${fmtTyF(tot.net,L,true)}</b></div>`+
    `<div class="hint" style="padding-bottom:8px">${L.buy}: ${fmtTyF(tot.bv,L,false)} · ${L.sell}: ${fmtTyF(tot.sv,L,false)}</div>`+
    (buy.length?`<div class="hint" style="padding:4px 0">${L.topBuy}</div><table>${list(buy)}</table>`:"")+
    (sell.length?`<div class="hint" style="padding:8px 0 4px">${L.topSell}</div><table>${list(sell)}</table>`:"");
}
// ---- Tu doanh hom nay (GET /proprietary-flow): cung khuon the Khoi
// ngoai, truong gia tri *_value_vnd; pham vi = cac ma co giao dich
// tu doanh trong phien (dem dong tai cho, khong tu nhan toan thi
// truong neu thieu).
const PF_I18N={
  vi:{net:"Ròng",syms:"mã có giao dịch",buy:"Mua",sell:"Bán",topBuy:"Mua ròng mạnh nhất",topSell:"Bán ròng mạnh nhất",empty:"Chưa có dữ liệu phiên này"},
  en:{net:"Net",syms:"symbols traded",buy:"Buy",sell:"Sell",topBuy:"Top net buys",topSell:"Top net sells",empty:"No data for this session yet"},
  zh:{net:"净额",syms:"只有交易的股票",buy:"买入",sell:"卖出",topBuy:"净买入前五",topSell:"净卖出前五",empty:"本时段暂无数据"},
  ko:{net:"순매수",syms:"거래 종목",buy:"매수",sell:"매도",topBuy:"순매수 상위",topSell:"순매도 상위",empty:"이번 세션 데이터 없음"},
};
async function loadPF(){
  try{ renderPF(await api("/proprietary-flow")); }
  catch(e){ /* giu nguyen khung */ }
}
function renderPF(j){
  const card=$("pfCard"); if(!card) return;
  const L=PF_I18N[curLang]||PF_I18N.vi;
  const F=FF_I18N[curLang]||FF_I18N.vi;
  const by=(j&&j.by_symbol)||{};
  const rows=Object.keys(by).map(s=>{const d=by[s]||{};const bv=d.buy_value_vnd||0,sv=d.sell_value_vnd||0;return{s,bv,sv,net:bv-sv};});
  if(!rows.length){ card.innerHTML=`<div class="hint">${L.empty}</div>`; return; }
  const tot=rows.reduce((a,r)=>({bv:a.bv+r.bv,sv:a.sv+r.sv,net:a.net+r.net}),{bv:0,sv:0,net:0});
  const cls=tot.net>0?"up":tot.net<0?"down":"";
  const list=(arr)=>arr.map(r=>`<tr><td><a href="#" onclick="openSym('${r.s}');return false"><b>${r.s}</b></a></td><td class="${r.net>0?"up":"down"}" style="text-align:right">${fmtTyF(r.net,F,true)}</td></tr>`).join("");
  const buy=rows.filter(r=>r.net>0).sort((a,b)=>b.net-a.net).slice(0,5);
  const sell=rows.filter(r=>r.net<0).sort((a,b)=>a.net-b.net).slice(0,5);
  card.innerHTML=
    `<div style="display:flex;justify-content:space-between;padding:2px 0 8px"><span>${L.net} · ${rows.length} ${L.syms}</span><b class="${cls}">${fmtTyF(tot.net,F,true)}</b></div>`+
    `<div class="hint" style="padding-bottom:8px">${L.buy}: ${fmtTyF(tot.bv,F,false)} · ${L.sell}: ${fmtTyF(tot.sv,F,false)}</div>`+
    (buy.length?`<div class="hint" style="padding:4px 0">${L.topBuy}</div><table>${list(buy)}</table>`:"")+
    (sell.length?`<div class="hint" style="padding:8px 0 4px">${L.topSell}</div><table>${list(sell)}</table>`:"");
}
// ---- Tin thi truong (GET /news/market) ----
async function loadMN(){
  try{ renderMN(await api("/news/market")); }
  catch(e){ /* giu nguyen khung */ }
}
function renderMN(j){
  const card=$("mnCard"); if(!card) return;
  const items=(j&&j.items)||[];
  if(!items.length){ card.innerHTML='<div class="hint">Chưa có tin</div>'; return; }
  card.innerHTML=items.slice(0,10).map(n=>`<div style="padding:8px 0;border-bottom:1px solid var(--pp-line)"><a href="${esc(n.url||"#")}" target="_blank" rel="noopener" style="display:flex;flex-direction:column;justify-content:center;min-height:44px;color:var(--pp-ink);text-decoration:none;font-size:14px;font-weight:600">${esc(n.title||"")}<div style="font-size:12px;color:var(--pp-mut);margin-top:2px;font-weight:400">${n.symbol?esc(n.symbol)+" · ":""}${esc((n.publish_time||"").slice(0,10))}</div></a></div>`).join("");
}
// ---- Tong thi truong chuan HSX (Chot 22:23 27/10): the "Tong toan
// thi truong — HSX, khop lenh" — tong GOP khop lenh toan san theo
// phien, KHONG lan voi rong ngoai + tu doanh trong AI Chat.
const MT_I18N={
  vi:{title:"Tổng toàn thị trường — HSX, khớp lệnh",vol:"Tổng khối lượng",val:"Tổng giá trị",stocks:"Cổ phiếu",warrant:"Chứng quyền có bảo đảm",etf:"ETF / Chứng chỉ quỹ",session:"Phiên",src:"Nguồn",captured:"Lấy số",basis:"Khớp lệnh thuần, không gồm thỏa thuận",empty:"Chưa có số liệu tổng thị trường",volUnit:"CP",valUnit:"tỷ ₫"},
  en:{title:"Whole-market total — HSX, matched trades",vol:"Total volume",val:"Total value",stocks:"Stocks",warrant:"Covered warrants",etf:"ETF / Fund certificates",session:"Session",src:"Source",captured:"Captured",basis:"Matched trades only, excluding negotiated deals",empty:"No whole-market totals yet",volUnit:"shares",valUnit:"VND bn"},
  zh:{title:"全市场总计 — HSX，撮合交易",vol:"总成交量",val:"总成交额",stocks:"股票",warrant:"备兑权证",etf:"ETF / 基金份额",session:"交易日",src:"来源",captured:"采集于",basis:"仅撮合成交，不含协议交易",empty:"暂无全市场总计数据",volUnit:"股",valUnit:"十亿₫"},
  ko:{title:"시장 전체 합계 — HSX, 체결 거래",vol:"총 거래량",val:"총 거래대금",stocks:"주식",warrant:"커버드 워런트",etf:"ETF / 펀드 증서",session:"거래일",src:"출처",captured:"수집 시각",basis:"체결 거래만, 협의 거래 제외",empty:"시장 전체 합계 데이터 없음",volUnit:"주",valUnit:"십억₫"},
};
let _mtData=null;
async function loadMarketTotals(){
  try{ _mtData=await api("/market-totals"); }
  catch(e){ _mtData=null; }
  renderMarketTotals();
}
function renderMarketTotals(){
  const w=$("mtWrap"); if(!w) return;
  const L=MT_I18N[curLang]||MT_I18N.vi, d=_mtData||{};
  const dash='<span style="color:var(--pp-mut)">—</span>';
  const grp=v=>v==null?null:Number(v).toLocaleString(curLang==="vi"?"vi-VN":"en-US");
  const fmtVol=v=>v==null?dash:grp(v)+" "+L.volUnit;
  const fmtVal=v=>{ if(v==null) return dash;
    const s=(Number(v)/1e9).toLocaleString(curLang==="vi"?"vi-VN":"en-US",{minimumFractionDigits:1,maximumFractionDigits:1});
    return s+" "+L.valUnit; };
  const fDate=s=>{ if(!s) return ""; const p=String(s).split("-"); return p.length===3?p[2]+"/"+p[1]+"/"+p[0]:String(s); };
  const fTime=s=>{ if(!s) return ""; return String(s).slice(11,16)+" "+fDate(String(s).slice(0,10)); };
  const bk=(d&&d.breakdown)||{};
  const row=(lbl,r)=>{ const v=r?r.total_volume_shares:null, val=r?r.total_value_vnd:null;
    return `<tr><td>${lbl}</td><td style="text-align:right">${fmtVol(v)}</td><td style="text-align:right">${fmtVal(val)}</td></tr>`; };
  const ok=d&&d.available;
  w.innerHTML=`<div class="sec">${L.title}</div><div class="card" style="padding:12px">`
    +`<div style="display:flex;gap:18px;flex-wrap:wrap"><div><div class="hint">${L.vol}</div><div style="font-size:20px;font-weight:700">${ok?fmtVol(d.total_volume):dash}</div></div>`
    +`<div><div class="hint">${L.val}</div><div style="font-size:20px;font-weight:700">${ok?fmtVal(d.total_value):dash}</div></div></div>`
    +`<table style="width:100%;margin-top:10px"><tbody>${row(L.stocks,bk.stock_other)}${row(L.warrant,bk.covered_warrant)}${row(L.etf,bk.etf_fund)}</tbody></table>`
    +(ok?`<div class="mcsrc" style="margin-top:8px">${L.session} ${fDate(d.date)} · ${L.src}: ${esc(d.source||"HSX")} · ${L.captured}: ${fTime(d.retrieved_at)}</div><div class="hint" style="margin-top:4px">${L.basis}</div>`:`<div class="hint" style="margin-top:8px">${L.empty}</div>`)
    +`</div>`;
}

// ---- Tong quan thi truong 2 phan (Chot 11:12 28/10) ----
// Phan A: phien hom qua da chot (file EOD san co). Phan B: phien dang
// chay, live — poll 60 giay, chi phan B. Do rong/TRIN dung CUNG cong
// thuc the chat (mcp analyze_market): TRIN=(Adv/Dec)/(AdvVol/DecVol),
// mau so la KHOI LUONG co phieu. Phan A tinh tai client tu screener
// EOD; phan B doc file live_overview do realtime_poller ghi (moi 5
// phut, tu bang KBS toan thi truong). Thieu so thi "—", khong chan view.
// Q4 (dinh chinh 11:17: tuy noi dung tong hop, khong co dinh): header
// luon hien 1 dong tom tat; mac dinh MO khi du kien live tuoi (<10
// phut), DONG khi chi con so da chot; nguoi dung bam doi thi lua chon
// do thang mac dinh trong phien.
const MOV_I18N={
  vi:{title:"Tổng quan thị trường",partA:"Phiên đã chốt",partB:"Phiên đang chạy",closed:"Đã chốt",live:"Đang chạy",updated:"Cập nhật",dataAsOf:"Dữ kiện",regime:"Trạng thái thị trường",ma50:"VNINDEX so với MA50",above:"trên",below:"dưới",breadth:"Độ rộng theo sàn",trin:"TRIN",divergence:"Phân kỳ CW−EW",leadLag:"Ngành dẫn dắt − lùi sau",sectorsUp:"ngành tăng",foreignNet:"Ròng khối ngoại",propNet:"Ròng tự doanh",propNote:"Trong phiên chưa có số tự doanh (PDF HOSE ~16:00, về phần A hôm sau)",totals:"Tổng toàn thị trường",vol:"Khối lượng",val:"Giá trị",indices:"Chỉ số",adv:"tăng",dec:"giảm",flat:"đứng giá",turnover:"Giá trị giao dịch",ty:"tỷ",tr:"triệu",syms:"mã",loading:"Đang tải…",noLive:"Chưa có dữ kiện live",lead:"Dẫn dắt",lag:"Lùi sau",session:"Phiên"},
  en:{title:"Market overview",partA:"Settled session",partB:"Live session",closed:"Settled",live:"Live",updated:"Updated",dataAsOf:"Data as of",regime:"Market regime",ma50:"VNINDEX vs MA50",above:"above",below:"below",breadth:"Breadth by exchange",trin:"TRIN",divergence:"CW−EW divergence",leadLag:"Leading − lagging sectors",sectorsUp:"sectors up",foreignNet:"Foreign net",propNet:"Proprietary net",propNote:"No proprietary data intraday (HOSE PDF ~16:00, lands in part A tomorrow)",totals:"Whole-market total",vol:"Volume",val:"Value",indices:"Indices",adv:"up",dec:"down",flat:"flat",turnover:"Turnover",ty:"B",tr:"M",syms:"symbols",loading:"Loading…",noLive:"No live data yet",lead:"Leading",lag:"Lagging",session:"Session"},
  zh:{title:"市场总览",partA:"已收盘交易日",partB:"进行中交易日",closed:"已收盘",live:"进行中",updated:"更新于",dataAsOf:"数据截至",regime:"市场状态",ma50:"VNINDEX 与 MA50",above:"上方",below:"下方",breadth:"分市场涨跌",trin:"TRIN",divergence:"市值加权−等权背离",leadLag:"领涨 − 落后行业",sectorsUp:"个行业上涨",foreignNet:"外资净额",propNet:"自营净额",propNote:"盘中暂无自营数据（HOSE PDF 约16:00，明日计入A部分）",totals:"全市场总计",vol:"成交量",val:"成交额",indices:"指数",adv:"涨",dec:"跌",flat:"平",turnover:"成交额",ty:"十亿",tr:"百万",syms:"只",loading:"加载中…",noLive:"暂无实时数据",lead:"领涨",lag:"落后",session:"交易日"},
  ko:{title:"시장 개요",partA:"마감 세션",partB:"진행 중 세션",closed:"마감",live:"진행 중",updated:"업데이트",dataAsOf:"데이터 기준",regime:"시장 상태",ma50:"VNINDEX 대 MA50",above:"위",below:"아래",breadth:"거래소별 등락",trin:"TRIN",divergence:"시가총액−동일가중 괴리",leadLag:"선도 − 부진 업종",sectorsUp:"개 업종 상승",foreignNet:"외국인 순매수",propNet:"자기매매 순매수",propNote:"장중에는 자기매매 데이터 없음(HOSE PDF ~16:00, 다음 날 A에 반영)",totals:"시장 전체 합계",vol:"거래량",val:"거래대금",indices:"지수",adv:"상승",dec:"하락",flat:"보합",turnover:"거래대금",ty:"십억",tr:"백만",syms:"종목",loading:"불러오는 중…",noLive:"실시간 데이터 없음",lead:"선도",lag:"부진",session:"세션"},
};
let _movA=null, _movB=null, _movOpen=null, _movTimer=null;
function movFmtDT(iso){
  if(!iso) return {d:"",t:""};
  const dt=new Date(iso); if(isNaN(dt)) return {d:"",t:""};
  const p=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Ho_Chi_Minh",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(dt);
  const g=k=>{ const x=p.find(y=>y.type===k); return x?x.value:""; };
  return {d:g("day")+"/"+g("month")+"/"+g("year"), t:g("hour")+":"+g("minute")};
}
function movICTDate(iso){
  if(!iso) return "";
  const dt=new Date(iso); if(isNaN(dt)) return "";
  return dt.toLocaleDateString("en-CA",{timeZone:"Asia/Ho_Chi_Minh"});
}
function movFDate(s){ if(!s) return ""; const p=String(s).split("-"); return p.length===3?p[2]+"/"+p[1]+"/"+p[0]:String(s); }
function movDec(v,dp){
  if(v==null||!isFinite(Number(v))) return "—";
  return Number(v).toLocaleString(curLang==="vi"?"vi-VN":"en-US",{minimumFractionDigits:dp,maximumFractionDigits:dp});
}
function movBreadth(rows){
  const byEx={}; let advN=0,decN=0,uncN=0,advV=0,decV=0,turn=0;
  for(const r of rows||[]){
    const ex=String(r.exchange||"").toUpperCase()||"UNKNOWN";
    if(!byEx[ex]) byEx[ex]={advancers:0,decliners:0,unchanged:0};
    const pc=parseFloat(r.pct_change);
    if(!isNaN(pc)){ if(pc>0){byEx[ex].advancers++;advN++;} else if(pc<0){byEx[ex].decliners++;decN++;} else {byEx[ex].unchanged++;uncN++;} }
    const vol=parseFloat(r.volume)||0;
    if(!isNaN(pc)&&pc>0) advV+=vol;
    if(!isNaN(pc)&&pc<0) decV+=vol;
    turn+=parseFloat(r.value_vnd)||0;
  }
  const trin=(advN&&decN&&decV)?Number((((advN/decN)/(advV/decV))).toFixed(4)):null;
  return {by_exchange:byEx,advancers:advN,decliners:decN,unchanged:uncN,trin,turnover_total:Math.round(turn)};
}
function movFlowTotal(doc,buyKey,sellKey){
  const by=(doc&&doc.by_symbol)||{}; let net=0;
  for(const s of Object.keys(by)){ const d=by[s]||{}; net+=(Number(d[buyKey])||0)-(Number(d[sellKey])||0); }
  return {net,n:Object.keys(by).length};
}
function movDocDate(doc){
  if(!doc) return "";
  const p=doc._prov||{};
  return movICTDate(p.fetched_at||p.retrieved_at||doc.updated||"");
}
function movSecName(code){
  const row=(window.PAL_SECTORS||[]).find(r=>r[0]===String(code));
  return row?row[1]:String(code||"");
}
function movLiveFresh(){
  const lv=_movB&&_movB.live;
  if(!lv||!lv.retrieved_at) return false;
  const t=new Date(lv.retrieved_at).getTime();
  return isFinite(t)&&(Date.now()-t)<10*60*1000;
}
function movBuildA(g){
  const scr=g.screener||{};
  const rows=scr.rows||[];
  const br=movBreadth(rows);
  const sess=(g.divergence&&g.divergence.sessions)||[];
  const dv=sess.length?sess[sess.length-1]:null;
  const sessionDate=movICTDate((scr._prov||{}).retrieved_at||scr.updated||"")||(dv?dv.date:"");
  const ff=movFlowTotal(g.foreign,"buy_value","sell_value");
  const pf=movFlowTotal(g.prop,"buy_value_vnd","sell_value_vnd");
  const ffDate=movDocDate(g.foreign), pfDate=movDocDate(g.prop);
  return {
    regime:g.regime||null, breadth:br, divergence:dv,
    divUpdated:(g.divergence&&g.divergence.updated)||"",
    sessionDate, asOf:movFmtDT((scr._prov||{}).retrieved_at||scr.updated||""),
    foreign:(ffDate&&ffDate===sessionDate)?ff:null, foreignDate:ffDate,
    prop:(pfDate&&pfDate===sessionDate)?pf:null, propDate:pfDate,
    totals:g.totals||null,
  };
}
function movBuildB(g){
  const rows=g.indices&&g.indices.rows?g.indices.rows:[];
  const want={VNINDEX:"VNINDEX",VN30:"VN30",HNXIndex:"HNX",UPCOMIndex:"UPCOM"};
  const idx=Object.keys(want).map(sym=>{ const r=rows.find(x=>x.symbol===sym)||null;
    return {sym, label:want[sym], close:r?r.close:null, pct:r?r.pct_change:null}; });
  const live=(g.live&&g.live.by_exchange)?g.live:null;
  const ff=movFlowTotal(g.foreign,"buy_value","sell_value");
  const sess=(g.divergence&&g.divergence.sessions)||[];
  const dv=sess.length?sess[sess.length-1]:null;
  return {
    indices:idx, idxAsOf:movFmtDT((g.indices&&g.indices._prov&&g.indices._prov.retrieved_at)||(g.indices&&g.indices.updated)||""),
    live, liveAsOf:movFmtDT(live?live.retrieved_at:""),
    foreign:ff, foreignAsOf:movFmtDT((g.foreign&&g.foreign._prov&&g.foreign._prov.fetched_at)||(g.foreign&&g.foreign.updated)||""),
    divergence:dv, divAsOf:movFmtDT((g.divergence&&g.divergence.updated)||""),
  };
}
function movRow(k,v,sub){
  return `<div class="movRow"><span class="k">${k}</span><span class="v">${v}${sub?`<div class="movSub">${sub}</div>`:""}</span></div>`;
}
function movBreadthTxt(L,br){
  if(!br) return "—";
  const parts=Object.keys(br.by_exchange||{}).sort().map(ex=>{
    const b=br.by_exchange[ex];
    return `${ex} ${fmtN(b.advancers)}/${fmtN(b.decliners)}`;
  });
  return parts.length?parts.join(" · "):"—";
}
function movDivTxt(L,dv){
  if(!dv||dv.cw_ew_spread_pp==null) return "—";
  const sp=Number(dv.cw_ew_spread_pp), cls=sp>=0?"up":"down";
  let h=`<span class="${cls}"><b>${sp>0?"+":""}${movDec(sp,2)} pp</b></span> · EW ${dv.ew_pct!=null?movDec(dv.ew_pct,2)+"%":"—"} · ${dv.pct_advancers!=null?movDec(dv.pct_advancers,1)+"% "+esc(L.adv):"—"}`;
  return h;
}
function movLeadTxt(L,dv){
  if(!dv||dv.leader_laggard_spread_pp==null) return "—";
  const top=dv.top_sector||null, bot=dv.bottom_sector||null;
  const tn=top?`${esc(movSecName(top.code))} ${top.ret_pct!=null?movDec(top.ret_pct,2)+"%":""}`:"—";
  const bn=bot?`${esc(movSecName(bot.code))} ${bot.ret_pct!=null?movDec(bot.ret_pct,2)+"%":""}`:"—";
  return `${movDec(dv.leader_laggard_spread_pp,2)} pp · ${fmtN(dv.sectors_up||0)}/${fmtN(dv.sectors_total||0)} ${esc(L.sectorsUp)}<div class="movSub">${esc(L.lead)}: ${tn} · ${esc(L.lag)}: ${bn}</div>`;
}
function movSummary(L){
  const fresh=movLiveFresh();
  const br=fresh?(_movB.live):(_movA?_movA.breadth:null);
  const trin=br?br.trin:null;
  let pct=null;
  if(fresh&&_movB.indices){ const v=_movB.indices.find(x=>x.sym==="VNINDEX"); pct=v?v.pct:null; }
  if(pct==null&&_movA&&_movA.divergence) pct=_movA.divergence.index_pct;
  const rg=_movA&&_movA.regime?_movA.regime:null;
  const rnm=rg?(REGIME_I18N[rg.regime]?((REGIME_I18N[rg.regime][curLang]||REGIME_I18N[rg.regime].vi)[0]):rg.regime):"";
  const bits=[];
  if(rnm) bits.push(esc(rnm));
  bits.push(`VNINDEX ${pct!=null?fmtPct(pct):"—"}`);
  if(br) bits.push(`${fmtN(br.advancers)} ${esc(L.adv)}/${fmtN(br.decliners)} ${esc(L.dec)}`);
  bits.push(`TRIN ${trin!=null?movDec(trin,2):"—"}`);
  return bits.join(" · ");
}
function renderMarketOverview(){
  const w=$("movWrap"); if(!w) return;
  const L=MOV_I18N[curLang]||MOV_I18N.vi;
  if(!_movA&&!_movB){ w.innerHTML=`<div class="hint">${esc(L.loading)}</div>`; return; }
  const dash='<span style="color:var(--pp-mut)">—</span>';
  const A=_movA||{}, B=_movB||{};
  const open=_movOpen!=null?_movOpen:movLiveFresh();
  const rg=A.regime||null;
  const rnm=rg?(REGIME_I18N[rg.regime]?((REGIME_I18N[rg.regime][curLang]||REGIME_I18N[rg.regime].vi)[0]):rg.regime):null;
  const rds=rg?(REGIME_I18N[rg.regime]?((REGIME_I18N[rg.regime][curLang]||REGIME_I18N[rg.regime].vi)[1]):(rg.desc||"")):"";
  const maTxt=(rg&&rg.vnindex_close!=null&&rg.vnindex_ma50!=null)
    ?`${fmtN(rg.vnindex_close)} / MA50 ${fmtN(rg.vnindex_ma50)} · ${rg.above_ma50?esc(L.above):esc(L.below)}`
    :(rg?`${rg.above_ma50?esc(L.above):esc(L.below)} MA50`:dash);
  const tot=A.totals||{};
  const totOk=tot&&tot.available;
  const bk=(tot&&tot.breakdown)||{};
  const totTxt=totOk?`${esc(L.vol)} ${fmtN(tot.total_volume)} · ${esc(L.val)} ${fmtTyF(tot.total_value,L,false)}`:dash;
  const aRows=[
    movRow(esc(L.regime), rnm?`${esc(rg.emoji||"")} <b>${esc(rnm)}</b> — ${esc(rds)}`:dash),
    movRow(esc(L.ma50), maTxt),
    movRow(esc(L.breadth), esc(movBreadthTxt(L,A.breadth))),
    movRow(esc(L.trin), A.breadth&&A.breadth.trin!=null?`<b>${movDec(A.breadth.trin,2)}</b>`:dash, A.breadth?`${esc(L.turnover)}: ${fmtTyF(A.breadth.turnover_total,L,false)}`:""),
    movRow(esc(L.divergence), movDivTxt(L,A.divergence)),
    movRow(esc(L.leadLag), movLeadTxt(L,A.divergence)),
    movRow(esc(L.foreignNet), A.foreign?`<b class="${A.foreign.net>0?"up":A.foreign.net<0?"down":""}">${fmtTyF(A.foreign.net,L,true)}</b>`:dash, A.foreignDate?movFDate(A.foreignDate):""),
    movRow(esc(L.propNet), A.prop?`<b class="${A.prop.net>0?"up":A.prop.net<0?"down":""}">${fmtTyF(A.prop.net,L,true)}</b>`:dash, A.propDate?movFDate(A.propDate):""),
    movRow(esc(L.totals), totTxt, totOk?movFDate(tot.date):""),
  ].join("");
  const idxRows=(B.indices||[]).map(r=>{
    const pc=r.pct, cls=pc>0?"up":pc<0?"down":"";
    return `<div class="movRow"><span class="k">${esc(r.label)}</span><span class="v"><b>${r.close!=null?fmtN(r.close):"—"}</b> <span class="${cls}">${pc!=null?fmtPct(pc):"—"}</span></span></div>`;
  }).join("")||`<div class="hint">${esc(L.noLive)}</div>`;
  const lv=B.live||null;
  const bRows=[
    `<div class="movRow"><span class="k">${esc(L.indices)}</span><span class="v">${B.idxAsOf&&B.idxAsOf.t?esc(B.idxAsOf.t):"—"}</span></div>`,
    idxRows,
    movRow(esc(L.breadth), lv?esc(movBreadthTxt(L,lv)):dash, lv?`${fmtN(lv.n_symbols||0)} ${esc(L.syms)}`:""),
    movRow(esc(L.trin), lv&&lv.trin!=null?`<b>${movDec(lv.trin,2)}</b>`:dash, lv?`${esc(L.turnover)}: ${fmtTyF(lv.turnover_total,L,false)}`:""),
    movRow(esc(L.foreignNet), B.foreign?`<b class="${B.foreign.net>0?"up":B.foreign.net<0?"down":""}">${fmtTyF(B.foreign.net,L,true)}</b>`:dash, B.foreignAsOf&&B.foreignAsOf.t?esc(B.foreignAsOf.t):""),
    movRow(esc(L.divergence), movDivTxt(L,B.divergence), B.divAsOf&&B.divAsOf.t?`${esc(L.dataAsOf)} ${esc(B.divAsOf.t)} ${esc(B.divAsOf.d)}`:""),
    movRow(esc(L.leadLag), movLeadTxt(L,B.divergence)),
    movRow(esc(L.propNet), dash, esc(L.propNote)),
  ].join("");
  const aHead=`${esc(L.partA)} · ${A.sessionDate?movFDate(A.sessionDate):"—"}${A.asOf&&A.asOf.t?` · ${esc(L.dataAsOf)} ${esc(A.asOf.t)}`:""}`;
  const bHead=`${esc(L.partB)}${B.liveAsOf&&B.liveAsOf.t?` · ${esc(L.updated)} ${esc(B.liveAsOf.t)}`:""}`;
  w.innerHTML=`<div class="sec">${esc(L.title)}</div><div class="card ${open?"movOpen":""}" style="padding:12px">`
    +`<button class="movHead" onclick="movToggle()" aria-expanded="${open?"true":"false"}"><span class="t">${esc(L.title)}</span><svg class="movChev"><use href="#i-chevron-down"/></svg></button>`
    +`<div class="movSum">${movSummary(L)}</div>`
    +`<div id="movBody" style="display:${open?"":"none"}">`
    +`<div class="movSec">${aHead}</div>${aRows}`
    +`<div class="movSec">${bHead}</div>${bRows}`
    +`</div></div>`;
}
function movToggle(){
  _movOpen=!(_movOpen!=null?_movOpen:movLiveFresh());
  renderMarketOverview();
}
function movRenderIdx(rows, doc){
  const el=$("idxRow"); if(!el) return;
  /* DUONG VEE CARD THU HAI (poll 60s cua pollMarketOverview) — cung phai
   * merge frame kieu loadMarket: đo live 03/11 07:00:25Z card in frame
   * "1.705,36" roi 07:00:30Z duong nay ve lai "1.706,61" (doc cu hon). */
  rows = mergeIdxWithLive(rows||[], idxDocMs(doc));
  el.innerHTML=rows.map(r=>{const pc=r.pct_change,cls=pc>0?"up":pc<0?"down":"";const fs=idxFileSym(r.symbol);
    return `<div class="idxcard"${fs?` style="cursor:pointer" onclick="openIndex('${fs}')" title="${esc(r.symbol)}"`:""}><div class="s">${esc(r.symbol)}</div><div class="p">${fmtN(r.close)}</div><div class="c ${cls}">${r.stale?'<span class="stale">— · số liệu cũ</span>':((pc>0?"▲":pc<0?"▼":"")+" "+fmtPct(pc))}</div></div>`;}).join("")||'<div class="hint">Chưa có dữ liệu</div>';
}
async function loadMarketOverview(){
  const g={};
  const f=async(k,p)=>{ try{ g[k]=await api(p); }catch(e){ g[k]=null; } };
  await Promise.all([f("regime","/regime"),f("screener","/screener?all=1"),f("divergence","/divergence"),f("foreign","/foreign-flow"),f("prop","/proprietary-flow"),f("totals","/market-totals"),f("indices","/indices"),f("live","/live-overview")]);
  _movA=movBuildA(g);
  _movB=movBuildB(g);
  renderMarketOverview();
  if(!_movTimer) _movTimer=setInterval(()=>{ try{
    if(document.hidden) return;
    const v=$("v-market"); if(!v||!v.classList.contains("on")) return;
    pollMarketOverview();
  }catch(e){} },60000);
}
async function pollMarketOverview(){
  const g={};
  const f=async(k,p)=>{ try{ g[k]=await api(p); }catch(e){ g[k]=null; } };
  await Promise.all([f("indices","/indices"),f("live","/live-overview"),f("foreign","/foreign-flow"),f("divergence","/divergence")]);
  _movB=movBuildB(g);
  try{ if(g.indices) movRenderIdx(g.indices.rows||[], g.indices); }catch(e){}
  renderMarketOverview();
}

// ---- Vi mo (Tier 2-1): GET /macro (overview + spark) va /macro/history
// khi mo chi tiet. Nguon chinh thong: NHNN, Vietcombank, SJC, NY Fed,
// Bo Tai chinh My — nhan nguon hien duoi moi the.
const MAC_I18N={
  vi:{src:"Nguồn",fxC:"Tỷ giá trung tâm USD/VND",fxV:"Tỷ giá Vietcombank",gold:"Vàng SJC",fed:"Lãi suất FED (EFFR)",omo:"Thị trường mở OMO (NHNN)",omoUnit:"tỷ ₫",omoNone:"Không có trúng thầu",omoDay:"ngày",ust:"Lợi suất TP Mỹ 10Y",pol:"Lãi suất điều hành NHNN",tgt:"Mục tiêu",refi:"Tái cấp vốn",redisc:"Tái chiết khấu",dep:"Huy động bình quân",buy:"Mua",sell:"Bán",buyTr:"Mua CK",usdSell:"USD bán",from:"Hiệu lực",dec:"theo",perL:"tr ₫/lượng",empty:"Chưa có dữ liệu vĩ mô"},
  en:{src:"Source",fxC:"SBV central rate USD/VND",fxV:"Vietcombank FX",gold:"SJC gold",fed:"Fed funds rate (EFFR)",omo:"Open market ops (SBV)",omoUnit:"₫bn",omoNone:"No winning bids",omoDay:"d",ust:"US Treasury 10Y",pol:"SBV policy rates",tgt:"Target",refi:"Refinancing",redisc:"Rediscount",dep:"Avg deposit rate",buy:"Buy",sell:"Sell",buyTr:"Buy (transfer)",usdSell:"USD sell",from:"Effective",dec:"per",perL:"M ₫/tael",empty:"No macro data yet"},
  zh:{src:"来源",fxC:"央行中心汇率 USD/VND",fxV:"Vietcombank 汇率",gold:"SJC 黄金",fed:"美联储利率 (EFFR)",omo:"公开市场操作 (央行)",omoUnit:"十亿₫",omoNone:"无中标",omoDay:"天",ust:"美国10年期国债收益率",pol:"央行政策利率",tgt:"目标",refi:"再融资",redisc:"再贴现",dep:"平均存款利率",buy:"买入",sell:"卖出",buyTr:"买入(转账)",usdSell:"美元卖出",from:"生效",dec:"依据",perL:"百万₫/两",empty:"暂无宏观数据"},
  ko:{src:"출처",fxC:"중앙환율 USD/VND",fxV:"Vietcombank 환율",gold:"SJC 금",fed:"연준 금리 (EFFR)",omo:"공개시장운영 (중앙은행)",omoUnit:"십억₫",omoNone:"낙찰 없음",omoDay:"일",ust:"미국 국채 10년",pol:"중앙은행 정책금리",tgt:"목표",refi:"재융자",redisc:"재할인",dep:"평균 예금금리",buy:"매수",sell:"매도",buyTr:"매수(송금)",usdSell:"USD 매도",from:"시행",dec:"근거",perL:"백만₫/량",empty:"거시 데이터 없음"},
};
const MAC_SRC={sbv:"NHNN",vcb:"Vietcombank",sjc:"SJC",nyfed:"NY Fed",treasury:"U.S. Treasury","sbv-curated":"NHNN"};
let MAC=null, MACOPEN=null, MACFC="USD", MACUT="y10", MACHIST={};
function macSpark(vals,color){
  if(!vals||vals.length<2) return '<svg width="100%" height="30" viewBox="0 0 120 30" preserveAspectRatio="none" aria-hidden="true"></svg>';
  const w=120,h=30,mn=Math.min(...vals),mx=Math.max(...vals),rg=mx-mn;
  if(rg===0){ const y=(h/2).toFixed(1); return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="0,${y} ${w},${y}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`; }
  const pad=rg*0.08, lo=mn-pad, span=rg+2*pad;
  const pts=vals.map((v,i)=>`${(i/(vals.length-1)*w).toFixed(1)},${(h-3-((v-lo)/span)*(h-6)).toFixed(1)}`).join(" ");
  return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`;
}
function macChg(ch,fmt){
  if(ch==null||ch===0) return `<span style="color:var(--pp-mut)">—</span>`;
  const cls=ch>0?"up":"down", ar=ch>0?"▲":"▼";
  return `<span class="${cls}" style="font-size:12px">${ar} ${fmt(Math.abs(ch))}</span>`;
}
async function loadMacro(){
  try{ MAC=await api("/macro"); renderMacro(); }
  catch(e){ /* giu khung, khong lam hong man thi truong */ }
}
function renderMacro(){
  const w=$("macroWrap"); if(!w||!MAC) return;
  const L=MAC_I18N[curLang]||MAC_I18N.vi, S=MAC.series||{};
  const fVnd=v=>Math.round(v).toLocaleString("vi-VN");
  const fPct=v=>v==null?"—":Number(v).toFixed(2).replace(".",",")+"%";
  const card=(sid,name,val,chg,spark,sub,src,date)=>`<div class="card mcard" onclick="macOpen('${sid}')">
    <div class="mct">${name}</div>
    <div class="mcv"><span class="mv">${val}</span><span class="md">${chg||""}</span></div>
    <div class="mcspark">${spark||""}</div>
    <div class="mcsub">${sub||""}</div>
    <div class="mcsrc"><span>${L.src}: ${src} <span class="nw">· ${date||""}</span></span></div></div>`;
  let h=`<div class="mgrid">`;
  const c=S.fx_center;
  if(c) h+=card("fx_center",L.fxC,fVnd(c.last.rate)+" ₫",macChg(c.change,v=>fVnd(v)+" ₫"),macSpark(c.spark,"#38bdf8"),"",MAC_SRC[c.source],c.date);
  const v=S.fx_vcb;
  if(v&&v.usd) h+=card("fx_vcb",L.fxV,fVnd(v.usd.sell||0)+" ₫",macChg(v.change,x=>fVnd(x)+" ₫"),macSpark(v.spark,"#38bdf8"),`${L.usdSell} · ${L.buyTr} ${fVnd(v.usd.buy_transfer||0)} ₫`,MAC_SRC[v.source],v.date);
  const g=S.gold_sjc;
  if(g) h+=card("gold_sjc",L.gold,(g.last.sell/1e6).toFixed(1).replace(".",",")+' <span class="mu">'+L.perL+"</span>",macChg(g.change,x=>(x/1e6).toFixed(2).replace(".",",")),macSpark(g.spark,"#e8c56a"),`${L.buy} ${(g.last.buy/1e6).toFixed(1).replace(".",",")} · ${L.sell} ${(g.last.sell/1e6).toFixed(1).replace(".",",")}`,MAC_SRC[g.source],g.date);
  const f=S.fed_effr;
  if(f) h+=card("fed_effr",L.fed,fPct(f.last.effr),macChg(f.change,x=>x.toFixed(2).replace(".",",")),macSpark(f.spark,"#a78bfa"),`${L.tgt} ${fPct(f.last.target_from)}–${fPct(f.last.target_to)}`,MAC_SRC[f.source],f.date);
  const u=S.ust;
  if(u) h+=card("ust",L.ust,fPct(u.last.y10),macChg(u.change,x=>x.toFixed(2).replace(".",",")),macSpark(u.spark,"#a78bfa"),`2Y ${fPct(u.last.y2)} · 30Y ${fPct(u.last.y30)}`,MAC_SRC[u.source],u.date);
  const o=S.omo;
  if(o&&o.last){ const fTy=v=>Number(v||0).toLocaleString("vi-VN",{maximumFractionDigits:1});
    const tt=(o.last.tenors||[]).filter(t=>t.volume>0);
    const sub=tt.length?tt.map(t=>`${t.days}${L.omoDay} ${fPct(t.rate)}`).join(" · "):L.omoNone;
    h+=card("omo",L.omo,fTy(o.last.total)+" "+L.omoUnit,macChg(o.change,v=>fTy(v)),macSpark(o.spark,"#34d399"),sub,MAC_SRC[o.source],o.date); }
  const p=MAC.policy_rates;
  if(p) h+=`<div class="card mcpol">
    <div class="mct">${L.pol}</div>
    <div class="vals">
      <div class="cell"><div class="k">${L.refi}</div><div class="v">${fPct(p.refinancing)}</div></div>
      <div class="cell"><div class="k">${L.redisc}</div><div class="v">${fPct(p.rediscount)}</div></div>
      <div class="cell"><div class="k">${L.dep}</div><div class="v">${fPct(p.deposit_avg)}</div></div></div>
    <div class="mcsrc" style="margin-top:8px">${L.from} ${p.effective} · ${L.dec} ${esc(p.decision||"")} · ${L.src}: NHNN</div></div>`;
  h+="</div>"+(MACOPEN?`<div class="card" style="margin-top:8px;padding:10px" id="macroDetail"><div class="hint">…</div></div>`:"");
  w.innerHTML=h||`<div class="hint">${L.empty}</div>`;
  if(MACOPEN) macDrawDetail();
}
function macSeriesVal(sid,row){
  if(sid==="fx_center") return row.rate;
  if(sid==="gold_sjc") return row.sell;
  if(sid==="fed_effr") return row.effr;
  if(sid==="omo") return row.total;
  if(sid==="ust") return row[MACUT];
  if(sid==="fx_vcb"){ const r=(row.rates||[]).find(x=>x.code===MACFC); return r?r.sell:null; }
  return null;
}
function macChartSvg(rows,sid){
  const pts=rows.map(r=>({d:r.date,v:macSeriesVal(sid,r)})).filter(p=>p.v!=null);
  if(pts.length<2) return '<div class="hint">—</div>';
  const w=330,h=120,vs=pts.map(p=>p.v),mn=Math.min(...vs),mx=Math.max(...vs),rg=(mx-mn)||1;
  const X=i=>(i/(pts.length-1)*w).toFixed(1), Y=v=>(h-14-((v-mn)/rg)*(h-28)).toFixed(1);
  const line=pts.map((p,i)=>`${X(i)},${Y(p.v)}`).join(" ");
  const fN=v=>v>=1000?Math.round(v).toLocaleString("vi-VN"):Number(v).toFixed(2).replace(".",",");
  return `<svg width="100%" viewBox="0 0 ${w} ${h}"><polyline points="${line}" fill="none" stroke="#38bdf8" stroke-width="1.6"/>
    <text x="2" y="10" fill="#9db8a9" font-size="9">${fN(mx)}</text><text x="2" y="${h-2}" fill="#9db8a9" font-size="9">${fN(mn)}</text>
    <text x="${w-2}" y="10" text-anchor="end" fill="#9db8a9" font-size="9">${pts[0].d}</text><text x="${w-2}" y="${h-2}" text-anchor="end" fill="#9db8a9" font-size="9">${pts[pts.length-1].d}</text></svg>`;
}
async function macOpen(sid){
  MACOPEN=(MACOPEN===sid)?null:sid;
  renderMacro();
  if(!MACOPEN) return;
  if(!MACHIST[sid]){
    try{ const j=await api("/macro/history?series="+sid+"&limit=500"); MACHIST[sid]=j.rows||[]; }
    catch(e){ MACHIST[sid]=[]; }
  }
  macDrawDetail();
}
function macDrawDetail(){
  const box=$("macroDetail"); if(!box||!MACOPEN) return;
  const L=MAC_I18N[curLang]||MAC_I18N.vi, rows=MACHIST[MACOPEN]||[];
  let extra="";
  if(MACOPEN==="fx_vcb"&&MAC.series.fx_vcb){
    const codes=MAC.series.fx_vcb.codes||["USD"];
    extra=`<div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">${codes.slice(0,10).map(c=>`<button onclick="MACFC='${c}';macDrawDetail()" style="padding:3px 9px;border-radius:99px;border:1px solid var(--pp-line);background:${c===MACFC?"var(--pp-accent)":"var(--pp-bg2)"};color:${c===MACFC?"#fff":"var(--pp-ink)"};font-size:12px;cursor:pointer">${c}</button>`).join("")}</div>`;
    const last=rows[rows.length-1];
    if(last) extra+=`<table>${last.rates.map(r=>`<tr><td><b>${r.code}</b></td><td style="text-align:right">${Math.round(r.buy_cash||0).toLocaleString("vi-VN")}</td><td style="text-align:right">${Math.round(r.buy_transfer||0).toLocaleString("vi-VN")}</td><td style="text-align:right">${Math.round(r.sell||0).toLocaleString("vi-VN")}</td></tr>`).join("")}</table>`;
  }
  if(MACOPEN==="omo"){
    const last=rows[rows.length-1];
    const fPct=v=>v==null?"—":Number(v).toFixed(2).replace(".",",")+"%";
    if(last&&last.tenors&&last.tenors.length) extra=`<table>${last.tenors.map(t=>`<tr><td><b>${t.days} ${L.omoDay}</b></td><td style="text-align:right">${Number(t.volume||0).toLocaleString("vi-VN",{maximumFractionDigits:1})} ${L.omoUnit}</td><td style="text-align:right">${fPct(t.rate)}</td><td style="text-align:right">${t.members_won||0}/${t.members_bid||0}</td></tr>`).join("")}</table>`;
  }
  if(MACOPEN==="ust"){
    extra=`<div style="display:flex;gap:6px;margin:6px 0">${["y2","y10","y30"].map(t=>`<button onclick="MACUT='${t}';macDrawDetail()" style="padding:3px 9px;border-radius:99px;border:1px solid var(--pp-line);background:${t===MACUT?"var(--pp-accent)":"var(--pp-bg2)"};color:${t===MACUT?"#fff":"var(--pp-ink)"};font-size:12px;cursor:pointer">${t.toUpperCase()}</button>`).join("")}</div>`;
  }
  box.innerHTML=extra+macChartSvg(rows.slice(-250),MACOPEN);
}
// ---- Màn 4 ----
// ===== Khoi Nhan dinh tu dong (Chot 09:34 22/10) =====
// Nganh/Dong thuan/Co dong: van ban tinh san tai publish (server,
// 4 ngon ngu) — client chi chon ngon ngu. Sang loc: tinh tai client
// tren dung tap dang loc bang mau SCR_TPL tuong ung.
const INS_I18N={
  vi:{t:"Nhận định tự động từ dữ liệu",src:"Nguồn"},
  en:{t:"Automated data insight",src:"Source"},
  zh:{t:"自动数据解读",src:"来源"},
  ko:{t:"자동 데이터 분석",src:"출처"}};
const INS_SRC={
  cons:{vi:"Báo cáo phân tích các hãng (đã kiểm chứng)",en:"Broker research (verified reports)",zh:"机构研报（已核实）",ko:"증권사 리포트(검증 완료)"},
  sec:{vi:"Báo cáo tài chính các doanh nghiệp trong ngành",en:"Member companies' financial statements",zh:"行业成分公司财务报表",ko:"업종 구성 기업의 재무제표"},
  hold:{vi:"Công bố cổ đông (chỉ mục đảo cổ đông)",en:"Shareholder disclosures (reverse index)",zh:"股东披露（反向索引）",ko:"주주 공시(역인덱스)"},
  scr:{vi:"Dữ liệu sàng lọc + cơ bản cuối phiên",en:"End-of-day screener & fundamentals",zh:"日终筛选与基本面数据",ko:"일일 스크리너·펀더멘털 데이터"}};
function insBox(insight, srcText, asOf){
  if(!insight) return "";
  const L=INS_I18N[curLang]||INS_I18N.vi;
  const txt=insight[curLang]||insight.vi||"";
  if(!txt) return "";
  let f="";
  if(srcText) f+=L.src+": "+esc(srcText);
  if(asOf) f+=(f?" · ":"")+String(asOf).slice(0,10);
  return `<div class="insight"><div class="ins-t">${L.t}</div><div class="ins-b">${esc(txt)}</div>${f?`<div class="ins-f">${f}</div>`:""}</div>`;
}
  if(typeof window!=="undefined"){
    window.REGIME_I18N=REGIME_I18N; window.BREADTH_I18N=BREADTH_I18N; window.PUSH_I18N=PUSH_I18N; window.CAL_I18N=CAL_I18N; window.FF_I18N=FF_I18N; window.PF_I18N=PF_I18N; window.MT_I18N=MT_I18N; window.MOV_I18N=MOV_I18N; window.MAC_I18N=MAC_I18N; window.MAC_SRC=MAC_SRC; window.INS_I18N=INS_I18N; window.INS_SRC=INS_SRC;
    Object.defineProperty(window,"_caData",{get:function(){ return _caData; },configurable:true});
    window.loadMarket=loadMarket; window.refreshMoversFromLive=refreshMoversFromLive; window.loadMarketTotals=loadMarketTotals; window.renderMarketTotals=renderMarketTotals; window.renderRegime=renderRegime;
    window.loadFF=loadFF; window.renderFF=renderFF; window.fmtTyF=fmtTyF; window.loadPF=loadPF; window.renderPF=renderPF; window.loadMN=loadMN; window.renderMN=renderMN;
    window.loadCA=loadCA; window.renderCA=renderCA; window.loadMarketOverview=loadMarketOverview; window.renderMarketOverview=renderMarketOverview; window.pollMarketOverview=pollMarketOverview;
    window.loadMacro=loadMacro; window.renderMacro=renderMacro; window.insBox=insBox; window.movToggle=movToggle; window.movRenderIdx=movRenderIdx;
    window.mergeIdxWithLive=mergeIdxWithLive; window.idxDocMs=idxDocMs;
    window.__mkTest={i18n:MT_I18N,load:loadMarket,totals:loadMarketTotals,renderTotals:renderMarketTotals,regime:renderRegime,ca:renderCA,overview:loadMarketOverview,renderOverview:renderMarketOverview,macro:loadMacro,insBox:insBox,fmtTyF:fmtTyF}; }
  if(typeof module!=="undefined" && module.exports){ module.exports = { mergeScreenerPx: mergeScreenerPx, livePx: livePx, withLivePx: withLivePx, moversFromLivePx: moversFromLivePx, mergeIdxWithLive: mergeIdxWithLive, idxDocMs: idxDocMs }; }
  if(typeof document!=="undefined") loadMarket();
})();
}catch(e){}
// __MK_END__
