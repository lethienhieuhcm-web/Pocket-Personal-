/* js/stocks/watchlist.js — bloc Watchlist dem tren man Thi truong: cho nguoi
   dung SEE cac ma bo loc dem (flow_screen_daily.py) dang nam trong danh sach,
   kem phien sang loc va phien ap dung. Doc duong GET /api/stock/flow-screen
   da ton tai (public) — khong them lane, khong them secret, khong gate.
   Classic script, nap lazy khi mo Thi truong (giong flowscreen.js). */
// __WL_BEGIN__
try{
(function(){
const WL_I18N={
  vi:{title:"Watchlist đêm",badge:"BỘ LỌC ĐÊM",syms:"mã",screen:"Sàng lọc",applies:"Áp dụng",empty:"Chưa có watchlist — bộ lọc đêm chưa công bố danh sách",loadErr:"Không tải được watchlist",stale:"Bản công bố gần nhất đã cũ so với phiên hôm nay — có thể bộ lọc đêm chưa chạy hoặc chưa được đẩy lên.",note:"Danh sách mã do bộ lọc đêm chọn theo dòng tiền, để theo dõi ở phiên kế tiếp — không phải tín hiệu mua. Chạm một mã để mở chi tiết."},
  en:{title:"Night watchlist",badge:"NIGHT FILTER",syms:"symbols",screen:"Screened",applies:"Applies",empty:"No watchlist yet — the night filter has not published a list",loadErr:"Could not load the watchlist",stale:"The latest published list is older than today's session — the night filter may not have run or been pushed.",note:"Symbols picked by the night filter on money flow, to track in the next session — not a buy signal. Tap a symbol to open details."},
  zh:{title:"夜间自选",badge:"夜间筛选",syms:"只",screen:"筛选于",applies:"适用于",empty:"暂无自选名单——夜间筛选尚未公布",loadErr:"无法加载自选名单",stale:"最新公布的名单早于今日交易——夜间筛选可能未运行或未上传。",note:"名单由夜间筛选按资金流选出，供下一交易日跟踪——并非买入信号。点击代码查看详情。"},
  ko:{title:"야간 워치리스트",badge:"야간 필터",syms:"종목",screen:"스크리닝",applies:"적용",empty:"워치리스트 없음 — 야간 필터가 목록을 발표하지 않았습니다",loadErr:"워치리스트를 불러오지 못했습니다",stale:"마지막 공개 목록이 오늘 거래일보다 오래되었습니다 — 야간 필터가 실행되지 않았거나 업로드되지 않았을 수 있습니다.",note:"야간 필터가 자금 흐름으로 고른 종목 목록입니다. 다음 거래일에서 추적용이며 매수 신호가 아닙니다. 종목을 눌러 상세를 여세요."}
};
let _wl=null;
const _wlLang=()=>{ try{ return WL_I18N[curLang] || WL_I18N.vi; }catch(e){ return WL_I18N.vi; } };
const _wlSymOk=(s)=>/^[A-Z0-9]{3,10}$/.test(String(s||""));
const _wlTodayISO=()=>{ const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
// So "YYYY-MM-DD" bang chuoi: dinh dang ISO => thu tu tu dien = thu tu thoi gian.
const _wlStale=(forDate,today)=>{ if(!/^\d{4}-\d{2}-\d{2}$/.test(String(forDate||""))) return false; return forDate < (today||_wlTodayISO()); };
function _wlHint(el,text){
  if(!el) return;
  el.textContent="";
  const d=document.createElement("div"); d.className="hint"; d.textContent=text;
  el.appendChild(d);
}
async function loadFlowWatchlist(){
  try{
    const j=await api("/flow-screen");
    _wl=j; renderWatchlist(j);
  }catch(e){
    _wl=null;
    _wlHint($("wlChips"),_wlLang().loadErr);
    const h=$("wlHead"); if(h) h.textContent="";
  }
}
function renderWatchlist(j){
  const L=_wlLang();
  const t=$("wlSecT"); if(t) t.textContent=L.title;
  const b=$("wlBadge"); if(b) b.textContent=L.badge;
  const chips=$("wlChips"), head=$("wlHead"), note=$("wlNote");
  const syms=((j&&j.rows)||[]).map(r=>String((r&&r.symbol)||"").toUpperCase()).filter(_wlSymOk);
  if(!j||!j.available||!syms.length){
    if(head) head.textContent="";
    _wlHint(chips,L.empty);
    if(note) note.textContent=L.note;
    return;
  }
  if(head) head.textContent=L.screen+": "+(j.screen_date||"—")+" · "+L.applies+": "+(j.for_date||"—")+" · "+(j.count==null?syms.length:j.count)+" "+L.syms;
  if(chips){
    chips.textContent="";
    for(const s of syms){
      const a=document.createElement("a");
      a.className="chipq"; a.href="#"; a.textContent=s;
      a.onclick=(ev)=>{ ev.preventDefault(); try{ openSym(s); }catch(e){} };
      chips.appendChild(a);
    }
  }
  if(note) note.textContent=L.note+(_wlStale(j.for_date)?(" "+L.stale):"");
}
  if(typeof window!=="undefined"){ window.loadFlowWatchlist=loadFlowWatchlist; window.renderWatchlist=renderWatchlist;
    window.__wlTest={i18n:WL_I18N,render:renderWatchlist,stale:_wlStale,symOk:_wlSymOk,rerender:function(){ if(_wl) renderWatchlist(_wl); }}; }
})();
}catch(e){}
// __WL_END__
