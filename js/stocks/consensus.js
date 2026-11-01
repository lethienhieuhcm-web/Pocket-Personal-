/* js/stocks/consensus.js — P5 module 4: khoi Dong thuan (v-consensus) tach tu stocks.html, giu nguyen hanh vi. Classic script, nap lazy khi mo tab. */
// __CONS_BEGIN__
try{
(function(){
// ---- Dong thuan CTCK (GET /consensus + /consensus/detail) ----
// Phuong phap: 1 phieu/hang = ban moi nhat cua hang trong 12 thang.
const CONS_I18N={
  vi:{avgT:"Giá MT TB",upside:"Upside",sources:"Nguồn",low:"Thấp nhất",high:"Cao nhất",spread:"Độ lệch",latest:"BC mới nhất",price:"Giá hiện tại",empty:"Chưa có dữ liệu đồng thuận",nodata:"Chưa có dữ liệu đồng thuận cho mã này",firms:"Theo hãng",dist:"Phân bố khuyến nghị",chart:"Diễn biến giá mục tiêu theo hãng",note:"Mỗi hãng tính 1 phiếu: báo cáo mới nhất trong 12 tháng. Chỉ số tổng hợp, không nội dung báo cáo."},
  en:{avgT:"Avg target",upside:"Upside",sources:"Sources",low:"Lowest",high:"Highest",spread:"Spread",latest:"Latest report",price:"Current price",empty:"No consensus data yet",nodata:"No consensus data for this symbol yet",firms:"By firm",dist:"Recommendation mix",chart:"Target price history by firm",note:"One vote per firm: its latest report within 12 months. Aggregates only, no report content."},
  zh:{avgT:"平均目标价",upside:"上涨空间",sources:"来源数",low:"最低",high:"最高",spread:"分歧度",latest:"最新报告",price:"现价",empty:"暂无共识数据",nodata:"该股票暂无共识数据",firms:"按机构",dist:"评级分布",chart:"各机构目标价走势",note:"每家机构 1 票:12 个月内最新报告。仅汇总数据,不含报告内容。"},
  ko:{avgT:"평균 목표가",upside:"상승 여력",sources:"출처 수",low:"최저",high:"최고",spread:"괴리도",latest:"최신 보고서",price:"현재가",empty:"컨센서스 데이터 없음",nodata:"이 종목의 컨센서스 데이터가 없습니다",firms:"기관별",dist:"투자의견 분포",chart:"기관별 목표가 추이",note:"기관당 1표: 12개월 내 최신 보고서 기준. 집계 수치만 제공, 보고서 내용은 없습니다."},
};
const KN_LBL={
  vi:{BUY:"Mua",POSITIVE:"Khả quan",NEUTRAL:"Trung lập",NEGATIVE:"Kém khả quan",SELL:"Bán"},
  en:{BUY:"Buy",POSITIVE:"Positive",NEUTRAL:"Neutral",NEGATIVE:"Negative",SELL:"Sell"},
  zh:{BUY:"买入",POSITIVE:"积极",NEUTRAL:"中立",NEGATIVE:"消极",SELL:"卖出"},
  ko:{BUY:"매수",POSITIVE:"긍정",NEUTRAL:"중립",NEGATIVE:"부정",SELL:"매도"},
};
let CONS_ROWS=[], CONS_SORT={k:"upside",dir:-1}, CONS_INSIGHT=null;
async function loadConsensus(){
  try{
    const j=await api("/consensus");
    CONS_ROWS=j.rows||[];
    CONS_INSIGHT=j.insight||null;
    const L=CONS_I18N[curLang]||CONS_I18N.vi;
    $("consNote").textContent=L.note+(j.updated?" · "+String(j.updated).slice(0,10):"");
    renderCons();
  }catch(e){ $("consBody").innerHTML='<tr><td colspan="7"><div class="hint">Lỗi tải</div></td></tr>'; }
}
function consSort(k){
  if(CONS_SORT.k===k) CONS_SORT.dir*=-1; else CONS_SORT={k,dir:(k==="symbol"||k==="latest_report")?1:-1};
  renderCons();
}
function renderCons(){
  const L=CONS_I18N[curLang]||CONS_I18N.vi;
  const tb=$("consBody"); if(!tb) return;
  const ib=$("consInsight");
  if(ib) ib.innerHTML=insBox(CONS_INSIGHT, INS_SRC.cons[curLang]||INS_SRC.cons.vi, null);
  if(!CONS_ROWS.length){ tb.innerHTML=`<tr><td colspan="7"><div class="hint">${L.empty}</div></td></tr>`; return; }
  const {k,dir}=CONS_SORT;
  const rows=CONS_ROWS.slice().sort((a,b)=>{
    const x=a[k],y=b[k];
    if(x==null&&y==null) return 0; if(x==null) return 1; if(y==null) return -1;
    return (typeof x==="string"?x.localeCompare(y):x-y)*dir;
  });
  const arrow=(kk)=>CONS_SORT.k===kk?(CONS_SORT.dir===1?" ↑":" ↓"):"";
  $("consHead").innerHTML=`<tr>
    <th onclick="consSort('symbol')" style="cursor:pointer">Mã${arrow('symbol')}</th>
    <th onclick="consSort('mean_target')" style="cursor:pointer;text-align:right">${L.avgT}${arrow('mean_target')}</th>
    <th onclick="consSort('upside')" style="cursor:pointer;text-align:right">${L.upside}${arrow('upside')}</th>
    <th onclick="consSort('n_sources')" style="cursor:pointer;text-align:center">${L.sources}${arrow('n_sources')}</th>
    <th onclick="consSort('min_target')" style="cursor:pointer;text-align:right">${L.low}${arrow('min_target')}</th>
    <th onclick="consSort('max_target')" style="cursor:pointer;text-align:right">${L.high}${arrow('max_target')}</th>
    <th onclick="consSort('spread_pct')" style="cursor:pointer;text-align:right">${L.spread}${arrow('spread_pct')}</th></tr>`;
  tb.innerHTML=rows.map(r=>{
    const up=r.upside==null?null:r.upside*100;
    const cls=up==null?"":up>0?"up":up<0?"down":"";
    return `<tr>
      <td><a href="#" onclick="openSym('${r.symbol}');return false"><b>${r.symbol}</b></a><div style="font-size:12px;color:var(--pp-mut)">${L.latest}: ${(r.latest_report||"").slice(0,10)}</div></td>
      <td style="text-align:right">${r.mean_target?fmtN(Math.round(r.mean_target)):"—"}</td>
      <td class="${cls}" style="text-align:right">${up==null?"—":(up>0?"+":"")+up.toFixed(1).replace(".",",")+"%"}</td>
      <td style="text-align:center">${r.n_sources}</td>
      <td style="text-align:right">${r.min_target?fmtN(r.min_target):"—"}</td>
      <td style="text-align:right">${r.max_target?fmtN(r.max_target):"—"}</td>
      <td style="text-align:right">${r.spread_pct==null?"—":(r.spread_pct*100).toFixed(0)+"%"}</td></tr>`;
  }).join("");
}
async function loadConsDetail(sym){
  const box=$("dCons"); if(!box) return;
  box.innerHTML='<div class="card"><div class="hint">Đang tải…</div></div>';
  try{
    const j=await api("/consensus/detail?symbol="+encodeURIComponent(sym));
    renderConsDetail(j);
  }catch(e){ box.innerHTML='<div class="card"><div class="hint">Lỗi tải</div></div>'; }
}
function renderConsDetail(j){
  const box=$("dCons"); if(!box) return;
  const L=CONS_I18N[curLang]||CONS_I18N.vi;
  const KN=KN_LBL[curLang]||KN_LBL.vi;
  const firms=j.firms||[];
  if(!firms.length){ box.innerHTML=`<div class="card"><div class="hint">${L.nodata}</div></div>`; return; }
  const up=j.upside==null?null:j.upside*100;
  const cls=up==null?"":up>0?"up":up<0?"down":"";
  let h=insBox(j.insight, INS_SRC.cons[curLang]||INS_SRC.cons.vi, j.latest_report);
  h+=`<div class="card">
    <div class="row"><span class="k">${L.avgT}</span><span class="v" style="font-size:17px">${j.mean_target?fmtN(Math.round(j.mean_target)):"—"}</span></div>
    <div class="row"><span class="k">${L.price}</span><span class="v">${j.cur_price?fmtN(j.cur_price):"—"}</span></div>
    <div class="row"><span class="k">${L.upside}</span><span class="v ${cls}">${up==null?"—":(up>0?"+":"")+up.toFixed(1).replace(".",",")+"%"}</span></div>
    <div class="row"><span class="k">${L.sources}</span><span class="v">${j.n_sources} (${j.n_reports} BC)</span></div>
    <div style="padding-top:6px"><span class="k" style="font-size:12px;color:var(--pp-mut)">${L.dist}: </span>${Object.entries(j.dist||{}).map(([k,v])=>`<span style="display:inline-block;padding:2px 8px;margin:2px;border:1px solid var(--pp-line);border-radius:99px;font-size:12px">${KN[k]||k} · ${v}</span>`).join("")}</div>
  </div>`;
  h+=`<div class="sec" id="dSecCons">${L.firms}</div><div class="card"><table>${firms.map(f=>`<tr><td>${f.link?`<a href="${esc(f.link)}" target="_blank" rel="noopener" style="color:var(--pp-accent);text-decoration:none"><b>${esc(f.src)}</b> ↗</a>`:`<b>${esc(f.src)}</b>`}</td><td>${f.kn?(KN[f.kn]||f.kn):"—"}</td><td style="text-align:right">${f.tgt?fmtN(f.tgt):"—"}</td><td style="text-align:right;color:var(--pp-mut)">${(f.date||"").slice(0,10)}</td></tr>`).join("")}</table></div>`;
  const ser=j.series||{};
  const srcs=Object.keys(ser).filter(s=>ser[s]&&ser[s].length);
  if(srcs.length){
    const PALETTE=["#38bdf8","#f0b429","#34d399","#f472b6","#a78bfa","#e8c56a"];
    const all=srcs.flatMap(s=>ser[s]);
    const t0=new Date(all.reduce((a,p)=>p[0]<a?p[0]:a,all[0][0])).getTime();
    const t1=new Date(all.reduce((a,p)=>p[0]>a?p[0]:a,all[0][0])).getTime();
    const vs=all.map(p=>p[1]); let mn=Math.min(...vs), mx=Math.max(...vs);
    if(mx===mn){ mx=mn*1.05+1; }
    const pad=(mx-mn)*0.08; mn-=pad; mx+=pad;
    const W=340,H=150,PL=6,PR=6,PT=8,PB=16;
    const X=t=>PL+(t1===t0?0.5:(t-t0)/(t1-t0))*(W-PL-PR);
    const Y=v=>PT+(1-(v-mn)/(mx-mn))*(H-PT-PB);
    let svg=`<svg width="100%" viewBox="0 0 ${W} ${H}">`;
    svg+=`<text x="${PL}" y="${PT+4}" font-size="9" fill="var(--pp-mut)">${fmtN(Math.round(mx-pad))}</text>`;
    svg+=`<text x="${PL}" y="${H-4}" font-size="9" fill="var(--pp-mut)">${fmtN(Math.round(mn+pad))}</text>`;
    srcs.forEach((s,i)=>{
      const pts=ser[s].map(p=>[new Date(p[0]).getTime(),p[1]]);
      const c=PALETTE[i%PALETTE.length];
      let d=`M ${X(pts[0][0]).toFixed(1)} ${Y(pts[0][1]).toFixed(1)}`;
      for(let k2=1;k2<pts.length;k2++){ d+=` H ${X(pts[k2][0]).toFixed(1)} V ${Y(pts[k2][1]).toFixed(1)}`; }
      if(pts.length===1||pts[pts.length-1][0]<t1) d+=` H ${X(t1).toFixed(1)}`;
      svg+=`<path d="${d}" fill="none" stroke="${c}" stroke-width="1.8"/>`;
      pts.forEach(p=>{ svg+=`<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="2.6" fill="${c}"/>`; });
    });
    svg+=`<text x="${PL}" y="${H-4}" font-size="9" fill="var(--pp-mut)" text-anchor="start">${new Date(t0).toISOString().slice(0,10)}</text>`;
    svg+=`<text x="${W-PR}" y="${H-4}" font-size="9" fill="var(--pp-mut)" text-anchor="end">${new Date(t1).toISOString().slice(0,10)}</text>`;
    svg+="</svg>";
    const legend=srcs.map((s,i)=>`<span style="margin-right:10px;font-size:12px"><span style="color:${PALETTE[i%PALETTE.length]}">●</span> ${esc(s)}</span>`).join("");
    h+=`<div class="sec">${L.chart}</div><div class="card">${svg}<div style="margin-top:4px">${legend}</div></div>`;
  }
  box.innerHTML=h;
}
  if(typeof window!=="undefined"){ window.loadConsensus=loadConsensus; window.consSort=consSort; window.loadConsDetail=loadConsDetail;
    window.__consTest={i18n:CONS_I18N,load:loadConsensus,render:renderCons}; }
})();
}catch(e){}
// __CONS_END__
