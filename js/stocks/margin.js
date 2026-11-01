/* js/stocks/margin.js — P5 module 2: khoi Margin (v-margin) tach tu stocks.html, giu nguyen hanh vi. Classic script, nap lazy khi mo tab. */
// __MG_BEGIN__
(function(){
  const MG_DATA = {"meta":{"latest":"2026-Q2","prev":"2026-Q1","partial_q":"2026-Q3","partial_n":39,"total_n":43,"source":"VCI IQ","hose_hnx_q2_margin":321150030564132,"upcom_q2_margin":18249570466871,"exchanges":{"HOSE":21,"HNX":11,"UPCOM":11}},"totals":[{"q":"2018-Q1","m":34014462029104,"a":2033112917575,"t":36047574946679,"n":38},{"q":"2018-Q2","m":23940425570796,"a":1311474958141,"t":25251900528937,"n":40},{"q":"2018-Q3","m":25895676145410,"a":1643744684334,"t":27539420829744,"n":37},{"q":"2018-Q4","m":22800969774558,"a":1888666492357,"t":24689636266915,"n":36},{"q":"2019-Q1","m":28341389495162,"a":1542442411892,"t":29883831907054,"n":38},{"q":"2019-Q2","m":33690800843965,"a":1671713123019,"t":35362513966984,"n":42},{"q":"2019-Q3","m":27981374047069,"a":1008502950971,"t":28989876998040,"n":38},{"q":"2019-Q4","m":21754688785513,"a":1298858518935,"t":23053547304448,"n":36},{"q":"2020-Q1","m":20511739407346,"a":1123258548113,"t":21634997955459,"n":38},{"q":"2020-Q2","m":29779130958080,"a":1951783962010,"t":31730914920090,"n":42},{"q":"2020-Q3","m":29817071965631,"a":1781607946210,"t":31598679911841,"n":40},{"q":"2020-Q4","m":38261150870124,"a":3544755221376,"t":41805906091500,"n":40},{"q":"2021-Q1","m":44601212386548,"a":4320687944441,"t":48921900330989,"n":36},{"q":"2021-Q2","m":64490804153633,"a":6832090243240,"t":71322894396873,"n":37},{"q":"2021-Q3","m":94715669601333,"a":5690882132607,"t":100406551733940,"n":39},{"q":"2021-Q4","m":95166599982734,"a":10081678646833,"t":105248278629567,"n":37},{"q":"2022-Q1","m":123470486628781,"a":10308546612951,"t":133779033241732,"n":40},{"q":"2022-Q2","m":98697635394642,"a":4051784849880,"t":102749420244522,"n":40},{"q":"2022-Q3","m":102618835213359,"a":4018029757068,"t":106636864970427,"n":36},{"q":"2022-Q4","m":74151201381749,"a":4289708542702,"t":78440909924451,"n":39},{"q":"2023-Q1","m":78109715374350,"a":3510330663130,"t":81620046037480,"n":40},{"q":"2023-Q2","m":93402220359813,"a":4146763023339,"t":97548983383152,"n":41},{"q":"2023-Q3","m":107036880736855,"a":3991613369021,"t":111028494105876,"n":41},{"q":"2023-Q4","m":118275411836748,"a":4825868499829,"t":123101280336577,"n":37},{"q":"2024-Q1","m":133298900444200,"a":6317132529756,"t":139616032973956,"n":39},{"q":"2024-Q2","m":155528740968264,"a":5689292434023,"t":161218033402287,"n":42},{"q":"2024-Q3","m":151081427474285,"a":4431071935471,"t":155512499409756,"n":40},{"q":"2024-Q4","m":172023589132332,"a":3836564576688,"t":175860153709020,"n":41},{"q":"2025-Q1","m":194349684666745,"a":4480043450595,"t":198829728117340,"n":41},{"q":"2025-Q2","m":214787722717427,"a":5158887810069,"t":219946610527496,"n":42},{"q":"2025-Q3","m":271686172155010,"a":8786349114353,"t":280472521269363,"n":41},{"q":"2025-Q4","m":307670472103409,"a":8074223126647,"t":315744695230056,"n":42},{"q":"2026-Q1","m":315031361553559,"a":6695329985868,"t":321726691539427,"n":42},{"q":"2026-Q2","m":339399601031003,"a":5908947572481,"t":345308548603484,"n":42},{"q":"2026-Q3","m":296934596280003,"a":3297740775362,"t":300232337055365,"n":39}],"firms":[{"s":"TCX","ex":"HOSE","name":"Chung khoan Techcombank","cls":"ok","m":51043232067722,"a":479203127134,"t":51522435194856,"pm":44146613378012,"q3m":54368387671504},{"s":"SSI","ex":"HOSE","name":"Chung khoan SSI","cls":"ok_recent","m":40036581154395,"a":435969870963,"t":40472551025358,"pm":36585242225377,"q3m":null},{"s":"VPX","ex":"HOSE","name":"Chung khoan VPBank","cls":"ok","m":37138760243238,"a":1038392662786,"t":38177152906024,"pm":35918759849688,"q3m":39691245533526},{"s":"VCK","ex":"HOSE","name":"Chung khoan VPS","cls":"ok_recent","m":30527661155420,"a":783792082340,"t":31311453237760,"pm":29979376691947,"q3m":25363394361661},{"s":"HCM","ex":"HOSE","name":"Chung khoan TP.HCM","cls":"ok","m":29023522504995,"a":0,"t":29023522504995,"pm":28140477163249,"q3m":29169878109274},{"s":"MBS","ex":"HNX","name":"Chung khoan MB","cls":"ok_recent","m":16670399706879,"a":157653840141,"t":16828053547020,"pm":14867436490253,"q3m":16510633797036},{"s":"VCI","ex":"HOSE","name":"Chung khoan Vietcap","cls":"ok","m":16646458908632,"a":499330699278,"t":17145789607910,"pm":16389139496232,"q3m":17155060526647},{"s":"VIX","ex":"HOSE","name":"Chung khoan VIX","cls":"ok_recent","m":13920481602576,"a":37644011607,"t":13958125614183,"pm":12453092661133,"q3m":12415461105213},{"s":"LPS","ex":"HOSE","name":"Chung khoan LPBank","cls":"partial","m":13636454644678,"a":101462974396,"t":13737917619074,"pm":11393575779172,"q3m":12394630057545},{"s":"VND","ex":"HOSE","name":"Chung khoan VNDIRECT","cls":"ok_recent","m":12700582740156,"a":158456205671,"t":12859038945827,"pm":12468621392668,"q3m":12115767509608},{"s":"KAI","ex":"UPCOM","name":"Chung khoan KAFI","cls":"ok_recent","m":11675097103052,"a":26723832625,"t":11701820935677,"pm":10707090458525,"q3m":12283889580322},{"s":"SHS","ex":"HNX","name":"Chung khoan Sai Gon Ha Noi","cls":"ok","m":11417441456788,"a":304630166666,"t":11722071623454,"pm":10196751152183,"q3m":12216411175910},{"s":"BSI","ex":"HOSE","name":"Chung khoan BIDV","cls":"ok","m":9372614221056,"a":97962479926,"t":9470576700982,"pm":8967221997478,"q3m":10255817424061},{"s":"DSE","ex":"HOSE","name":"Chung khoan DNSE","cls":"ok","m":6125104986489,"a":177959765712,"t":6303064752201,"pm":5655551028905,"q3m":6274083784594},{"s":"FTS","ex":"HOSE","name":"Chung khoan FPT","cls":"partial","m":5979842170172,"a":400546865449,"t":6380389035621,"pm":5592679998102,"q3m":5616099597852},{"s":"CTS","ex":"HOSE","name":"Chung khoan VietinBank","cls":"ok_recent","m":5276415740011,"a":45336851853,"t":5321752591864,"pm":5284578584542,"q3m":5050382620179},{"s":"VDS","ex":"HOSE","name":"Chung khoan Rong Viet","cls":"ok","m":4132797490688,"a":156869011403,"t":4289666502091,"pm":3707687465252,"q3m":null},{"s":"BVS","ex":"HNX","name":"Chung khoan Bao Viet","cls":"ok","m":4006109530803,"a":400379238169,"t":4406488768972,"pm":4074220268542,"q3m":3692158600025},{"s":"PHS","ex":"UPCOM","name":"Chung khoan Phu Hung","cls":"ok_recent","m":3878191502894,"a":117236937920,"t":3995428440814,"pm":4005653704131,"q3m":3987970842435},{"s":"AGR","ex":"HOSE","name":"Chung khoan Agribank","cls":"partial","m":2903705711294,"a":84294806155,"t":2988000517449,"pm":2464370146152,"q3m":3160429580221},{"s":"DSC","ex":"HOSE","name":"Chung khoan DSC","cls":"ok","m":2894012833286,"a":31471441399,"t":2925484274685,"pm":2554410990025,"q3m":2737978981926},{"s":"VFS","ex":"HNX","name":"Chung khoan Nhat Viet","cls":"ok","m":1909272125400,"a":60608083048,"t":1969880208448,"pm":1822467477021,"q3m":2270478577396},{"s":"ORS","ex":"HOSE","name":"Chung khoan Tien Phong","cls":"ok_recent","m":1872278593486,"a":12311221297,"t":1884589814783,"pm":1664476218820,"q3m":2662551315946},{"s":"PSI","ex":"HNX","name":"Chung khoan Dau khi","cls":"ok_recent","m":1245199021898,"a":28037759244,"t":1273236781142,"pm":1454417534533,"q3m":1367830770285},{"s":"ABW","ex":"UPCOM","name":"Chung khoan An Binh","cls":"ok","m":1172311676887,"a":69737432433,"t":1242049109320,"pm":808952255063,"q3m":1774996381523},{"s":"IVS","ex":"HNX","name":"Chung khoan Guotai Haitong","cls":"ok","m":791046202248,"a":2644217280,"t":793690419528,"pm":798244028169,"q3m":708947295685},{"s":"APG","ex":"HOSE","name":"Chung khoan APG","cls":"ok","m":723831348914,"a":3938060564,"t":727769409478,"pm":694606705711,"q3m":691783691157},{"s":"TCI","ex":"HOSE","name":"Chung khoan Thanh Cong","cls":"ok","m":560280031085,"a":21267896455,"t":581547927540,"pm":694954745033,"q3m":501930256943},{"s":"SBS","ex":"UPCOM","name":"Chung khoan Sacombank","cls":"ok","m":418231125461,"a":16896019391,"t":435127144852,"pm":220236456469,"q3m":342239800389},{"s":"TVS","ex":"HOSE","name":"Chung khoan Thien Viet","cls":"ok","m":364085136308,"a":1992982462,"t":366078118770,"pm":346715619687,"q3m":null},{"s":"VUA","ex":"UPCOM","name":"Chung khoan Stanley Brothers","cls":"ok_recent","m":300513471371,"a":150000000,"t":300663471371,"pm":71648842837,"q3m":578303630242},{"s":"BMS","ex":"UPCOM","name":"Chung khoan Bao Minh","cls":"ok","m":279595169597,"a":26500523684,"t":306095693281,"pm":134471861350,"q3m":688969266676},{"s":"HAC","ex":"UPCOM","name":"Chung khoan Hai Phong","cls":"ok","m":224547116988,"a":5744140308,"t":230291257296,"pm":173684217782,"q3m":432837737734},{"s":"APS","ex":"HNX","name":"Chung khoan APEC","cls":"ok","m":152720530183,"a":19023773920,"t":171744304103,"pm":160872046797,"q3m":149361823127},{"s":"ART","ex":"UPCOM","name":"Chung khoan BOS","cls":"partial","m":114411857455,"a":0,"t":114411857455,"pm":114411857455,"q3m":99411857455},{"s":"AAS","ex":"UPCOM","name":"Chung khoan SmartInvest","cls":"ok","m":100417405801,"a":1113992277,"t":101531398078,"pm":117336013603,"q3m":95972090366},{"s":"UPS","ex":"UPCOM","name":"Chung khoan UP","cls":"ok_recent","m":75968897669,"a":3743148984,"t":79712046653,"pm":104721434103,"q3m":50960141118},{"s":"EVS","ex":"HNX","name":"Chung khoan EVS","cls":"partial","m":72260541565,"a":2692354524,"t":74952896089,"pm":79996493658,"q3m":36621467816},{"s":"CSI","ex":"UPCOM","name":"Chung khoan Kirin","cls":"ok","m":10285139696,"a":155155410,"t":10440295106,"pm":9595966994,"q3m":14053826219},{"s":"TVB","ex":"HOSE","name":"Chung khoan T-Cap","cls":"ok_recent","m":4615187750,"a":8855574670,"t":13470762420,"pm":4615187750,"q3m":4615187750},{"s":"VIG","ex":"HNX","name":"Chung khoan VICS","cls":"ok","m":1466849764,"a":94709697,"t":1561559461,"pm":0,"q3m":2537357364},{"s":"WSS","ex":"HNX","name":"Chung khoan pho Wall","cls":"ok_recent","m":796126253,"a":88123655240,"t":88919781493,"pm":2385669156,"q3m":512945273},{"s":"HBS","ex":"HNX","name":"Chung khoan Hoa Binh","cls":"ok_recent","m":null,"a":null,"t":0,"pm":null,"q3m":null}]};
  const MG_I18N = {
    vi:{srcShort:"Nguồn: VCI IQ",totalMargin:"Tổng dư nợ margin",advance:"Ứng trước",totalLoans:"Tổng cho vay",coverage:"Độ phủ",firmsReported:"hãng đã báo cáo",changePrev:"Thay đổi so với quý trước",chartT:"Tổng dư nợ margin theo quý",tableT:"Từng CTCK — dư nợ margin",colSym:"Mã",colMargin:"Dư nợ margin",colChange:"Thay đổi",noData:"Chưa có số liệu",loadErr:"Lỗi tải",partialShort:"đang cập nhật",unitT:" nghìn tỷ",unitB:" tỷ",
      partial:"Quý {q} mới có {n}/{t} hãng báo cáo — tổng thấp hơn chưa phải mức giảm.",
      noteSrc:"Nguồn: VCI IQ (dữ liệu công khai). Nhóm: 43 CTCK đang giao dịch (21 HOSE, 11 HNX, 11 UPCOM).",
      noteNotOfficial:"Tổng trên là tổng cộng dồn của nhóm, KHÔNG phải số chính thức do UBCK/HOSE công bố. Các CTCK chưa niêm yết (ACBS, TCBS, KBS, KIS…) không nằm trong nhóm.",
      noteUpcom:"Tổng gồm 11 hãng UPCOM. Riêng HOSE+HNX, dư nợ margin Q2/2026 là 321,2 nghìn tỷ.",
      noteVerify:"SSI Q2/2026 đã đối chiếu khớp tuyệt đối với BCTC chính thức (bản riêng lẻ và hợp nhất)."},
    en:{srcShort:"Source: VCI IQ",totalMargin:"Total margin loans",advance:"Investor advances",totalLoans:"Total loans",coverage:"Coverage",firmsReported:"firms reported",changePrev:"Change vs previous quarter",chartT:"Total margin loans by quarter",tableT:"By firm — margin loans",colSym:"Symbol",colMargin:"Margin loans",colChange:"Change",noData:"No data yet",loadErr:"Load failed",partialShort:"updating",unitT:"T VND",unitB:"B VND",
      partial:"Quarter {q} has only {n}/{t} firms reported — the lower total is not a decline.",
      noteSrc:"Source: VCI IQ (public data). Universe: 43 trading securities firms (21 HOSE, 11 HNX, 11 UPCOM).",
      noteNotOfficial:"The total above is the group's summed total, NOT an official figure published by UBCK/HOSE. Unlisted firms (ACBS, TCBS, KBS, KIS…) are not in the group.",
      noteUpcom:"The total includes 11 UPCOM firms. HOSE+HNX only, Q2/2026 margin loans are 321.2 trillion VND.",
      noteVerify:"SSI Q2/2026 reconciles exactly with its official financial statements (separate and consolidated)."},
    zh:{srcShort:"来源：VCI IQ",totalMargin:"融资余额合计",advance:"投资者垫款",totalLoans:"贷款合计",coverage:"覆盖率",firmsReported:"家已公布",changePrev:"较上季度变化",chartT:"各季度融资余额合计",tableT:"各券商——融资余额",colSym:"代码",colMargin:"融资余额",colChange:"变化",noData:"暂无数据",loadErr:"加载失败",partialShort:"更新中",unitT:"万亿越盾",unitB:"十亿越盾",
      partial:"{q}仅{n}/{t}家公布——合计偏低并非下降。",
      noteSrc:"来源：VCI IQ（公开数据）。范围：43 家在交易证券公司（21 家 HOSE、11 家 HNX、11 家 UPCOM）。",
      noteNotOfficial:"上述合计为该组加总数，并非 UBCK/HOSE 发布的官方数字。未上市券商（ACBS、TCBS、KBS、KIS…）不在范围内。",
      noteUpcom:"合计包含 11 家 UPCOM 公司。仅 HOSE+HNX，2026 年第二季度融资余额为 321.2 万亿越盾。",
      noteVerify:"SSI 2026 年第二季度已与官方财务报表（单体与合并）完全核对一致。"},
    ko:{srcShort:"출처: VCI IQ",totalMargin:"신용융자 잔액 합계",advance:"투자자 선지급금",totalLoans:"대출 합계",coverage:"커버리지",firmsReported:"개사 공시",changePrev:"전 분기 대비 변동",chartT:"분기별 신용융자 잔액 합계",tableT:"증권사별——신용융자 잔액",colSym:"종목",colMargin:"신용융자 잔액",colChange:"변동",noData:"데이터 없음",loadErr:"불러오기 실패",partialShort:"업데이트 중",unitT:"조 동",unitB:"십억 동",
      partial:"{q}는 {n}/{t}개사만 공시——합계가 낮은 것은 감소가 아닙니다.",
      noteSrc:"출처: VCI IQ(공개 데이터). 범위: 거래 중인 증권사 43개사(HOSE 21, HNX 11, UPCOM 11).",
      noteNotOfficial:"위 합계는 그룹 합산 수치이며, UBCK/HOSE가 발표한 공식 수치가 아닙니다. 비상장 증권사(ACBS, TCBS, KBS, KIS…)는 포함되지 않습니다.",
      noteUpcom:"합계에는 UPCOM 11개사가 포함됩니다. HOSE+HNX만으로는 2026년 2분기 신용융자 잔액이 321.2조 동입니다.",
      noteVerify:"SSI 2026년 2분기는 공식 재무제표(별도·연결)와 정확히 일치합니다."}
  };
  function mgL(){ const l=(typeof curLang!=="undefined"?curLang:"vi"); return MG_I18N[l]||MG_I18N.vi; }
  function mgT(k){ const L=mgL(); return (L[k]!=null?L[k]:MG_I18N.vi[k]); }
  function mgEsc(s){ return String(s??"").replace(/[&<>"]/g,function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]); }); }
  function mgFmtT(v){ if(v==null) return "—"; return (v/1e12).toLocaleString("en-US",{minimumFractionDigits:1,maximumFractionDigits:1})+mgT("unitT"); }
  function mgFmtB(v){ if(v==null) return "—"; return Math.round(v/1e9).toLocaleString("en-US")+mgT("unitB"); }
  function mgPct(p){ if(p==null) return "—"; return (p>0?"+":"")+p.toFixed(2)+"%"; }
  function mgQLbl(q){ const p=String(q).split("-"); return p.length===2?p[1]+"/"+p[0]:q; }
  function mgFind(q){ for(const t of MG_DATA.totals){ if(t.q===q) return t; } return null; }
  function mgLatestTotal(){ return mgFind(MG_DATA.meta.latest); }
  function mgPartial(){ return mgFind(MG_DATA.meta.partial_q); }
  function mgChange(f){ if(f.m==null||f.pm==null||f.pm===0) return null; return (f.m-f.pm)/f.pm*100; }
  function mgChartSVG(){
    const comp=MG_DATA.totals.filter(function(t){ return t.q!==MG_DATA.meta.partial_q; });
    const part=mgPartial();
    if(!comp.length) return "";
    const vals=comp.map(function(t){ return t.m; });
    let mn=Math.min.apply(null,vals), mx=Math.max.apply(null,vals);
    const pad=(mx-mn)*0.08||1; mn-=pad; mx+=pad;
    const W=440,H=170,PL=8,PR=8,PT=16,PB=22, n=comp.length;
    const X=function(i){ return PL+i*(W-PL-PR)/(n-1); };
    const Y=function(v){ return PT+(1-(v-mn)/(mx-mn))*(H-PT-PB); };
    const pts=comp.map(function(t,i){ return X(i).toFixed(1)+","+Y(t.m).toFixed(1); }).join(" ");
    let labels="";
    comp.forEach(function(t,i){ if(t.q.slice(5)==="Q1"||i===n-1){ labels+='<text x="'+X(i).toFixed(1)+'" y="'+(H-6)+'" font-size="10" fill="var(--pp-mut)" text-anchor="middle">'+mgQLbl(t.q)+'</text>'; } });
    const lastV='<text x="'+X(n-1).toFixed(1)+'" y="'+(Y(comp[n-1].m)-8).toFixed(1)+'" font-size="11" font-weight="700" fill="var(--pp-ink)" text-anchor="end">'+mgFmtT(comp[n-1].m)+'</text>';
    let dashed="";
    if(part&&part.m!=null){
      const x2=PL+n*(W-PL-PR)/(n-1);
      dashed='<line x1="'+X(n-1).toFixed(1)+'" y1="'+Y(comp[n-1].m).toFixed(1)+'" x2="'+x2.toFixed(1)+'" y2="'+Y(part.m).toFixed(1)+'" stroke="var(--pp-mut)" stroke-width="1.5" stroke-dasharray="4 3"/>'+
        '<circle cx="'+x2.toFixed(1)+'" cy="'+Y(part.m).toFixed(1)+'" r="4" fill="none" stroke="var(--pp-mut)" stroke-width="1.5"/>';
    }
    return '<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto;display:block"><polyline points="'+pts+'" fill="none" stroke="var(--pp-accent)" stroke-width="2" stroke-linejoin="round"/>'+dashed+lastV+labels+'</svg>';
  }
  function loadMargin(){
    try{
      const head=$("mgHead"), chart=$("mgChart"), chartT=$("mgChartT"), tableT=$("mgTableT"),
        thead=$("mgTableHead"), tbody=$("mgTableBody"), notes=$("mgNotes"), banner=$("mgBanner"), src=$("mgSrc");
      if(!tbody) return;
      const m=MG_DATA.meta, lt=mgLatestTotal(), pv=mgFind(m.prev), part=mgPartial();
      if(!lt||!MG_DATA.totals.length){ tbody.innerHTML='<tr><td colspan="3"><div class="hint">'+mgT("loadErr")+'</div></td></tr>'; return; }
      const chg=(lt.m!=null&&pv&&pv.m)?(lt.m-pv.m)/pv.m*100:null;
      if(src) src.textContent=mgT("srcShort");
      if(banner){
        banner.innerHTML = part ? '<div class="insight"><div class="ins-b">'+mgT("partial").replace("{q}",mgQLbl(m.partial_q)).replace("{n}",String(m.partial_n)).replace("{t}",String(m.total_n))+'</div></div>' : "";
      }
      if(head) head.innerHTML=
        '<div class="idxcard"><div class="s">'+mgT("totalMargin")+' ('+mgQLbl(m.latest)+')</div><div class="p">'+mgFmtT(lt.m)+'</div><div class="c">'+mgT("changePrev")+': '+mgPct(chg)+'</div></div>'+
        '<div class="idxcard"><div class="s">'+mgT("advance")+'</div><div class="p">'+mgFmtT(lt.a)+'</div><div class="c">'+mgT("totalLoans")+': '+mgFmtT(lt.t)+'</div></div>'+
        '<div class="idxcard"><div class="s">'+mgT("coverage")+'</div><div class="p">'+lt.n+'/'+m.total_n+'</div><div class="c">'+mgT("firmsReported")+'</div></div>'+
        '<div class="idxcard"><div class="s">'+mgQLbl(m.partial_q)+'</div><div class="p">'+mgFmtT(part?part.m:null)+'</div><div class="c">'+mgT("partialShort")+'</div></div>';
      if(chartT) chartT.textContent=mgT("chartT");
      if(chart) chart.innerHTML=mgChartSVG();
      if(tableT) tableT.textContent=mgT("tableT");
      if(thead) thead.innerHTML='<tr><th>'+mgT("colSym")+'</th><th style="text-align:right">'+mgT("colMargin")+'</th><th style="text-align:right">'+mgT("colChange")+'</th></tr>';
      tbody.innerHTML=MG_DATA.firms.map(function(f){
        const c=mgChange(f);
        const cls=c==null?"":(c>=0?"up":"down");
        const adv=f.a==null?"":'<div style="font-size:12px;color:var(--pp-mut)">'+mgT("advance")+': '+(f.a===0?"0":mgFmtB(f.a))+'</div>';
        return '<tr><td><b>'+mgEsc(f.s)+'</b><div style="font-size:12px;color:var(--pp-mut)">'+mgEsc(f.name)+' · '+mgEsc(f.ex)+'</div></td>'+
          '<td style="text-align:right">'+(f.m==null?'<span style="color:var(--pp-mut)">'+mgT("noData")+'</span>':'<b>'+mgFmtB(f.m)+'</b>'+adv)+'</td>'+
          '<td style="text-align:right" class="'+cls+'">'+mgPct(c)+'</td></tr>';
      }).join("");
      if(notes) notes.innerHTML='<div class="note">'+mgT("noteSrc")+'</div><div class="note">'+mgT("noteNotOfficial")+'</div><div class="note">'+mgT("noteUpcom")+'</div><div class="note">'+mgT("noteVerify")+'</div>';
    }catch(e){
      const b=$("mgTableBody"); if(b) b.innerHTML='<tr><td colspan="3"><div class="hint">'+mgT("loadErr")+'</div></td></tr>';
    }
  }
  if(typeof window!=="undefined"){ window.loadMargin=loadMargin; window.__mgTest={data:MG_DATA,latestTotal:mgLatestTotal,partial:mgPartial,change:mgChange,fmtT:mgFmtT,fmtB:mgFmtB,pct:mgPct,qlbl:mgQLbl,chart:mgChartSVG,i18n:MG_I18N,t:mgT,render:loadMargin}; }
})();
// __MG_END__
