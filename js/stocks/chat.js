(function(){
// ---- AI Chat (Dot A): trang rieng, hoi qua lop du lieu da cong bo,
// tra loi the cau truc + dong nguon/as_of; khong chan goi/han muc
// (worker mo full giai doan thu nghiem). ----
function chatAdd(who,text){
  const d=document.createElement("div");
  d.style.cssText="margin:8px 0;font-size:12.5px;line-height:1.6";
  d.innerHTML=(who==="u"?'<div style="text-align:right"><span style="background:var(--pp-accent);color:#fff;padding:8px 12px;border-radius:12px;display:inline-block;max-width:85%">'+esc(text)+'</span></div>':'<div><div style="background:var(--pp-bg2);padding:10px 12px;border-radius:12px;display:inline-block;max-width:94%;width:94%;box-sizing:border-box">'+text+'</div></div>');
  $("chatBox").appendChild(d);$("chatBox").scrollTop=$("chatBox").scrollHeight;
  return d;
}
let _mcpId=0;
async function mcpCall(name,args){
  const tok=localStorage.getItem("elab_authToken")||"";
  const r=await fetch("/api/mcp",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+tok},
    body:JSON.stringify({jsonrpc:"2.0",id:++_mcpId,method:"tools/call",params:{name,arguments:args||{}}})});
  const j=await r.json().catch(()=>null);
  if(!j||j.error) throw new Error((j&&j.error&&j.error.message)||"mcp");
  const res=j.result||{};
  let p=res.structuredContent;
  if(!p&&res.content&&res.content[0]&&res.content[0].text){ try{ p=JSON.parse(res.content[0].text); }catch(e){} }
  if(!p) throw new Error("mcp-empty");
  return p;
}
function chatDsLabel(ds){
  const s=String(ds||"");
  // get_flow_summary: dataset gop nhieu snapshot — nhan tong hop rieng,
  // tranh dinh nhan "khoi ngoai" khi gom ca tu doanh
  if(s.includes("screener")&&(s.includes("foreign_flow")||s.includes("proprietary_flow"))) return "Dòng tiền (tổng hợp)";
  const M=[["foreign_flow","Dòng tiền khối ngoại"],["prop_flow","Dòng tiền tự doanh"],["company_profile","Hồ sơ công ty"],["quotes","Bảng giá"],["ohlcv","Nến ngày"],["indices","Chỉ số thị trường"],["screener","Bảng sàng lọc"],["fundamentals","Chỉ số tài chính"],["statements","Báo cáo tài chính"],["holders","Sổ cổ đông"],["consensus","Đồng thuận các công ty chứng khoán"],["sectors","Ngành"],["macro","Số liệu vĩ mô"],["events","Sự kiện"],["news","Tin tức"]];
  for(const [k,v] of M) if(s.includes(k)) return v;
  return "Dữ liệu thị trường";
}
function chatAsOf(s){
  if(!s) return "";
  const str=String(s);
  if(str.includes("T")){ const [d,t]=str.split("T"); return d+" "+(t||"").slice(0,5); }
  return str;
}
function chatMetaHtml(p){
  const m=p&&p.meta; if(!m) return "";
  let h=`<div class="chatmeta">${esc(T("Nguồn"))}: ${esc(chatDsLabel(m.source&&m.source.dataset))}`;
  if(m.as_of) h+=` · ${esc(T("Dữ liệu tại"))}: ${esc(chatAsOf(m.as_of))}`;
  if(m.stale) h+=` · <span class="down">${esc(T("dữ liệu có thể đã cũ"))}</span>`;
  if(m.verification==="parity_pending") h+=`<br><span class="down">${esc(T("Số đang được đối chiếu chéo, chưa chốt"))}</span>`;
  if(m.coverage&&m.coverage.note) h+=`<br>${esc(m.coverage.note)}`;
  return h+"</div>";
}
const CHAT_ROUTES=[];
function chatReg(label,tool,args){ CHAT_ROUTES.push({label,tool,args}); return CHAT_ROUTES.length-1; }
function chatChipTap(i){ const r=CHAT_ROUTES[i]; if(!r) return; chatRun(r.label,{tool:r.tool,args:r.args}); }
function chatFollowHtml(items){
  if(!items||!items.length) return "";
  return `<div class="chatfollow">${items.map(it=>`<button class="chipq" onclick="chatChipTap(${chatReg(it.label,it.tool,it.args)})">${esc(it.label)}</button>`).join("")}</div>`;
}
function symLink(sym){ return `<span class="symlink" onclick="openSym('${esc(sym)}')">${esc(sym)}</span>`; }
function chatRow(k,v){ return `<div class="row"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`; }
function chatRender(route,p){
  if(!p) return esc(T("Chưa có dữ liệu"));
  if(p.error) return `<b>${esc(p.error.message||T("Chưa có dữ liệu"))}</b>`+chatMetaHtml(p);
  const d=p.data||{}, tool=route.tool, a=route.args||{};
  let h="", follow=[];
  const ty=v=>v==null?"—":fmtTyAbs(v);
  const cls=v=>v==null?"":(v>=0?"up":"dn");
  const symFollow=(s)=>[
    {label:`${T("Giá")} ${s}`,tool:"get_quote",args:{symbol:s}},
    {label:`${T("Biểu đồ 20 phiên")} ${s}`,tool:"get_ohlcv",args:{symbol:s,limit:20}},
    {label:`${T("Hồ sơ & cổ đông")} ${s}`,tool:"get_company_profile",args:{symbol:s}},
    {label:`${T("Đồng thuận")} ${s}`,tool:"get_consensus",args:{symbol:s}},
    {label:`${T("Khối ngoại")} ${s}`,tool:"get_flow",args:{kind:"foreign",symbol:s,days:30}},
  ];
  if(tool==="get_quote"){
    const pc=d.pct_change, cls=pc>0?"up":pc<0?"down":"";
    h=`<div style="font-size:15px"><b>${esc(d.symbol||a.symbol||"")}</b> <span style="font-size:12px;color:var(--pp-mut)">${esc(d.exchange||"")}</span></div>`
      +`<div style="font-size:22px;font-weight:800;margin:2px 0">${fmtN(d.close)} <span class="${cls}" style="font-size:13px">${fmtPct(pc)}</span></div>`;
    if(d.volume!=null) h+=chatRow(T("Khối lượng"),fmtN(d.volume));
    if(d.value_vnd!=null) h+=chatRow(T("Giá trị"),fmtTyAbs(d.value_vnd));
    if(d.foreign_buy_value!=null||d.foreign_sell_value!=null) h+=chatRow(T("NN mua / bán"),`<span class="up">${fmtTyAbs(d.foreign_buy_value||0)}</span> / <span class="down">${fmtTyAbs(d.foreign_sell_value||0)}</span>`);
    follow=symFollow(d.symbol||a.symbol);
  } else if(tool==="get_ohlcv"){
    const rows=d.rows||[], sym=d.symbol||a.symbol, isIdx=IDX_LIST.includes(sym);
    const mult=isIdx?1:1000;
    if(!rows.length) h=esc(T("Chưa có dữ liệu"));
    else{
      const last=rows[rows.length-1];
      h=`<b>${esc(sym)}</b> — ${esc(T("Đóng cửa phiên gần nhất"))}: <b>${fmtN(last.c*mult)}</b> (${esc(last.t||"")})`;
      h+='<table class="chatft">'+rows.slice(-6).reverse().map(r=>`<tr><td>${esc(r.t||"")}</td><td style="text-align:right">${fmtN(r.o*mult)}</td><td style="text-align:right">${fmtN(r.h*mult)}</td><td style="text-align:right">${fmtN(r.l*mult)}</td><td style="text-align:right"><b>${fmtN(r.c*mult)}</b></td><td style="text-align:right">${fmtN(r.v||0)}</td></tr>`).join("")+"</table>";
      h+=`<div style="font-size:11px;color:var(--pp-mut)">${esc(T("Ngày · Mở · Cao · Thấp · Đóng · Khối lượng"))}</div>`;
    }
    if(!isIdx) follow=symFollow(sym);
  } else if(tool==="get_indices"){
    const ix=d.indices||{};
    if(d.regime) h+=`<div style="margin-bottom:6px">${esc(T("Trạng thái thị trường"))}: <b>${esc(typeof d.regime==="string"?d.regime:(d.regime.regime||""))}</b>${d.regime&&d.regime.desc?` — ${esc(d.regime.desc)}`:""}</div>`;
    const tbl=(arr,tap)=>'<table class="chatft">'+(arr||[]).map(e=>{ const code=e.symbol||e.code||e.name||""; const pc=e.pct_change!=null?e.pct_change:e.pct; return `<tr><td>${tap&&IDX_LIST.includes(code)?`<span class="symlink" onclick="openIndex('${esc(code)}')">${esc(e.name||code)}</span>`:esc(e.name||code)}</td><td style="text-align:right"><b>${fmtN(e.close)}</b></td><td style="text-align:right" class="${(pc||0)>=0?"up":"dn"}">${pc!=null?fmtPct(pc):""}</td></tr>`; }).join("")+"</table>";
    h+=tbl(ix.main,true);
    if(ix.sectors&&ix.sectors.length) h+=`<div style="margin-top:8px;font-weight:700">${esc(T("Chỉ số ngành"))}</div>`+tbl(ix.sectors,false);
    follow=[{label:"VNINDEX 20 phiên",tool:"get_ohlcv",args:{symbol:"VNINDEX",limit:20}}];
  } else if(tool==="get_company_profile"){
    const sym=a.symbol||"", sh=(d.shareholders||[]).slice().sort((x,y)=>(y.shares_owned||0)-(x.shares_owned||0));
    h=`<b>${esc(sym)}</b> — ${esc(T("Hồ sơ & cổ đông"))}`;
    if(sh.length){
      const top=sh[0];
      h+=`<div style="margin-top:4px">${esc(T("Cổ đông lớn nhất"))}: <b>${esc(top.name||"")}</b> — ${fmtN(top.shares_owned)} ${esc(T("cổ phiếu"))} (${top.ownership_percentage!=null?Number(top.ownership_percentage).toFixed(2).replace(".",",")+"%":""})</div>`;
      h+='<table class="chatft">'+sh.slice(0,5).map(r=>`<tr><td>${esc(r.name||"")}</td><td style="text-align:right">${fmtN(r.shares_owned)}</td><td style="text-align:right">${r.ownership_percentage!=null?Number(r.ownership_percentage).toFixed(2).replace(".",",")+"%":"—"}</td></tr>`).join("")+"</table>";
    } else h+=`<br>${esc(T("Chưa có dữ liệu"))}`;
    follow=symFollow(sym);
  } else if(tool==="find_holder"){
    const hs=d.holders||[];
    if(!hs.length) h=esc(T("Không tìm thấy cổ đông khớp tên này trong chỉ mục đã công bố."));
    else h=hs.map(hd=>{
      const rows=(hd.holdings||[]).slice().sort((x,y)=>(y.quantity||0)-(x.quantity||0));
      let s=`<b>${esc(hd.name||"")}</b>${hd.tot?` — ${esc(T("tổng"))} ${fmtN(hd.tot)} ${esc(T("cổ phiếu"))}`:""}`;
      s+='<table class="chatft">'+rows.slice(0,10).map(r=>`<tr><td>${symLink(r.symbol)}${r.position?`<div style="font-size:11px;color:var(--pp-mut)">${esc(r.position)}</div>`:""}</td><td style="text-align:right">${fmtN(r.quantity)}</td><td style="text-align:right">${r.pct!=null?(r.pct*100).toFixed(2).replace(".",",")+"%":"—"}</td></tr>`).join("")+"</table>";
      return s;
    }).join("");
  } else if(tool==="get_flow"){
    const kind=a.kind==="proprietary"?T("Tự doanh"):T("Khối ngoại");
    const pickV=(r,...ks)=>{ for(const k of ks){ if(r[k]!=null) return r[k]; } return null; };
    if(a.symbol){
      const rows=d.rows||[];
      h=`<b>${esc(a.symbol)}</b> — ${kind} (${esc(T("mua/bán ròng theo phiên"))})`;
      if(rows.length){
        const rowsDesc=rows.slice().sort((x,y)=>String(y.trade_date||y.date||"").localeCompare(String(x.trade_date||x.date||"")));
        h+='<table class="chatft">'+rowsDesc.slice(0,8).map(r=>{
          const bv=pickV(r,"buy_value_est","buy_value_vnd","buy_value"), sv=pickV(r,"sell_value_est","sell_value_vnd","sell_value"), net=pickV(r,"net_value_est","net_value_vnd","net_value");
          return `<tr><td>${esc(r.trade_date||r.date||"")}</td><td style="text-align:right">${bv==null?"—":fmtTyAbs(bv)}</td><td style="text-align:right">${sv==null?"—":fmtTyAbs(sv)}</td><td style="text-align:right" class="${net==null?"":net>=0?"up":"dn"}"><b>${net==null?"—":fmtTyAbs(net)}</b></td></tr>`; }).join("")+"</table>";
        h+=`<div style="font-size:11px;color:var(--pp-mut)">${esc(T("Ngày · Mua · Bán · Ròng (đồng)"))}</div>`;
      } else h+=`<br>${esc(T("Chưa có dữ liệu"))}`;
      follow=symFollow(a.symbol);
    } else {
      let rows=d.rows||[];
      if(!rows.length&&d.by_symbol) rows=Object.keys(d.by_symbol).map(k=>({symbol:k,...(d.by_symbol[k]||{})}));
      const netOf=r=>{ const v=pickV(r,"net_value_vnd","net_value_est","net_value","net"); if(v!=null) return v; const b=pickV(r,"buy_value_vnd","buy_value"), s=pickV(r,"sell_value_vnd","sell_value"); return (b!=null&&s!=null)?b-s:0; };
      rows=rows.slice().sort((x,y)=>Math.abs(netOf(y))-Math.abs(netOf(x))).slice(0,10);
      h=`<b>${kind} — ${esc(T("hôm nay"))}</b>`;
      if(rows.length) h+='<table class="chatft">'+rows.map(r=>`<tr><td>${r.symbol?symLink(r.symbol):""}</td><td style="text-align:right" class="${netOf(r)>=0?"up":"dn"}"><b>${fmtTyAbs(netOf(r))}</b></td></tr>`).join("")+"</table>";
      else h+=`<br>${esc(T("Chưa có dữ liệu"))}`;
    }
  } else if(tool==="get_flow_summary"){
    const kind=a.kind||"both", gb=a.group_by||"sector";
    const ty=v=>v==null?"—":fmtTyAbs(v);
    const cls=v=>v==null?"":(v>=0?"up":"dn");
    const colF=kind!=="proprietary", colP=kind!=="foreign";
    if(d.sector){
      const s=d.sector;
      h=`<b>${esc(s.name||a.sector_code||"")}</b> — ${esc(T("Dòng tiền"))}`;
      h+=chatRow(T("Ròng gộp"),`<span class="${cls(s.net_total)}"><b>${ty(s.net_total)}</b></span>`);
      if(colF) h+=chatRow(T("Khối ngoại"),`<span class="${cls(s.net_foreign)}">${ty(s.net_foreign)}</span>`);
      if(colP) h+=chatRow(T("Tự doanh"),`<span class="${cls(s.net_proprietary)}">${ty(s.net_proprietary)}</span>`);
      if(s.n_symbols!=null) h+=chatRow(T("Số mã có dòng tiền"),fmtN(s.n_symbols));
      const tops=d.top_symbols||[];
      if(tops.length) h+='<table class="chatft">'+tops.map(r=>`<tr><td>${r.symbol?symLink(r.symbol):""}</td>${colF?`<td style="text-align:right" class="${cls(r.net_foreign)}">${ty(r.net_foreign)}</td>`:""}${colP?`<td style="text-align:right" class="${cls(r.net_proprietary)}">${ty(r.net_proprietary)}</td>`:""}<td style="text-align:right" class="${cls(r.net_total)}"><b>${ty(r.net_total)}</b></td></tr>`).join("")+"</table>";
    } else if(gb==="market"){
      const t=d.total||{};
      h=`<b>${esc(T("Dòng tiền"))} — ${esc(T("Toàn thị trường"))}</b>`;
      if(colF) h+=chatRow(T("Khối ngoại"),`<span class="${cls(t.net_foreign)}"><b>${ty(t.net_foreign)}</b></span>`);
      if(colP) h+=chatRow(T("Tự doanh"),`<span class="${cls(t.net_proprietary)}"><b>${ty(t.net_proprietary)}</b></span>`);
      h+=chatRow(T("Ròng gộp"),`<span class="${cls(t.net_total)}"><b>${ty(t.net_total)}</b></span>`);
      if(t.n_symbols!=null) h+=chatRow(T("Số mã có dòng tiền"),fmtN(t.n_symbols));
    } else {
      const groups=d.groups||[];
      h=`<b>${esc(T("Dòng tiền đổ về đâu"))}</b>`;
      if(groups.length){
        const head=`<tr><td>${esc(T(gb==="exchange"?"Sàn":"Ngành"))}</td>${colF?`<td style="text-align:right">${esc(T("Khối ngoại"))}</td>`:""}${colP?`<td style="text-align:right">${esc(T("Tự doanh"))}</td>`:""}<td style="text-align:right">${esc(T("Gộp"))}</td></tr>`;
        h+='<table class="chatft">'+head+groups.map(g=>`<tr><td>${esc(g.name||g.key||"")}</td>${colF?`<td style="text-align:right" class="${cls(g.net_foreign)}">${ty(g.net_foreign)}</td>`:""}${colP?`<td style="text-align:right" class="${cls(g.net_proprietary)}">${ty(g.net_proprietary)}</td>`:""}<td style="text-align:right" class="${cls(g.net_total)}"><b>${ty(g.net_total)}</b></td></tr>`).join("")+"</table>";
      } else h+=`<br>${esc(T("Chưa có dữ liệu"))}`;
      if(d.total) h+=`<div style="margin-top:4px">${esc(T("Tổng toàn thị trường"))}: <b class="${cls(d.total.net_total)}">${ty(d.total.net_total)}</b></div>`;
    }
    follow=[
      {label:T("Theo ngành"),tool:"get_flow_summary",args:{kind:"both",group_by:"sector"}},
      {label:T("Theo sàn"),tool:"get_flow_summary",args:{kind:"both",group_by:"exchange"}},
      {label:T("Chỉ khối ngoại"),tool:"get_flow_summary",args:{kind:"foreign",group_by:"sector"}},
      {label:T("Chỉ tự doanh"),tool:"get_flow_summary",args:{kind:"proprietary",group_by:"sector"}},
    ];
    if(gb==="sector"&&!d.sector){
      // Chip khoan co cau truc cho 3 nganh dong tien lon nhat: bam la
      // ra ngay the nganh + top ma, khong phu thuoc tang LLM (ca loi
      // 11:35 23/10: the thieu chip khoan, chi con duong go cau tu do).
      const tops=[...(d.groups||[])]
        .sort((x,y)=>Math.abs(y.net_total||0)-Math.abs(x.net_total||0))
        .slice(0,3);
      for(const g of tops){
        if(!g.key) continue;
        follow.push({label:`${T("Phân tích")} ${g.name||g.key} ${T("để rõ hơn")}`,
          tool:"analyze_sector",
          args:{code:g.key}});
      }
    }
  } else if(tool==="get_sector"){
    if(a.code){
      h=`<b>${esc(d.name||a.code)}</b> — ${esc(T("Ngành"))}`;
      const roePct=v=>v==null?null:((Math.abs(v)<=1.5?v*100:v).toFixed(2).replace(".",",")+"%");
      if(d.pe!=null) h+=chatRow("P/E",Number(d.pe).toFixed(2).replace(".",","));
      if(d.roe_ttm!=null) h+=chatRow("ROE (TTM)",roePct(d.roe_ttm));
      if(d.npat_ttm!=null) h+=chatRow(T("LNST (TTM)"),fmtTyAbs(d.npat_ttm));
      if(d.mcap!=null) h+=chatRow(T("Vốn hoá ngành"),fmtTyAbs(d.mcap));
      if(d.n_members!=null) h+=chatRow(T("Số mã thành viên"),fmtN(d.n_members));
      if(d.pe==null&&d.roe_ttm==null) h+=`<br>${esc(T("Chưa có dữ liệu"))}`;
      h+=`<div style="font-size:11px;color:var(--pp-mut)">${esc(T("Kỳ"))}: ${esc(d.latest_period||"")}</div>`;
    } else {
      const rows=d.rows||[];
      const roePct1=v=>v==null?"":("ROE "+(Math.abs(v)<=1.5?v*100:v).toFixed(1).replace(".",",")+"%");
      h=`<b>${esc(T("Ngành"))}</b>`;
      h+='<table class="chatft">'+rows.map(r=>{ const pe=(r.pe!=null?r.pe:r.pe_ttm); return `<tr><td>${esc(r.name||r.code||"")}</td><td style="text-align:right">${pe!=null?"P/E "+Number(pe).toFixed(1).replace(".",","):""}</td><td style="text-align:right">${roePct1(r.roe_ttm)}</td></tr>`; }).join("")+"</table>";
    }
    follow=[{label:T("Tất cả ngành"),tool:"get_sector",args:{}}];
  } else if(tool==="get_macro"){
    if(a.series){
      const rows=d.rows||[];
      const sLbl={omo:"OMO",fx_center:T("Tỷ giá trung tâm USD/VND"),fx_vcb:"Vietcombank",gold_sjc:T("Vàng SJC (bán)"),us10y:T("TP Mỹ 10 năm"),ust_yield:T("TP Mỹ 10 năm"),fed_funds:"Fed",fed_effr:"Fed"}[a.series]||a.series;
      h=`<b>${esc(sLbl)}</b>`;
      const last=rows.length?rows[rows.length-1]:((d.series&&d.series.last)||null);
      if(last){
        if(a.series==="omo"){
          if(last.total!=null) h+=chatRow(T("Tổng trúng thầu"),fmtTyAbs(last.total));
          if(last.total===0) h+=`<div style="margin-top:2px">${esc(T("Không có giao dịch trúng thầu trong ngày"))}</div>`;
          (last.tenors||[]).filter(tn=>(tn.volume||0)>0).forEach(tn=>{ h+=chatRow(`${tn.days} ${esc(T("ngày"))}`,`${fmtTyAbs(tn.volume)} · ${tn.rate!=null?Number(tn.rate)+"%":""}`); });
        } else {
          const KLBL={rate:T("Tỷ giá"),buy:T("Mua"),sell:T("Bán"),yield:T("Lợi suất"),total:T("Tổng")};
          h+=Object.keys(last).filter(k=>k!=="date"&&k!=="notice"&&typeof last[k]==="number").slice(0,5).map(k=>chatRow(KLBL[k]||k, Math.abs(last[k])>=1e9?fmtTyAbs(last[k]):fmtN(last[k]))).join("");
          if(last.notice) h+=`<div style="font-size:11px;color:var(--pp-mut)">${esc(T("Thông báo"))}: ${esc(last.notice)}</div>`;
        }
        h+=`<div style="font-size:11px;color:var(--pp-mut)">${esc(T("Ngày"))}: ${esc(last.date||"")}</div>`;
      } else h+=`<br>${esc(T("Chưa có dữ liệu"))}`;
    } else {
      const pr=d.policy_rates;
      h=`<b>${esc(T("Vĩ mô"))}</b>`;
      if(pr){
        if(pr.refinancing!=null) h+=chatRow(T("Lãi suất tái cấp vốn"),Number(pr.refinancing).toFixed(2).replace(".",",")+"%");
        if(pr.rediscount!=null) h+=chatRow(T("Lãi suất tái chiết khấu"),Number(pr.rediscount).toFixed(2).replace(".",",")+"%");
        if(pr.deposit_avg!=null) h+=chatRow(T("Huy động bình quân"),Number(pr.deposit_avg).toFixed(2).replace(".",",")+"%");
        if(pr.date) h+=`<div style="font-size:11px;color:var(--pp-mut)">${esc(T("Hiệu lực từ"))}: ${esc(pr.date)}</div>`;
      }
      const S=d.series||{};
      const one=(lbl,sv,fmt)=>{ if(!sv||!sv.last) return ""; return chatRow(lbl,fmt(sv.last)); };
      h+=one(T("Tỷ giá trung tâm USD/VND"),S.fx_center,l=>fmtN(l.rate)+" ₫");
      h+=one(T("Vàng SJC (bán)"),S.gold_sjc,l=>fmtN(l.sell)+" ₫");
      h+=one(T("TP Mỹ 10 năm"),S.us10y||S.ust_yield,l=>(l.yield!=null?Number(l.yield).toFixed(2).replace(".",","):"")+"%");
      if(!pr&&!S.fx_center) h+=`<br>${esc(T("Chưa có dữ liệu"))}`;
    }
    follow=[{label:"OMO",tool:"get_macro",args:{series:"omo"}},{label:T("Tỷ giá trung tâm"),tool:"get_macro",args:{series:"fx_center"}}];
  } else if(tool==="get_consensus"){
    if(a.symbol){
      h=`<b>${esc(a.symbol)}</b> — ${esc(T("Đồng thuận các công ty chứng khoán"))}`;
      if(d.n_sources!=null) h+=chatRow(T("Số hãng có khuyến nghị"),fmtN(d.n_sources));
      if(d.mean_target!=null) h+=chatRow(T("Giá mục tiêu trung bình"),fmtN(d.mean_target));
      if(d.cur_price!=null) h+=chatRow(T("Giá hiện tại"),fmtN(d.cur_price));
      if(d.upside!=null) h+=chatRow(T("Dư địa tăng"),`<span class="${d.upside>=0?"up":"dn"}">${fmtPct(d.upside*100)}</span>`);
      const firms=d.firms||[];
      if(firms.length) h+='<table class="chatft">'+firms.map(f=>`<tr><td>${f.link?`<a href="${esc(f.link)}" target="_blank" rel="noopener" style="color:var(--pp-accent);text-decoration:none">${esc(f.src||"")}</a>`:esc(f.src||"")}</td><td>${esc(f.kn||"")}</td><td style="text-align:right">${f.tgt!=null?fmtN(f.tgt):"—"}</td><td style="text-align:right">${esc(f.date||"")}</td></tr>`).join("")+"</table>";
      follow=symFollow(a.symbol);
    } else {
      const rows=d.rows||[];
      h=`<b>${esc(T("Đồng thuận — dư địa tăng cao nhất"))}</b>`;
      h+='<table class="chatft">'+rows.slice(0,10).map(r=>`<tr><td>${symLink(r.symbol)}</td><td style="text-align:right">${r.n_sources!=null?fmtN(r.n_sources)+" "+esc(T("hãng")):""}</td><td style="text-align:right">${r.mean_target!=null?fmtN(r.mean_target):"—"}</td><td style="text-align:right" class="${(r.upside||0)>=0?"up":"dn"}">${r.upside!=null?fmtPct(r.upside*100):"—"}</td></tr>`).join("")+"</table>";
    }
  } else if(tool==="get_screener"){
    const rows=d.rows||[];
    h=`<b>${esc(route.label||T("Sàng lọc"))}</b>`;
    h+='<table class="chatft">'+rows.map((r,i)=>`<tr><td style="color:var(--pp-mut)">${i+1}</td><td>${symLink(r.symbol)}</td><td style="text-align:right">${fmtN((r.close||0)*1000)}</td><td style="text-align:right" class="${(r.pct_change||0)>=0?"up":"dn"}">${r.pct_change!=null?fmtPct(r.pct_change):""}</td><td style="text-align:right">${r.pe_ttm!=null?"P/E "+Number(r.pe_ttm).toFixed(1).replace(".",","):""}</td><td style="text-align:right">${r.roe_ttm!=null?"ROE "+Number(r.roe_ttm).toFixed(1).replace(".",",")+"%":""}</td></tr>`).join("")+"</table>";
    h+=`<div style="font-size:11px;color:var(--pp-mut)">${esc(T("Giá tính bằng đồng"))}</div>`;
  } else if(tool==="get_fundamentals"){
    h=`<b>${esc(a.symbol||"")}</b> — ${esc(T("Chỉ số tài chính"))}${d.quarter?` (${esc(d.quarter)})`:""}`;
    if(d.pe_ttm!=null) h+=chatRow("P/E",Number(d.pe_ttm).toFixed(2).replace(".",","));
    if(d.pb!=null) h+=chatRow("P/B",Number(d.pb).toFixed(2).replace(".",","));
    if(d.roe_ttm!=null) h+=chatRow("ROE",Number(d.roe_ttm).toFixed(2).replace(".",",")+"%");
    if(d.roa_ttm!=null) h+=chatRow("ROA",Number(d.roa_ttm).toFixed(2).replace(".",",")+"%");
    if(d.de_ratio!=null) h+=chatRow(T("Nợ / Vốn chủ"),Number(d.de_ratio).toFixed(2).replace(".",","));
    if(d.eps!=null) h+=chatRow("EPS",fmtN(d.eps)+" ₫");
    if(d.bvps!=null) h+=chatRow("BVPS",fmtN(d.bvps)+" ₫");
    follow=symFollow(a.symbol);
  } else if(tool==="get_statements"){
    const types=d.types||{}, IS=types.IS||[];
    const byId=(id)=>IS.find(r=>r.id===id);
    const findBest=(re,notRe)=>{ const cs=IS.filter(r=>re.test(r.name||"")&&!(notRe&&notRe.test(r.name||"")));
      return cs.find(r=>{ const vs=Object.values(r.v||{}); return vs.some(v=>v!=null); })||cs[0]||null; };
    const rev=byId("IS_NET_INTEREST_INCOME")||byId("IS_REVENUE")||byId("IS_NET_REVENUE")||findBest(/doanh thu/i,/tài chính/i);
    const prf=byId("IS_NET_PROFIT_AFTER_TAX")||findBest(/^lợi nhuận sau thuế/i);
    const pers=(d.periods||[]).slice(0,3);
    h=`<b>${esc(a.symbol||"")}</b> — ${esc(T("Kết quả kinh doanh"))}`;
    const line=(lbl,r)=>{ if(!r) return ""; return `<div style="margin-top:4px">${esc(lbl)}:<br>${pers.map(pp=>`${esc(pp)}: <b>${fmtTyAbs(r.v?r.v[pp]:null)}</b>`).join(" · ")}</div>`; };
    h+=line(rev&&rev.id==="IS_NET_INTEREST_INCOME"?T("Thu nhập lãi thuần"):T("Doanh thu"),rev)+line(T("Lợi nhuận sau thuế"),prf);
    if(!rev&&!prf) h+=`<br>${esc(T("Chưa có dữ liệu"))}`;
    follow=symFollow(a.symbol);
  } else if(tool==="get_events"){
    const items=d.items||[];
    h=`<b>${esc(a.symbol||"")}</b> — ${esc(T("Sự kiện"))}`;
    if(items.length) h+='<table class="chatft">'+items.slice(0,8).map(e=>`<tr><td style="white-space:nowrap">${esc(e.date||e.event_date||"")}</td><td>${esc(e.title||e.name||e.event_type||"")}</td></tr>`).join("")+"</table>";
    else h+=`<br>${esc(T("Chưa có dữ liệu"))}`;
    follow=symFollow(a.symbol);
  } else if(tool==="get_news"){
    const items=d.items||[];
    h=`<b>${esc(T("Tin tức"))}${a.symbol?" — "+esc(a.symbol):""}</b>`;
    if(d.latest_published_at) h+=`<div style="margin-top:4px">${esc(T("Tin mới nhất"))}: <b>${esc(chatAsOf(d.latest_published_at))}</b></div>`;
    if(items.length) h+='<div style="margin-top:4px">'+items.slice(0,6).map(n=>`<div style="padding:5px 0;border-bottom:1px solid var(--pp-line)">${n.url?`<a href="${esc(n.url)}" target="_blank" rel="noopener" style="color:var(--pp-ink);text-decoration:none">${esc(n.title||"")}</a>`:esc(n.title||"")}<div style="font-size:11px;color:var(--pp-mut)">${esc(chatAsOf(n.published_at||n.time||""))}${n.source?" · "+esc(n.source):""}</div></div>`).join("")+"</div>";
    else h+=`<br>${esc(T("Chưa có dữ liệu"))}`;
  } else if(tool==="analyze_sector"){
    const fl=d.flow_latest||{}, bl=d.breadth_latest||{}, cx=d.context||{};
    h=`<b>${esc(T("Phân tích ngành"))} ${esc((d.sector||{}).name||a.code||"")}</b>`;
    h+=chatRow(T("Ròng khối ngoại"),`<span class="${cls(fl.foreign_net_total)}"><b>${ty(fl.foreign_net_total)}</b></span>`);
    h+=chatRow(T("Ròng tự doanh"),`<span class="${cls(fl.proprietary_net_total)}"><b>${ty(fl.proprietary_net_total)}</b></span>`);
    if(fl.concentration_top3!=null) h+=chatRow(T("Độ tập trung top 3"),(fl.concentration_top3*100).toFixed(1).replace(".",",")+"%");
    if(bl.advancers!=null) h+=chatRow(T("Độ rộng"),`${fmtN(bl.advancers)} ${esc(T("mã tăng"))} · ${fmtN(bl.decliners)} ${esc(T("mã giảm"))} · ${fmtN(bl.unchanged)} ${esc(T("đứng giá"))}${bl.pct_advancers!=null?" ("+Number(bl.pct_advancers).toFixed(1).replace(".",",")+"%)":""}`);
    if(bl.turnover_value!=null) h+=chatRow(T("Giá trị"),`${fmtTyAbs(bl.turnover_value)}${bl.turnover_share_pct!=null?" · "+Number(bl.turnover_share_pct).toFixed(1).replace(".",",")+"% "+esc(T("toàn thị trường")):""}`);
    if(cx.pe&&cx.pe.current!=null) h+=chatRow("P/E",Number(cx.pe.current).toFixed(2).replace(".",","));
    if(cx.index) h+=chatRow(T("Chỉ số ngành"),`${esc(cx.index.code)} ${fmtN(cx.index.close)}${cx.index.pct_change!=null?` <span class="${cx.index.pct_change>=0?"up":"dn"}">${fmtPct(cx.index.pct_change)}</span>`:""}`);
    const tops=fl.top_contributors||[];
    if(tops.length) h+='<table class="chatft">'+tops.slice(0,8).map(r=>`<tr><td>${r.symbol?symLink(r.symbol):""}</td><td style="text-align:right" class="${cls(r.foreign_net)}">${ty(r.foreign_net)}</td><td style="text-align:right" class="${cls(r.proprietary_net)}">${ty(r.proprietary_net)}</td><td style="text-align:right" class="${cls(r.combined_net)}"><b>${ty(r.combined_net)}</b></td></tr>`).join("")+"</table>";
    if(d.trend&&d.trend.flow&&d.trend.flow.sums){
      const sm=d.trend.flow.sums;
      h+=`<div style="margin-top:6px;font-weight:700">${esc(T("Xu hướng nhiều phiên"))}</div>`;
      if(sm.foreign) h+=chatRow(T("Ròng khối ngoại")+" 5/20/60",`${ty(sm.foreign.d5)} · ${ty(sm.foreign.d20)} · ${ty(sm.foreign.d60)}`);
      if(sm.proprietary) h+=chatRow(T("Ròng tự doanh")+" 5/20/60",`${ty(sm.proprietary.d5)} · ${ty(sm.proprietary.d20)} · ${ty(sm.proprietary.d60)}`);
      if(d.trend.breadth&&d.trend.breadth.latest) h+=chatRow(T("Trên MA20/MA50"),`${d.trend.breadth.latest.pct_above_ma20!=null?Number(d.trend.breadth.latest.pct_above_ma20).toFixed(1).replace(".",",")+"%":"—"} / ${d.trend.breadth.latest.pct_above_ma50!=null?Number(d.trend.breadth.latest.pct_above_ma50).toFixed(1).replace(".",",")+"%":"—"}`);
    } else {
      h+=`<div style="font-size:11px;color:var(--pp-mut);margin-top:4px">${esc(T("Xu hướng nhiều phiên"))}: ${esc(T("chưa có dữ liệu"))}</div>`;
    }
    follow=[{label:T("Dòng tiền theo ngành"),tool:"get_flow_summary",args:{kind:"both",group_by:"sector"}}];
  } else if(tool==="analyze_symbol"){
    const sym=d.symbol||a.symbol||"", pp=d.price_position||{}, ma=pp.ma||{}, pv=pp.pct_vs_ma||{}, ind=d.indicators||{}, fl=d.flow||{};
    h=`<b>${esc(T("Phân tích"))} ${esc(sym)}</b>`;
    if(pp.close!=null) h+=chatRow(T("Đóng cửa"),`<b>${fmtN(pp.close)}</b>`);
    if(ma.ma20!=null) h+=chatRow("MA20 / MA50",`${fmtN(ma.ma20)} / ${fmtN(ma.ma50)}${pv.ma20!=null?` <span class="${pv.ma20>=0?"up":"dn"}">(${pv.ma20>=0?"+":""}${Number(pv.ma20).toFixed(2).replace(".",",")}%)</span>`:""}`);
    if(pp.range_52w&&pp.range_52w.low!=null) h+=chatRow(T("Biên 52 tuần"),`${fmtN(pp.range_52w.low)} – ${fmtN(pp.range_52w.high)}`);
    if(ind.rsi_14!=null) h+=chatRow("RSI(14)",Number(ind.rsi_14).toFixed(1).replace(".",","));
    if(d.trend_template) h+=chatRow(T("Tiêu chí xu hướng (Minervini)"),`${d.trend_template.met}/${d.trend_template.evaluable||8}`);
    if(fl.foreign_net) h+=chatRow(T("Ròng khối ngoại")+" 5/20/60",`${ty(fl.foreign_net.d5)} · ${ty(fl.foreign_net.d20)} · ${ty(fl.foreign_net.d60)}`);
    if(fl.proprietary_net) h+=chatRow(T("Ròng tự doanh")+" 5/20/60",`${ty(fl.proprietary_net.d5)} · ${ty(fl.proprietary_net.d20)} · ${ty(fl.proprietary_net.d60)}`);
    const cs=d.consensus;
    if(cs&&cs.target) h+=chatRow(T("Giá mục tiêu trung vị"),`${fmtN(cs.target.median)} <span class="${(cs.upside_median_pct||0)>=0?"up":"dn"}">(${cs.upside_median_pct!=null?fmtPct(cs.upside_median_pct):""})</span> · ${fmtN(cs.firms_12m)} ${esc(T("hãng"))}`);
    else if(cs&&cs.targets) h+=chatRow(T("Đồng thuận"),cs.targets.map(t=>`${esc(t.firm||"")}: ${fmtN(t.target)}`).join(" · "));
    const hd=d.holders;
    if(hd&&hd.top&&hd.top.length) h+=chatRow(T("Cổ đông lớn nhất"),`${esc(hd.top[0].name||"")}${hd.top[0].pct!=null?" — "+Number(hd.top[0].pct).toFixed(2).replace(".",",")+"%":""}`);
    follow=symFollow(sym);
  } else if(tool==="analyze_compare"){
    const nm=v=>{ if(v==null) return "—"; return esc(String(v)); };
    h=`<b>${esc(T("So sánh"))} ${esc((a.items||[]).join(" · "))}</b>`;
    const fmtU=(u,v)=>{ if(v==null) return "—"; if(u==="VND") return fmtTyAbs(v); if(u==="pp") return Number(v).toFixed(2).replace(".",","); if(u==="lan") return Number(v).toFixed(2).replace(".",","); return fmtN(v); };
    if((d.criteria||[]).length) h+='<table class="chatft">'+d.criteria.map(c=>`<tr><td>${esc(c.label||c.key||"")}</td><td style="text-align:right">${fmtU(c.unit,c.a)}</td><td style="text-align:right">${fmtU(c.unit,c.b)}</td><td style="text-align:right" class="${(c.diff||0)>=0?"up":"dn"}">${c.diff!=null?(c.diff>0?"+":"")+fmtU(c.unit,c.diff):""}</td></tr>`).join("")+"</table>";
    if((d.unilateral||[]).length) h+=`<div style="font-size:11px;color:var(--pp-mut)">${esc(T("Một số tiêu chí chỉ một phía có dữ liệu"))}</div>`;
  } else if(tool==="analyze_market"){
    h=`<b>${esc(T("Toàn cảnh thị trường"))}</b>`;
    const ix=d.indices||[];
    if(ix.length) h+='<table class="chatft">'+ix.slice(0,6).map(e=>`<tr><td>${esc(e.code||"")}</td><td style="text-align:right"><b>${fmtN(e.close)}</b></td><td style="text-align:right" class="${(e.pct_change||0)>=0?"up":"dn"}">${e.pct_change!=null?fmtPct(e.pct_change):""}</td></tr>`).join("")+"</table>";
    const bx=(d.breadth||{}).by_exchange||{};
    for(const ex of Object.keys(bx)) h+=chatRow(ex,`${fmtN(bx[ex].advancers)} ${esc(T("mã tăng"))} · ${fmtN(bx[ex].decliners)} ${esc(T("mã giảm"))}`);
    if(d.trin&&d.trin.value!=null) h+=chatRow("TRIN",Number(d.trin.value).toFixed(2).replace(".",","));
    const dv=d.divergence||{};
    if(dv.cw_ew_spread_pp!=null){
      h+=chatRow(T("Phân kỳ CW−EW"),`<span class="${dv.cw_ew_spread_pp>=0?"up":"dn"}"><b>${dv.cw_ew_spread_pp>0?"+":""}${Number(dv.cw_ew_spread_pp).toFixed(2).replace(".",",")} pp</b></span> · EW ${dv.ew_pct!=null?(dv.ew_pct>0?"+":"")+Number(dv.ew_pct).toFixed(2).replace(".",",")+"%":"—"} · ${dv.pct_advancers!=null?Number(dv.pct_advancers).toFixed(1).replace(".",",")+"% "+esc(T("mã tăng")):""}`);
      if(dv.leader_laggard_spread_pp!=null) h+=chatRow(T("Ngành dẫn dắt − lùi sau"),`${Number(dv.leader_laggard_spread_pp).toFixed(2).replace(".",",")} pp · ${fmtN(dv.sectors_up||0)}/${fmtN(dv.sectors_total||0)} ${esc(T("ngành tăng"))}`);
    }
    const ft=d.flow_totals||{};
    if(ft.foreign_net!=null) h+=chatRow(T("Ròng khối ngoại"),`<span class="${cls(ft.foreign_net)}"><b>${ty(ft.foreign_net)}</b></span>`);
    if(ft.proprietary_net!=null) h+=chatRow(T("Ròng tự doanh"),`<span class="${cls(ft.proprietary_net)}"><b>${ty(ft.proprietary_net)}</b></span>`);
    if(d.regime) h+=chatRow(T("Trạng thái thị trường"),esc(typeof d.regime==="string"?d.regime:(d.regime.regime||"")));
    follow=[{label:T("Dòng tiền đổ về đâu"),tool:"get_flow_summary",args:{kind:"both",group_by:"sector"}}];
  } else if(tool==="analyze_holders"){
    const sym=d.symbol||a.symbol||"", cz=d.concentration||{}, hh=cz.hhi_partial||{}, ff=d.free_float||{}, fr=d.foreign_room, ld=d.leadership||{}, ch=d.changes;
    const pc=v=>v==null?"—":Number(v).toFixed(2).replace(".",",")+"%";
    h=`<b>${esc(T("Cổ đông & sở hữu"))} ${esc(sym)}</b>`;
    if(cz.cr1_pct!=null) h+=chatRow(T("Cô đặc")+" CR1/CR5/CR10",`${pc(cz.cr1_pct)} · ${pc(cz.cr5_pct)} · ${pc(cz.cr10_pct)}`);
    if(hh.value!=null) h+=chatRow(T("HHI từng phần"),`${Number(hh.value).toFixed(3).replace(".",",")} · ${esc(T("Độ phủ"))} ${pc(hh.coverage_shares_pct)} · ${esc(T("Phần chưa công bố"))} ${pc(hh.residual_pct)}`);
    if(cz.top_holders&&cz.top_holders.length) h+=chatRow(T("Cổ đông lớn nhất"),`${esc(cz.top_holders[0].name||"")} — ${pc(cz.top_holders[0].pct)}`);
    if(ff.pct_upper_bound!=null) h+=chatRow(T("Free float (cận trên)"),pc(ff.pct_upper_bound));
    if(fr) h+=chatRow(T("Room ngoại"),`${esc(T("Trần"))} ${pc(fr.fol_max_pct)} · ${esc(T("đang giữ"))} ${pc(fr.foreign_owned_pct)} · ${esc(T("còn lại"))} ${fr.room_pp!=null?Number(fr.room_pp).toFixed(2).replace(".",",")+" pp":"—"} (${fmtN(fr.room_shares)} CP)${fr.status==="tight"?" · "+esc(T("kín room")):""}`);
    else h+=chatRow(T("Room ngoại"),esc(T("chưa có dữ liệu")));
    if(ld.ownership_pct_incl_related!=null) h+=chatRow(T("Lãnh đạo nắm giữ"),`${pc(ld.ownership_pct_incl_related)} · ${fmtN(ld.holders_count||0)} ${esc(T("người"))}${ld.chair_pct!=null?" · "+esc(T("Chủ tịch"))+" "+pc(ld.chair_pct):""}`);
    if(ch&&ch.counts) h+=chatRow(T("Thay đổi giữa 2 kỳ chốt"),`${fmtN(ch.counts.changed||0)} ${esc(T("thay đổi"))} · ${fmtN(ch.counts.unchanged||0)} ${esc(T("giữ nguyên"))}`);
    else h+=chatRow(T("Thay đổi giữa 2 kỳ chốt"),esc(T("chưa có dữ liệu")));
    if(ch&&ch.entries&&ch.entries.length) h+='<table class="chatft">'+ch.entries.slice(0,6).map(e=>`<tr><td>${esc(e.holder||"")}</td><td>${esc(e.class||"")}</td><td style="text-align:right" class="${(e.d_shares||0)>=0?"up":"dn"}">${e.d_shares!=null?((e.d_shares>0?"+":"")+fmtN(e.d_shares)):""}</td><td style="text-align:right">${e.d_pp!=null?((e.d_pp>0?"+":"")+Number(e.d_pp).toFixed(2).replace(".",","))+" pp":""}</td></tr>`).join("")+"</table>";
    h+=chatRow(T("Sự kiện nội bộ"),esc(T("chưa có dữ liệu")));
    follow=sym?[{label:`${T("Phân tích")} ${sym}`,tool:"analyze_symbol",args:{symbol:sym}},{label:T("Hồ sơ công ty"),tool:"get_company_profile",args:{symbol:sym}}]:[];
  } else if(tool==="get_holder_portfolio_changes"){
    const hd=d.holder||{};
    h=`<b>${esc(T("Thay đổi nắm giữ"))} — ${esc(hd.name||a.name||"")}</b>`;
    if(hd.symbols_with_prev_period!=null) h+=chatRow(T("Số mã có 2 kỳ chốt"),`${fmtN(hd.symbols_with_prev_period)}/${fmtN(hd.symbols_held||0)}`);
    if((d.entries||[]).length) h+='<table class="chatft">'+d.entries.slice(0,15).map(e=>`<tr><td>${e.symbol?symLink(e.symbol):""}</td><td>${esc(e.class||"")}</td><td style="text-align:right" class="${(e.d_shares||0)>=0?"up":"dn"}">${e.d_shares!=null?((e.d_shares>0?"+":"")+fmtN(e.d_shares)):""}</td><td style="text-align:right">${e.d_pp!=null?((e.d_pp>0?"+":"")+Number(e.d_pp).toFixed(2).replace(".",","))+" pp":""}</td></tr>`).join("")+"</table>";
    else h+=`<div style="font-size:11px;color:var(--pp-mut);margin-top:4px">${esc(T("Chưa đủ 2 kỳ chốt để kết luận thay đổi"))}</div>`;
    follow=[];
  } else if(tool==="get_analysis_catalog"){
    const ents=(d&&d.entries)||[];
    h=`<b>${esc(T("Danh mục phân tích"))}</b>`;
    if(ents.length) h+='<table class="chatft">'+ents.slice(0,8).map(e=>`<tr><td><b>${esc(e.name||"")}</b></td><td>${esc(e.label||"")}</td></tr>`).join("")+"</table>"+(ents[0].definition?`<div style="font-size:11px;color:var(--pp-mut);margin-top:4px">${esc(ents[0].definition)}</div>`:"");
    else h+=`<div style="font-size:11px;color:var(--pp-mut);margin-top:4px">${esc(T("chưa có dữ liệu"))}</div>`;
    follow=[];
  } else if(tool==="calc_flow_sum"){
    h=`<b>${esc(a.symbol||"")} — ${esc(T("Tổng dòng tiền"))}</b>`;
    if(d.foreign) h+=chatRow(T("Khối ngoại"),`<span class="${cls(d.foreign.net)}"><b>${ty(d.foreign.net)}</b></span> · ${fmtN(d.foreign.sessions)} ${esc(T("phiên"))}`);
    if(d.proprietary) h+=chatRow(T("Tự doanh"),`<span class="${cls(d.proprietary.net)}"><b>${ty(d.proprietary.net)}</b></span> · ${fmtN(d.proprietary.sessions)} ${esc(T("phiên"))}`);
    if(d.net_total!=null) h+=chatRow(T("Ròng gộp"),`<b>${ty(d.net_total)}</b> · ${fmtN(d.sessions)} ${esc(T("phiên"))}`);
  }
  return h+chatFollowHtml(follow)+chatMetaHtml(p);
}
function chatRoute(qRaw){
  const q=qRaw||"";
  // Ma chung khoan: chi nhan TOKEN dung mot minh (tranh bat manh ASCII
  // trong tu tieng Viet co dau, vd "NGO" trong "NGOẠI" — loi 23/10) va
  // doi chieu danh muc ma that SS_ROWS neu da tai (chan not "NAY" trong
  // "hom nay"); chua tai thi dung danh sach tu dung tieng Viet/chi so.
  let sym=null;
  { const STOP=new Set(["ROE","EPS","NAY","MUA","BAN","XEM","CHO","HOM","QUA","SAU","MAI","MOT","HAI","BON","BAY","TAM","CHI","PHI","VON","LAI","TOT","XAU","CAO","MOI","THE","AND","FOR","HOW","ROOM","FREE","FLOAT"]);
    const cands=q.match(/(?:^|\s)([A-Za-z]{3,4})(?=[\s?.!,]|$)/g)||[];
    for(const cm of cands){ const t=cm.trim(), up=t.toUpperCase();
      const inUni=(typeof window.SS_ROWS!=="undefined"&&window.SS_ROWS&&window.SS_ROWS.length)?window.SS_ROWS.some(r=>r.s===up):null;
      if((t===t.toUpperCase()||t===t.toLowerCase())&&!STOP.has(up)&&(inUni===null||inUni)){ sym=up; break; } } }
  const low=q.toLowerCase();
  const has=(re)=>re.test(low);
  if(has(/lãi suất điều hành|tái cấp vốn|tái chiết khấu/)) return {tool:"get_macro",args:{},label:q};
  if(has(/omo/)) return {tool:"get_macro",args:{series:"omo"},label:q};
  if(has(/tỷ giá trung tâm/)) return {tool:"get_macro",args:{series:"fx_center"},label:q};
  if(has(/giá vàng|vàng sjc/)) return {tool:"get_macro",args:{series:"gold_sjc"},label:q};
  if(has(/vĩ mô/)) return {tool:"get_macro",args:{},label:q};
  // Dong tien theo dich den PHAI dung truoc luat /nganh/: "do ve dau"
  // la cau tong hop dong tien, khong phai bang P/E nganh (ca loi goc
  // anh Henrry 07:40 23/10).
  if(has(/đổ về|đổ vào|tiền.*(vào|ra|đâu)|dòng tiền.*(ngành|sàn|đâu)/)) return {tool:"get_flow_summary",args:{kind:has(/tự doanh/)?"proprietary":has(/khối ngoại|nước ngoài/)?"foreign":"both",group_by:has(/sàn|hose|hnx|upcom/)?"exchange":"sector"},label:q};
  // Khoan nganh TAT DINH (lenh dau moi 21:39 23/10): "phan tich
  // <nganh> de ro hon" va bien the -> analyze_sector nhu duong chip
  // khoan (Worker tra fallback hoac mat mang). Dat truoc luat /nganh/.
  // Fix dinh tuyen (Chot 27/10): them ho "ma nao" — giong luoi worker
  // (deterministicDrill) de cau "ma nao" khong co chu "nganh" van khoan
  // dung nganh thay vi roi null -> tu choi (ca Q3 22:37 27/10).
  if(!sym&&has(/phân tích|để rõ hơn|khoan sâu|xem thêm|thì sao|kỹ hơn|mã nào|ma nao/)){
    const SD=[["bất động sản","8600"],["bđs","8600"],["ngân hàng","8300"],["dầu khí","0500"],["tài nguyên cơ bản","1700"],["thực phẩm","3500"],["điện","7500"],["bán lẻ","5300"],["xây dựng","2300"],["du lịch","5700"],["hóa chất","1300"],["ô tô","3300"],["dịch vụ tài chính","8700"],["chứng khoán","8700"],["công nghệ","9500"],["viễn thông","6500"],["y tế","4500"],["truyền thông","5500"],["bảo hiểm","8500"]];
    for(const [nm,cd] of SD){ if(low.includes(nm)) return {tool:"analyze_sector",args:{code:cd},label:q}; }
  }
  if(has(/ngành/)){ if(has(/ngân hàng/)) return {tool:"get_sector",args:{code:"8300"},label:q}; return {tool:"get_sector",args:{},label:q}; }
  if(has(/đồng thuận|khuyến nghị|giá mục tiêu/)) return {tool:"get_consensus",args:sym?{symbol:sym}:{},label:q};
  if(has(/tự doanh/)) return {tool:"get_flow",args:sym?{kind:"proprietary",symbol:sym,days:30}:{kind:"proprietary"},label:q};
  if(has(/khối ngoại|nước ngoài/)){ const dm=low.match(/(\d+)\s*ngày/); return {tool:"get_flow",args:sym?{kind:"foreign",symbol:sym,days:dm?Number(dm[1]):30}:{kind:"foreign"},label:q}; }
  if(has(/thay đổi nắm giữ|tăng hay giảm nắm|kỳ này.*(tăng|giảm).*nắm/)){
    const name=q.replace(/ông|bà|anh|chị/gi," ").replace(/kỳ này.*$/i,"").replace(/thay đổi nắm giữ.*$/i,"").replace(/tăng hay giảm nắm.*$/i,"").replace(/[?？]/g,"").trim();
    if(name.split(/\s+/).length>=2) return {tool:"get_holder_portfolio_changes",args:{name},label:q};
  }
  if(sym&&has(/cô đặc|room ngoại|room của|trần.*ngoại|free float|tự do chuyển nhượng|lãnh đạo.*(nắm|giữ|sở hữu)/)) return {tool:"analyze_holders",args:{symbol:sym},label:q};
  if(has(/nắm/)&&!has(/cổ đông lớn/)){
    const name=q.replace(/ông|bà|anh|chị/gi," ").replace(/đang\s*nắm.*$/i,"").replace(/nắm.*$/i,"").replace(/[?？]/g,"").trim();
    if(name.split(/\s+/).length>=2) return {tool:"find_holder",args:{name},label:q};
  }
  if(has(/p\/e thấp nhất|thấp nhất thị trường/)) return {tool:"get_screener",args:{sort_by:"pe_ttm",order:"asc",limit:10},label:T("P/E thấp nhất thị trường")};
  if(has(/tăng mạnh nhất/)) return {tool:"get_screener",args:{sort_by:"pct_change",order:"desc",limit:10},label:T("Tăng mạnh nhất")};
  if(has(/giá trị giao dịch|thanh khoản cao nhất|giá trị lớn nhất/)) return {tool:"get_screener",args:{sort_by:"value_vnd",order:"desc",limit:10},label:T("Giá trị giao dịch lớn nhất")};
  if(has(/sàng lọc|xếp hạng/)) return {tool:"get_screener",args:{sort_by:"pct_change",order:"desc",limit:10},label:T("Sàng lọc")};
  if(has(/cổ đông lớn|hồ sơ/)) { if(sym) return {tool:"get_company_profile",args:{symbol:sym},label:q}; }
  if(has(/sự kiện|cổ tức|đại hội/)) { if(sym) return {tool:"get_events",args:{symbol:sym},label:q}; }
  if(has(/doanh thu|lợi nhuận|kết quả kinh doanh|báo cáo tài chính/)) { if(sym) return {tool:"get_statements",args:{symbol:sym,periods:4},label:q}; }
  if(has(/chỉ số tài chính|p\/e của|roe của|cơ bản/)) { if(sym) return {tool:"get_fundamentals",args:{symbol:sym},label:q}; }
  if(has(/tin/)) return {tool:"get_news",args:sym?{symbol:sym}:{},label:q};
  if(has(/chỉ số/)&&(has(/phiên|biểu đồ|diễn biến|nến/))) { const ix=["VNINDEX","VN30","HNX","UPCOM"].find(x=>q.toUpperCase().includes(x))||"VNINDEX"; const lm=low.match(/(\d+)\s*phiên/); return {tool:"get_ohlcv",args:{symbol:ix,limit:lm?Number(lm[1]):20},label:q}; }
  if(has(/biểu đồ|nến|diễn biến|phiên gần/)) { if(sym&&!IDX_LIST.includes(sym)) return {tool:"get_ohlcv",args:{symbol:sym,limit:20},label:q}; if(sym) return {tool:"get_ohlcv",args:{symbol:sym,limit:20},label:q}; }
  if(has(/chỉ số|thị trường hôm nay/)) return {tool:"get_indices",args:{},label:q};
  if(sym) return {tool:"get_quote",args:{symbol:sym},label:q};
  return null;
}
// ---- Dot B: lich su hoi thoai + tang dieu phoi LLM ----
// _chatHist: toi da 8 luot {u, tool, args}; tool=null khi luot truoc
// khong goi tool (tra loi text). Chen vao ngu canh gui len
// /api/ai/chat de LLM giai quyet cau sua y / khuyet chu ngu.
const _chatHist=[];
function chatPushHist(q,route){
  if(!q) return;
  _chatHist.push({u:q,tool:route?route.tool:null,args:(route&&route.args)||{}});
  while(_chatHist.length>8) _chatHist.shift();
}
async function _chatFill(inner,label,route,pre){
  try{
    if(pre&&pre.errorText){ inner.innerHTML=`<b>${esc(pre.errorText)}</b>`; chatPushHist(label,route); return; }
    if(pre&&pre.textOnly){ inner.innerHTML=esc(pre.textOnly); chatPushHist(label,null); return; }
    if(!route){ inner.innerHTML=`<b>${esc(T("Câu hỏi này em chưa trả lời được."))}</b><br>${esc(T("Thử các câu gợi ý ở đầu trang, hoặc hỏi theo mã cổ phiếu, ngành, vĩ mô, dòng tiền…"))}`; return; }
    const p=(pre&&pre.envelope)||await mcpCall(route.tool,route.args);
    let html=chatRender({...route,label},p);
    if(pre&&pre.lead) html=`<div style="font-style:italic;margin-bottom:6px">${esc(pre.lead)}</div>`+html;
    inner.innerHTML=html;
    chatPushHist(label,route);
  }catch(e){ inner.textContent=T("Lỗi tải dữ liệu. Thử lại sau."); }
  $("chatBox").scrollTop=$("chatBox").scrollHeight;
}
async function chatRun(label,route){
  chatAdd("u",label);
  const d=chatAdd("a",esc(T("Đang tìm…")));
  const inner=d.querySelector("div>div");
  await _chatFill(inner,label,route,null);
}
// Cau goi tay: LLM dieu phoi truoc (hieu y + ngu canh); moi loi mem
// tu worker (fallback) hoac loi mang -> roi ve bo khop Dot A.
async function chatSmart(q){
  if(typeof window.ssLoad==="function"&&!window.SS_ROWS){ try{ await window.ssLoad(); }catch(e){} }
  chatAdd("u",q);
  const d=chatAdd("a",esc(T("Đang tìm…")));
  const inner=d.querySelector("div>div");
  const msgs=[];
  for(const it of _chatHist){
    msgs.push({role:"user",text:it.u});
    if(it.tool) msgs.push({role:"assistant",text:"TOOL "+it.tool+" "+JSON.stringify(it.args||{})});
  }
  msgs.push({role:"user",text:q});
  const tok=localStorage.getItem("elab_authToken")||"";
  const ctl=("AbortController" in window)?new AbortController():null;
  const timer=ctl?setTimeout(()=>ctl.abort(),15000):null;
  let j=null;
  try{
    const r=await fetch("/api/ai/chat",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+tok},
      body:JSON.stringify({messages:msgs,lang:curLang}),signal:ctl?ctl.signal:undefined});
    j=await r.json().catch(()=>null);
  }catch(e){ j=null; }
  if(timer) clearTimeout(timer);
  if(!j||j.fallback||!j.ok){
    await _chatFill(inner,q,chatRoute(q),null); return;
  }
  const route=j.tool?{tool:j.tool,args:j.args||{},label:q}:null;
  await _chatFill(inner,q,route,{envelope:j.envelope,lead:j.lead||null,errorText:j.errorText||null,textOnly:j.tool?null:(j.text||"")});
}
function chatAsk(){
  const q=$("chatIn").value.trim(); if(!q) return;
  $("chatIn").value="";
  chatSmart(q);
}
$("chatSend").onclick=chatAsk;
$("chatIn").onkeydown=e=>{if(e.key==="Enter")chatAsk();};


