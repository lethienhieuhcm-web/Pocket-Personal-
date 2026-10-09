// js/features/stock.js — Vietnam stocks (R2-backed via worker /api/stock/*).
import { $, esc, toast } from '../core/dom.js';
import { state } from '../core/state.js';
import { apiCall } from '../core/api.js';

/* ---------- i18n (VI/EN/中文/한국어) ---------- */
const I18N = {
vi:{
login_required:"Đăng nhập để xem chứng khoán.",no_data_updating:"Dữ liệu đang cập nhật. Vui lòng đợi.",
updated:"Cập nhật: ",error:"Lỗi",loading:"Đang tải…",watching:"✓ Đang theo dõi",watch:"+ Theo dõi",
unwatched:"Đã bỏ theo dõi",watched:"Đã thêm vào theo dõi",chart_fail:"Không tải được biểu đồ.",
loading_news:"Đang tải tin tức…",no_news:"Chưa có tin tức.",loading_events:"Đang tải sự kiện…",no_events:"Chưa có sự kiện.",
ex_date:"Ngày GDKHQ",ratio:"Tỷ lệ",per_share:"/cổ phiếu",
ref_price:"Tham chiếu",open_price:"Mở cửa",high_price:"Cao nhất",low_price:"Thấp nhất",volume:"Khối lượng",value:"Giá trị",billion:"tỷ",
loading_screener:"Đang tải bộ lọc…",no_data:"Chưa có dữ liệu.",
th_symbol:"Mã",th_score:"Điểm",th_price:"Giá",th_pct:"%",th_pe:"P/E",th_qty:"SL",th_avg_cost:"Giá vốn",th_pl:"Lãi/Lỗ",th_date:"Ngày",th_side:"Mua/Bán",
select_symbol_first:"Chọn một mã trước",calculating:"Đang tính…",
bt_strategy:"Chiến lược",bt_buyhold:"Mua & giữ",bt_trades_winrate:"Số lệnh / Tỷ lệ thắng",bt_maxdd:"Lỗ tối đa",
wl_empty:"Chưa theo dõi mã nào. Thêm từ tab Thị trường.",added:"Đã thêm ",
pf_total_value:"Tổng giá trị",pf_unrealized:"Lãi/lỗ chưa chốt",pf_realized:"Đã chốt",
pf_no_positions:"Chưa có vị thế. Thêm giao dịch ở form bên dưới.",
buy:"Mua",sell:"Bán",no_txns:"Chưa có giao dịch.",del_txn_q:"Xoá giao dịch này?",
confirm_yes:"Xác nhận",cancel:"Huỷ",save:"Lưu",note_ph:"Ghi chú…",note_updated:"Đã cập nhật ghi chú",
txn_fill:"Nhập mã, giá, số lượng, ngày",txn_saved_fee:"Đã lưu (phí {fee})",no_data2:"Không có dữ liệu",
series_market:"Thị trường",series_avgcost:"Giá vốn TB",
tp_label:"Chốt lời %",sl_label:"Cắt lỗ %",target_set:"Đã đặt mục tiêu cho ",
premium_locked:"Tính năng này hiện chưa khả dụng.",
cmp_hint:"Nhập các mã, ví dụ HPG,VCB",downloaded:"Đã tải ",
no_alerts:"Chưa có cảnh báo.",th_condition:"Điều kiện",
alert_fill:"Nhập mã và giá",alert_added:"Đã thêm cảnh báo",
no_targets:"Chưa có mục tiêu. Đặt từ tab Danh mục.",
th_tp:"Chốt lời",th_sl:"Cắt lỗ",
ind_on:"✓ Chỉ báo",ind_off:"fx Chỉ báo",vn_time:"Việt Nam (GMT+7)"},
en:{
login_required:"Log in to view stocks.",no_data_updating:"Data is being updated. Please wait.",
updated:"Updated: ",error:"Error",loading:"Loading…",watching:"✓ Following",watch:"+ Follow",
unwatched:"Unfollowed",watched:"Added to watchlist",chart_fail:"Chart could not be loaded.",
loading_news:"Loading news…",no_news:"No news yet.",loading_events:"Loading events…",no_events:"No events yet.",
ex_date:"Ex-date",ratio:"Ratio",per_share:"/share",
ref_price:"Reference",open_price:"Open",high_price:"High",low_price:"Low",volume:"Volume",value:"Value",billion:"B",
loading_screener:"Loading screener…",no_data:"No data yet.",
th_symbol:"Symbol",th_score:"Score",th_price:"Price",th_pct:"%",th_pe:"P/E",th_qty:"Qty",th_avg_cost:"Avg cost",th_pl:"P&L",th_date:"Date",th_side:"Side",
select_symbol_first:"Select a symbol first",calculating:"Calculating…",
bt_strategy:"Strategy",bt_buyhold:"Buy & hold",bt_trades_winrate:"Trades / Winrate",bt_maxdd:"Max drawdown",
wl_empty:"Not following any symbols. Add from the Market tab.",added:"Added ",
pf_total_value:"Total value",pf_unrealized:"Unrealized P&L",pf_realized:"Realized",
pf_no_positions:"No positions. Add a transaction in the form below.",
buy:"Buy",sell:"Sell",no_txns:"No transactions.",del_txn_q:"Delete this transaction?",
confirm_yes:"Confirm",cancel:"Cancel",save:"Save",note_ph:"Note…",note_updated:"Note updated",
txn_fill:"Fill in symbol, price, qty, date",txn_saved_fee:"Saved (fee {fee})",no_data2:"No data",
series_market:"Market",series_avgcost:"Avg cost",
tp_label:"Take profit %",sl_label:"Stop loss %",target_set:"Target set for ",
premium_locked:"This feature is not available right now.",
cmp_hint:"Enter symbols, e.g. HPG,VCB",downloaded:"Downloaded ",
no_alerts:"No alerts.",th_condition:"Condition",
alert_fill:"Fill in symbol and price",alert_added:"Alert added",
no_targets:"No targets. Set them from the Portfolio tab.",
th_tp:"Take profit",th_sl:"Stop loss",
ind_on:"✓ Indicators",ind_off:"fx Indicators",vn_time:"Vietnam (GMT+7)"},
zh:{
login_required:"登录后查看股票。",no_data_updating:"数据正在更新，请稍候。",
updated:"更新时间：",error:"错误",loading:"加载中…",watching:"✓ 已关注",watch:"+ 关注",
unwatched:"已取消关注",watched:"已加入关注",chart_fail:"图表加载失败。",
loading_news:"正在加载新闻…",no_news:"暂无新闻。",loading_events:"正在加载事件…",no_events:"暂无事件。",
ex_date:"除权日",ratio:"比例",per_share:"/股",
ref_price:"参考价",open_price:"开盘",high_price:"最高",low_price:"最低",volume:"成交量",value:"成交额",billion:"十亿",
loading_screener:"正在加载筛选器…",no_data:"暂无数据。",
th_symbol:"代码",th_score:"评分",th_price:"价格",th_pct:"%",th_pe:"市盈率",th_qty:"数量",th_avg_cost:"平均成本",th_pl:"盈亏",th_date:"日期",th_side:"方向",
select_symbol_first:"请先选择一只股票",calculating:"计算中…",
bt_strategy:"策略",bt_buyhold:"买入持有",bt_trades_winrate:"交易次数 / 胜率",bt_maxdd:"最大回撤",
wl_empty:"尚未关注任何股票，请从市场页添加。",added:"已添加 ",
pf_total_value:"总市值",pf_unrealized:"浮动盈亏",pf_realized:"已实现盈亏",
pf_no_positions:"暂无持仓，请在下方表单添加交易。",
buy:"买入",sell:"卖出",no_txns:"暂无交易记录。",del_txn_q:"删除这笔交易？",
confirm_yes:"确认",cancel:"取消",save:"保存",note_ph:"备注…",note_updated:"备注已更新",
txn_fill:"请填写代码、价格、数量、日期",txn_saved_fee:"已保存（手续费 {fee}）",no_data2:"无数据",
series_market:"市场价",series_avgcost:"平均成本",
tp_label:"止盈 %",sl_label:"止损 %",target_set:"已为 ",
premium_locked:"该功能目前不可用。",
cmp_hint:"输入代码，例如 HPG,VCB",downloaded:"已下载 ",
no_alerts:"暂无提醒。",th_condition:"条件",
alert_fill:"请填写代码和价格",alert_added:"提醒已添加",
no_targets:"暂无目标，请从投资组合页设置。",
th_tp:"止盈",th_sl:"止损",
ind_on:"✓ 指标",ind_off:"fx 指标",vn_time:"越南 (GMT+7)"},
ko:{
login_required:"로그인 후 주식을 확인하세요。",no_data_updating:"데이터를 업데이트 중입니다. 잠시만 기다려 주세요.",
updated:"업데이트: ",error:"오류",loading:"불러오는 중…",watching:"✓ 팔로우 중",watch:"+ 팔로우",
unwatched:"팔로우를 해제했습니다",watched:"관심 목록에 추가했습니다",chart_fail:"차트를 불러오지 못했습니다.",
loading_news:"뉴스를 불러오는 중…",no_news:"아직 뉴스가 없습니다.",loading_events:"이벤트를 불러오는 중…",no_events:"아직 이벤트가 없습니다.",
ex_date:"배당락일",ratio:"비율",per_share:"/주",
ref_price:"기준가",open_price:"시가",high_price:"고가",low_price:"저가",volume:"거래량",value:"거래대금",billion:"십억",
loading_screener:"스크리너를 불러오는 중…",no_data:"아직 데이터가 없습니다.",
th_symbol:"종목",th_score:"점수",th_price:"가격",th_pct:"%",th_pe:"PER",th_qty:"수량",th_avg_cost:"평균 단가",th_pl:"손익",th_date:"날짜",th_side:"구분",
select_symbol_first:"먼저 종목을 선택하세요",calculating:"계산 중…",
bt_strategy:"전략",bt_buyhold:"바이앤홀드",bt_trades_winrate:"거래 수 / 승률",bt_maxdd:"최대 낙폭",
wl_empty:"팔로우 중인 종목이 없습니다. 시장 탭에서 추가하세요.",added:"추가됨: ",
pf_total_value:"총 평가금액",pf_unrealized:"평가손익",pf_realized:"실현손익",
pf_no_positions:"보유 종목이 없습니다. 아래 양식에서 거래를 추가하세요.",
buy:"매수",sell:"매도",no_txns:"거래 내역이 없습니다.",del_txn_q:"이 거래를 삭제하시겠습니까?",
confirm_yes:"확인",cancel:"취소",save:"저장",note_ph:"메모…",note_updated:"메모가 업데이트되었습니다",
txn_fill:"종목, 가격, 수량, 날짜를 입력하세요",txn_saved_fee:"저장됨 (수수료 {fee})",no_data2:"데이터 없음",
series_market:"시장가",series_avgcost:"평균 단가",
tp_label:"익절 %",sl_label:"손절 %",target_set:"목표가 설정됨: ",
premium_locked:"이 기능은 현재 사용할 수 없습니다.",
cmp_hint:"종목을 입력하세요 (예: HPG,VCB)",downloaded:"다운로드됨: ",
no_alerts:"알림이 없습니다.",th_condition:"조건",
alert_fill:"종목과 가격을 입력하세요",alert_added:"알림이 추가되었습니다",
no_targets:"목표가가 없습니다. 포트폴리오 탭에서 설정하세요.",
th_tp:"익절",th_sl:"손절",
ind_on:"✓ 지표",ind_off:"fx 지표",vn_time:"베트남 (GMT+7)"}
};
let LANG = "vi";
try{ const v = localStorage.getItem("elab_uiLang"); if(v) LANG = JSON.parse(v); }catch(e){}
const LOCALES = {vi:"vi-VN", en:"en-US", zh:"zh-CN", ko:"ko-KR"};
function t(key){ return (I18N[LANG]&&I18N[LANG][key]) || I18N.en[key] || key; }

