/* js/stocks/ctg.js — P5 module: màn CTG + 28 mã ngân hàng (v-ctg).
   Đọc bản công bố tĩnh js/stocks/ctg-banks.json (số chép nguyên văn từ
   REPORT-GD2-28.md §4 — không tính lại, không bịa). Tab KHÔNG nằm trong GATED
   (tính năng free). Classic script, nap lazy khi mo tab (giong sectors.js). */
// __CTG_BEGIN__
try{
(function(){
const CTG_DATA_URL="/english/js/stocks/ctg-banks.json";
const CTG_I18N={
  vi:{title:"CTG & 28 mã ngân hàng",head:"Bản công bố {as_of} · {pub} mã đủ dữ liệu · {blk} mã chưa đủ lịch sử",
    ctgT:"CTG — chi tiết",bvps:"BVPS 2025",bvpsNote:"BCTC kiểm toán PwC · đã chốt đúng",price:"Giá đối chiếu",
    pba:"P/B A (chuỗi năm)",pbb:"P/B B (chuỗi quý)",pbaBad:"PROVEN UNRECONCILABLE",pbbOk:"ĐẠT",
    unrec:"Mốc bản mẫu 1,22 ± 0,01 đòi {min}–{max} cp, trong khi Thuyết minh kiểm toán 20.3(a) ghi {aud} cp; 19 cơ số đã chấm, 0 cơ số vào được. Vì vậy 1,22 KHÔNG phải mức đạt được — 1,3272 là số đúng trên cơ số kiểm toán.",
    pct:"Percentile A / B",pctNote:"Hạng P/B hôm nay trong lịch sử của chính mã",
    pubT:"{pub} mã công bố được",pubHead:["Mã","P/B A","P/B B","% rẻ A","% rẻ B","p80 A (lần / đ)","p80 B (lần / đ)","Phiên A / B","Cơ sở"],
    blkT:"{blk} mã chưa đủ lịch sử",blkHead:["Mã","Lý do","Phiên giá","Phiên đầu","Năm lên sàn","Input","P/B"],
    inputOk:"shares ✓ · equity ✓",blockedNote:"Cổng 2.000 phiên giữ nguyên, không hạ để cứu số. Các mã này có đủ số cổ phần và vốn chủ (0 lỗi input) nhưng lịch sử giá ngắn — không hiển thị P/B, không bịa số.",
    decT:"Quyết định D1–D7",notesT:"Đọc kèm",
    basisA:"{a} (kiểm toán) → {b}",basisR:"{a} → {b}",
    tagKT:"KT",tagB:"số chưa kiểm chứng",tagCanary:"canary",
    empty:"Chưa có bản công bố",loadErr:"Không tải được bản công bố — kiểm tra mạng rồi mở lại tab.",
    legend:"A = giá / BVPS năm gần nhất đã biết (lag 75 ngày) · B = giá / BVPS quý gần nhất đã biết (lag 45 ngày) · KT = dùng số cổ phần Thuyết minh kiểm toán 31/12/2025 cho chuỗi A."},
  en:{title:"CTG & 28 bank codes",head:"Release {as_of} · {pub} codes with full data · {blk} codes with short history",
    ctgT:"CTG — detail",bvps:"BVPS 2025",bvpsNote:"PwC audited statements · confirmed",price:"Reference price",
    pba:"P/B A (yearly series)",pbb:"P/B B (quarterly series)",pbaBad:"PROVEN UNRECONCILABLE",pbbOk:"MET",
    unrec:"The template band 1.22 ± 0.01 requires {min}–{max} shares, while audited note 20.3(a) states {aud} shares; 19 bases tested, 0 fit. So 1.22 is NOT an achievable level — 1.3272 is the correct figure on the audited base.",
    pct:"Percentile A / B",pctNote:"Rank of today's P/B within the code's own history",
    pubT:"{pub} publishable codes",pubHead:["Code","P/B A","P/B B","Cheaper A","Cheaper B","p80 A (x / VND)","p80 B (x / VND)","Sessions A / B","Basis"],
    blkT:"{blk} codes with short history",blkHead:["Code","Reason","Sessions","First session","Listed","Inputs","P/B"],
    inputOk:"shares ✓ · equity ✓",blockedNote:"The 2,000-session gate is kept, not lowered to rescue a number. These codes have valid shares and equity (0 input errors) but short price history — no P/B shown, no invented figures.",
    decT:"Decisions D1–D7",notesT:"Read together",
    basisA:"{a} (audited) → {b}",basisR:"{a} → {b}",
    tagKT:"KT",tagB:"unverified figure",tagCanary:"canary",
    empty:"No release yet",loadErr:"Could not load the release — check the network and reopen the tab.",
    legend:"A = price / latest known yearly BVPS (75-day lag) · B = price / latest known quarterly BVPS (45-day lag) · KT = audited share count from the 31/12/2025 notes used for series A."},
  zh:{title:"CTG 与 28 个银行代码",head:"发布 {as_of} · {pub} 个代码数据齐全 · {blk} 个代码历史不足",
    ctgT:"CTG — 详情",bvps:"2025 年每股净资产",bvpsNote:"普华永道审计报表 · 已确认",price:"对照价格",
    pba:"P/B A（年度序列）",pbb:"P/B B（季度序列)",pbaBad:"PROVEN UNRECONCILABLE",pbbOk:"达标",
    unrec:"样本区间 1.22 ± 0.01 需要 {min}–{max} 股，而经审计附注 20.3(a) 为 {aud} 股；已测 19 种口径，0 种符合。因此 1.22 并非可达水平 — 1.3272 是按审计口径的正确数值。",
    pct:"百分位 A / B",pctNote:"今日 P/B 在该代码自身历史中的排名",
    pubT:"{pub} 个可发布代码",pubHead:["代码","P/B A","P/B B","便宜比例 A","便宜比例 B","p80 A（倍 / 盾）","p80 B（倍 / 盾）","交易日 A / B","基础"],
    blkT:"{blk} 个历史不足代码",blkHead:["代码","原因","交易日","首个交易日","上市","输入","P/B"],
    inputOk:"股数 ✓ · 权益 ✓",blockedNote:"2000 交易日门槛保持不变，不下调以迁就数字。这些代码股数与权益均有效（0 输入错误），但价格历史过短 — 不显示 P/B，不编造数字。",
    decT:"决定 D1–D7",notesT:"附带说明",
    basisA:"{a}（审计）→ {b}",basisR:"{a} → {b}",
    tagKT:"KT",tagB:"未核验数值",tagCanary:"canary",
    empty:"暂无发布",loadErr:"无法加载发布 — 请检查网络后重新打开。",
    legend:"A = 价格 / 最近的已知年度每股净资产（滞后 75 天）· B = 价格 / 最近的已知季度每股净资产（滞后 45 天）· KT = A 序列采用 2025/12/31 经审计附注股数。"},
  ko:{title:"CTG 및 28개 은행 종목",head:"발표 {as_of} · {pub}개 종목 데이터 충분 · {blk}개 종목 이력 부족",
    ctgT:"CTG — 상세",bvps:"2025년 BPS",bvpsNote:"PwC 감리 재무제표 · 확인됨",price:"대조 가격",
    pba:"P/B A(연간)",pbb:"P/B B(분기)",pbaBad:"PROVEN UNRECONCILABLE",pbbOk:"달성",
    unrec:"템플릿 구간 1.22 ± 0.01은 {min}–{max} 주식을 요구하지만 감사 주석 20.3(a)는 {aud} 주식입니다. 19개 기준을 검토해 0개가 부합합니다. 따라서 1.22는 도달 가능한 값이 아니며, 1.3272이 감사 기준에 따른 올바른 수치입니다.",
    pct:"백분위 A / B",pctNote:"오늘 P/B의 해당 종목 자체 이력 내 순위",
    pubT:"발표 가능한 {pub}개 종목",pubHead:["종목","P/B A","P/B B","저렴 A","저렴 B","p80 A(배 / 동)","p80 B(배 / 동)","세션 A / B","기준"],
    blkT:"이력 부족 {blk}개 종목",blkHead:["종목","사유","세션","첫 세션","상장","입력","P/B"],
    inputOk:"주식수 ✓ · 자본 ✓",blockedNote:"2,000 세션 기준은 유지하며 수치를 맞추기 위해 낮추지 않습니다. 이 종목들은 주식수와 자본이 모두 유효하지만(입력 오류 0) 가격 이력이 짧습니다 — P/B를 표시하지 않으며 수치를 만들지 않습니다.",
    decT:"결정 D1–D7",notesT:"함께 읽을 내용",
    basisA:"{a}(감사) → {b}",basisR:"{a} → {b}",
    tagKT:"KT",tagB:"미검증 수치",tagCanary:"canary",
    empty:"아직 발표 없음",loadErr:"발표를 불러오지 못했습니다 — 네트워크 확인 후 다시 여세요.",
    legend:"A = 가격 / 최근 확인된 연간 BPS(75일 지연) · B = 가격 / 최근 확인된 분기 BPS(45일 지연) · KT = A 계열은 2025-12-31 감사 주석 주식수를 사용."},
};
const _ctgL=()=>{ try{ return CTG_I18N[curLang]||CTG_I18N.vi; }catch(e){ return CTG_I18N.vi; } };
const _ctgT=(tpl,map)=>String(tpl||"").replace(/\{(\w+)\}/g,(m,k)=>{ const v=map&&map[k]; return v==null?m:String(v); });
// So trinh bay theo kieu VN (dau . hang nghin, dau , thap phan) — giong cach sectors.js lam.
function ctgFmt(v,dp){
  if(v==null||!isFinite(Number(v))) return "—";
  const n=Number(v), d=dp==null?4:dp;
  return n.toLocaleString("vi-VN",{minimumFractionDigits:d,maximumFractionDigits:d});
}
function ctgFmtInt(v){
  if(v==null||!isFinite(Number(v))) return "—";
  return Number(v).toLocaleString("vi-VN");
}
let _ctgData=null;
async function loadCtg(){
  try{
    const r=await fetch(CTG_DATA_URL,{cache:"no-store"});
    if(!r||!r.ok) throw new Error(String(r&&r.status));
    _ctgData=await r.json();
    renderCtg(_ctgData);
  }catch(e){
    _ctgData=null;
    _ctgHint($("ctgPubBody"),_ctgL().loadErr,8);
    _ctgHint($("ctgBlockBody"),_ctgL().loadErr,7);
    const h=$("ctgHead"); if(h) h.textContent="";
  }
}
function _ctgHint(el,text,colspan){
  if(!el) return;
  el.innerHTML='<tr><td colspan="'+(colspan||1)+'"><div class="hint">'+esc(text)+'</div></td></tr>';
}
function renderCtg(j){
  const L=_ctgL();
  j=j||_ctgData;
  const src=$("ctgSrc"); if(src) src.textContent=L.title;
  if(!j||!j.publishable){
    const h=$("ctgHead"); if(h) h.textContent="";
    _ctgHint($("ctgPubBody"),L.empty,8); _ctgHint($("ctgBlockBody"),L.empty,7);
    return;
  }
  const pub=j.publishable||[], blk=j.blocked||[];
  const head=$("ctgHead");
  if(head) head.textContent=_ctgT(L.head,{as_of:j.as_of||"—",pub:pub.length,blk:blk.length});
  renderCtgDetail(j);
  renderCtgPub(j,pub);
  renderCtgBlocked(j,blk);
  renderCtgDec(j);
  renderCtgNotes(j);
}
function renderCtgDetail(j){
  const L=_ctgL(), c=j.ctg_detail;
  const tt=$("ctgCtgT"); if(tt) tt.textContent=L.ctgT;
  const box=$("ctgCtg"); if(!box) return;
  if(!c){ box.innerHTML=""; return; }
  const t=c.pb_a_template||{};
  const audTxt=(t.audited_shares!=null?ctgFmtInt(t.audited_shares):"—");
  const minTxt=(t.shares_needed_min!=null?ctgFmtInt(t.shares_needed_min):"—");
  const maxTxt=(t.shares_needed_max!=null?ctgFmtInt(t.shares_needed_max):"—");
  box.innerHTML=`<div class="card">
    <div class="row"><span class="k">${esc(L.bvps)}</span><span class="v">${ctgFmt(c.bvps_2025_dong,2)}đ <span style="font-size:11px;color:var(--pp-mut)">${esc(L.bvpsNote)}</span></span></div>
    <div class="row"><span class="k">${esc(L.price)}</span><span class="v">${ctgFmtInt(c.price_as_of_dong)}đ · ${esc(j.as_of||"")}</span></div>
    <div class="row"><span class="k">${esc(L.pba)}</span><span class="v"><b>${ctgFmt(c.pb_a,4)}</b> <span class="trialbadge" data-ctg="unrec">${esc(L.pbaBad)}</span></span></div>
    <div class="row"><span class="k">${esc(L.pbb)}</span><span class="v"><b>${ctgFmt(c.pb_b,4)}</b> ${esc(L.pbbOk)}</span></div>
    <div class="row"><span class="k">${esc(L.pct)}</span><span class="v">${ctgFmt(c.percentile_a_pct,2)}% / ${ctgFmt(c.percentile_b_pct,2)}% <span style="font-size:11px;color:var(--pp-mut)">${esc(L.pctNote)}</span></span></div>
    <div class="note" data-ctg="unrec-note">${esc(_ctgT(L.unrec,{min:minTxt,max:maxTxt,aud:audTxt}))}</div>
    <div style="font-size:11px;color:var(--pp-mut);margin-top:4px">${esc(L.tagCanary)}: P/B A ${ctgFmt(c.canary&&c.canary.pb_a_expected!=null?c.canary.pb_a_expected:c.pb_a,4)} · P/B B ${ctgFmt(c.canary&&c.canary.pb_b_expected!=null?c.canary.pb_b_expected:c.pb_b,4)}</div>
  </div>`;
}
function renderCtgPub(j,rows){
  const L=_ctgL();
  const t=$("ctgPubT"); if(t) t.textContent=_ctgT(L.pubT,{pub:rows.length});
  const hd=$("ctgPubHead");
  if(hd) hd.innerHTML="<tr>"+L.pubHead.map((h,i)=>`<th${i?" style=\"text-align:right\"":""}>${esc(h)}</th>`).join("")+"</tr>";
  const tb=$("ctgPubBody"); if(!tb) return;
  if(!rows.length){ _ctgHint(tb,L.empty,9); return; }
  tb.innerHTML=rows.map(r=>{
    const kind=r.basis_a_kind==="audited"?L.basisA:L.basisR;
    const basis=_ctgT(kind,{a:r.basis_a,b:r.basis_b});
    return `<tr>
      <td><b>${esc(r.code)}</b>${r.shares_override?` <span style="font-size:11px;color:var(--pp-mut)">${esc(L.tagKT)} ${ctgFmtInt(r.shares_override)}</span>`:""}${r.canary?` <span style="font-size:11px;color:var(--pp-mut)">${esc(L.tagCanary)}</span>`:""}</td>
      <td style="text-align:right"><b>${ctgFmt(r.pb_a,4)}</b>${r.canary?' <span class="trialbadge" data-ctg="unrec">'+esc(L.pbaBad)+"</span>":""}</td>
      <td style="text-align:right">${ctgFmt(r.pb_b,4)}${r.pb_b_unaudited?` <span style="font-size:11px;color:var(--pp-mut)">${esc(L.tagB)}</span>`:""}</td>
      <td style="text-align:right">${ctgFmt(r.cheap_a_pct,2)}%</td>
      <td style="text-align:right">${ctgFmt(r.cheap_b_pct,2)}%</td>
      <td style="text-align:right">${ctgFmt(r.p80_a_mult,4)} / ${ctgFmt(r.p80_a_dong,1)}</td>
      <td style="text-align:right">${ctgFmt(r.p80_b_mult,4)} / ${ctgFmt(r.p80_b_dong,1)}</td>
      <td style="text-align:right">${ctgFmtInt(r.sessions_a)} / ${ctgFmtInt(r.sessions_b)}</td>
      <td style="text-align:right;font-size:12px;color:var(--pp-mut)">${esc(basis)}</td></tr>`;
  }).join("");
}
function renderCtgBlocked(j,rows){
  const L=_ctgL();
  const t=$("ctgBlockT"); if(t) t.textContent=_ctgT(L.blkT,{blk:rows.length});
  const hd=$("ctgBlockHead");
  if(hd) hd.innerHTML="<tr>"+L.blkHead.map((h,i)=>`<th${i&&i!==6?" style=\"text-align:right\"":""}>${esc(h)}</th>`).join("")+"</tr>";
  const tb=$("ctgBlockBody"); if(!tb) return;
  if(!rows.length){ _ctgHint(tb,L.empty,7); return; }
  tb.innerHTML=rows.map(r=>`<tr>
    <td><b>${esc(r.code)}</b></td>
    <td style="text-align:right;font-size:12px">${esc(r.reason||"")}</td>
    <td style="text-align:right">${ctgFmtInt(r.sessions)}</td>
    <td style="text-align:right">${esc(r.first_session||"—")}</td>
    <td style="text-align:right">${esc(r.listed||"—")}</td>
    <td style="text-align:right;font-size:12px;color:var(--pp-mut)">${esc(L.inputOk)}</td>
    <td style="text-align:right">—</td></tr>`).join("");
  const n=$("ctgBlockNote"); if(n) n.textContent=L.blockedNote;
}
function renderCtgDec(j){
  const L=_ctgL(), rows=j.decisions||[];
  const t=$("ctgDecT"); if(t) t.textContent=L.decT;
  const box=$("ctgDec"); if(!box) return;
  if(!rows.length){ box.innerHTML=""; return; }
  box.innerHTML=`<div class="card">${rows.map(d=>`<div class="row"><span class="k">${esc(d.id)}</span><span class="v" style="text-align:right"><b>${esc(d.verdict||"")}</b><div style="font-size:12px;color:var(--pp-mut)">${esc(d.line||"")}</div></span></div>`).join("")}</div>`;
}
function renderCtgNotes(j){
  const L=_ctgL(), rows=j.notes||[];
  const box=$("ctgNotes"); if(!box) return;
  const items=rows.concat([L.legend]);
  box.innerHTML=`<div class="sec">${esc(L.notesT)}</div>`+items.map(n=>`<div class="note">${esc(n)}</div>`).join("");
}
  if(typeof window!=="undefined"){ window.loadCtg=loadCtg; window.renderCtg=renderCtg;
    window.__ctgTest={i18n:CTG_I18N,url:CTG_DATA_URL,load:loadCtg,render:renderCtg,fmt:ctgFmt,fmtInt:ctgFmtInt,
      data:function(){ return _ctgData; },rerender:function(){ if(_ctgData) renderCtg(_ctgData); }}; }
})();
}catch(e){}
// __CTG_END__