// ---- Cau hoi goi y theo 7 nhom kha nang (Dot A) ----
const CHAT_GROUPS=[
 {t:{vi:"Giá & biểu đồ",en:"Price & charts",zh:"价格与图表",ko:"가격·차트"},qs:[
  {q:{vi:"Giá FPT phiên gần nhất?",en:"Latest FPT price?",zh:"FPT最新价格?",ko:"FPT 최근 가격?"},tool:"get_quote",args:{symbol:"FPT"}},
  {q:{vi:"VNINDEX 20 phiên gần đây diễn biến thế nào?",en:"How has VNINDEX moved over the last 20 sessions?",zh:"VNINDEX近20个交易日走势如何?",ko:"VNINDEX 최근 20거래일 흐름은?"},tool:"get_ohlcv",args:{symbol:"VNINDEX",limit:20}},
  {q:{vi:"Chỉ số thị trường hôm nay",en:"Market indices today",zh:"今日市场指数",ko:"오늘 시장 지수"},tool:"get_indices",args:{}},
 ]},
 {t:{vi:"Hồ sơ & cổ đông",en:"Profile & shareholders",zh:"公司资料与股东",ko:"기업 정보·주주"},qs:[
  {q:{vi:"Cổ đông lớn nhất của FPT là ai?",en:"Who is FPT's largest shareholder?",zh:"FPT的最大股东是谁?",ko:"FPT의 최대 주주는 누구인가요?"},tool:"get_company_profile",args:{symbol:"FPT"}},
  {q:{vi:"Ông Trương Gia Bình đang nắm những mã nào?",en:"Which stocks does Mr. Truong Gia Binh hold?",zh:"张家平先生持有哪些股票?",ko:"쯔엉자빈 회장은 어떤 종목을 보유하고 있나요?"},tool:"find_holder",args:{name:"Trương Gia Bình"}},
  {q:{vi:"Sự kiện sắp tới của VNM",en:"Upcoming VNM events",zh:"VNM近期事件",ko:"VNM 예정 이벤트"},tool:"get_events",args:{symbol:"VNM"}},
 ]},
 {t:{vi:"Dòng tiền",en:"Money flow",zh:"资金流",ko:"수급"},qs:[
  {q:{vi:"Khối ngoại mua ròng VCB 30 ngày qua thế nào?",en:"Foreign net buying of VCB over the last 30 days?",zh:"近30日外资净买入VCB情况?",ko:"최근 30일 외국인 VCB 순매수는?"},tool:"get_flow",args:{kind:"foreign",symbol:"VCB",days:30}},
  {q:{vi:"Tự doanh hôm nay mua ròng mạnh nhất mã nào?",en:"Which stock did proprietary desks net-buy most today?",zh:"今日自营净买入最多的股票?",ko:"오늘 자기자본 순매수 1위 종목은?"},tool:"get_flow",args:{kind:"proprietary"}},
  {q:{vi:"Khối ngoại hôm nay mua/bán ròng ra sao?",en:"Foreign net flow today?",zh:"今日外资净买卖情况?",ko:"오늘 외국인 순매매는?"},tool:"get_flow",args:{kind:"foreign"}},
 ]},
 {t:{vi:"Đồng thuận CTCK",en:"Broker consensus",zh:"券商共识",ko:"증권사 컨센서스"},qs:[
  {q:{vi:"FPT được mấy hãng khuyến nghị, giá mục tiêu trung bình bao nhiêu?",en:"How many brokers cover FPT and what is the average target?",zh:"有多少家券商覆盖FPT,平均目标价多少?",ko:"FPT를 커버하는 증권사는 몇 곳, 평균 목표가는?"},tool:"get_consensus",args:{symbol:"FPT"}},
  {q:{vi:"Mã nào có dư địa tăng theo đồng thuận cao nhất?",en:"Which stock has the highest consensus upside?",zh:"共识上涨空间最大的股票?",ko:"컨센서스 상승 여력이 가장 큰 종목은?"},tool:"get_consensus",args:{}},
 ]},
 {t:{vi:"Vĩ mô",en:"Macro",zh:"宏观",ko:"거시경제"},qs:[
  {q:{vi:"Lãi suất điều hành hiện nay bao nhiêu?",en:"Current policy interest rates?",zh:"当前政策利率是多少?",ko:"현재 정책금리는?"},tool:"get_macro",args:{}},
  {q:{vi:"OMO hôm nay bơm/hút bao nhiêu?",en:"Today's open-market operations?",zh:"今日公开市场操作如何?",ko:"오늘 공개시장운영은?"},tool:"get_macro",args:{series:"omo"}},
  {q:{vi:"Tỷ giá trung tâm USD/VND hôm nay?",en:"Today's USD/VND central rate?",zh:"今日美元/越盾中心汇率?",ko:"오늘 USD/VND 기준환율은?"},tool:"get_macro",args:{series:"fx_center"}},
 ]},
 {t:{vi:"Ngành",en:"Sectors",zh:"行业",ko:"업종"},qs:[
  {q:{vi:"Ngành ngân hàng: P/E và ROE ra sao?",en:"Banking sector: P/E and ROE?",zh:"银行行业:市盈率和ROE如何?",ko:"은행 업종: P/E와 ROE는?"},tool:"get_sector",args:{code:"8300"}},
  {q:{vi:"Tất cả ngành: P/E hiện tại",en:"All sectors: current P/E",zh:"全部行业:当前市盈率",ko:"전체 업종: 현재 P/E"},tool:"get_sector",args:{}},
 ]},
 {t:{vi:"Sàng lọc",en:"Screener",zh:"筛选",ko:"스크리너"},qs:[
  {q:{vi:"Mã có P/E thấp nhất thị trường?",en:"Lowest P/E stocks?",zh:"市盈率最低的股票?",ko:"P/E가 가장 낮은 종목은?"},tool:"get_screener",args:{sort_by:"pe_ttm",order:"asc",limit:10}},
  {q:{vi:"Mã tăng mạnh nhất hôm nay",en:"Top gainers today",zh:"今日涨幅最大的股票",ko:"오늘 상승률 상위 종목"},tool:"get_screener",args:{sort_by:"pct_change",order:"desc",limit:10}},
  {q:{vi:"Mã có giá trị giao dịch lớn nhất",en:"Highest traded value",zh:"成交额最大的股票",ko:"거래대금 상위 종목"},tool:"get_screener",args:{sort_by:"value_vnd",order:"desc",limit:10}},
 ]},
];
const SUG_TITLE={vi:"Câu hỏi gợi ý",en:"Suggested questions",zh:"推荐问题",ko:"추천 질문"};
let _sugOpen=false;
function chatSugToggle(){
  _sugOpen=!_sugOpen;
  const l=$("sugList"); if(l) l.style.display=_sugOpen?"":"none";
  const c=$("sugChev"); if(c) c.style.transform=_sugOpen?"rotate(180deg)":"";
}
function chatSugPick(i){ if(_sugOpen) chatSugToggle(); chatChipTap(i); }
function renderChatSug(){
  const el=$("chatSug"); if(!el) return;
  const lg=["vi","en","zh","ko"].includes(curLang)?curLang:"vi";
  _sugOpen=false;
  el.innerHTML='<div class="chatsug"><button type="button" class="sugbar" id="sugBar"><span>'+esc(SUG_TITLE[lg])+'</span><svg id="sugChev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>'
    +'<div class="suglist" id="sugList" style="display:none">'+CHAT_GROUPS.map(g=>
    `<div class="sg"><div class="sgt">${esc(g.t[lg]||g.t.vi)}</div>${g.qs.map(it=>`<button class="sugq" onclick="chatSugPick(${chatReg(it.q[lg]||it.q.vi,it.tool,it.args)})">${esc(it.q[lg]||it.q.vi)}</button>`).join("")}</div>`
  ).join("")+"</div></div>";
  const bar=$("sugBar"); if(bar) bar.addEventListener("click",chatSugToggle);
}
window.renderChatSug=renderChatSug;
window.chatChipTap=chatChipTap;
window.chatSugPick=chatSugPick;
window.chatRoute=chatRoute;
window.chatRun=chatRun;
window.__chatTest={route:chatRoute,run:chatRun,render:renderChatSug};
})();