let chart = null;
let curSymbol = null;
let stkTab = "market";

async function sApi(path, opts={}){
  if(!state.authToken){ throw new Error("Login required"); }
  return apiCall("/api/stock"+path, opts);
}
const fmtN = n => n==null ? "—" : Number(n).toLocaleString("en-US");
const fmtPct = p => p==null ? "—" : (p>0?"+":"")+Number(p).toFixed(2)+"%";
const pcCls = p => p>0?"up":p<0?"dn":"";

export function bindStock(){
  const inp = $("stkSearch");
  if(inp){
    let timer = null;
    inp.addEventListener("input", ()=>{
      clearTimeout(timer);
      timer = setTimeout(()=>stockSearch(inp.value.trim().toUpperCase()), 300);
    });
    inp.addEventListener("keydown", e=>{
      if(e.key==="Enter"){ const v=inp.value.trim().toUpperCase(); if(v) openSymbol(v); }
    });
  }
  const btn = $("stkSearchBtn");
  if(btn) btn.onclick = ()=>{ const v=$("stkSearch").value.trim().toUpperCase(); if(v) openSymbol(v); };
  // sub-tabs
  document.querySelectorAll(".stktab").forEach(b=>{
    b.onclick = ()=>{ stkTab = b.dataset.t; renderStockTab(); };
  });
  // watchlist add
  const wbtn = $("wlAddBtn");
  if(wbtn) wbtn.onclick = addWatchlist;
  // txn form
  const tbtn = $("txnAddBtn");
  if(tbtn) tbtn.onclick = addTxn;
  // alert form
  const abtn = $("alAddBtn");
  if(abtn) abtn.onclick = addAlert;
  // backtest
  const bbtn = $("btRunBtn");
  if(bbtn) bbtn.onclick = runBacktest;
  // compare (premium)
  const cbtn = $("cmpBtn");
  if(cbtn) cbtn.onclick = async ()=>{
    if(await isFreeUser()){ showUpgradeToast(); return; }
    runCompare();
  };
  // export (premium)
  const epbtn = $("expPosBtn");
  if(epbtn) epbtn.onclick = async ()=>{ if(await isFreeUser()){ showUpgradeToast(); return; } exportCSV("positions"); };
  const etbtn = $("expTxnBtn");
  if(etbtn) etbtn.onclick = async ()=>{ if(await isFreeUser()){ showUpgradeToast(); return; } exportCSV("transactions"); };
  // interval buttons
  document.querySelectorAll("[data-iv]").forEach(b=>{
    b.onclick = ()=>{
      document.querySelectorAll("[data-iv]").forEach(x=>x.classList.toggle("active", x===b));
      curIv = b.dataset.iv;
      if(curSymbol) loadChart(curSymbol, curIv);
    };
  });
  // FireAnt-style detail tabs
  document.querySelectorAll("[data-ft]").forEach(b=>{
    b.onclick = ()=>{
      document.querySelectorAll("[data-ft]").forEach(x=>x.classList.toggle("active", x===b));
      const ft = b.dataset.ft;
      $("fadOv").style.display = ft==="ov"?"":"none";
      $("fadNews").style.display = ft==="news"?"":"none";
      $("fadFund").style.display = ft==="fund"?"":"none";
      $("fadBt").style.display = ft==="bt"?"":"none";
      if(curSymbol && (ft==="news"||ft==="fund") && !loadedTabs[curSymbol].tabs){
        loadedTabs[curSymbol].tabs = true;
        loadNewsEvents(curSymbol);
      }
      if(ft==="ov" && curSymbol) loadChart(curSymbol, curIv);
    };
  });
  // back button
  const bk = $("stkBack");
  if(bk) bk.onclick = ()=>{ $("stkDetail").style.display = "none"; curSymbol = null; };
  // indicator mode toggle
  const itg = $("indToggle");
  if(itg) itg.onclick = ()=>{
    indMode = !indMode;
    itg.classList.toggle("primary", indMode);
    itg.textContent = indMode ? t("ind_on") : t("ind_off");
    if(curSymbol) loadChart(curSymbol, curIv);
  };
  // alert button in detail -> alerts tab with symbol prefilled
  const agb = $("alGoBtn");
  if(agb) agb.onclick = ()=>{
    stkTab = "alert"; renderStockTab();
    setTimeout(()=>{ const i=$("alSym"); if(i && curSymbol) i.value = curSymbol; }, 60);
  };
  // screener filter
  const sbtn = $("scrBtn");
  if(sbtn) sbtn.onclick = renderScreener;
}

