/* js/stocks/flow.js — P5 module flow: khoi Khoi ngoai + Tu doanh (v-foreign/v-prop) tach tu stocks.html, giu nguyen hanh vi. Classic script, nap lazy khi mo tab. */
// __FLOW_BEGIN__
// Tab Khối ngoại + Tự doanh (Chốt 07:12 25/10): biểu đồ mua/bán/ròng
// các phiên gần đây + Top 10 mua/bán ròng phiên gần nhất, đơn vị tỷ
// đồng. Chỉ đọc API đã có (/foreign-flow, /proprietary-flow và
// /history theo mã), không mở collector mới. Biểu đồ cộng dồn lịch
// sử của các mã trong snapshot phiên gần nhất; phiên cuối tuần
// (không giao dịch) và phiên thiếu giá trị ước lượng được bỏ qua.
try{
(function(){
  const FLOW_I18N={
    vi:{titleF:"Khối ngoại",titleP:"Tự doanh",session:"Phiên",chartT:"Giá trị mua/bán/ròng các phiên gần đây",buyT:"Top 10 mua ròng",sellT:"Top 10 bán ròng",colSym:"Mã",colBuy:"Mua",colSell:"Bán",colNet:"Mua ròng",unitB:"tỷ đồng",noData:"Chưa có số liệu",loadErr:"Không tải được dữ liệu",noteF:"Nguồn: dữ liệu VCI Trading, cập nhật sau 17:15 mỗi phiên.",noteF2:"Biểu đồ cộng dồn {N} mã có dữ liệu; giá trị lịch sử là ước lượng (khối lượng × giá đóng cửa) và chỉ hiện phiên có đủ giá trị; phiên cuối tuần không phải phiên giao dịch nên không hiện.",noteP:"Nguồn: dữ liệu tự doanh 3 sàn (FINFO → Vietstock → PDF HOSE đối chiếu), chu trình 16:35 mỗi phiên.",noteP2:"Biểu đồ cộng dồn {N} mã có giao dịch tự doanh trong phiên gần nhất.",buyLbl:"Mua",sellLbl:"Bán",netLbl:"Mua ròng"},
    en:{titleF:"Foreign",titleP:"Proprietary",session:"Session",chartT:"Buy/sell/net value over recent sessions",buyT:"Top 10 net buys",sellT:"Top 10 net sells",colSym:"Symbol",colBuy:"Buy",colSell:"Sell",colNet:"Net buy",unitB:"B VND",noData:"No data yet",loadErr:"Load failed",noteF:"Source: VCI Trading data, updated after 17:15 each session.",noteF2:"Chart sums {N} symbols with data; historical values are estimates (volume × close price) and only sessions with complete values are shown; weekends are not trading sessions.",noteP:"Source: proprietary trading data, 3 markets (FINFO → Vietstock → HOSE PDF cross-checked), 16:35 cycle each session.",noteP2:"Chart sums {N} symbols with proprietary trades in the latest session.",buyLbl:"Buy",sellLbl:"Sell",netLbl:"Net buy"},
    zh:{titleF:"外资",titleP:"自营",session:"交易日",chartT:"近几个交易日买入/卖出/净买入金额",buyT:"净买入前10",sellT:"净卖出前10",colSym:"代码",colBuy:"买入",colSell:"卖出",colNet:"净买入",unitB:"十亿越盾",noData:"暂无数据",loadErr:"加载失败",noteF:"来源：VCI Trading数据，每个交易日17:15后更新。",noteF2:"图表汇总{N}只有数据的代码；历史金额为估算值（成交量×收盘价），仅显示数值完整的交易日；周末不是交易日。",noteP:"来源：三市自营交易数据（FINFO→Vietstock→HOSE PDF核对），每个交易日16:35更新。",noteP2:"图表汇总最新交易日有自营交易的{N}只代码。",buyLbl:"买入",sellLbl:"卖出",netLbl:"净买入"},
    ko:{titleF:"외국인",titleP:"자기매매",session:"거래일",chartT:"최근 거래일 매수/매도/순매수 금액",buyT:"순매수 상위 10",sellT:"순매도 상위 10",colSym:"종목",colBuy:"매수",colSell:"매도",colNet:"순매수",unitB:"십억 동",noData:"데이터 없음",loadErr:"불러오기 실패",noteF:"출처: VCI Trading 데이터, 매 거래일 17:15 이후 업데이트.",noteF2:"차트는 데이터가 있는 {N} 종목 합계이며, 과거 금액은 추정치(거래량×종가)이고 값이 완전한 거래일만 표시합니다. 주말은 거래일이 아닙니다.",noteP:"출처: 3개 시장 자기매매 데이터(FINFO→Vietstock→HOSE PDF 대조), 매 거래일 16:35 주기.",noteP2:"차트는 최근 거래일에 자기매매가 있었던 {N} 종목 합계입니다.",buyLbl:"매수",sellLbl:"매도",netLbl:"순매수"}
  };
  function flT(k){ try{ const o=FLOW_I18N[curLang]||FLOW_I18N.vi; return o[k]||FLOW_I18N.vi[k]||k; }catch(e){ return FLOW_I18N.vi[k]||k; } }
  function flB(v){ if(v==null||!isFinite(+v)) return "—"; return (+v/1e9).toLocaleString("vi-VN",{maximumFractionDigits:1}); }
  function flD(iso){ if(!/^\d{4}-\d{2}-\d{2}$/.test(iso||"")) return iso||"—"; const p=iso.split("-"); return p[2]+"/"+p[1]+"/"+p[0]; }
  function flWeekend(iso){ try{ const d=new Date(iso+"T00:00:00Z").getUTCDay(); return d===0||d===6; }catch(e){ return false; } }
  const FLOW_CFG={
    foreign:{pfx:"ff",snap:"/foreign-flow",hist:"/foreign-flow/history",buyK:"buy_value",sellK:"sell_value",hBuyK:"buy_value_est",hSellK:"sell_value_est",title:"titleF",note1:"noteF",note2:"noteF2",src:"VCI Trading"},
    prop:{pfx:"pf",snap:"/proprietary-flow",hist:"/proprietary-flow/history",buyK:"buy_value_vnd",sellK:"sell_value_vnd",hBuyK:"buy_value_vnd",hSellK:"sell_value_vnd",title:"titleP",note1:"noteP",note2:"noteP2",src:"FINFO · Vietstock · PDF HOSE"}
  };
  function flChartSVG(series){
    const W=720,H=270,PL=58,PR=12,PT=16,PB=30;
    const iw=W-PL-PR, ih=H-PT-PB;
    if(!series.length) return '<div class="hint">'+flT("noData")+'</div>';
    let mx=0,mn=0;
    series.forEach(s=>{ mx=Math.max(mx,s.buy,s.sell,s.buy-s.sell); mn=Math.min(mn,0,s.buy-s.sell); });
    if(mx<=0) mx=1;
    const X=i=>PL+iw*(series.length===1?0.5:i/(series.length-1));
    const Y=v=>PT+ih*(mx-v)/(mx-mn);
    const bw=Math.min(26,iw/Math.max(1,series.length)/2.2);
    let s='<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto;display:block" role="img">';
    [0,0.5,1].forEach(f=>{ const v=mn+(mx-mn)*f, y=Y(v);
      s+='<line x1="'+PL+'" y1="'+y.toFixed(1)+'" x2="'+(W-PR)+'" y2="'+y.toFixed(1)+'" stroke="#e5e7eb"/><text x="'+(PL-6)+'" y="'+(y+4).toFixed(1)+'" font-size="11" text-anchor="end" fill="#6b7280">'+flB(v)+'</text>'; });
    const y0=Y(0);
    s+='<line x1="'+PL+'" y1="'+y0.toFixed(1)+'" x2="'+(W-PR)+'" y2="'+y0.toFixed(1)+'" stroke="#9ca3af"/>';
    series.forEach((pt,i)=>{
      const x=X(i);
      s+='<rect x="'+(x-bw-1).toFixed(1)+'" y="'+Y(pt.buy).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(0,(y0-Y(pt.buy))).toFixed(1)+'" fill="#22c55e"/>';
      s+='<rect x="'+(x+1).toFixed(1)+'" y="'+Y(pt.sell).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(0,(y0-Y(pt.sell))).toFixed(1)+'" fill="#ef4444"/>';
      s+='<text x="'+x.toFixed(1)+'" y="'+(H-8)+'" font-size="11" text-anchor="middle" fill="#6b7280">'+flD(pt.d).slice(0,5)+'</text>';
    });
    let pts="";
    series.forEach((pt,i)=>{ pts+=(pts?" ":"")+X(i).toFixed(1)+","+Y(pt.buy-pt.sell).toFixed(1); });
    s+='<polyline points="'+pts+'" fill="none" stroke="#3b82f6" stroke-width="2"/>';
    series.forEach((pt,i)=>{ s+='<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(pt.buy-pt.sell).toFixed(1)+'" r="3" fill="#3b82f6"/>'; });
    s+='</svg>';
    s+='<div class="hint" style="margin-top:6px"><span style="color:#22c55e">■</span> '+flT("buyLbl")+' &nbsp; <span style="color:#ef4444">■</span> '+flT("sellLbl")+' &nbsp; <span style="color:#3b82f6">—</span> '+flT("netLbl")+' ('+flT("unitB")+')</div>';
    return s;
  }
  async function flPool(items, n, fn){
    let idx=0;
    async function wk(){ while(idx<items.length){ const it=items[idx++]; try{ await fn(it); }catch(e){} } }
    const ws=[]; for(let k=0;k<Math.min(n,items.length);k++) ws.push(wk());
    await Promise.all(ws);
  }
  async function loadFlow(kind){
    const C=FLOW_CFG[kind]; if(!C) return;
    const P=C.pfx, g=id=>$(P+id);
    try{
      const t=g("Title"); if(t) t.textContent=flT(C.title);
      const sr=g("Src"); if(sr) sr.textContent=C.src;
      const ct=g("ChartT"); if(ct) ct.textContent=flT("chartT")+" ("+flT("unitB")+")";
      const bt=g("BuyT"); if(bt) bt.textContent=flT("buyT");
      const st=g("SellT"); if(st) st.textContent=flT("sellT");
      const snap=await api(C.snap);
      const by=snap.by_symbol||{};
      const rows=Object.keys(by).map(sym=>{
        const d=by[sym]||{};
        const b=+d[C.buyK]||0, s=+d[C.sellK]||0;
        return {sym,buy:b,sell:s,net:b-s,td:d.trade_date||""};
      }).filter(r=>r.buy||r.sell);
      if(!rows.length) throw new Error("empty");
      const buyTop=[...rows].sort((a,b)=>b.net-a.net).slice(0,10);
      const sellTop=[...rows].sort((a,b)=>a.net-b.net).slice(0,10);
      const th='<tr><th>'+flT("colSym")+'</th><th style="text-align:right">'+flT("colBuy")+'</th><th style="text-align:right">'+flT("colSell")+'</th><th style="text-align:right">'+flT("colNet")+'</th></tr>';
      const mk=list=>list.map(r=>'<tr><td><b>'+esc(r.sym)+'</b></td><td style="text-align:right">'+flB(r.buy)+'</td><td style="text-align:right">'+flB(r.sell)+'</td><td style="text-align:right;color:'+(r.net>=0?"#16a34a":"#dc2626")+'">'+flB(r.net)+'</td></tr>').join("");
      const bh=g("BuyHead"), bb=g("BuyBody"), sh=g("SellHead"), sb=g("SellBody");
      if(bh) bh.innerHTML=th; if(bb) bb.innerHTML=mk(buyTop)||'<tr><td colspan="4"><div class="hint">'+flT("noData")+'</div></td></tr>';
      if(sh) sh.innerHTML=th; if(sb) sb.innerHTML=mk(sellTop)||'<tr><td colspan="4"><div class="hint">'+flT("noData")+'</div></td></tr>';
      let tb=0, ts=0; rows.forEach(r=>{ tb+=r.buy; ts+=r.sell; });
      const agg={};
      await flPool(rows.map(r=>r.sym), 8, async sym=>{
        try{
          const h=await api(C.hist+"?symbol="+encodeURIComponent(sym)+"&limit=30");
          (h.rows||[]).forEach(r=>{
            const dt=r.trade_date||"";
            if(!/^\d{4}-\d{2}-\d{2}$/.test(dt)) return;
            if(flWeekend(dt)) return;
            const b=+r[C.hBuyK], s=+r[C.hSellK];
            if(!isFinite(b)||!isFinite(s)) return;
            if(!agg[dt]) agg[dt]={buy:0,sell:0};
            agg[dt].buy+=b; agg[dt].sell+=s;
          });
        }catch(e){}
      });
      const dates=Object.keys(agg).sort().slice(-20);
      const series=dates.map(d=>({d:d,buy:agg[d].buy,sell:agg[d].sell}));
      const ch=g("Chart"); if(ch) ch.innerHTML=flChartSVG(series);
      let sess="";
      if(kind==="prop"){ const tds=rows.map(r=>r.td).filter(Boolean).sort(); if(tds.length) sess=tds[tds.length-1]; }
      if(!sess && dates.length) sess=dates[dates.length-1];
      if(!sess && snap.updated) sess=String(snap.updated).slice(0,10);
      const hd=g("Head");
      if(hd) hd.innerHTML='<div class="idxcard"><div class="s">'+flT("session")+' '+flD(sess)+'</div><div class="p">'+flB(tb-ts)+'</div><div class="c">'+flT("buyLbl")+': '+flB(tb)+' · '+flT("sellLbl")+': '+flB(ts)+'</div></div>';
      const nt=g("Notes");
      if(nt) nt.innerHTML='<div class="note">'+flT(C.note1)+'</div><div class="note">'+flT(C.note2).replace("{N}", String(rows.length))+'</div>';
    }catch(e){
      const ch=g("Chart"); if(ch) ch.innerHTML='<div class="hint">'+flT("loadErr")+'</div>';
      const bb=g("BuyBody"); if(bb) bb.innerHTML='<tr><td colspan="4"><div class="hint">'+flT("loadErr")+'</div></td></tr>';
      const sb=g("SellBody"); if(sb) sb.innerHTML='<tr><td colspan="4"><div class="hint">'+flT("loadErr")+'</div></td></tr>';
    }
  }
  function loadForeign(){ return loadFlow("foreign"); }
  function loadProp(){ return loadFlow("prop"); }
  if(typeof window!=="undefined"){ window.loadForeign=loadForeign; window.loadProp=loadProp;
    window.__flowTest={i18n:FLOW_I18N,t:flT,fmtB:flB,fmtD:flD,weekend:flWeekend,chart:flChartSVG,load:loadFlow,cfg:FLOW_CFG}; }
})();
}catch(e){}
// __FLOW_END__
