/* js/stocks/sectors.js — P5 module 6: khoi Nganh (v-sectors) tach tu stocks.html, giu nguyen hanh vi. Classic script, nap lazy khi mo tab. */
// __SEC_BEGIN__
try{
(function(){
// ---- Nganh (GET /sectors + /sectors/detail) ----
const SEC_I18N={
  vi:{rev:"Doanh thu 4 quý",npat:"LNST 4 quý",roe:"ROE 4 quý",pe:"P/E",members:"Số mã",mcap:"Vốn hoá",chart:"Doanh thu & LNST theo quý (tỷ đồng)",series:"Chuỗi theo kỳ",period:"Kỳ",revQ:"Doanh thu",npatQ:"LNST",roeQ:"ROE quý",margin:"Biên LN",back:"‹ Quay lại danh sách",mem:"Mã thành viên",empty:"Chưa có dữ liệu ngành",kTy:"nghìn tỷ",ty:"tỷ",note:"P/E ngành = tổng vốn hoá / tổng LNST 4 quý của các mã có đủ dữ liệu EPS (số mã được tính ghi ở chi tiết). ROE 4 quý = LNST 4 quý / vốn chủ sở hữu kỳ mới nhất."},
  en:{rev:"Revenue (TTM)",npat:"Net profit (TTM)",roe:"ROE (TTM)",pe:"P/E",members:"Symbols",mcap:"Market cap",chart:"Quarterly revenue & net profit (VND bn)",series:"History by quarter",period:"Period",revQ:"Revenue",npatQ:"Net profit",roeQ:"Quarterly ROE",margin:"Net margin",back:"‹ Back to list",mem:"Member symbols",empty:"No sector data yet",kTy:"tn",ty:"bn",note:"Sector P/E = total market cap / total TTM net profit over symbols with sufficient EPS data (count shown in detail). TTM ROE = TTM net profit / latest equity."},
  zh:{rev:"营收(近4季)",npat:"净利润(近4季)",roe:"ROE(近4季)",pe:"市盈率",members:"股票数",mcap:"总市值",chart:"季度营收与净利润(十亿越盾)",series:"分季度序列",period:"期间",revQ:"营收",npatQ:"净利润",roeQ:"季度ROE",margin:"净利率",back:"‹ 返回列表",mem:"成分股",empty:"暂无行业数据",kTy:"万亿",ty:"十亿",note:"行业市盈率 = 有足够 EPS 数据股票的总市值 / 近4季净利润总额(样本数见详情)。近4季 ROE = 近4季净利润 / 最新净资产。"},
  ko:{rev:"매출(최근 4분기)",npat:"순이익(최근 4분기)",roe:"ROE(최근 4분기)",pe:"P/E",members:"종목 수",mcap:"시가총액",chart:"분기 매출 및 순이익(십억 동)",series:"분기별 추이",period:"기간",revQ:"매출",npatQ:"순이익",roeQ:"분기 ROE",margin:"순이익률",back:"‹ 목록으로",mem:"구성 종목",empty:"업종 데이터 없음",kTy:"조",ty:"십억",note:"업종 P/E = EPS 데이터가 충분한 종목들의 시가총액 합계 / 최근 4분기 순이익 합계(표본 수는 상세에 표시). 최근 4분기 ROE = 최근 4분기 순이익 / 최신 자본."},
};
function fmtMoney(v){
  const L=SEC_I18N[curLang]||SEC_I18N.vi;
  if(v==null) return "—";
  const a=Math.abs(v);
  if(a>=1e12) return (v/1e12).toFixed(2).replace(".",",")+" "+L.kTy;
  if(a>=1e9) return Math.round(v/1e9).toLocaleString("vi-VN")+" "+L.ty;
  return fmtN(Math.round(v));
}
let SEC_ROWS=[], SEC_SORT={k:"rev_ttm",dir:-1}, SEC_INSIGHT=null;
async function loadSectors(){
  try{
    const j=await api("/sectors");
    SEC_ROWS=j.rows||[];
    SEC_INSIGHT=j.insight||null;
    renderSec();
  }catch(e){ const b=$("secBody"); if(b) b.innerHTML='<tr><td colspan="6"><div class="hint">Lỗi tải</div></td></tr>'; }
}
function secSort(k){
  if(SEC_SORT.k===k) SEC_SORT.dir*=-1; else SEC_SORT={k,dir:k==="name"?1:-1};
  renderSec();
}
function renderSec(){
  const L=SEC_I18N[curLang]||SEC_I18N.vi;
  const tb=$("secBody"); if(!tb) return;
  const ib=$("secInsight");
  if(ib) ib.innerHTML=insBox(SEC_INSIGHT, INS_SRC.sec[curLang]||INS_SRC.sec.vi, null);
  $("secNote").textContent=L.note;
  if(!SEC_ROWS.length){ tb.innerHTML=`<tr><td colspan="6"><div class="hint">${L.empty}</div></td></tr>`; return; }
  const {k,dir}=SEC_SORT;
  const rows=SEC_ROWS.slice().sort((a,b)=>{
    const x=a[k],y=b[k];
    if(x==null&&y==null) return 0; if(x==null) return 1; if(y==null) return -1;
    return (typeof x==="string"?x.localeCompare(y):x-y)*dir;
  });
  const arrow=(kk)=>SEC_SORT.k===kk?(SEC_SORT.dir===1?" ↑":" ↓"):"";
  $("secHead").innerHTML=`<tr>
    <th onclick="secSort('name')" style="cursor:pointer">Ngành${arrow('name')}</th>
    <th onclick="secSort('rev_ttm')" style="cursor:pointer;text-align:right">${L.rev}${arrow('rev_ttm')}</th>
    <th onclick="secSort('npat_ttm')" style="cursor:pointer;text-align:right">${L.npat}${arrow('npat_ttm')}</th>
    <th onclick="secSort('roe_ttm')" style="cursor:pointer;text-align:right">${L.roe}${arrow('roe_ttm')}</th>
    <th onclick="secSort('pe')" style="cursor:pointer;text-align:right">${L.pe}${arrow('pe')}</th>
    <th onclick="secSort('n_members')" style="cursor:pointer;text-align:center">${L.members}${arrow('n_members')}</th></tr>`;
  tb.innerHTML=rows.map(r=>`<tr>
    <td><a href="#" onclick="openSector('${r.code}');return false" style="color:var(--pp-accent);text-decoration:none"><b>${esc(r.name)}</b></a><div style="font-size:12px;color:var(--pp-mut)">${r.latest_period||""}</div></td>
    <td style="text-align:right">${fmtMoney(r.rev_ttm)}</td>
    <td style="text-align:right">${fmtMoney(r.npat_ttm)}</td>
    <td style="text-align:right">${r.roe_ttm==null?"—":(r.roe_ttm*100).toFixed(1).replace(".",",")+"%"}</td>
    <td style="text-align:right">${r.pe==null?"—":r.pe.toFixed(1).replace(".",",")}</td>
    <td style="text-align:center">${r.n_members}</td></tr>`).join("");
}
async function openSector(code){
  const L=SEC_I18N[curLang]||SEC_I18N.vi;
  $("secListWrap").style.display="none";
  const box=$("secDetail"); box.style.display="";
  box.innerHTML='<div class="card"><div class="hint">Đang tải…</div></div>';
  try{
    const j=await api("/sectors/detail?code="+encodeURIComponent(code));
    renderSector(j);
  }catch(e){ box.innerHTML='<div class="card"><div class="hint">Lỗi tải</div></div>'; }
}
function renderSector(j){
  const L=SEC_I18N[curLang]||SEC_I18N.vi;
  const box=$("secDetail"); if(!box) return;
  const ser=(j.series||[]).filter(p=>p.rev!=null||p.npat!=null);
  let h=`<div style="padding:2px 2px 8px"><a href="#" onclick="backSectors();return false" style="color:var(--pp-accent);text-decoration:none">${L.back}</a></div>`;
  h+=insBox(j.insight, INS_SRC.sec[curLang]||INS_SRC.sec.vi, j.latest_period);
  h+=`<div class="card">
    <div style="font-size:17px;font-weight:600">${esc(j.name||"")}</div>
    <div class="row" style="margin-top:6px"><span class="k">${L.rev}</span><span class="v">${fmtMoney(j.rev_ttm)}</span></div>
    <div class="row"><span class="k">${L.npat}</span><span class="v">${fmtMoney(j.npat_ttm)}</span></div>
    <div class="row"><span class="k">${L.roe}</span><span class="v">${j.roe_ttm==null?"—":(j.roe_ttm*100).toFixed(1).replace(".",",")+"%"}</span></div>
    <div class="row"><span class="k">${L.pe}</span><span class="v">${j.pe==null?"—":j.pe.toFixed(1).replace(".",",")+" ("+(j.n_pe||0)+"/"+(j.n_members||0)+" "+L.members+")"}</span></div>
    <div class="row"><span class="k">${L.mcap}</span><span class="v">${fmtMoney(j.mcap)}</span></div>
  </div>`;
  if(ser.length>3){
    const W=340,H=140,PL=4,PR=4,PT=10,PB=14,BW=(W-PL-PR)/ser.length;
    const mx=Math.max(...ser.map(p=>Math.max(p.rev||0,p.npat||0)))*1.1||1;
    const mn=Math.min(0,...ser.map(p=>Math.min(p.rev||0,p.npat||0)))*1.1;
    const Y=v=>PT+(1-(v-mn)/(mx-mn))*(H-PT-PB);
    let svg=`<svg width="100%" viewBox="0 0 ${W} ${H}">`;
    svg+=`<line x1="${PL}" y1="${Y(0)}" x2="${W-PR}" y2="${Y(0)}" stroke="var(--pp-line)"/>`;
    ser.forEach((p,i)=>{
      const x=PL+i*BW+BW*0.15, w=BW*0.7;
      if(p.rev!=null) svg+=`<rect x="${x.toFixed(1)}" y="${Y(Math.max(p.rev,0)).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.abs(Y(p.rev)-Y(0)).toFixed(1)}" fill="#38bdf8" opacity="0.75"/>`;
    });
    let d="";
    ser.forEach((p,i)=>{ if(p.npat!=null){ const x=PL+i*BW+BW/2; d+=(d?" L ":"M ")+x.toFixed(1)+" "+Y(p.npat).toFixed(1); } });
    if(d) svg+=`<path d="${d}" fill="none" stroke="#f0b429" stroke-width="1.8"/>`;
    svg+=`<text x="${PL}" y="${H-2}" font-size="9" fill="var(--pp-mut)">${ser[0].period}</text>`;
    svg+=`<text x="${W-PR}" y="${H-2}" font-size="9" fill="var(--pp-mut)" text-anchor="end">${ser[ser.length-1].period}</text>`;
    svg+="</svg>";
    h+=`<div class="sec">${L.chart}</div><div class="card">${svg}<div style="font-size:12px"><span style="color:#38bdf8">■</span> ${L.revQ} · <span style="color:#f0b429">■</span> ${L.npatQ}</div></div>`;
  }
  const last=ser.slice(-8).reverse();
  if(last.length){
    h+=`<div class="sec">${L.series}</div><div class="card"><table>
    <tr><th>${L.period}</th><th style="text-align:right">${L.revQ}</th><th style="text-align:right">${L.npatQ}</th><th style="text-align:right">${L.roeQ}</th><th style="text-align:right">${L.margin}</th></tr>
    ${last.map(p=>`<tr><td>${p.period}</td><td style="text-align:right">${fmtMoney(p.rev)}</td><td style="text-align:right">${fmtMoney(p.npat)}</td><td style="text-align:right">${p.roe_q==null?"—":(p.roe_q*100).toFixed(1).replace(".",",")+"%"}</td><td style="text-align:right">${p.net_margin==null?"—":(p.net_margin*100).toFixed(1).replace(".",",")+"%"}</td></tr>`).join("")}</table></div>`;
  }
  const mem=j.members||[];
  if(mem.length){
    h+=`<div class="sec">${L.mem} (${mem.length})</div><div class="card"><div style="display:flex;flex-wrap:wrap;gap:6px">${mem.map(m=>{
      const pc=m.pct==null?null:m.pct;
      const cls=pc==null?"":pc>0?"up":pc<0?"down":"";
      return `<a href="#" onclick="openSym('${m.symbol}');return false" style="display:inline-block;padding:5px 9px;border:1px solid var(--pp-line);border-radius:99px;text-decoration:none;color:var(--pp-ink);font-size:12px"><b>${m.symbol}</b>${m.price?" · "+fmtN(m.price):""}${pc!=null?` <span class="${cls}">${pc>0?"+":""}${Number(pc).toFixed(1).replace(".",",")}%</span>`:""}</a>`;
    }).join("")}</div></div>`;
  }
  box.innerHTML=h;
}
function backSectors(){
  $("secDetail").style.display="none";
  $("secListWrap").style.display="";
}
  if(typeof window!=="undefined"){ window.loadSectors=loadSectors; window.secSort=secSort; window.openSector=openSector; window.backSectors=backSectors;
    window.__secTest={i18n:SEC_I18N,load:loadSectors,render:renderSec}; }
})();
}catch(e){}
// __SEC_END__