export async function renderStock(){
  if(!state.authToken){
    $("stkMain").innerHTML = '<div class="hint">'+t("login_required")+'</div>';
    return;
  }
  renderStockTab();
}

// Called when Ably push "market update" arrives: refresh market tab silently
export function refreshMarketOnPush(){
  if(stkTab==="market" && state.authToken){
    renderIndices();
    renderScreener();
  }
}

function renderStockTab(){
  document.querySelectorAll(".stktab").forEach(b=> b.classList.toggle("active", b.dataset.t===stkTab));
  ["market","watch","port","alert"].forEach(n=>{
    const el = $("stkTab"+n[0].toUpperCase()+n.slice(1));
    if(el) el.style.display = n===stkTab ? "" : "none";
  });
  if(stkTab==="market"){ renderIndices(); renderScreener(); }
  if(stkTab==="watch") renderWatchlist();
  if(stkTab==="port") renderPortfolio();
  if(stkTab==="alert"){ renderAlerts(); renderTargets(); }
}

/* ---------- market ---------- */
async function renderIndices(){
  const box = $("stkIndices");
  if(!box) return;
  box.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap">'
    + '<div class="pp-skeleton" style="width:110px;height:66px"></div>'
    + '<div class="pp-skeleton" style="width:110px;height:66px"></div>'
    + '<div class="pp-skeleton" style="width:110px;height:66px"></div></div>';
  try{
    const j = await sApi("/indices");
    if(!j.rows.length){ box.innerHTML = '<div class="hint">'+t("no_data_updating")+'</div>'; return; }
    box.innerHTML = j.rows.map(r=>{
      const pc = r.pct_change, cls = pcCls(pc);
      const arrow = pc>0?"▲":pc<0?"▼":"—";
      return `<div class="stkidx"><div class="stkidx-sym">${esc(r.symbol)}</div>
        <div class="stkidx-px ${cls}">${r.close!=null?r.close:"—"}</div>
        <div class="stkidx-chg ${cls}">${arrow} ${fmtPct(pc)}</div></div>`;
    }).join("");
    const upd = j.updated ? new Date(j.updated) : null;
    $("stkUpd").textContent = upd ? t("updated")+upd.toLocaleString(LOCALES[LANG]||"en-US") : "";
  }catch(e){ box.innerHTML = '<div class="hint">'+t("error")+": "+esc(e.message)+'</div>'; }
}

async function stockSearch(q){
  const box = $("stkSearchRes");
  if(!box || !q){ if(box) box.innerHTML=""; return; }
  try{
    const j = await sApi("/symbols");
    const rows = (j.rows||[]).filter(r=>r.symbol.includes(q)).slice(0,8);
    box.innerHTML = rows.map(r=>
      `<div class="stkres" data-sym="${esc(r.symbol)}"><b>${esc(r.symbol)}</b> <span class="hint">${esc(r.exchange||"")}</span></div>`
    ).join("");
    box.querySelectorAll(".stkres").forEach(d=> d.onclick = ()=>openSymbol(d.dataset.sym));
  }catch(e){ /* silent */ }
}

let curIv = "1D";
let indMode = false; // false: MA+Volume (FireAnt default) · true: RSI/MACD/Bollinger
let exMap = null; // symbol -> exchange cache
let loadedTabs = {}; // sym -> {news:bool}

async function getEx(sym){
  if(!exMap){
    try{
      const j = await sApi("/symbols");
      exMap = {};
      (j.rows||[]).forEach(r=>{ exMap[r.symbol]=r.exchange; });
    }catch(e){ exMap = {}; }
  }
  return exMap[sym]||"";
}

export async function openSymbol(sym){
  curSymbol = sym;
  curIv = "1D"; indMode = false;
  loadedTabs[sym] = {};
  // switch to market tab to show detail
  stkTab = "market"; renderStockTab();
  setTimeout(async ()=>{
    $("stkDetail").style.display = "";
    $("stkDetailSym").textContent = sym;
    $("stkDetailEx").textContent = "";
    $("stkSearchRes").innerHTML = "";
    $("stkSearch").value = sym;
    // reset fad tabs to overview
    document.querySelectorAll("[data-ft]").forEach(x=>x.classList.toggle("active", x.dataset.ft==="ov"));
    ["fadOv","fadNews","fadFund","fadBt"].forEach((id,i)=>{ $(id).style.display = i===0?"":"none"; });
    getEx(sym).then(ex=>{ $("stkDetailEx").textContent = "("+(ex==="HOSE"?"HSX":ex)+")"; });
    await loadSymHead(sym);
    await loadChart(sym, curIv);
    $("stkDetail").scrollIntoView({block:"start"});
  }, 50);
}

async function loadSymHead(sym){
  try{
    const q = await sApi("/quote?symbol="+encodeURIComponent(sym));
    const pc = q.pct_change, cls = pcCls(pc);
    const chg = (q.change!=null?q.change:"—");
    $("stkPx").textContent = q.close??"—";
    $("stkPx").className = "fadpx "+cls;
    $("stkChg").textContent = `${chg} (${fmtPct(pc)})`;
    $("stkChg").className = "fadchg "+cls;
    $("stkTime").textContent = new Date().toLocaleTimeString(LOCALES[LANG]||"en-US",{timeZone:"Asia/Ho_Chi_Minh",hour12:false})+" | "+t("vn_time");
    let inWl = false;
    try{ const wl = await sApi("/watchlist"); inWl = wl.includes(sym); }catch(e){}
    const wbtn = $("wlToggle2");
    wbtn.textContent = inWl?t("watching"):t("watch");
    wbtn.onclick = async ()=>{
      try{
        if(inWl){ await sApi("/watchlist/"+sym, {method:"DELETE"}); toast(t("unwatched")); }
        else{ await sApi("/watchlist", {method:"POST", body:JSON.stringify({symbol:sym})}); toast(t("watched")); }
        loadSymHead(sym);
      }catch(e){ toast(t("error")+": "+e.message); }
    };
  }catch(e){
    $("stkPx").textContent = "—";
    $("stkChg").textContent = esc(e.message);
  }
}

