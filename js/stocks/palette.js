/* js/stocks/palette.js — P5 module 10: Tim kiem + palette toan cuc (ss*, pal*) tach tu stocks.html, giu nguyen hanh vi. EAGER: nap cung trang qua <script src> (dung tu moi view), khong lazy. */
// __PAL_BEGIN__
try{
(function(){

// ---- Tim ma (o tim o dau tab Thi truong, Chot 21/10) ----
// Danh sach 1.519 ma tai LUOI khi nguoi dung cham vao o tim (khong
// tai luc mo app). Gia/% chi hien neu ma da co san trong du lieu
// trang da tai (SS_PX tu luot screener cua top movers) - khong goi
// API rieng cho tung ket qua.
let SS_ROWS=null; const SS_PX={};
function ssFold(s){return (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/đ/g,"d");}
async function ssLoad(){
  if(SS_ROWS)return;
  try{const j=await api("/listing");
    SS_ROWS=(j.rows||[]).map(r=>({s:r.s,n:r.n,e:r.e,f:ssFold(r.n)}));
  }catch(e){SS_ROWS=[];}
}
function ssMatch(q){
  const qs=q.trim().toUpperCase(), qf=ssFold(q.trim());
  if(!qs||!SS_ROWS)return [];
  const t0=[],t1=[],t2=[];
  for(const r of SS_ROWS){
    if(r.s.startsWith(qs))t0.push(r);
    else if(r.s.includes(qs))t1.push(r);
    else if(qf&&r.f.includes(qf))t2.push(r);
    if(t0.length>=8)break;
  }
  return t0.concat(t1,t2).slice(0,8);
}
// ---- Palette hop nhat (Ctrl-K) — Chot thiet ke A 24/10 ----
// MOT o nhap duy nhat toan app: o #symSearch o tab Thi truong la DIEM
// MO palette (dropdown inline cu da go). Cung 1 palette: nut tim tren
// thanh tren moi trang + Ctrl-K/Cmd-K. Engine tim ma (ssLoad/ssFold/
// ssMatch), dieu huong (openSym/openSector/go) tai dung nguyen; khong
// LLM, khong endpoint moi. Bang nganh sao du kien tu bang SD cua
// chatRoute (cung file) — khong nguon nganh thu hai.
const PAL_I18N={
vi:{ph:"Tìm mã, ngành, trang hoặc lệnh…",none:"Không tìm thấy kết quả",hint:"↑↓ chọn · Enter mở · Esc đóng",gCmd:"Lệnh",gSym:"Mã",gSec:"Ngành",gPage:"Trang",holders:"Cổ đông",cons:"Đồng thuận",events:"Sự kiện",fin:"Báo cáo tài chính",chart:"Biểu đồ",flow:"Dòng tiền",foreign:"Khối ngoại",prop:"Tự doanh"},
en:{ph:"Search symbols, sectors, pages or commands…",none:"No results found",hint:"↑↓ navigate · Enter open · Esc close",gCmd:"Commands",gSym:"Symbols",gSec:"Sectors",gPage:"Pages",holders:"Shareholders",cons:"Consensus",events:"Events",fin:"Financial statements",chart:"Chart",flow:"Money flow",foreign:"Foreign flow",prop:"Proprietary flow"},
zh:{ph:"搜索股票、行业、页面或命令…",none:"未找到结果",hint:"↑↓ 选择 · Enter 打开 · Esc 关闭",gCmd:"命令",gSym:"股票",gSec:"行业",gPage:"页面",holders:"股东",cons:"共识",events:"事件",fin:"财务报表",chart:"图表",flow:"资金流",foreign:"外资流向",prop:"自营流向"},
ko:{ph:"종목, 업종, 페이지 또는 명령 검색…",none:"결과가 없습니다",hint:"↑↓ 이동 · Enter 열기 · Esc 닫기",gCmd:"명령",gSym:"종목",gSec:"업종",gPage:"페이지",holders:"주주",cons:"컨센서스",events:"이벤트",fin:"재무제표",chart:"차트",flow:"자금 흐름",foreign:"외국인 흐름",prop:"자전거래 흐름"}};
const PAL_SECTORS=[
["0500","Dầu khí",["dau khi"]],["1300","Hóa chất",["hoa chat"]],
["1700","Tài nguyên cơ bản",["tai nguyen co ban"]],
["2300","Xây dựng và vật liệu",["xay dung"]],
["2700","Hàng & dịch vụ công nghiệp",["hang dich vu cong nghiep"]],
["3300","Ô tô và phụ tùng",["o to"]],
["3500","Thực phẩm và đồ uống",["thuc pham"]],
["3700","Hàng cá nhân & gia dụng",["gia dung"]],
["4500","Y tế",["y te"]],["5300","Bán lẻ",["ban le"]],
["5500","Truyền thông",["truyen thong"]],
["5700","Du lịch và giải trí",["du lich"]],
["6500","Viễn thông",["vien thong"]],
["7500","Điện, nước & xăng dầu khí đốt",["dien"]],
["8300","Ngân hàng",["ngan hang"]],["8500","Bảo hiểm",["bao hiem"]],
["8600","Bất động sản",["bat dong san","bds"]],
["8700","Dịch vụ tài chính",["dich vu tai chinh","chung khoan"]],
["9500","Công nghệ thông tin",["cong nghe"]]];
const PAL_STOP=new Set(["ROE","EPS","NAY","MUA","BAN","XEM","CHO","HOM","QUA","SAU","MAI","MOT","HAI","BON","BAY","TAM","CHI","PHI","VON","LAI","TOT","XAU","CAO","MOI","THE","AND","FOR","HOW","ROOM","FREE","FLOAT"]);
let PAL_OPEN=false,PAL_ITEMS=[],PAL_ACT=0,PAL_RET=null;
function palT(k){const L=PAL_I18N[curLang]||PAL_I18N.vi;return L[k];}
function palSymToken(q){
  if(!SS_ROWS||!SS_ROWS.length)return null;
  const cands=q.match(/(?:^|\s)([A-Za-z]{3,4})(?=[\s?.!,]|$)/g)||[];
  for(const cm of cands){const t=cm.trim(),up=t.toUpperCase();
    if((t===t.toUpperCase()||t===t.toLowerCase())&&!PAL_STOP.has(up)&&SS_ROWS.some(r=>r.s===up))return up;}
  return null;
}
function palJumpSym(sym,dkey,anchorId){
  // Trang chi tiet co cac trang con (dOpen: Prof/Cons/Flow/News/Fund/
  // Tape); khoi Co dong nam o trang Prof, Dong thuan o trang Cons —
  // phai mo dung trang con thi neo moi hien (offsetParent != null).
  palClose();openSym(sym);
  if(!dkey&&!anchorId)return;
  let n=0,stable=0,opened=!dkey;
  const iv=setInterval(()=>{
    if(!opened&&curSym===sym){try{dOpen(dkey);opened=true;}catch(e){}}
    if(opened&&anchorId){
      const el=document.getElementById(anchorId);
      if(el&&el.offsetParent!==null){
        el.scrollIntoView({block:"start"});
        const r=el.getBoundingClientRect();
        if(r.top>=-4&&r.top<innerHeight){if(++stable>=2)clearInterval(iv);}
        else stable=0;
      }
    }
    if(++n>48)clearInterval(iv);},250);
}
function palJumpMarket(anchorId){
  palClose();go("v-market");
  if(!anchorId)return;
  let n=0;const iv=setInterval(()=>{const el=document.getElementById(anchorId);
    if(el&&el.offsetParent!==null){el.scrollIntoView({block:"center"});clearInterval(iv);}
    else if(++n>15)clearInterval(iv);},150);
}
function palCommands(q){
  const out=[],qf=ssFold(q.trim());if(!qf)return out;
  const sym=palSymToken(q),has=(s)=>qf.includes(s);
  if(sym){
    if(has("co dong"))out.push({label:sym+" · "+palT("holders"),act:()=>palJumpSym(sym,"Prof","dSecHolders")});
    if(has("dong thuan")||has("khuyen nghi"))out.push({label:sym+" · "+palT("cons"),act:()=>palJumpSym(sym,"Cons","dSecCons")});
    if(has("su kien")||has("co tuc"))out.push({label:sym+" · "+palT("events"),act:()=>palJumpSym(sym,null,"dEventsSec")});
    if(has("tai chinh")||has("doanh thu")||has("loi nhuan"))out.push({label:sym+" · "+palT("fin"),act:()=>palJumpSym(sym,null,"dFinSec")});
    if(has("bieu do"))out.push({label:sym+" · "+palT("chart"),act:()=>palJumpSym(sym,null,"dChartSec")});
  }
  if(has("dong tien")||has("tien vao")||has("tien ra"))out.push({label:palT("flow"),act:()=>palJumpMarket("ffCard")});
  if(has("khoi ngoai")||has("nuoc ngoai"))out.push({label:palT("foreign"),act:()=>palJumpMarket("ffCard")});
  if(has("tu doanh"))out.push({label:palT("prop"),act:()=>palJumpMarket("pfCard")});
  return out.slice(0,3);
}
function palSectors(q){
  const qf=ssFold(q.trim());if(!qf)return PAL_SECTORS.slice();
  return PAL_SECTORS.filter(([c,n,al])=>ssFold(n).includes(qf)||al.some(a=>a.includes(qf)||qf.includes(a))).slice(0,5);
}
function palPages(q){
  const qf=ssFold(q.trim());
  return NAV.filter(([v,vi])=>ssFold(NAVLBL[v]||"").includes(qf)||ssFold(vi).includes(qf));
}
function palSymHtml(r){
  const px=SS_PX[r.s];
  const pxh=px&&px.c!=null?'<span class="ss-px">'+fmtN(px.c)+(px.p!=null?' <span class="'+(px.p>0?"up":px.p<0?"down":"")+'">'+fmtPct(px.p)+"</span>":"")+"</span>":"";
  return '<span class="ss-sym">'+esc(r.s)+'</span><span class="ss-ex">'+esc(r.e)+'</span><span class="ss-name">'+esc(r.n)+"</span>"+pxh;
}
function palPaint(){
  document.querySelectorAll("#palResults .pal-row").forEach(el=>{
    el.classList.toggle("on",Number(el.dataset.i)===PAL_ACT);});
  const act=document.querySelector("#palResults .pal-row.on");
  if(act)act.scrollIntoView({block:"nearest"});
}
function palRender(){
  const box=$("palResults");if(!box)return;
  const q=$("palIn").value;PAL_ITEMS=[];PAL_ACT=0;
  let h="";
  const addGroup=(title,rows)=>{if(!rows.length)return;
    h+='<div class="pal-g">'+esc(title)+"</div>";
    rows.forEach(r=>{const i=PAL_ITEMS.length;PAL_ITEMS.push(r);
      h+='<div class="pal-row" data-i="'+i+'">'+r.html+"</div>";});};
  const secRow=([c,n])=>({html:'<span class="ss-sym" style="font-weight:600">'+esc(n)+'</span><span class="ss-ex">'+c+"</span>",act:()=>{palClose();go("v-sectors");openSectorLazy(c);}});
  const pgRow=([v])=>({html:'<span class="pal-pg">'+esc(NAVLBL[v]||v)+"</span>",act:()=>{palClose();go(v);}});
  if(!q.trim()){
    addGroup(palT("gPage"),NAV.map(pgRow));
    addGroup(palT("gSec"),PAL_SECTORS.map(secRow));
  }else{
    addGroup(palT("gCmd"),palCommands(q).map(c=>({html:'<span class="pal-cmd">'+esc(c.label)+"</span>",act:c.act})));
    const symRows=ssMatch(q),tok=palSymToken(q);
    if(tok&&!symRows.some(r=>r.s===tok)){const row=(SS_ROWS||[]).find(r=>r.s===tok);if(row)symRows.unshift(row);}
    addGroup(palT("gSym"),symRows.map(r=>({html:palSymHtml(r),act:()=>{const inp=$("symSearch");if(inp)inp.value=r.s;palClose();openSym(r.s);}})));
    addGroup(palT("gSec"),palSectors(q).map(secRow));
    addGroup(palT("gPage"),palPages(q).map(pgRow));
    if(!PAL_ITEMS.length)h='<div class="ss-none">'+esc(palT("none"))+"</div>";
  }
  box.innerHTML=h;
  box.querySelectorAll(".pal-row").forEach(el=>{
    el.addEventListener("mousedown",ev=>{ev.preventDefault();palActivate(Number(el.dataset.i));});
    el.addEventListener("mousemove",()=>{const i=Number(el.dataset.i);if(PAL_ACT!==i){PAL_ACT=i;palPaint();}});
  });
  palPaint();
}
function palMove(d){
  if(!PAL_ITEMS.length)return;
  PAL_ACT=(PAL_ACT+d+PAL_ITEMS.length)%PAL_ITEMS.length;palPaint();
}
function palActivate(i){const it=PAL_ITEMS[i];if(it)it.act();}
function palOpen(prefill){
  const ov=$("palOverlay"),inp=$("palIn");if(!ov||!inp)return;
  if(PAL_OPEN){inp.focus();return;}
  PAL_OPEN=true;PAL_RET=document.activeElement;
  ov.style.display="";document.body.style.overflow="hidden";
  if(typeof translatePh==="function")translatePh();
  $("palFoot").textContent=palT("hint");
  inp.value=prefill||"";
  palRender();inp.focus();
  try{inp.setSelectionRange(inp.value.length,inp.value.length);}catch(e){}
  ssLoad().then(()=>{if(PAL_OPEN)palRender();});
}
function palClose(){
  if(!PAL_OPEN)return;PAL_OPEN=false;
  $("palOverlay").style.display="none";document.body.style.overflow="";
  if(PAL_RET&&PAL_RET.id!=="symSearch"&&PAL_RET.focus)try{PAL_RET.focus();}catch(e){}
  PAL_RET=null;
}
(function palInit(){
  const inp=$("symSearch");
  if(inp){
    inp.addEventListener("focus",()=>{palOpen(inp.value);inp.blur();});
    inp.addEventListener("click",()=>{palOpen(inp.value);});
  }
  document.querySelectorAll(".hdr").forEach(hdr=>{
    const b=document.createElement("button");
    b.className="pal-btn";b.type="button";b.setAttribute("aria-label","Search / Tìm kiếm");
    b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
    b.addEventListener("click",()=>palOpen(""));
    hdr.appendChild(b);
  });
  const pin=$("palIn");
  if(pin){
    pin.addEventListener("input",()=>palRender());
    pin.addEventListener("keydown",ev=>{
      if(ev.key==="ArrowDown"){ev.preventDefault();palMove(1);}
      else if(ev.key==="ArrowUp"){ev.preventDefault();palMove(-1);}
      else if(ev.key==="Enter"){ev.preventDefault();if(PAL_ITEMS.length)palActivate(PAL_ACT);}
      else if(ev.key==="Escape"){ev.preventDefault();palClose();}
    });
  }
  const pc=$("palClose"); if(pc)pc.addEventListener("click",()=>palClose());
  const pov=$("palOverlay"); if(pov)pov.addEventListener("mousedown",ev=>{if(ev.target===pov)palClose();});
  document.addEventListener("keydown",ev=>{
    if((ev.ctrlKey||ev.metaKey)&&(ev.key==="k"||ev.key==="K")){
      ev.preventDefault();if(PAL_OPEN)palClose();else palOpen("");
    }
  });
})();
  if(typeof window!=="undefined"){
    window.SS_PX=SS_PX; window.PAL_SECTORS=PAL_SECTORS; window.PAL_STOP=PAL_STOP; window.PAL_I18N=PAL_I18N;
    Object.defineProperty(window,"SS_ROWS",{get:function(){ return SS_ROWS; },configurable:true});
    window.ssFold=ssFold; window.ssLoad=ssLoad; window.ssMatch=ssMatch;
    window.palOpen=palOpen; window.palClose=palClose; window.palT=palT; window.palRender=palRender; window.palMove=palMove; window.palActivate=palActivate;
    window.__palTest={i18n:PAL_I18N,load:ssLoad,match:ssMatch,open:palOpen,close:palClose}; }
})();
}catch(e){}
// __PAL_END__
