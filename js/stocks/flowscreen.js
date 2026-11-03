/* js/stocks/flowscreen.js — P5 module 9: khoi Dong tien (v-flow) tach tu stocks.html, giu nguyen hanh vi. Classic script, nap lazy khi mo tab. */
// __FS_BEGIN__
try{
(function(){
// ---- Dòng tiền: sàng lọc dòng tiền ngày (Chốt F1-F4 27/10) ----
// Chỉ hiển thị + xác nhận. Không gate, không tín hiệu mua: thang 4
// tín hiệu chưa hiệu chuẩn, mọi cột mới chỉ để theo dõi/đối chiếu.
const FLOWSCR_I18N={
  vi:{title:"Dòng tiền",trial:"[THỬ DÒNG TIỀN]",disc:"Đo dòng tiền, không phải tín hiệu mua. Số liệu chỉ để theo dõi và đối chiếu.",screen:"Phiên sàng lọc",applies:"Áp dụng cho phiên",syms:"mã",rank:"Hạng",sym:"Mã",close:"Đóng cửa",mf20:"Ròng 20 phiên (tiền)",mf60:"Ròng 60 phiên (tiền)",mf200:"Ròng 200 phiên (tiền)",agree:"Đồng thuận 3 cửa sổ",agreeIn:"Vào rõ",agreeOut:"Ra rõ",agreeDiv:"Lệch",divNote:"Ba cửa sổ cùng chiều mới gọi là vào/ra rõ; lệch nhau thì ghi rõ là lệch — chính sự lệch là thông tin.",f20:"Ngoại ròng 20 phiên",f1:"Ngoại ròng 1 phiên",prop:"Tự doanh ròng",empty:"Chưa có dữ liệu sàng lọc dòng tiền",loadErr:"Không tải được dữ liệu dòng tiền",stale:"Mã thiếu hoặc chưa cập nhật tới phiên sàng lọc hiện “—”.",inout:"+ là vào ròng, − là ra ròng (tỷ đồng).",ty:"tỷ",tr:"triệu"},
  en:{title:"Money flow",trial:"[MONEY FLOW TRIAL]",disc:"Measures money flow, not a buy signal. Figures are for tracking and cross-checking only.",screen:"Screening session",applies:"Applies to session",syms:"symbols",rank:"Rank",sym:"Symbol",close:"Close",mf20:"Net 20 sessions (money)",mf60:"Net 60 sessions (money)",mf200:"Net 200 sessions (money)",agree:"3-window agreement",agreeIn:"Clear inflow",agreeOut:"Clear outflow",agreeDiv:"Divergent",divNote:"All three windows pointing the same way means clear inflow/outflow; when they disagree the row is marked divergent — the divergence itself is information.",f20:"Foreign net · 20 sessions",f1:"Foreign net · 1 session",prop:"Proprietary net",empty:"No money-flow screening data yet",loadErr:"Could not load money-flow data",stale:"Symbols missing or not yet updated to the screening session show “—”.",inout:"+ means net inflow, − means net outflow (B VND).",ty:"B",tr:"M"},
  zh:{title:"资金流",trial:"[资金流试用]",disc:"衡量资金流向，并非买入信号。数据仅供跟踪与核对。",screen:"筛选交易日",applies:"适用交易日",syms:"只",rank:"排名",sym:"代码",close:"收盘",mf20:"20日净额（金额）",mf60:"60日净额（金额）",mf200:"200日净额（金额）",agree:"三窗口一致性",agreeIn:"明确流入",agreeOut:"明确流出",agreeDiv:"分化",divNote:"三个窗口同向才算明确流入/流出；方向不一致时标注为分化——分化本身就是信息。",f20:"外资净额 · 20日",f1:"外资净额 · 1日",prop:"自营净额",empty:"暂无资金流筛选数据",loadErr:"无法加载资金流数据",stale:"缺失或未更新至筛选交易日的代码显示“—”。",inout:"+ 为净流入，− 为净流出（十亿越盾）。",ty:"十亿",tr:"百万"},
  ko:{title:"자금 흐름",trial:"[자금 흐름 시범]",disc:"자금 흐름을 측정할 뿐 매수 신호가 아닙니다. 수치는 추적 및 대조용입니다.",screen:"스크리닝 거래일",applies:"적용 거래일",syms:"종목",rank:"순위",sym:"종목",close:"종가",mf20:"20거래일 순매수(금액)",mf60:"60거래일 순매수(금액)",mf200:"200거래일 순매수(금액)",agree:"3구간 일치",agreeIn:"명확 유입",agreeOut:"명확 유출",agreeDiv:"엇갈림",divNote:"세 구간이 같은 방향일 때만 명확한 유입/유출이며, 방향이 다르면 엇갈림으로 표시합니다. 엇갈림 자체가 정보입니다.",f20:"외국인 순매수 · 20거래일",f1:"외국인 순매수 · 1거래일",prop:"자전 순매수",empty:"자금 흐름 스크리닝 데이터 없음",loadErr:"자금 흐름 데이터를 불러오지 못했습니다",stale:"누락되었거나 스크리닝 거래일까지 업데이트되지 않은 종목은 “—”로 표시됩니다.",inout:"+는 순유입, −는 순유출입니다(십억 동).",ty:"십억",tr:"백만"},
};
let _flowScr=null;
const _fsSigned=(v,d)=>{ if(v==null||!isFinite(Number(v))) return "—"; const n=Number(v); return (n>0?"+":"")+n.toFixed(d); };
const _fsAgree=(r,L)=>{ const sg=[]; for(const v of [r.mf20_val,r.mf60_val,r.mf200_val]){ if(v==null||!isFinite(Number(v))||Number(v)===0) continue; sg.push(Number(v)>0?1:-1); } if(sg.length<2) return {t:"—",c:""}; if(sg.every(x=>x===1)) return {t:L.agreeIn,c:"up"}; if(sg.every(x=>x===-1)) return {t:L.agreeOut,c:"down"}; return {t:L.agreeDiv,c:""}; };
async function loadFlowScreen(){
  const body=$("flowTableBody");
  try{
    const j=await api("/flow-screen");
    _flowScr=j; renderFlowScreen(j);
  }catch(e){
    const L=FLOWSCR_I18N[curLang]||FLOWSCR_I18N.vi;
    if(body) body.innerHTML=`<tr><td colspan="17"><div class="hint">${L.loadErr}</div></td></tr>`;
  }
}
function renderFlowScreen(j){
  const L=FLOWSCR_I18N[curLang]||FLOWSCR_I18N.vi;
  const t=$("flowTitle"); if(t) t.textContent=L.title;
  const tr=$("flowTrial"); if(tr) tr.textContent=L.trial;
  const src=$("flowSrc"); if(src) src.textContent=j.screen_date||"";
  const head=$("flowHead");
  if(head) head.textContent=j.available?`${L.screen}: ${j.screen_date||"—"} · ${L.applies}: ${j.for_date||"—"} · ${j.count} ${L.syms}`:`${L.screen}: ${j.screen_date||"—"}`;
  const tt=$("flowTableT"); if(tt) tt.textContent=L.title;
  const th=$("flowTableHead"), body=$("flowTableBody");
  const cols=[L.rank,L.sym,L.close,L.mf20,"CMF20","OBV20",L.mf60,"CMF60","OBV60",L.mf200,"CMF200","OBV200","MFI14",L.f20,L.f1,L.prop,L.agree];
  if(th) th.innerHTML="<tr>"+cols.map((c,i)=>`<th${i>1?" style=\"text-align:right\"":""}>${esc(c)}</th>`).join("")+"</tr>";
  const rows=(j&&j.rows)||[];
  if(!j.available||!rows.length){
    if(body) body.innerHTML=`<tr><td colspan="17"><div class="hint">${L.empty}</div></td></tr>`;
  }else{
    const cls=v=>v==null?"":(Number(v)>0?"up":Number(v)<0?"down":"");
    const ty=v=>fmtTyF(v,L,true);
    if(body) body.innerHTML=rows.map(r=>{ const ag=_fsAgree(r,L); return `<tr><td>${r.rank}</td><td><a href="#" onclick="openSym('${esc(r.symbol)}');return false"><b>${esc(r.symbol)}</b></a></td><td style="text-align:right">${fmtN(r.close)}</td><td style="text-align:right"><b class="${cls(r.mf20_val)}">${ty(r.mf20_val)}</b></td><td style="text-align:right" class="${cls(r.cmf20)}">${_fsSigned(r.cmf20,3)}</td><td style="text-align:right" class="${cls(r.obv20)}">${_fsSigned(r.obv20,2)}</td><td style="text-align:right" class="${cls(r.mf60_val)}">${ty(r.mf60_val)}</td><td style="text-align:right" class="${cls(r.cmf60)}">${_fsSigned(r.cmf60,3)}</td><td style="text-align:right" class="${cls(r.obv60)}">${_fsSigned(r.obv60,2)}</td><td style="text-align:right" class="${cls(r.mf200_val)}">${ty(r.mf200_val)}</td><td style="text-align:right" class="${cls(r.cmf200)}">${_fsSigned(r.cmf200,3)}</td><td style="text-align:right" class="${cls(r.obv200)}">${_fsSigned(r.obv200,2)}</td><td style="text-align:right">${r.mfi14==null?"—":Number(r.mfi14).toFixed(1)}</td><td style="text-align:right" class="${cls(r.foreign_net20_val)}">${ty(r.foreign_net20_val)}</td><td style="text-align:right" class="${cls(r.foreign_net1_val)}">${ty(r.foreign_net1_val)}</td><td style="text-align:right" class="${cls(r.prop_net_val)}">${ty(r.prop_net_val)}</td><td style="text-align:right" class="${ag.c}">${esc(ag.t)}</td></tr>`; }).join("");
  }
  const note=$("flowNote");
  if(note) note.textContent=L.disc+" "+L.inout+" "+L.divNote+" "+L.stale;
}
  if(typeof window!=="undefined"){ window.loadFlowScreen=loadFlowScreen; window.renderFlowScreen=renderFlowScreen;
    window.__fsTest={i18n:FLOWSCR_I18N,load:loadFlowScreen,render:renderFlowScreen,rerender:function(){ if(_flowScr) renderFlowScreen(_flowScr); }}; }
})();
}catch(e){}
// __FS_END__