// simple moving average over numeric array (null until warm)
function smaArr(vals, n){
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  for(let i=0;i<vals.length;i++){
    sum += vals[i];
    if(i>=n) sum -= vals[i-n];
    if(i>=n-1) out[i] = sum/n;
  }
  return out;
}

async function loadNewsEvents(sym){
  // news
  const nbox = $("stkNews");
  if(nbox){
    nbox.innerHTML = '<div class="hint">'+t("loading_news")+'</div>';
    try{
      const j = await sApi("/news?symbol="+encodeURIComponent(sym));
      const items = j.items||[];
      nbox.innerHTML = items.length ? items.slice(0,8).map(n=>
        `<div class="stknews"><a href="${esc(n.url||"#")}" target="_blank" rel="noopener"><b>${esc(n.title||"")}</b></a><div class="hint">${esc(n.publish_time||"")}</div></div>`
      ).join("") : '<div class="hint">'+t("no_news")+'</div>';
    }catch(e){ nbox.innerHTML = '<div class="hint">—</div>'; }
  }
  // events
  const ebox = $("stkEvents");
  if(ebox){
    ebox.innerHTML = '<div class="hint">'+t("loading_events")+'</div>';
    try{
      const j = await sApi("/events?symbol="+encodeURIComponent(sym));
      const items = j.items||[];
      nbox && (nbox.innerHTML = nbox.innerHTML); // no-op
      ebox.innerHTML = items.length ? items.slice(0,10).map(ev=>
        `<div class="stkev"><b>${esc(ev.name||"")}</b><div>${esc(ev.title||"")}</div><div class="hint">${t("ex_date")}: ${esc(ev.exright_date||ev.date||"—")}${ev.value_per_share?` · ${esc(String(ev.value_per_share))}${t("per_share")}`:""}${ev.exercise_ratio?` · ${t("ratio")} ${esc(ev.exercise_ratio)}`:""}</div></div>`
      ).join("") : '<div class="hint">'+t("no_events")+'</div>';
    }catch(e){ ebox.innerHTML = '<div class="hint">—</div>'; }
  }
  // fundamentals
  const fbox = $("stkFund");
  if(fbox){
    try{
      const f = await sApi("/fundamentals?symbol="+encodeURIComponent(sym));
      const q = await sApi("/quote?symbol="+encodeURIComponent(sym)).catch(()=>({}));
      const close = q.close;
      const pe = (close && f.eps>0) ? (close*1000/f.eps).toFixed(2) : "—";
      const pb = (close && f.bvps>0) ? (close*1000/f.bvps).toFixed(2) : "—";
      fbox.innerHTML = `<div class="stkfund"><span>P/E <b>${pe}</b></span><span>P/B <b>${pb}</b></span><span>ROE <b>${f.roe??"—"}%</b></span><span>ROA <b>${f.roa??"—"}%</b></span><span>EPS <b>${fmtN(f.eps)}</b></span><span>Sector <b>${esc(f.industry||"—")}</b></span></div>`;
    }catch(e){ fbox.innerHTML = '<div class="hint">—</div>'; }
  }
}

async function loadChart(sym, interval="1D"){
  const el = $("stkChart");
  if(typeof LightweightCharts==="undefined"){
    el.innerHTML = '<div class="hint">'+t("chart_fail")+'</div>';
    return;
  }
  el.innerHTML = '<div class="pp-skeleton" style="height:300px;border-radius:12px"></div>';
  try{
    const isIntraday = interval!=="1D";
    const count = isIntraday ? 80 : 300;
    const j = await sApi("/ohlcv?symbol="+encodeURIComponent(sym)+"&count="+count+"&interval="+interval);
    el.innerHTML = "";
    el.style.position = "relative";
    const dark = document.body.classList.contains("dark");
    chart = LightweightCharts.createChart(el, {
      layout:{background:{color: dark?"#1a1a1a":"#ffffff"}, textColor: dark?"#d4d4d4":"#333"},
      width: el.clientWidth, height: 300,
      timeScale:{timeVisible:isIntraday},
    });
    const cs = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor:"#26a69a", downColor:"#ef5350",
      wickUpColor:"#26a69a", wickDownColor:"#ef5350", borderVisible:false,
    });
    const rows = j.rows||[];
    const disp = rows.slice(-120);
    const candleData = disp.map(r=>{
      let t = r.t;
      if(isIntraday && t.includes("T")){
        t = Math.floor(new Date(t).getTime()/1000);
      }
      return {time:t, open:r.o, high:r.h, low:r.l, close:r.c};
    });
    cs.setData(candleData);
    const closes = disp.map(r=>r.c), vols = disp.map(r=>r.v||0);
    const mkLine = (data,color,opts={})=>{
      const s = chart.addSeries(LightweightCharts.LineSeries, Object.assign({
        color, lineWidth:1, priceLineVisible:false, lastValueVisible:false,
        crosshairMarkerVisible:false,
      }, opts));
      s.setData(data);
      return s;
    };
    const lineData = (arr)=>candleData.map((p,i)=>({time:p.time, value:arr[i]})).filter(p=>p.value!=null);

    if(!isIntraday && indMode && j.indicators && j.indicators.length){
      // ---- indicator mode: Bollinger + RSI + MACD ----
      const indByT = {};
      j.indicators.forEach(r=>{ indByT[r.t]=r; });
      const val = (t,k)=>{ const r=indByT[t]; const v=r?r[k]:null; return v==null?null:v; };
      mkLine(candleData.filter(p=>val(p.time,"bb_up")!=null).map(p=>({time:p.time, value:val(p.time,"bb_up")})), "#2962FF");
      mkLine(candleData.filter(p=>val(p.time,"bb_mid")!=null).map(p=>({time:p.time, value:val(p.time,"bb_mid")})), "#9E9E9E", {lineStyle:2});
      mkLine(candleData.filter(p=>val(p.time,"bb_lo")!=null).map(p=>({time:p.time, value:val(p.time,"bb_lo")})), "#2962FF");
      chart.priceScale("rsi").applyOptions({scaleMargins:{top:0.85, bottom:0.02}});
      const rsiS = mkLine(candleData.filter(p=>val(p.time,"rsi")!=null).map(p=>({time:p.time, value:val(p.time,"rsi")})), "#7B1FA2", {priceScaleId:"rsi"});
      rsiS.createPriceLine({price:70, color:"#ef5350", lineWidth:1, lineStyle:2, axisLabelVisible:false, title:""});
      rsiS.createPriceLine({price:30, color:"#26a69a", lineWidth:1, lineStyle:2, axisLabelVisible:false, title:""});
      chart.priceScale("macd").applyOptions({scaleMargins:{top:0.68, bottom:0.18}});
      const hist = chart.addSeries(LightweightCharts.HistogramSeries, {
        priceScaleId:"macd",
        priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
      });
      hist.setData(candleData.filter(p=>val(p.time,"macd_hist")!=null).map(p=>{
        const v = val(p.time,"macd_hist");
        return {time:p.time, value:v, color: v>=0 ? "#26a69a" : "#ef5350"};
      }));
      mkLine(candleData.filter(p=>val(p.time,"macd")!=null).map(p=>({time:p.time, value:val(p.time,"macd")})), "#2962FF", {priceScaleId:"macd"});
      mkLine(candleData.filter(p=>val(p.time,"macd_sig")!=null).map(p=>({time:p.time, value:val(p.time,"macd_sig")})), "#FF6D00", {priceScaleId:"macd"});
      chart.priceScale("right").applyOptions({scaleMargins:{top:0.05, bottom:0.35}});
      const lg = document.createElement("div");
      lg.style.cssText = "position:absolute;top:6px;left:8px;font-size:11px;font-weight:700;pointer-events:none";
      lg.innerHTML = '<span style="color:#7B1FA2">RSI 14</span> · <span style="color:#2962FF">MACD</span> · <span style="color:#FF6D00">Signal</span> · <span style="color:#2962FF">BB(20,2)</span>';
      el.appendChild(lg);
    } else {
      // ---- FireAnt default: MA10/MA50 + volume(+MA5/MA10) ----
      const ma10 = smaArr(closes, 10), ma50 = smaArr(closes, 50);
      mkLine(lineData(ma10), "#26a69a");
      mkLine(lineData(ma50), "#FF9800");
      const volS = chart.addSeries(LightweightCharts.HistogramSeries, {
        priceScaleId:"vol",
        priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
      });
      volS.setData(disp.map((r,i)=>{
        const up = r.c>=r.o;
        return {time:candleData[i].time, value:r.v||0, color: up?"rgba(38,166,154,.55)":"rgba(239,83,80,.55)"};
      }));
      const vma5 = smaArr(vols, 5), vma10 = smaArr(vols, 10);
      mkLine(lineData(vma5), "#FF9800", {priceScaleId:"vol"});
      mkLine(lineData(vma10), "#26a69a", {priceScaleId:"vol"});
      chart.priceScale("right").applyOptions({scaleMargins:{top:0.05, bottom:0.30}});
      chart.priceScale("vol").applyOptions({scaleMargins:{top:0.78, bottom:0.02}});
      const last = disp[disp.length-1]||{};
      const lg = document.createElement("div");
      lg.style.cssText = "position:absolute;top:6px;left:8px;font-size:11px;font-weight:700;pointer-events:none";
      const ma10v = ma10[ma10.length-1], ma50v = ma50[ma50.length-1];
      const v5 = vma5[vma5.length-1], v10 = vma10[vma10.length-1];
      lg.innerHTML = `<span style="color:#26a69a">MA10:${ma10v!=null?ma10v.toFixed(2):"—"}</span> <span style="color:#FF9800">MA50:${ma50v!=null?ma50v.toFixed(2):"—"}</span><br>`+
        `<span style="color:#7B1FA2">VOL:${fmtN(last.v)}</span> <span style="color:#FF9800">MA5:${v5!=null?fmtN(Math.round(v5)):"—"}</span> <span style="color:#26a69a">MA10:${v10!=null?fmtN(Math.round(v10)):"—"}</span>`;
      el.appendChild(lg);
    }
    chart.timeScale().fitContent();
    renderPerfStats(rows, isIntraday);
  }catch(e){ el.innerHTML = '<div class="hint">'+esc(e.message)+'</div>'; }
}

