/* js/stocks/holders.js — P5 module 5: khoi Co dong (v-holders) tach tu stocks.html, giu nguyen hanh vi. Classic script, nap lazy khi mo tab. */
// __HOLD_BEGIN__
try{
(function(){
// ---- Co dong: tra cuu nguoc (GET /holders + /holders/shard) ----
const HOLD_I18N={
  vi:{searchPh:"Tìm theo tên cổ đông…",total:"Tổng cổ phần nắm giữ",symbols:"Số mã",holdings:"Các mã nắm giữ",back:"‹ Quay lại danh sách",empty:"Không tìm thấy cổ đông khớp",nodata:"Cổ đông này chưa có trong chỉ mục đã thu thập",updated:"Cập nhật",cov:(c,t)=>`Chỉ mục đã thu thập: ${c}/${t} mã có dữ liệu cổ đông`,found:n=>`${n} cổ đông`,top:"Nắm giữ lớn nhất",INDIVIDUAL:"Cá nhân",CORPORATE:"Tổ chức"},
  en:{searchPh:"Search by shareholder name…",total:"Total shares held",symbols:"Symbols",holdings:"Holdings",back:"‹ Back to list",empty:"No matching shareholder",nodata:"This shareholder is not in the collected index yet",updated:"Updated",cov:(c,t)=>`Index coverage: ${c}/${t} symbols with shareholder data`,found:n=>`${n} shareholders`,top:"Largest holders",INDIVIDUAL:"Individual",CORPORATE:"Organization"},
  zh:{searchPh:"按股东姓名搜索…",total:"持有股份总数",symbols:"股票数",holdings:"持股明细",back:"‹ 返回列表",empty:"未找到匹配的股东",nodata:"该股东尚未收录于已采集索引",updated:"更新于",cov:(c,t)=>`索引覆盖:${c}/${t} 只股票有股东数据`,found:n=>`${n} 位股东`,top:"持股最多",INDIVIDUAL:"个人",CORPORATE:"机构"},
  ko:{searchPh:"주주 이름으로 검색…",total:"총 보유 주식",symbols:"종목 수",holdings:"보유 종목",back:"‹ 목록으로",empty:"일치하는 주주가 없습니다",nodata:"이 주주는 아직 수집된 인덱스에 없습니다",updated:"업데이트",cov:(c,t)=>`인덱스 커버리지: 주주 데이터가 있는 ${c}/${t} 종목`,found:n=>`주주 ${n}명`,top:"최다 보유",INDIVIDUAL:"개인",CORPORATE:"기관"},
};
function holdNorm(s){
  return (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/đ/g,"d").replace(/Đ/g,"D")
    .replace(/\s+/g," ").trim().toUpperCase();
}
let HOLD_IDX=null, HOLD_SHARDS={}, HOLD_CUR=null, HOLD_LOADING=null;
async function loadHolders(){
  const L=HOLD_I18N[curLang]||HOLD_I18N.vi;
  const q=$("holdQ");
  if(q){ q.placeholder=L.searchPh;
    if(!q.dataset.wired){ q.dataset.wired=1;
      q.addEventListener("input",()=>renderHoldList()); } }
  if(HOLD_IDX){ renderHoldList(); return; }
  if(!HOLD_LOADING){
    HOLD_LOADING=api("/holders").then(j=>{
      HOLD_IDX=j; const m=j.meta||{};
      const c=$("holdCov");
      if(c) c.textContent=L.cov(fmtN(m.covered||0),fmtN(m.total||0));
    }).catch(()=>{ const b=$("holdList");
      if(b) b.innerHTML='<div class="hint">Lỗi tải</div>'; });
  }
  await HOLD_LOADING;
  if(HOLD_IDX) renderHoldList();
}
function renderHoldList(){
  const L=HOLD_I18N[curLang]||HOLD_I18N.vi;
  const box=$("holdList"); if(!box||!HOLD_IDX) return;
  $("holdDetail").style.display="none"; $("holdListWrap").style.display="";
  const qn=holdNorm(($("holdQ")||{}).value||"");
  let rows=HOLD_IDX.rows||[];
  if(qn) rows=rows.filter(r=>r.q.includes(qn));
  const total=rows.length;
  rows=rows.slice(0,50);
  const head=qn?L.found(total):L.top;
  box.innerHTML=`<div class="hint" style="padding:4px 0 8px">${head}${total>rows.length?" · "+rows.length:""}</div>`+
    (rows.length?`<table>${rows.map(r=>`<tr>
      <td><a href="#" onclick="openHolder('${r.id}');return false" style="color:var(--pp-accent);text-decoration:none"><b>${esc(r.name)}</b></a><div style="font-size:12px;color:var(--pp-mut)">${L[r.t]||r.t||""}</div></td>
      <td style="text-align:right">${fmtN(r.tot)}<div style="font-size:12px;color:var(--pp-mut)">${r.n} ${L.symbols}</div></td></tr>`).join("")}</table>`
    :`<div class="hint">${L.empty}</div>`);
}
async function openHolder(id){
  const L=HOLD_I18N[curLang]||HOLD_I18N.vi;
  const sh=id.slice(0,2);
  if(!HOLD_SHARDS[sh]){
    try{ HOLD_SHARDS[sh]=await api("/holders/shard?s="+sh); }
    catch(e){ HOLD_SHARDS[sh]={}; }
  }
  const h=(HOLD_SHARDS[sh]||{})[id];
  const box=$("holdDetail");
  $("holdListWrap").style.display="none"; box.style.display="";
  if(!h){ box.innerHTML=`<div class="card"><div class="hint">${L.nodata}</div></div>`+
    `<div style="padding:10px 2px"><a href="#" onclick="renderHoldList();return false" style="color:var(--pp-accent);text-decoration:none">${L.back}</a></div>`; return; }
  HOLD_CUR=id;
  let s=`<div style="padding:2px 2px 8px"><a href="#" onclick="renderHoldList();return false" style="color:var(--pp-accent);text-decoration:none">${L.back}</a></div>
  <div class="card">
    <div style="font-size:17px;font-weight:600">${esc(h.name)}</div>
    <div style="font-size:12px;color:var(--pp-mut)">${L[h.t]||h.t||""}</div>
    <div class="row" style="margin-top:6px"><span class="k">${L.total}</span><span class="v" style="font-size:17px">${fmtN(h.tot)}</span></div>
    <div class="row"><span class="k">${L.symbols}</span><span class="v">${(h.holds||[]).length}</span></div>
  </div>
  ${insBox(h.insight, INS_SRC.hold[curLang]||INS_SRC.hold.vi, (h.holds||[]).map(x=>x.date||"").sort().slice(-1)[0]||null)}
  <div class="sec">${L.holdings}</div>
  <div class="card"><table>${(h.holds||[]).map(x=>`<tr>
    <td><a href="#" onclick="openSym('${x.symbol}');return false"><b>${x.symbol}</b></a>${x.position?`<div style="font-size:12px;color:var(--pp-mut)">${esc(x.position)}</div>`:""}</td>
    <td style="text-align:right">${fmtN(x.quantity)}<div style="font-size:12px;color:var(--pp-mut)">${x.pct==null?"—":(x.pct*100).toFixed(2).replace(".",",")+"%"}</div></td>
    <td style="text-align:right;color:var(--pp-mut);font-size:12px">${(x.date||"").slice(0,10)}</td></tr>`).join("")}</table></div>`;
  box.innerHTML=s;
}
async function openHolderByName(name){
  go('v-holders');
  const L=HOLD_I18N[curLang]||HOLD_I18N.vi;
  if(!HOLD_IDX){ await loadHolders(); }
  const qn=holdNorm(name);
  const row=(HOLD_IDX.rows||[]).find(r=>r.q===qn);
  if(row){ openHolder(row.id); }
  else{
    $("holdListWrap").style.display="none";
    const box=$("holdDetail"); box.style.display="";
    box.innerHTML=`<div class="card"><div style="font-size:17px;font-weight:600">${esc(name)}</div><div class="hint" style="padding-top:6px">${L.nodata}</div></div>`+
    `<div style="padding:10px 2px"><a href="#" onclick="renderHoldList();return false" style="color:var(--pp-accent);text-decoration:none">${L.back}</a></div>`;
  }
}
  if(typeof window!=="undefined"){ window.loadHolders=loadHolders; window.renderHoldList=renderHoldList; window.openHolder=openHolder; window.openHolderByName=openHolderByName;
    window.__holdTest={i18n:HOLD_I18N,load:loadHolders,render:renderHoldList,open:openHolder,byName:openHolderByName}; }
})();
}catch(e){}
// __HOLD_END__
