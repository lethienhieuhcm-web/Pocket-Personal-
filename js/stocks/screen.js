/* js/stocks/screen.js — P5 module 3: sang loc (v-screen) tach tu stocks.html, giu nguyen hanh vi. Classic script, nap lazy khi mo tab. */
// __SCR_BEGIN__
try{
(function(){
const patName={trend_crossover:"Trend Crossover",bollinger_squeeze:"Bollinger Squeeze",episodic_pivot:"Episodic Pivot",momentum_pullback:"Momentum Pullback"};
const patIcon={trend_crossover:"<svg class='tic' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><path d='M3 3v18h18'/><path d='M7 14l4-4 3 3 5-6'/></svg>",bollinger_squeeze:"<svg class='tic' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><path d='M3 3v18h18'/><path d='M7 15l4-6 4 3 5-8'/></svg>",episodic_pivot:"<svg class='tic' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><path d='M13 2L3 14h9l-1 8 10-12h-9l1-8z'/></svg>",momentum_pullback:"<svg class='tic' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><path d='M23 4v6h-6M1 20v-6h6'/><path d='M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15'/></svg>"};
const SCR_TPL={
  vi:{all:"Tất cả sàn",trendAll:"Mọi xu hướng",trendYes:"Đạt trend",trendNo:"Chưa đạt trend",
    low:"Tập lọc chỉ có {n} mã — mẫu quá nhỏ, nhận định có độ tin cậy thấp.",
    s1:"Tập đang lọc gồm {n} mã; sàn đông nhất: {ex} ({pe}%).",
    s1b:" Ngành đông nhất: {ind} ({pi}%).",
    s2:"Động lượng phiên gần nhất: {up}% mã tăng, {down}% mã giảm; {tr}% đạt mẫu hình xu hướng (trend template).",
    s3:"Định giá: P/E trung vị {pe} lần, P/B trung vị {pb} lần.",
    s4:"Chất lượng: ROE trung vị {roe}%; {pio}% mã đạt Piotroski ≥ 7; {alt}% mã có Altman Z trong vùng an toàn theo thang VN (>1,5).",
    s5:"Thanh khoản: tổng giá trị giao dịch {tv}; mã chiếm tỉ trọng lớn nhất: {sym} ({s}%).",
    s6:"Rủi ro: {de}% mã đòn bẩy cao (D/E > 2 hoặc âm); {ad}% mã có Altman Z vùng nguy hiểm theo thang VN (<0,45)."},
  en:{all:"All exchanges",trendAll:"Any trend",trendYes:"Trend met",trendNo:"Trend not met",
    low:"The filtered set has only {n} symbols — too small a sample; this insight has low reliability.",
    s1:"The filtered set has {n} symbols; largest exchange: {ex} ({pe}%).",
    s1b:" Largest industry: {ind} ({pi}%).",
    s2:"Latest-session momentum: {up}% advancers, {down}% decliners; {tr}% meet the trend template.",
    s3:"Valuation: median P/E {pe}x, median P/B {pb}x.",
    s4:"Quality: median ROE {roe}%; {pio}% score Piotroski ≥ 7; {alt}% have Altman Z in the safe zone on the VN-calibrated scale (>1.5).",
    s5:"Liquidity: total traded value {tv}; largest contributor: {sym} ({s}%).",
    s6:"Risk: {de}% are highly leveraged (D/E > 2 or negative); {ad}% have Altman Z in the distress zone on the VN-calibrated scale (<0.45)."},
  zh:{all:"全部交易所",trendAll:"全部趋势",trendYes:"符合趋势",trendNo:"未符合趋势",
    low:"筛选集仅有{n}只股票——样本过小，本解读可靠性低。",
    s1:"当前筛选集共{n}只股票；最多的交易所：{ex}（{pe}%）。",
    s1b:" 最多的行业：{ind}（{pi}%）。",
    s2:"最近一期动量：{up}%上涨，{down}%下跌；{tr}%符合趋势模板。",
    s3:"估值：市盈率中位数{pe}倍，市净率中位数{pb}倍。",
    s4:"质量：ROE中位数{roe}%；{pio}%的股票Piotroski ≥ 7；{alt}%的股票Altman Z按越南校准标准处于安全区（>1.5）。",
    s5:"流动性：总成交额{tv}；占比最大：{sym}（{s}%）。",
    s6:"风险：{de}%的股票杠杆高（D/E > 2或为负）；{ad}%的股票Altman Z按越南校准标准处于危险区（<0.45）。"},
  ko:{all:"전체 거래소",trendAll:"모든 추세",trendYes:"추세 충족",trendNo:"추세 미충족",
    low:"필터 집합에 {n}개 종목뿐입니다 — 표본이 너무 작아 이 분석의 신뢰도가 낮습니다.",
    s1:"현재 필터 집합은 {n}개 종목; 가장 큰 거래소: {ex}({pe}%).",
    s1b:" 가장 큰 업종: {ind}({pi}%).",
    s2:"최근 세션 모멘텀: {up}% 상승, {down}% 하락; {tr}%가 추세 템플릿을 충족합니다.",
    s3:"밸류에이션: P/E 중앙값 {pe}배, P/B 중앙값 {pb}배.",
    s4:"퀄리티: ROE 중앙값 {roe}%; {pio}%가 Piotroski ≥ 7; {alt}%가 베트남 보정 기준 Altman Z 안전 구간(>1.5)입니다.",
    s5:"유동성: 총 거래대금 {tv}; 비중이 가장 큰 종목: {sym}({s}%).",
    s6:"리스크: {de}%가 고레버리지(D/E > 2 또는 음수); {ad}%가 베트남 보정 기준 Altman Z 위험 구간(<0.45)입니다."}};
const _med=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);const m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
// Thang Altman HIEU CHUAN cho du lieu VN (22/10/2026, do tren phan bo Z cua
// fundamentals_cache + neo proxy ket cuc von am/lo TTM): an toan > 1.5,
// nguy hiem < 0.45. KHONG phai nguong Altman goc (2.99/1.81) — Z luu trong kho
// la ban 4 nhan to (thieu so hang loi nhuan giu lai) nen nguong goc lam 89%
// toan thi truong roi vao vung nguy hiem, khong con gia tri phan biet.
const AZ_SAFE=1.5, AZ_DIST=0.45;
const _pc=(v,d=0)=>v==null?"—":Number(v).toFixed(d).replace(".",",");
function scrInsightText(rows){
  const T=SCR_TPL[curLang]||SCR_TPL.vi;
  const n=rows.length;
  const out={};
  for(const lang of ["vi","en","zh","ko"]){
    const t=SCR_TPL[lang];
    if(!n){ out[lang]=""; continue; }
    const s=[];
    const exc={}; rows.forEach(r=>{const e=(r.exchange||"—").toUpperCase();exc[e]=(exc[e]||0)+1;});
    const topEx=Object.entries(exc).sort((a,b)=>b[1]-a[1])[0];
    let s1=t.s1.replace("{n}",n).replace("{ex}",topEx[0]).replace("{pe}",_pc(topEx[1]/n*100,0));
    const ind={}; rows.forEach(r=>{if(r.industry)ind[r.industry]=(ind[r.industry]||0)+1;});
    const topInd=Object.entries(ind).sort((a,b)=>b[1]-a[1])[0];
    if(topInd) s1+=t.s1b.replace("{ind}",topInd[0]).replace("{pi}",_pc(topInd[1]/n*100,0));
    s.push(s1);
    if(n<5){ s.push(t.low.replace("{n}",n)); out[lang]=s.join(" "); continue; }
    const up=rows.filter(r=>(r.pct_change||0)>0).length/n*100, dn=rows.filter(r=>(r.pct_change||0)<0).length/n*100;
    const tr=rows.filter(r=>r.trend_template).length/n*100;
    s.push(t.s2.replace("{up}",_pc(up,0)).replace("{down}",_pc(dn,0)).replace("{tr}",_pc(tr,0)));
    const pes=rows.map(r=>(r.eps>0&&r.close)?r.close*1000/r.eps:null).filter(v=>v!=null&&isFinite(v));
    const pbs=rows.map(r=>(r.bvps>0&&r.close)?r.close*1000/r.bvps:null).filter(v=>v!=null&&isFinite(v));
    if(pes.length||pbs.length) s.push(t.s3.replace("{pe}",_pc(_med(pes),1)).replace("{pb}",_pc(_med(pbs),1)));
    const roes=rows.map(r=>r.roe_ttm).filter(v=>v!=null&&isFinite(v)&&Math.abs(v)<500);
    const pio=rows.filter(r=>r.piotroski!=null);
    const alt=rows.filter(r=>r.altman_z!=null&&r.altman_z!==0);
    let s4=t.s4.replace("{roe}",_pc(_med(roes),1));
    s4=s4.replace("{pio}",pio.length?_pc(pio.filter(r=>r.piotroski>=7).length/pio.length*100,0):"—");
    s4=s4.replace("{alt}",alt.length?_pc(alt.filter(r=>r.altman_z>AZ_SAFE).length/alt.length*100,0):"—");
    if(roes.length||pio.length||alt.length) s.push(s4);
    const tv=rows.reduce((a,r)=>a+(r.value_vnd||0),0);
    if(tv>0){
      const top=rows.reduce((a,r)=>(r.value_vnd||0)>(a.value_vnd||0)?r:a,rows[0]);
      const tvs=tv>=1e12?(tv/1e12).toFixed(2).replace(".",",")+" "+(lang==="vi"?"nghìn tỷ đồng":lang==="en"?"trillion VND":lang==="zh"?"万亿越南盾":"조 동")
        :(tv/1e9).toFixed(1).replace(".",",")+" "+(lang==="vi"?"tỷ đồng":lang==="en"?"billion VND":lang==="zh"?"十亿越南盾":"십억 동");
      s.push(t.s5.replace("{tv}",tvs).replace("{sym}",top.symbol).replace("{s}",_pc((top.value_vnd||0)/tv*100,1)));
    }
    const de=rows.filter(r=>r.debt_to_equity!=null);
    const ad=alt.length?alt.filter(r=>r.altman_z<AZ_DIST).length/alt.length*100:null;
    if(de.length||ad!=null) s.push(t.s6.replace("{de}",de.length?_pc(de.filter(r=>r.debt_to_equity>2||r.debt_to_equity<0).length/de.length*100,0):"—").replace("{ad}",ad==null?"—":_pc(ad,0)));
    out[lang]=s.join(" ");
  }
  return out;
}
let SCR_ROWS=[], SCR_EX="", SCR_TREND="", SCR_UPDATED=null;
function renderScrFilt(){
  const T=SCR_TPL[curLang]||SCR_TPL.vi;
  const chip=(v,lbl,on)=>`<span class="fchip${on?" on":""}" onclick="scrSetFilt('${v}')">${lbl}</span>`;
  $("scrFilt").innerHTML=
    chip("",T.all,!SCR_EX)+chip("HOSE","HOSE",SCR_EX==="HOSE")+chip("HNX","HNX",SCR_EX==="HNX")+chip("UPCOM","UPCOM",SCR_EX==="UPCOM")+
    chip("T1",T.trendYes,SCR_TREND==="1")+chip("T0",T.trendNo,SCR_TREND==="0");
}
function scrSetFilt(v){
  if(v==="T1"||v==="T0"){ SCR_TREND=SCR_TREND===v.slice(1)?"":v.slice(1); }
  else SCR_EX=SCR_EX===v?"":v;
  renderScrFilt(); renderScreen();
}
function scrFiltered(){
  let rows=SCR_ROWS;
  if(SCR_EX) rows=rows.filter(r=>(r.exchange||"").toUpperCase()===SCR_EX);
  if(SCR_TREND==="1") rows=rows.filter(r=>!!r.trend_template);
  if(SCR_TREND==="0") rows=rows.filter(r=>!r.trend_template);
  return rows;
}
function renderScreen(){
  const rows=scrFiltered();
  $("screenerBody").innerHTML=rows.slice(0,30).map(r=>{
    const tr=(r.trend_template===null||r.trend_template===undefined)?"—":(r.trend_template?'<span class="up">✓ Đạt</span>':'<span class="down">✗ Chưa</span>');
    return `<tr><td><b onclick="openSym('${esc(r.symbol)}')" style="cursor:pointer">${esc(r.symbol)}</b></td><td>${tr}</td><td>${r.pe_ttm!=null?Number(r.pe_ttm).toFixed(1):"—"}</td><td>${r.pb!=null?Number(r.pb).toFixed(1):"—"}</td><td>${r.roe_ttm!=null?'<span class="up">'+Number(r.roe_ttm).toFixed(1)+"%</span>":"—"}</td></tr>`;}).join("")||'<tr><td colspan="5"><div class="hint">Chưa có dữ liệu</div></td></tr>';
  const ib=$("scrInsight");
  if(ib) ib.innerHTML=insBox(scrInsightText(rows), INS_SRC.scr[curLang]||INS_SRC.scr.vi, SCR_UPDATED);
}
async function loadScreener(){
  try{
    const j=await api("/screener?all=1");
    SCR_ROWS=j.rows||[]; SCR_UPDATED=j.updated||null;
    renderScrFilt(); renderScreen();
  }catch(e){}
  try{
    const j=await api("/signals");const sigs=j.signals||[];
    $("signalsList").innerHTML=sigs.length?sigs.map(s=>`<div class="sig"><div class="ic">${patIcon[s.pattern]||""}</div><div><div class="tt">${esc(s.symbol)} — ${esc(patName[s.pattern]||s.pattern)}</div><div class="dd">${esc(s.desc||"")}</div></div></div>`).join(""):'<div class="hint">Hôm nay chưa có tín hiệu mới</div>';
  }catch(e){}
}
  if(typeof window!=="undefined"){ window.loadScreener=loadScreener; window.scrSetFilt=scrSetFilt;
    window.__scrTest={i18n:SCR_TPL,load:loadScreener,render:renderScreen}; }
})();
}catch(e){}
// __SCR_END__