function renderPerfStats(rows, isIntraday){
  // performance strip (1D only): 1D/1W/1M/3M/6M/1Y
  const pbox = $("stkPerf");
  if(!isIntraday && rows.length>=6){
    const periods = [["1D",1],["1W",5],["1M",22],["3M",66],["6M",132],["1Y",250]];
    const last = rows[rows.length-1].c;
    pbox.innerHTML = periods.map(([lb,back])=>{
      let v = "—", cls = "";
      if(rows.length>back && rows[rows.length-1-back].c){
        const ref = rows[rows.length-1-back].c;
        const pct = (last-ref)/ref*100;
        v = fmtPct(pct); cls = pcCls(pct);
      }
      return `<div class="pcell"><div class="pl">${lb}</div><div class="pv ${cls}">${v}</div></div>`;
    }).join("");
  } else { pbox.innerHTML = ""; }
  // stats grid
  const sbox = $("stkStats");
  const last = rows[rows.length-1], prev = rows[rows.length-2];
  if(!last){ sbox.innerHTML = ""; return; }
  const val = last.v*last.c/1e9;
  const cell = (l,v,c="")=>`<div class="scell"><span class="sl">${l}</span><span class="sv ${c}">${v}</span></div>`;
  sbox.innerHTML =
    cell(t("ref_price"), prev?prev.c.toFixed(2):"—")+
    cell(t("open_price"), last.o.toFixed(2))+
    cell(t("high_price"), last.h.toFixed(2), "up")+
    cell(t("low_price"), last.l.toFixed(2), "dn")+
    cell(t("volume"), fmtN(last.v))+
    cell(t("value"), val.toFixed(2)+" "+t("billion"));
}

async function renderScreener(){
  const box = $("stkScreener");
  if(!box) return;
  box.innerHTML = '<div class="hint">'+t("loading_screener")+'</div>';
  try{
    const ex = $("scrEx") ? $("scrEx").value : "";
    const minPct = $("scrMinPct") ? $("scrMinPct").value : "";
    const minScore = $("scrMinScore") ? $("scrMinScore").value : "";
    let url = "/screener2?";
    if(ex) url += "exchange="+encodeURIComponent(ex)+"&";
    if(minPct!=="") url += "min_score=0&"; // screener2 doesn't have min_pct, filter client-side
    if(minScore!=="") url += "min_score="+encodeURIComponent(minScore)+"&";
    const j = await sApi(url);
    let rows = j.rows||[];
    if(minPct!==""){
      const mp = parseFloat(minPct);
      rows = rows.filter(r=>r.pct_change!=null && r.pct_change>=mp);
    }
    if(!rows.length){ box.innerHTML = '<div class="hint">'+t("no_data")+'</div>'; return; }
    const top = rows.slice(0,30);
    box.innerHTML = `<table class="stktbl"><tr><th>${t("th_symbol")}</th><th>${t("th_score")}</th><th>${t("th_price")}</th><th>${t("th_pct")}</th><th>${t("th_pe")}</th></tr>` +
      top.map(r=>{
        const pc=r.pct_change, cls=pcCls(pc);
        return `<tr data-sym="${esc(r.symbol)}"><td><b>${esc(r.symbol)}</b></td><td>${r.score??"—"}</td><td>${r.close??"—"}</td><td class="${cls}">${fmtPct(pc)}</td><td>${r.pe??"—"}</td></tr>`;
      }).join("") + `</table>`;
    box.querySelectorAll("tr[data-sym]").forEach(tr=> tr.onclick = ()=>openSymbol(tr.dataset.sym));
  }catch(e){ box.innerHTML = '<div class="hint">'+t("error")+": "+esc(e.message)+'</div>'; }
}

