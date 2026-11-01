/* js/stocks/profile.js — P5 module 13: Ho so ma tach tu stocks.html, giu nguyen hanh vi. LAZY qua loadStockMod (theo detail — loadDetail nap khi mo ma). */
/* Goi tu detail.js (loadDetail) qua loadStockMod, khong goi truc tiep. Cac ham xuat window.loadProfile/loadEvents/loadTarget/loadCost/loadFund de detail.js goi. */
// __PF_BEGIN__
try{
(function(){
let EVST={items:[],f:"all",n:10};
function evIsIns(n){return String(n.name||"").indexOf("Giao dịch nội bộ")===0;}
function evFiltered(){
  if(EVST.f==="corp")return EVST.items.filter(x=>!evIsIns(x));
  if(EVST.f==="ins")return EVST.items.filter(x=>evIsIns(x));
  return EVST.items;
}
function paintEvents(){
  const box=$("dEvents");const L=BL();
  const all=EVST.items;
  const nCorp=all.filter(x=>!evIsIns(x)).length;
  const nIns=all.length-nCorp;
  const list=evFiltered();
  const chip=(k,lb,cnt)=>`<button data-evf="${k}" style="padding:5px 11px;border-radius:99px;border:1px solid ${EVST.f===k?"var(--pp-accent)":"var(--pp-line)"};background:${EVST.f===k?"var(--pp-accent)":"var(--pp-bg2)"};color:${EVST.f===k?"#fff":"var(--pp-ink)"};font-size:12px;font-weight:600;cursor:pointer">${lb} · ${cnt}</button>`;
  let h=`<div style="display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 4px">${chip("all",L.evAll,all.length)}${chip("corp",L.evCorp,nCorp)}${chip("ins",L.evIns,nIns)}</div>`;
  if(!list.length){box.innerHTML=h+'<div class="hint">'+L.noEv+'</div>';}
  else{
    h+=list.slice(0,EVST.n).map(n=>{
      const pay=n.payout_date&&/^\d{4}-\d{2}-\d{2}/.test(String(n.payout_date))?String(n.payout_date).slice(0,10):"";
      return `<div style="padding:7px 0;border-bottom:1px solid var(--pp-line)"><div style="font-size:14px;font-weight:600">${esc(n.title||n.name||"")}</div><div style="font-size:12px;color:var(--pp-mut);margin-top:2px">${esc(n.name||"")}${n.date?" · "+esc(String(n.date).slice(0,10)):""}${n.exright_date?" · Ex: "+esc(String(n.exright_date).slice(0,10)):""}${pay?" · "+L.evPay+": "+pay:""}</div></div>`;
    }).join("");
    if(list.length>EVST.n)h+=`<button id="evMore" style="width:100%;margin-top:8px;padding:8px;border-radius:8px;background:var(--pp-bg2);color:var(--pp-ink);border:1px solid var(--pp-line);font-size:12px;font-weight:600;cursor:pointer">${L.evMore} (${Math.min(EVST.n,list.length)}/${list.length})</button>`;
    box.innerHTML=h;
  }
  box.querySelectorAll("[data-evf]").forEach(b=>{b.onclick=()=>{EVST.f=b.getAttribute("data-evf");EVST.n=10;paintEvents();};});
  const m=$("evMore");if(m)m.onclick=()=>{EVST.n+=20;paintEvents();};
}
const PROF_I18N={
  vi:{holders:"Cổ đông lớn",officers:"Ban lãnh đạo",subs:"Công ty con / liên kết",capital:"Vốn điều lệ",own:"Cơ cấu sở hữu",shares:"CP",empty:"Chưa có dữ liệu hồ sơ",ty:"tỷ"},
  en:{holders:"Major shareholders",officers:"Management",subs:"Subsidiaries / affiliates",capital:"Charter capital",own:"Ownership structure",shares:"shares",empty:"No profile data yet",ty:"B"},
  zh:{holders:"主要股东",officers:"管理层",subs:"子公司 / 关联公司",capital:"注册资本",own:"股权结构",shares:"股",empty:"暂无档案数据",ty:"十亿"},
  ko:{holders:"주요 주주",officers:"경영진",subs:"자회사 / 관계사",capital:"자본금",own:"지분 구조",shares:"주",empty:"프로필 데이터 없음",ty:"십억"},
};
async function loadProfile(sym){
  const box=$("dProf"); if(!box) return;
  box.innerHTML='<div class="card"><div class="hint">Đang tải…</div></div>';
  try{
    const j=await api("/company/profile?symbol="+encodeURIComponent(sym));
    renderProfile(j);
  }catch(e){ box.innerHTML='<div class="card"><div class="hint">Lỗi tải</div></div>'; }
}
function renderProfile(j){
  const box=$("dProf"); if(!box) return;
  window._lastProfile=j; renderFaPctGrid();
  const L=PROF_I18N[curLang]||PROF_I18N.vi;
  const pct=v=>v==null?"—":Number(v).toFixed(2).replace(".",",")+"%";
  const pctF=v=>v==null?"—":pct(v<=1?v*100:v);
  let h="";
  const sh=(j.shareholders||[]).slice().sort((a,b)=>(b.shares_owned||0)-(a.shares_owned||0)).slice(0,10);
  if(sh.length) h+=`<div class="sec" id="dSecHolders">${L.holders}</div><div class="card"><table>${sh.map(r=>`<tr><td><a href="#" onclick="openHolderByNameLazy('${(r.name||"").replace(/\\/g,"").replace(/'/g,"\\'")}');return false" style="color:var(--pp-accent);text-decoration:none">${esc(r.name||"")}</a></td><td style="text-align:right">${fmtN(r.shares_owned)} ${L.shares}</td><td style="text-align:right">${pct(r.ownership_percentage)}</td></tr>`).join("")}</table></div>`;
  h+=`<div id="dHoldIns"></div>`;
  const of=j.officers||[];
  if(of.length) h+=`<div class="sec">${L.officers}</div><div class="card"><table>${of.map(r=>`<tr><td>${esc(r.name||"")}</td><td style="text-align:right;color:var(--pp-mut)">${esc(r.position||"")}</td><td style="text-align:right">${r.total_shares?fmtN(r.total_shares)+" "+L.shares:"—"}</td></tr>`).join("")}</table></div>`;
  const sb=j.subsidiaries||[];
  if(sb.length) h+=`<div class="sec">${L.subs}</div><div class="card"><table>${sb.map(r=>`<tr><td>${esc(r.name||"")}${r.sub_symbol?' <span style="color:var(--pp-mut)">('+esc(r.sub_symbol)+")</span>":""}</td><td style="text-align:right">${pctF(r.rate)}</td></tr>`).join("")}</table></div>`;
  const ow=(j.ownership||[]).filter(r=>r&&(r.name||r.shareholder_type||r.type)&&(r.percentage!=null||r.rate!=null));
  if(ow.length) h+=`<div class="sec">${L.own}</div><div class="card"><table>${ow.map(r=>`<tr><td>${esc(r.name||r.shareholder_type||r.type||"")}</td><td style="text-align:right">${pctF(r.percentage!=null?r.percentage:r.rate)}</td></tr>`).join("")}</table></div>`;
  const ch=(j.capital_history||[]).slice(0,5);
  if(ch.length) h+=`<div class="sec">${L.capital}</div><div class="card"><table>${ch.map(r=>`<tr><td>${esc(r.date||"")}</td><td style="text-align:right">${r.charter_capital?(Number(r.charter_capital)/1e9).toLocaleString("vi-VN",{maximumFractionDigits:0})+" "+L.ty:"—"}</td></tr>`).join("")}</table></div>`;
  box.innerHTML=h||`<div class="card"><div class="hint">${L.empty}</div></div>`;
  loadHolderSymInsight(window.curSym);
}
async function loadHolderSymInsight(sym){
  const el=$("dHoldIns"); if(!el||!sym) return;
  try{
    const j=await api("/holders/symbol?symbol="+encodeURIComponent(sym));
    el.innerHTML=window.insBox(j.insight, window.INS_SRC.hold[curLang]||window.INS_SRC.hold.vi, j.as_of);
  }catch(e){ el.innerHTML=""; }
}
async function loadEvents(sym){
  const box=$("dEvents");box.innerHTML='<div class="hint">Đang tải…</div>';
  EVST={items:[],f:"all",n:10};
  try{
    const j=await api("/events?symbol="+encodeURIComponent(sym));
    EVST.items=j.items||[];
    if(!EVST.items.length){box.innerHTML='<div class="hint">'+BL().noEv+'</div>';return;}
    paintEvents();
  }catch(e){box.innerHTML='<div class="hint">'+BL().noEv+'</div>';}
}
async function loadTarget(sym){
  const box=$("dTarget");const L=BL();
  try{
    const list=await api("/targets");
    const t=(list||[]).find(x=>x.symbol===sym);
    const cur=t?((t.take_profit_pct!=null?("TP +"+t.take_profit_pct+"%"):"")+(t.take_profit_pct!=null&&t.stop_loss_pct!=null?" · ":"")+(t.stop_loss_pct!=null?("SL −"+t.stop_loss_pct+"%"):"")):L.curNone;
    box.innerHTML=`<div class="row"><span class="k">${esc(cur)}</span>${t&&t.unrealized_pct!=null?`<span class="v ${t.unrealized_pct>0?"up":t.unrealized_pct<0?"down":""}">${t.unrealized_pct>0?"+":""}${t.unrealized_pct}%</span>`:""}</div>
    <div style="display:flex;gap:8px;margin-top:8px">
    <input id="tgTp" type="number" min="0" step="0.5" placeholder="${L.tpPh}" value="${t&&t.take_profit_pct!=null?t.take_profit_pct:""}" style="flex:1;min-width:0;background:var(--pp-bg2);color:var(--pp-ink);border:1px solid var(--pp-line);border-radius:8px;padding:8px;font-size:14px">
    <input id="tgSl" type="number" min="0" step="0.5" placeholder="${L.slPh}" value="${t&&t.stop_loss_pct!=null?t.stop_loss_pct:""}" style="flex:1;min-width:0;background:var(--pp-bg2);color:var(--pp-ink);border:1px solid var(--pp-line);border-radius:8px;padding:8px;font-size:14px">
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
    <button id="tgSave" style="flex:1;padding:9px;border-radius:8px;background:var(--pp-accent);color:#fff;border:none;font-size:14px;font-weight:600;cursor:pointer">${L.save}</button>
    ${t?`<button id="tgDel" style="padding:9px 14px;border-radius:8px;background:var(--pp-bg2);color:var(--pp-ink);border:1px solid var(--pp-line);font-size:14px;cursor:pointer">${L.del}</button>`:""}
    </div><div class="hint" id="tgMsg" style="padding-top:6px"></div>`;
    $("tgSave").onclick=async()=>{
      const tp=parseFloat($("tgTp").value),sl=parseFloat($("tgSl").value);
      const body={symbol:sym};
      if(!isNaN(tp))body.take_profit_pct=tp;
      if(!isNaN(sl))body.stop_loss_pct=sl;
      try{await apip("/targets","POST",body);$("tgMsg").textContent=L.saved;loadTarget(sym);}
      catch(e){$("tgMsg").textContent="⚠ "+e.message;}
    };
    const del=$("tgDel");
    if(del)del.onclick=async()=>{try{await apip("/targets/"+sym,"DELETE");loadTarget(sym);}catch(e){}};
  }catch(e){box.innerHTML='<div class="hint">—</div>';}
}
function twoLineSvg(series){
  const W=340,H=130;let hi=-1e18,lo=1e18;
  for(const r of series){hi=Math.max(hi,r.avg,r.close);lo=Math.min(lo,r.avg,r.close);}
  const pad=(hi-lo)*0.08||1;hi+=pad;lo-=pad;
  const X=i=>series.length<2?0:i/(series.length-1)*W, Y=v=>H-(v-lo)/(hi-lo)*H;
  const path=k=>series.map((r,i)=>(i?"L":"M")+X(i).toFixed(1)+","+Y(r[k]).toFixed(1)).join(" ");
  let s=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">`;
  for(let i=1;i<4;i++){const y=(H*i/4).toFixed(1);s+=`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(140,140,140,.25)"/>`;}
  s+=`<path d="${path("close")}" fill="none" stroke="#2563eb" stroke-width="1.6"/><path d="${path("avg")}" fill="none" stroke="#f59e0b" stroke-width="1.6" stroke-dasharray="5 3"/></svg>`;
  return s;
}
async function loadCost(sym){
  const sec=$("dCostSec"),box=$("dCost");
  try{
    const j=await api("/portfolio/cost_history?symbol="+encodeURIComponent(sym));
    const s=j.series||[];
    if(s.length<2){sec.style.display="none";box.style.display="none";return;}
    sec.style.display="";box.style.display="";
    box.innerHTML=twoLineSvg(s)+`<div style="font-size:12px;color:var(--pp-mut);margin-top:4px"><span style="color:#f59e0b">- - ${BL().avgCost}</span> · <span style="color:#2563eb">— ${BL().mktClose}</span> · ${esc(s[0].time)} → ${esc(s[s.length-1].time)}</div>`;
  }catch(e){sec.style.display="none";box.style.display="none";}
}
async function loadFund(sym){
  try{
    const j=await api("/fundamentals?symbol="+encodeURIComponent(sym));
    const f=j.fundamentals||j; window._lastFund=f; renderFaPctGrid();
    const row=(k,v,cls)=>`<div class="row"><span class="k">${k}</span><span class="v ${cls||""}">${v}</span></div>`;
    $("dRatios").innerHTML=row("P/E",f.pe_ttm!=null?Number(f.pe_ttm).toFixed(1):"—")+row("P/B",f.pb!=null?Number(f.pb).toFixed(1):"—")+row("ROE",f.roe_ttm!=null?Number(f.roe_ttm).toFixed(1)+"%":"—","up")+row("ROA",f.roa_ttm!=null?Number(f.roa_ttm).toFixed(1)+"%":"—")+row("Nợ / Vốn chủ",f.de_ratio!=null?Number(f.de_ratio).toFixed(2):"—");
  }catch(e){}
  loadFs(sym);
}
// ---- BCTC: bang theo loai (IS=KQKD, BS=CDKT, CF=LCTT) + tai CSV/Excel ----
let _fsData=null, _fsType="IS", _fsSym="";
const FS_TNAME={IS:"KQKD",BS:"CDKT",CF:"LCTT"};
function fsRawVal(r,p){ const v=r.v?r.v[p]:null; if(v==null) return null; return /EARNINGS_PER_SHARE/.test(r.id)?v:v/1e9; }
function fmtFsVal(r,p){ const v=fsRawVal(r,p); return v==null?"—":Number(v).toLocaleString("vi-VN",{maximumFractionDigits:2}); }
async function loadFs(sym){
  _fsSym=sym; _fsData=null;
  try{
    _fsData=await api("/statements?symbol="+encodeURIComponent(sym));
    renderFs();
  }catch(e){
    $("dFsTbl").innerHTML='<div class="hint">Chưa có dữ liệu báo cáo</div>';
  }
}
function renderFs(){
  if(!_fsData) return;
  const rows=(_fsData.types&&_fsData.types[_fsType])||[];
  const periods=_fsData.periods||[];
  if(!rows.length){ $("dFsTbl").innerHTML='<div class="hint">Chưa có dữ liệu báo cáo</div>'; return; }
  let h='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><tr><th style="text-align:left;padding:4px 2px"></th>'+periods.map(p=>`<th style="text-align:right;padding:4px 2px;white-space:nowrap">${esc(p)}</th>`).join("")+'</tr>';
  for(const r of rows){
    h+=`<tr><td style="padding:4px 2px;color:var(--pp-mut)">${esc(r.name||r.id)}</td>`+periods.map(p=>`<td style="text-align:right;padding:4px 2px;white-space:nowrap">${fmtFsVal(r,p)}</td>`).join("")+'</tr>';
  }
  $("dFsTbl").innerHTML=h+'</table></div>';
}
document.querySelectorAll("#dFs button").forEach((b,i)=>{
  b.onclick=()=>{
    document.querySelectorAll("#dFs button").forEach(x=>x.classList.remove("on"));
    b.classList.add("on");
    _fsType=["IS","BS","CF"][i];
    renderFs();
  };
});
function dlBlob(content, filename, mime){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([content],{type:mime}));
  a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
}
$("dlCsv").onclick=()=>{
  if(!_fsData) return;
  const rows=(_fsData.types&&_fsData.types[_fsType])||[];
  const periods=_fsData.periods||[];
  if(!rows.length) return;
  const q=v=>'"'+String(v??"").replace(/"/g,'""')+'"';
  const lines=[[T("Chỉ tiêu"),...periods].map(q).join(";")];
  for(const r of rows) lines.push([r.name||r.id, ...periods.map(p=>{const v=fsRawVal(r,p); return v==null?"":v;})].map(q).join(";"));
  dlBlob("\ufeff"+lines.join("\r\n"), `${_fsSym}_${FS_TNAME[_fsType]}.csv`, "text/csv;charset=utf-8");
};
$("dlXls").onclick=()=>{
  if(!_fsData) return;
  const rows=(_fsData.types&&_fsData.types[_fsType])||[];
  const periods=_fsData.periods||[];
  if(!rows.length) return;
  let h='<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body><table border="1"><tr><th>'+esc(T("Chỉ tiêu"))+'</th>'+periods.map(p=>`<th>${esc(p)}</th>`).join("")+'</tr>';
  for(const r of rows) h+='<tr><td>'+esc(r.name||r.id)+'</td>'+periods.map(p=>{const v=fsRawVal(r,p); return '<td>'+(v==null?"":v)+'</td>';}).join("")+'</tr>';
  dlBlob(h+'</table></body></html>', `${_fsSym}_${FS_TNAME[_fsType]}.xls`, "application/vnd.ms-excel");
};

  if(typeof window!=="undefined"){
    window.PROF_I18N=PROF_I18N; window.FS_TNAME=FS_TNAME;
    window.loadProfile=loadProfile; window.renderProfile=renderProfile; window.loadEvents=loadEvents; window.loadTarget=loadTarget; window.loadCost=loadCost; window.loadFund=loadFund; window.loadFs=loadFs; window.renderFs=renderFs; window.loadHolderSymInsight=loadHolderSymInsight;
    window.__pfTest={load:loadProfile,render:renderProfile,events:loadEvents,target:loadTarget,cost:loadCost,fund:loadFund,fs:loadFs,renderFs:renderFs,i18n:PROF_I18N}; }
})();
}catch(e){}
// __PF_END__
