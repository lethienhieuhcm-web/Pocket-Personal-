/* js/stocks/mine.js — P5 module 8: khoi Cua toi (v-mine) tach tu stocks.html, giu nguyen hanh vi. Classic script, nap lazy khi mo tab. */
// __MN_BEGIN__
try{
(function(){
// ---- Đợt B: Của tôi (danh mục / sổ lệnh / rủi ro) ----
let _pfCache=null,_riskCache=null;
const fmtD=n=>n==null?"—":Math.round(Number(n)).toLocaleString("vi-VN");
async function loadMine(){
  loadWatchlist();
  try{
    const pf=await api("/portfolio"); _pfCache=pf;
    const pos=pf.positions||[];
    $("pfPos").innerHTML=pos.length?pos.map(p=>{
      const pl=p.unrealized,cls=pl>0?"up":pl<0?"down":"";
      return `<tr><td><b>${esc(p.symbol)}</b></td><td>${fmtN(p.qty)}</td><td>${fmtN(p.avg_cost)}</td><td>${p.current!=null?fmtN(p.current):"—"}</td><td class="${cls}">${pl!=null?(pl>0?"+":"")+fmtD(pl)+(p.unrealized_pct!=null?" ("+(p.unrealized_pct>0?"+":"")+p.unrealized_pct+"%)":""):"—"}</td></tr>`;
    }).join(""):'<tr><td colspan="5"><div class="hint">Chưa có vị thế — nhập danh mục ở trên.</div></td></tr>';
    if(pos.length)$("pfRisk").innerHTML=`<div class="row"><span class="k">Giá trị thị trường</span><span class="v">${fmtD(pf.total_market_value)} đ</span></div><div class="row"><span class="k">Tổng vốn</span><span class="v">${fmtD(pf.total_cost)} đ</span></div><div class="row"><span class="k">Lãi/lỗ chưa chốt</span><span class="v ${pf.total_unrealized>0?"up":pf.total_unrealized<0?"down":""}">${pf.total_unrealized>0?"+":""}${fmtD(pf.total_unrealized)} đ</span></div><div class="row"><span class="k">Lãi/lỗ đã chốt</span><span class="v ${pf.total_realized>0?"up":pf.total_realized<0?"down":""}">${pf.total_realized>0?"+":""}${fmtD(pf.total_realized)} đ</span></div>`;
    // Lệnh gần nhất (sổ lệnh)
    const txns=(pf.txns||[]).slice().sort((a,b)=>b.date<a.date?-1:b.date>a.date?1:(b.id||0)-(a.id||0)).slice(0,20);
    $("jTrades").innerHTML=txns.length?txns.map(t=>`<tr><td>${esc(t.date||"")}</td><td><b>${esc(t.symbol)}</b></td><td class="${t.side==="BUY"?"up":"down"}">${t.side==="BUY"?"Mua":"Bán"} ${fmtN(t.qty)} @ ${fmtN(t.price)}</td><td>${t.note?esc(t.note):"—"}</td></tr>`).join(""):'<tr><td colspan="4"><div class="hint">Chưa có lệnh nào.</div></td></tr>';
  }catch(e){$("pfPos").innerHTML='<tr><td colspan="5"><div class="hint">Lỗi tải danh mục (cần đăng nhập).</div></td></tr>';}
  try{
    const rk=await api("/risk"); _riskCache=rk;
    const st=rk.stats||{};
    $("jStats").innerHTML=st.trades?`<div class="row"><span class="k">Số vòng đã chốt</span><span class="v">${st.trades} (${st.wins||0} thắng / ${st.losses||0} thua)</span></div><div class="row"><span class="k">Win rate</span><span class="v">${st.win_rate_pct}%</span></div><div class="row"><span class="k">Tổng P/L đã chốt</span><span class="v ${st.total_pnl>0?"up":st.total_pnl<0?"down":""}">${st.total_pnl>0?"+":""}${fmtD(st.total_pnl)} đ</span></div><div class="row"><span class="k">Lãi TB / Lỗ TB</span><span class="v">${fmtD(st.avg_win)} / ${fmtD(st.avg_loss)} đ</span></div><div class="row"><span class="k">Profit factor</span><span class="v">${st.profit_factor!=null?st.profit_factor:"—"}</span></div>`:'<div class="hint">Chưa có vòng giao dịch nào đã chốt.</div>';
    try{
      const sr=await api("/strategy_review");
      const srows=sr.rows||[];
      const VD={giu:"🟢 Giữ",xem_lai:"🟡 Xem lại",dung:"🔴 Dừng"};
      $("jStrat").innerHTML=srows.length?srows.map(r=>`<tr><td><b>${esc(r.label)}</b></td><td>${r.trades}</td><td class="${r.win_rate_pct>=50?"up":"down"}">${r.win_rate_pct}%</td><td class="${r.profit_factor==null||r.profit_factor>=1?"up":"down"}">${r.profit_factor!=null?String(r.profit_factor).replace(".",","):"—"}</td><td>${VD[r.verdict]||"—"}</td></tr>`).join(""):'<tr><td colspan="5"><div class="hint">Chưa đủ dữ liệu để đánh giá chiến lược.</div></td></tr>';
    }catch(e){$("jStrat").innerHTML='<tr><td colspan="5"><div class="hint">Lỗi tải đánh giá chiến lược.</div></td></tr>';}
    const pr=rk.profile||{};
    const PROF_LBL={than_trong:"Thận trọng",can_bang:"Cân bằng",tang_truong:"Tăng trưởng",mao_hiem:"Mạo hiểm"};
    $("riskProfile").innerHTML=pr.profile?`<div class="row"><span class="k">Hồ sơ</span><span class="v" style="font-size:17px">${esc(PROF_LBL[pr.profile]||pr.profile)} · ${pr.score}/100</span></div><div class="hint" style="padding:6px 0">${esc(pr.mo_ta||"")}</div>${(pr.ly_do||[]).map(x=>`<div class="hint" style="padding:2px 0">• ${esc(x)}</div>`).join("")}${pr.goi_y_gioi_han?`<div class="row" style="margin-top:6px"><span class="k">Giới hạn gợi ý</span><span class="v">Mã ≤ ${pr.goi_y_gioi_han.max_position_pct}% · Cắt lỗ ${pr.goi_y_gioi_han.stop_loss_pct}%</span></div><div class="hint" style="padding:2px 0">${esc(pr.goi_y_gioi_han.note||"")}</div>`:""}`:'<div class="hint">Chưa đủ dữ liệu.</div>';
    const vs=rk.violations||[];
    $("riskWatch").innerHTML=vs.length?vs.map(v=>`<div class="card" style="margin-bottom:8px;border-left:3px solid ${v.severity==="high"?"var(--pp-danger)":v.severity==="medium"?"#f0b429":"var(--pp-mut)"}"><div style="font-size:14px">${esc(v.message)}</div></div>`).join(""):'<div class="card"><div class="hint">Không có cảnh báo rủi ro. Danh mục đang trong giới hạn an toàn.</div></div>';
  }catch(e){$("jStats").innerHTML='<div class="hint">Lỗi tải rủi ro (cần đăng nhập).</div>';$("riskProfile").innerHTML='<div class="hint">Đăng nhập để xem hồ sơ rủi ro.</div>';$("riskWatch").innerHTML='<div class="hint">Đăng nhập để xem cảnh báo rủi ro.</div>';}
}
// Import: parse bảng (port portfolio_parse.py: doan cot + parse so Viet)
function pfNorm(s){return String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").trim();}
function pfNum(s){
  if(s==null)return null; s=String(s).trim().replace(/\s/g,""); if(!s||s==="-")return null;
  if(s.includes(".")&&s.includes(",")){if(s.lastIndexOf(".")>s.lastIndexOf(","))s=s.replace(/,/g,"");else s=s.replace(/\./g,"").replace(",",".");}
  else if(s.includes(",")){const p=s.split(",");s=(p.length>1&&p[p.length-1].length===3)?s.replace(/,/g,""):s.replace(",",".");}
  else if(s.includes(".")){const p=s.split(".");if(p.length>1&&p.slice(1).every(x=>x.length===3))s=s.replace(/\./g,"");}
  const v=parseFloat(s.replace(/[^\d.\-]/g,""));return isNaN(v)?null:v;
}
function pfParseRows(rows){
  rows=(rows||[]).map(r=>(r||[]).map(c=>String(c==null?"":c).trim()));
  if(!rows.length)return[];
  const COLS={symbol:["ma ck","ma","symbol","ticker","stock","chung khoan"],quantity:["so luong","kl","quantity","qty","volume","so du"],avg_price:["gia von","gia tb","gia mua","avg","average price","cost","gia goc","don gia"]};
  const head=rows[0].map(pfNorm); let idx={};
  for(const f of Object.keys(COLS))for(let i=0;i<head.length;i++){if(COLS[f].some(k=>head[i].includes(k))){idx[f]=i;break;}}
  let data=rows;
  if(idx.symbol!=null)data=rows.slice(1); else idx={symbol:0,quantity:1,avg_price:2};
  const out=[];
  for(const r of data){
    if(pfNorm(r[idx.symbol]).startsWith("tong"))continue;
    const sym=String(r[idx.symbol]||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
    const qty=pfNum(r[idx.quantity]), price=pfNum(r[idx.avg_price]);
    if(/^[A-Z]{3,10}$/.test(sym)&&qty>0&&price>0)out.push({symbol:sym,quantity:qty,avg_price:price});
  }
  return out;
}
function pfParseTable(text){
  const lines=String(text||"").split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if(!lines.length)return[];
  const delim=lines[0].includes("\t")?"\t":(lines[0].includes(";")?";":",");
  return pfParseRows(lines.map(l=>l.split(delim)));
}
async function pfImportRows(rows,msgEl){
  if(!rows.length){msgEl.textContent="Không đọc được dòng nào hợp lệ (cần cột Mã · Số lượng · Giá vốn).";return;}
  const today=new Date(); const dstr=today.getFullYear()+"-"+String(today.getMonth()+1).padStart(2,"0")+"-"+String(today.getDate()).padStart(2,"0");
  let ok=0,err=0;
  for(const r of rows){
    try{await apip("/portfolio/txn","POST",{symbol:r.symbol,side:"BUY",qty:r.quantity,price:r.avg_price,date:dstr,note:"import"});ok++;}
    catch(e){err++;}
  }
  msgEl.textContent=`Đã nhập ${ok} mã${err?`, lỗi ${err} mã`:""}. Đang tải lại…`;
  loadMine();
}
$("pfPasteBtn").onclick=()=>{const b=$("pfPasteBox");b.style.display=b.style.display==="none"?"":"none";};
$("pfPasteGo").onclick=()=>pfImportRows(pfParseTable($("pfPasteTxt").value),$("pfImportMsg"));
let _xlsxP=null;
function pfLoadXlsx(){
  if(window.XLSX)return Promise.resolve();
  if(_xlsxP)return _xlsxP;
  _xlsxP=new Promise((res,rej)=>{
    const sc=document.createElement("script");
    sc.src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
    sc.onload=()=>res(); sc.onerror=()=>rej(new Error("xlsx load fail"));
    document.head.appendChild(sc);
  });
  return _xlsxP;
}
$("pfFile").onchange=async e=>{
  const f=e.target.files&&e.target.files[0]; if(!f)return;
  const msg=$("pfImportMsg"); $("pfPasteBox").style.display="";
  try{
    if(/\.xlsx?$/i.test(f.name||"")){
      msg.textContent="Đang đọc file Excel…";
      await pfLoadXlsx();
      const buf=await f.arrayBuffer();
      const wb=XLSX.read(buf,{type:"array"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:""});
      pfImportRows(pfParseRows(rows),msg);
    }else{
      pfImportRows(pfParseTable(await f.text()),msg);
    }
  }catch(err){msg.textContent="Không đọc được file. Thử lại với file .xlsx hoặc dán bảng.";}
  e.target.value="";
};
$("posSizeBtn").onclick=()=>{const b=$("posSizeBox");b.style.display=b.style.display==="none"?"":"none";};
$("psGo").onclick=()=>{
  const cap=parseFloat($("psCap").value),rp=parseFloat($("psRisk").value),en=parseFloat($("psEntry").value),st=parseFloat($("psStop").value);
  if(!(cap>0&&rp>0&&en>0&&st>0&&en>st)){$("psOut").innerHTML='<div class="hint">Kiểm tra lại: cần Vốn, % rủi ro, Giá vào &gt; Giá cắt lỗ &gt; 0.</div>';return;}
  const riskAmt=cap*rp/100, per=en-st, qty=Math.floor(riskAmt/per/100)*100, val=qty*en;
  $("psOut").innerHTML=`<div class="row"><span class="k">Số tiền rủi ro</span><span class="v">${fmtD(riskAmt)} đ</span></div><div class="row"><span class="k">Khối lượng mua</span><span class="v" style="font-size:17px">${fmtN(qty)} cp</span></div><div class="row"><span class="k">Giá trị vị thế</span><span class="v">${fmtD(val)} đ (${(val/cap*100).toFixed(1)}% vốn)</span></div><div class="hint" style="padding-top:4px">Lô chẵn 100 cp (HOSE). Nếu giá chạm cắt lỗ, lỗ đúng ${fmtD(riskAmt)} đ = ${rp}% vốn.</div>`;
};
$("pfExportBtn").onclick=()=>{
  const pos=(_pfCache&&_pfCache.positions)||[];
  if(!pos.length){alert("Chưa có vị thế để xuất.");return;}
  let csv="symbol,qty,avg_cost,current,market_value,unrealized,unrealized_pct\n"+pos.map(p=>[p.symbol,p.qty,p.avg_cost,p.current??"",p.market_value??"",p.unrealized??"",p.unrealized_pct??""].join(",")).join("\n");
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\ufeff"+csv],{type:"text/csv"}));a.download="danh-muc.csv";a.click();URL.revokeObjectURL(a.href);
};
  if(typeof window!=="undefined"){ window.loadMine=loadMine; window.pfImportRows=pfImportRows; window.pfLoadXlsx=pfLoadXlsx;
    window.__mnTest={load:loadMine,parse:pfParseRows}; }
})();
}catch(e){}
// __MN_END__