/* ---------- backtest ---------- */
export async function runBacktest(){
  const sym = curSymbol;
  if(!sym){ toast(t("select_symbol_first")); return; }
  const fast = parseInt($("btFast").value)||20;
  const slow = parseInt($("btSlow").value)||50;
  const box = $("btResult");
  box.innerHTML = '<div class="hint">'+t("calculating")+'</div>';
  try{
    const j = await sApi(`/backtest?symbol=${encodeURIComponent(sym)}&fast=${fast}&slow=${slow}`);
    const s = j.stats;
    const cls = pcCls(s.strategy_ret>0?1:s.strategy_ret<0?-1:0);
    box.innerHTML = `<div class="stkidx"><div class="stkidx-sym">${t("bt_strategy")}</div><div class="stkidx-px ${cls}">${s.strategy_ret>0?"+":""}${s.strategy_ret}%</div></div>
      <div class="stkidx"><div class="stkidx-sym">${t("bt_buyhold")}</div><div class="stkidx-px">${s.bh_ret>0?"+":""}${s.bh_ret}%</div></div>
      <div class="stkidx"><div class="stkidx-sym">${t("bt_trades_winrate")}</div><div class="stkidx-px">${s.trades} / ${s.winrate}%</div></div>
      <div class="stkidx"><div class="stkidx-sym">${t("bt_maxdd")}</div><div class="stkidx-px dn">${s.max_drawdown}%</div></div>
      <div class="hint" style="margin-top:8px">${esc(j.note||"")}</div>
      <div id="btChart" style="width:100%;height:220px;margin-top:8px"></div>`;
    // chart
    const el = $("btChart");
    if(typeof LightweightCharts!=="undefined" && j.equity.length){
      const dark = document.body.classList.contains("dark");
      const ch = LightweightCharts.createChart(el, {
        layout:{background:{color: dark?"#1a1a1a":"#ffffff"}, textColor: dark?"#d4d4d4":"#333"},
        width: el.clientWidth, height: 220,
      });
      const s1 = ch.addSeries(LightweightCharts.LineSeries, {color:"#26a69a", lineWidth:2, title:t("bt_strategy")});
      s1.setData(j.equity.map(p=>({time:p.t, value:p.v})));
      const s2 = ch.addSeries(LightweightCharts.LineSeries, {color:"#888", lineWidth:1, lineStyle:2, title:t("bt_buyhold")});
      s2.setData(j.bh_equity.map(p=>({time:p.t, value:p.v})));
      ch.timeScale().fitContent();
    }
  }catch(e){ box.innerHTML = '<div class="hint">'+t("error")+": "+esc(e.message)+'</div>'; }
}

/* ---------- watchlist ---------- */
async function renderWatchlist(){
  const box = $("wlList");
  box.innerHTML = '<div class="hint">'+t("loading")+'</div>';
  try{
    const wl = await sApi("/watchlist");
    if(!wl.length){ box.innerHTML = '<div class="hint">'+t("wl_empty")+'</div>'; return; }
    const q = await sApi("/screener").catch(()=>({rows:[]}));
    const bySym = {};
    (q.rows||[]).forEach(r=> bySym[r.symbol]=r);
    box.innerHTML = `<table class="stktbl"><tr><th>${t("th_symbol")}</th><th>${t("th_price")}</th><th>${t("th_pct")}</th><th></th></tr>` +
      wl.map(sym=>{
        const r = bySym[sym]||{};
        const pc = r.pct_change, cls = pcCls(pc);
        return `<tr><td data-sym="${esc(sym)}" style="cursor:pointer"><b>${esc(sym)}</b></td><td>${r.close??"—"}</td><td class="${cls}">${fmtPct(pc)}</td><td><button class="btn ghost" data-del="${esc(sym)}" style="padding:4px 8px">✕</button></td></tr>`;
      }).join("") + `</table>`;
    box.querySelectorAll("[data-sym]").forEach(td=> td.onclick = ()=>openSymbol(td.dataset.sym));
    box.querySelectorAll("[data-del]").forEach(b=> b.onclick = async (e)=>{
      e.stopPropagation();
      await sApi("/watchlist/"+b.dataset.del, {method:"DELETE"});
      renderWatchlist();
    });
  }catch(e){ box.innerHTML = '<div class="hint">'+t("error")+": "+esc(e.message)+'</div>'; }
}

async function addWatchlist(){
  const inp = $("wlAddSym");
  const sym = inp.value.trim().toUpperCase();
  if(!sym) return;
  try{
    await sApi("/watchlist", {method:"POST", body:JSON.stringify({symbol:sym})});
    inp.value = "";
    toast(t("added")+sym);
    renderWatchlist();
  }catch(e){ toast(t("error")+": "+e.message); }
}


// Two-step inline delete confirm (no popup): first click arms, second click deletes.
function armDelBtn(b){
  b.dataset.armed = "1";
  b.dataset.orig = b.innerHTML;
  b.innerHTML = esc(t("confirm_yes")) + "?";
  b.classList.remove("ghost"); b.classList.add("primary");
  const c = document.createElement("button");
  c.className = "btn ghost"; c.style.cssText = "padding:4px 8px;margin-left:4px";
  c.textContent = "\u2715";
  c.setAttribute("aria-label", t("cancel"));
  c.onclick = (e)=>{ e.stopPropagation(); disarmDelBtn(b); };
  b.after(c);
  b._cancelBtn = c;
  b._outside = (e)=>{ if(e.target!==b && e.target!==c) disarmDelBtn(b); };
  document.addEventListener("click", b._outside, {capture:true, once:true});
  b._armTimer = setTimeout(()=>disarmDelBtn(b), 5000);
}
function disarmDelBtn(b){
  if(!b || !b.dataset.armed) return;
  delete b.dataset.armed;
  clearTimeout(b._armTimer);
  if(b._outside) document.removeEventListener("click", b._outside, {capture:true});
  b.innerHTML = b.dataset.orig || "\u2715";
  b.classList.add("ghost"); b.classList.remove("primary");
  if(b._cancelBtn){ b._cancelBtn.remove(); delete b._cancelBtn; }
}

/* ---------- portfolio ---------- */
async function renderPortfolio(){
  const box = $("pfPos");
  box.innerHTML = '<div class="hint">'+t("loading")+'</div>';
  try{
    const j = await sApi("/portfolio");
    // summary cards
    const sum = $("pfSum");
    if(sum){
      const un = j.total_unrealized, cls = pcCls(un>0?1:un<0?-1:0);
      sum.innerHTML = `<div class="stkidx"><div class="stkidx-sym">${t("pf_total_value")}</div><div class="stkidx-px">${fmtN(j.total_market_value)}</div></div>
        <div class="stkidx"><div class="stkidx-sym">${t("pf_unrealized")}</div><div class="stkidx-px ${cls}">${un>0?"+":""}${fmtN(un)}</div></div>
        <div class="stkidx"><div class="stkidx-sym">${t("pf_realized")}</div><div class="stkidx-px">${fmtN(j.total_realized)}</div></div>`;
    }
    // positions
    if(!j.positions.length){
      box.innerHTML = '<div class="hint">'+t("pf_no_positions")+'</div>';
    }else{
      box.innerHTML = `<table class="stktbl"><tr><th>${t("th_symbol")}</th><th>${t("th_qty")}</th><th>${t("th_avg_cost")}</th><th>${t("th_price")}</th><th>${t("th_pl")}</th><th></th></tr>` +
        j.positions.map(p=>{
          const un=p.unrealized, cls=pcCls(un>0?1:un<0?-1:0);
          return `<tr><td><b>${esc(p.symbol)}</b><div class="hint">${p.allocation??"—"}%</div></td><td>${fmtN(p.qty)}</td><td>${fmtN(p.avg_cost)}</td><td>${fmtN(p.current)}</td><td class="${cls}">${un>0?"+":""}${fmtN(un)}<div class="hint">${fmtPct(p.unrealized_pct)}</div></td><td><button class="btn ghost" data-cost="${esc(p.symbol)}" style="padding:4px 8px">Cost</button> <button class="btn ghost" data-tp="${esc(p.symbol)}" style="padding:4px 8px">TP/SL</button></td></tr>`;
        }).join("") + `</table>`;
      box.querySelectorAll("[data-cost]").forEach(b=> b.onclick = ()=>showCostChart(b.dataset.cost));
      box.querySelectorAll("[data-tp]").forEach(b=> b.onclick = ()=>setTarget(b.dataset.tp));
    }
    // history
    const hbox = $("pfHist");
    const txns = [...(j.txns||[])].reverse().slice(0,30);
    hbox.innerHTML = txns.length ? `<table class="stktbl"><tr><th>${t("th_date")}</th><th>${t("th_symbol")}</th><th>${t("th_side")}</th><th>${t("th_price")}</th><th>${t("th_qty")}</th><th></th></tr>` +
      txns.map(txn=>`<tr><td>${esc(txn.date)}</td><td><b>${esc(txn.symbol)}</b>${txn.note?`<div class="hint">${esc(txn.note)}</div>`:""}</td><td>${txn.side==="BUY"?'<span class="up">'+t("buy")+'</span>':'<span class="dn">'+t("sell")+'</span>'}</td><td>${fmtN(txn.price)}</td><td>${fmtN(txn.qty)}</td><td><button class="btn ghost" data-tnote="${txn.id}" title="Edit note" style="padding:4px 8px">Edit</button> <button class="btn ghost" data-tdel="${txn.id}" style="padding:4px 8px">✕</button></td></tr>`).join("")+`</table>`
      : '<div class="hint">'+t("no_txns")+'</div>';
    hbox.querySelectorAll("[data-tdel]").forEach(b=> b.onclick = async (ev)=>{
      ev.stopPropagation();
      if(b.dataset.armed){
        // second click within 5s -> do the delete
        disarmDelBtn(b);
        try{
          await sApi("/portfolio/txn/"+b.dataset.tdel, {method:"DELETE"});
          renderPortfolio();
        }catch(e){ toast(t("error")+": "+e.message); }
        return;
      }
      armDelBtn(b);
    });
    hbox.querySelectorAll("[data-tnote]").forEach(b=> b.onclick = ()=>{
      const tr = b.closest("tr");
      const symCell = tr.children[1];
      if(symCell.querySelector("[data-noteedit]")) return; // already editing
      const noteDiv = symCell.querySelector(".hint");
      const hasNote = !!noteDiv;
      const oldNote = hasNote ? noteDiv.textContent : "";
      const wrap = document.createElement("div");
      wrap.setAttribute("data-noteedit","");
      wrap.style.cssText = "margin-top:4px;display:flex;gap:4px";
      wrap.innerHTML = `<input type="text" class="gptInput" maxlength="500" value="${esc(oldNote)}" placeholder="${esc(t("note_ph"))}" style="flex:1;min-width:0">` +
        `<button class="btn primary" data-nsave style="padding:4px 10px;white-space:nowrap">${esc(t("save"))}</button>` +
        `<button class="btn ghost" data-ncancel style="padding:4px 8px" aria-label="${esc(t("cancel"))}">✕</button>`;
      if(hasNote) noteDiv.replaceWith(wrap); else symCell.appendChild(wrap);
      const inp = wrap.querySelector("input");
      inp.focus(); inp.select();
      wrap.querySelector("[data-ncancel]").onclick = ()=>renderPortfolio();
      wrap.querySelector("[data-nsave]").onclick = async ()=>{
        try{
          await sApi("/portfolio/txn/"+b.dataset.tnote, {method:"PUT", body:JSON.stringify({note:inp.value.slice(0,500)})});
          toast(t("note_updated"));
          renderPortfolio();
        }catch(e){ toast(t("error")+": "+e.message); }
      };
      inp.onkeydown = (e)=>{
        if(e.key==="Enter") wrap.querySelector("[data-nsave]").click();
        if(e.key==="Escape") renderPortfolio();
      };
    });
  }catch(e){ box.innerHTML = '<div class="hint">'+t("error")+": "+esc(e.message)+'</div>'; }
}

async function addTxn(){
  const sym = $("txnSym").value.trim().toUpperCase();
  const side = $("txnSide").value;
  const price = parseFloat($("txnPrice").value);
  const qty = parseFloat($("txnQty").value);
  const date = $("txnDate").value;
  const note = $("txnNote").value.trim();
  if(!sym || !(price>0) || !(qty>0) || !date){ toast(t("txn_fill")); return; }
  try{
    const r = await sApi("/portfolio/txn", {method:"POST", body:JSON.stringify({symbol:sym, side, price, qty, date, note})});
    toast(t("txn_saved_fee").replace("{fee}", fmtN(r.fee)));
    $("txnSym").value=""; $("txnPrice").value=""; $("txnQty").value=""; $("txnNote").value="";
    renderPortfolio();
  }catch(e){ toast(t("error")+": "+e.message); }
}

async function showCostChart(sym){
  try{
    const j = await sApi("/portfolio/cost_history?symbol="+encodeURIComponent(sym));
    if(!j.series.length){ toast(t("no_data2")); return; }
    const el = $("pfCostChart");
    el.style.display = "";
    el.innerHTML = "";
    if(typeof LightweightCharts==="undefined"){ el.innerHTML = '<div class="hint">'+t("chart_fail")+'</div>'; return; }
    const dark = document.body.classList.contains("dark");
    const ch = LightweightCharts.createChart(el, {
      layout:{background:{color: dark?"#1a1a1a":"#ffffff"}, textColor: dark?"#d4d4d4":"#333"},
      width: el.clientWidth, height: 220,
    });
    const mkt = ch.addSeries(LightweightCharts.LineSeries, {color:"#26a69a", lineWidth:2, title:t("series_market")});
    mkt.setData(j.series.map(p=>({time:p.time, value:p.close})));
    const avg = ch.addSeries(LightweightCharts.LineSeries, {color:"#f0b429", lineWidth:2, lineStyle:2, title:t("series_avgcost")});
    avg.setData(j.series.map(p=>({time:p.time, value:p.avg})));
    ch.timeScale().fitContent();
    el.scrollIntoView({block:"nearest"});
  }catch(e){ toast(t("error")+": "+e.message); }
}

async function setTarget(sym){
  const box = $("pfPos");
  const old = $("tpForm");
  if(old) old.remove();
  // prefill with existing targets if any
  let tpVal = "", slVal = "";
  try{
    const tg = await sApi("/targets");
    const cur = (tg||[]).find(x=>x.symbol===sym);
    if(cur){
      if(cur.take_profit_pct!=null) tpVal = cur.take_profit_pct;
      if(cur.stop_loss_pct!=null) slVal = cur.stop_loss_pct;
    }
  }catch(e){}
  const form = document.createElement("div");
  form.id = "tpForm";
  form.className = "card";
  form.style.cssText = "margin-top:8px;padding:12px";
  form.innerHTML =
    `<div style="font-weight:700;margin-bottom:8px">${esc(sym)}</div>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap">` +
    `<label style="flex:1;min-width:120px"><div class="hint">${esc(t("tp_label"))}</div><input type="number" step="any" class="gptInput" data-tpval value="${esc(String(tpVal))}" style="width:100%"></label>` +
    `<label style="flex:1;min-width:120px"><div class="hint">${esc(t("sl_label"))}</div><input type="number" step="any" class="gptInput" data-slval value="${esc(String(slVal))}" style="width:100%"></label>` +
    `</div>` +
    `<div style="display:flex;gap:8px;margin-top:10px">` +
    `<button class="btn primary" data-tpsave>${esc(t("save"))}</button>` +
    `<button class="btn ghost" data-tpcancel>${esc(t("cancel"))}</button>` +
    `</div>`;
  box.after(form);
  const tpInp = form.querySelector("[data-tpval]");
  tpInp.focus();
  form.querySelector("[data-tpcancel]").onclick = ()=>form.remove();
  form.querySelector("[data-tpsave]").onclick = async ()=>{
    const tp = tpInp.value.trim(), sl = form.querySelector("[data-slval]").value.trim();
    if(tp==="" && sl===""){ form.remove(); return; }
    try{
      await sApi("/targets", {method:"POST", body:JSON.stringify({
        symbol:sym,
        take_profit_pct: tp===""?null:parseFloat(tp),
        stop_loss_pct: sl===""?null:parseFloat(sl),
      })});
      toast(t("target_set")+sym);
      form.remove();
      try{ renderTargets(); }catch(e){}
    }catch(e){ toast(t("error")+": "+e.message); }
  };
}

// Check if current user is on free plan
let _cachedPlan = null;
async function isFreeUser(){
  try{
    if(_cachedPlan) return _cachedPlan === "free";
    const token = localStorage.getItem("elab_authToken");
    if(!token) return true;
    const r = await fetch("/api/user/plan", {headers:{"Authorization":"Bearer "+token}});
    if(!r.ok) return true;
    const j = await r.json();
    _cachedPlan = j.plan || "free";
    return _cachedPlan === "free";
  }catch(e){ return true; }
}
function showUpgradeToast(){
  toast(t("premium_locked"));
  setTimeout(()=>{ window.location.href = "/upgrade"; }, 1500);
}
/* ---------- compare ---------- */
export async function runCompare(){
  const input = $("cmpSyms").value.trim().toUpperCase();
  if(!input){ toast(t("cmp_hint")); return; }
  const syms = input.split(",").map(s=>s.trim()).filter(Boolean).slice(0,5);
  const el = $("cmpChart");
  el.innerHTML = '<div class="hint">'+t("loading")+'</div>';
  try{
    const j = await sApi("/compare?symbols="+encodeURIComponent(syms.join(","))+"&count=120");
    const series = j.series||{};
    const keys = Object.keys(series);
    if(!keys.length){ el.innerHTML = '<div class="hint">'+t("no_data")+'</div>'; return; }
    el.innerHTML = "";
    if(typeof LightweightCharts==="undefined"){ el.innerHTML = '<div class="hint">'+t("chart_fail")+'</div>'; return; }
    const dark = document.body.classList.contains("dark");
    const ch = LightweightCharts.createChart(el, {
      layout:{background:{color: dark?"#1a1a1a":"#ffffff"}, textColor: dark?"#d4d4d4":"#333"},
      width: el.clientWidth, height: 280,
    });
    const colors = ["#26a69a","#ef5350","#2962ff","#ff9800","#9c27b0"];
    keys.forEach((sym, i)=>{
      const ls = ch.addSeries(LightweightCharts.LineSeries, {color:colors[i%colors.length], lineWidth:2, title:sym});
      ls.setData(series[sym].map(p=>({time:p.t, value:p.v})));
    });
    ch.timeScale().fitContent();
  }catch(e){ el.innerHTML = '<div class="hint">'+t("error")+": "+esc(e.message)+'</div>'; }
}

/* ---------- export CSV ---------- */
async function exportCSV(kind){
  try{
    const j = await sApi("/portfolio");
    let csv, filename;
    if(kind==="positions"){
      const rows = j.positions||[];
      csv = "Symbol,Qty,Avg Cost,Current Price,Market Value,Unrealized P&L,Unrealized %,Allocation %,Realized P&L\n" +
        rows.map(p=>[p.symbol,p.qty,p.avg_cost,p.current,p.market_value,p.unrealized,p.unrealized_pct,p.allocation,p.realized].join(",")).join("\n");
      filename = "positions.csv";
    }else{
      const rows = j.txns||[];
      csv = "ID,Date,Symbol,Side,Price,Qty,Fee,Note\n" +
        rows.map(r=>[r.id,r.date,r.symbol,r.side,r.price,r.qty,r.fee,'"'+(r.note||"").replace(/"/g,'""')+'"'].join(",")).join("\n");
      filename = "transactions.csv";
    }
    const blob = new Blob(["\ufeff"+csv], {type:"text/csv;charset=utf-8"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(t("downloaded")+filename);
  }catch(e){ toast(t("error")+": "+e.message); }
}

/* ---------- alerts & targets ---------- */
async function renderAlerts(){
  const box = $("alList");
  box.innerHTML = '<div class="hint">'+t("loading")+'</div>';
  try{
    const al = await sApi("/alerts");
    box.innerHTML = al.length ? `<table class="stktbl"><tr><th>${t("th_symbol")}</th><th>${t("th_condition")}</th><th></th></tr>` +
      al.map(a=>`<tr><td><b>${esc(a.symbol)}</b></td><td>${a.direction==="ABOVE"?"≥":"≤"} ${fmtN(a.price)}</td><td><button class="btn ghost" data-adel="${a.id}" style="padding:4px 8px">✕</button></td></tr>`).join("")+`</table>`
      : '<div class="hint">'+t("no_alerts")+'</div>';
    box.querySelectorAll("[data-adel]").forEach(b=> b.onclick = async ()=>{
      await sApi("/alerts/"+b.dataset.adel, {method:"DELETE"});
      renderAlerts();
    });
  }catch(e){ box.innerHTML = '<div class="hint">'+t("error")+": "+esc(e.message)+'</div>'; }
}

async function addAlert(){
  const sym = $("alSym").value.trim().toUpperCase();
  const dir = $("alDir").value;
  const price = parseFloat($("alPrice").value);
  if(!sym || !(price>0)){ toast(t("alert_fill")); return; }
  try{
    await sApi("/alerts", {method:"POST", body:JSON.stringify({symbol:sym, direction:dir, price})});
    $("alSym").value=""; $("alPrice").value="";
    toast(t("alert_added"));
    renderAlerts();
  }catch(e){ toast(t("error")+": "+e.message); }
}

async function renderTargets(){
  const box = $("tgList");
  box.innerHTML = '<div class="hint">'+t("loading")+'</div>';
  try{
    const tg = await sApi("/targets");
    box.innerHTML = tg.length ? `<table class="stktbl"><tr><th>${t("th_symbol")}</th><th>${t("th_tp")}</th><th>${t("th_sl")}</th><th>${t("th_pl")}</th><th></th></tr>` +
      tg.map(g=>{
        const un = g.unrealized_pct, cls = pcCls(un>0?1:un<0?-1:0);
        return `<tr><td><b>${esc(g.symbol)}</b></td><td>${g.take_profit_pct??"—"}%</td><td>${g.stop_loss_pct??"—"}%</td><td class="${cls}">${fmtPct(un)}</td><td><button class="btn ghost" data-tgdel="${esc(g.symbol)}" style="padding:4px 8px">✕</button></td></tr>`;
      }).join("")+`</table>`
      : '<div class="hint">'+t("no_targets")+'</div>';
    box.querySelectorAll("[data-tgdel]").forEach(b=> b.onclick = async ()=>{
      await sApi("/targets/"+b.dataset.tgdel, {method:"DELETE"});
      renderTargets();
    });
  }catch(e){ box.innerHTML = '<div class="hint">'+t("error")+": "+esc(e.message)+'</div>'; }
}

/* ---------- language switch (called from stocks.html applyLang) ---------- */
export function setStockLang(l){
  LANG = l;
  try{ renderStockTab(); }catch(e){}
  const itg = $("indToggle");
  if(itg) itg.textContent = indMode ? t("ind_on") : t("ind_off");
  if(curSymbol){
    const d = $("stkDetail");
    if(d && d.style.display!=="none"){
      loadSymHead(curSymbol);
      if(loadedTabs[curSymbol] && loadedTabs[curSymbol].tabs) loadNewsEvents(curSymbol);
    }
  }
}
