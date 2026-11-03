/* js/stocks/finhay.js — Lớp hiển thị dữ liệu Finhay BỔ SUNG cho trang stock.
 *
 * Đọc qua lane đọc công khai MỚI `GET /api/stock/finhay/<key>` (bản nháp worker,
 * patches/worker-finhay-lane.patch) — mỗi doc là envelope {schema,source,ok,
 * ttl_seconds,fetched_at[_ict],errors[],data}. Trang đọc theo `ttl_seconds`;
 * `ok===false` hoặc `errors` khác rỗng thì vẫn hiển thị bản cũ KÈM NHÃN, không ẩn.
 *
 * LUẬT: chỉ THÊM hiển thị. Không đụng luồng giá realtime/chỉ số/nến
 * (PA-3b/3c/4a), không đụng bộ thu. MIỄN PHÍ cho mọi người — không nằm trong
 * GATED flags, không premium-check, không cần token (endpoint public).
 *
 * Phạm vi hiển thị (theo TASK 03/11):
 *   - Vĩ mô VN Chuỗi MỚI: CPI, PMI, IIP, INTERBANK_RATE, 10Y TPCP  (mục 2)
 *   - Vàng SJC + tỷ giá USD/VND  (mục 3, Finhay = đối chiếu — hệ thống đã có thẻ
 *     riêng từ nguồn NHNN/SJC; khối này là ô Finhay cạnh đó, không thay nguồn cũ)
 *   - Khuyến nghị theo mã: nhãn MUA/BÁN + giá mục tiêu + nguồn + ngày  (mục 5)
 *   KHÔNG hiển thị (ghi rõ lý do):
 *   - 3 chuỗi XNK (TOTAL_EXPORT/FDI_EXPORT/DOMESTIC_EXPORT): đơn vị CHƯA CHẮC
 *     (API không trả unit, hint chỉ là suy luận) — chờ xác nhận (REPORT §9.5).
 *   - Quỹ (DCDS/DCBC/VESAF/VEOF): dữ liệu đóng băng 2023-07 — đề xuất BỎ hẳn
 *     kenh quỹ trên trang (REPORT §9.8), không có ô ở đây.
 *   - FED/UST: chuỗi đã có chỗ (fed_effr, ust) từ nyfed/treasury — không thêm ô.
 */
(function(root){
// ---------- helpers thuần (node-test được, không phụ thuộc DOM/global) ----------
function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c];}); }
function num(v,d){ if(v==null||!isFinite(v)) return "—"; return Number(v).toLocaleString("vi-VN",{minimumFractionDigits:d||0,maximumFractionDigits:(d==null?2:d)}); }
function trillions(v){ if(v==null||!isFinite(v)) return "—"; return num(v/1e6,1); } // 1e6 = triệu

// Nhãn + màu cho khuyến nghị (miền không dấu để khớp an toàn).
var REC_UP={MUA:1,KHA_QUAN:1,TANG_TY_TRONG:1,OUTPERFORM:1,MUA_MANH:1,PHU_HOP_THI_TRUONG:1};
var REC_DOWN={BAN:1,TRUNG_LAP_NEG:1};
function recColor(label){
  var key=String(label||"").normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[\s.]+/g,"_").toUpperCase();
  if(REC_UP[key]) return "up";
  if(key==="BAN"||key==="THOAT_HIEM") return "down";
  return ""; // NẮM GIỮ / TÍCH LŨY / THEO DÕI / TRUNG LẬP ... -> trung tính
}
// Nhãn + đơn vị cho các chuỗi vĩ mô VN mới (khung hiển thị).
var VN_MACRO=[
  {key:"VN.CPI", label:"CPI VN", unit:"% yoy"},
  {key:"VN.PMI", label:"PMI VN", unit:"index"},
  {key:"VN.IIP", label:"IIP VN", unit:"% yoy"},
  {key:"VN.INTERBANK_RATE", label:"Lãi suất liên NH", unit:"%/năm"},
  {key:"VN.GOVERNMENT_10Y_BOND_YIELD", label:"TPCP VN 10Y", unit:"%/năm"}
];
// XNK — CỐ Ý không hiển thị (đơn vị chưa chắc). Liệt kê để chống ai đó thêm nhầm.
var VN_XNK_HOLD=["VN.TOTAL_EXPORT","VN.FDI_EXPORT","VN.DOMESTIC_EXPORT"];

// Một chuỗi vĩ mô -> ô thẻ. `series` là data.series[<key>] từ macro/latest.
// `label` là nhãn thân thiện (từ VN_MACRO) — ưu tiên hơn kiểu dữ liệu thô.
function macroCard(s,label,key){
  if(!s||s.status!=="ok"||!s.latest||s.latest.value==null)
    return "<div class=\"fhcard\" data-series=\""+esc(key||"")+"\"><div class=\"fhk\">—</div><div class=\"fhv hint\">Chưa có dữ liệu</div></div>";
  var per=(s.latest.date||s.latest.month||"");
  var chg=(s.change==null||!isFinite(s.change))?null:s.change;
  var chgTxt=chg==null?"":("<span class=\""+(chg>0?"up":chg<0?"down":"")+"\">"+(chg>0?"▲ ":chg<0?"▼ ":"")+num(Math.abs(chg),2)+"</span>");
  var nm=label||((s.type||"")+(s.country?" · "+s.country:""));
  return "<div class=\"fhcard\" data-series=\""+esc(key||"")+"\">"
    +"<div class=\"fhk\">"+esc(nm)+"</div>"
    +"<div class=\"fhv\"><span class=\"mv\">"+num(s.latest.value,2)+"</span> "
      +"<span class=\"mu\">"+esc(s.unit_hint||"")+"</span></div>"
    +"<div class=\"fhd\">"+chgTxt+(chgTxt?" · ":"")+"kỳ "+esc(per)+"</div>"
    +"</div>";
}

// Doc vĩ mô (envelope) + doc hàng hoá (envelope) -> HTML khối "Vĩ mô VN — Finhay".
// ok=false / errors -> vẫn render data cũ, thêm nhãn cảnh báo (fail-open, không ẩn).
function renderFinhayMacro(macroDoc, commDoc){
  var notes=[];
  var out="";
  if(macroDoc && macroDoc.data && macroDoc.data.series){
    var S=macroDoc.data.series, cards="";
    VN_MACRO.forEach(function(m){ var s=S[m.key]; if(s) cards+=macroCard(s,m.label,m.key); });
    if(cards) out+="<div class=\"fhgrid\">"+cards+"</div>";
  }
  // Vàng SJC (Finhay) — đối chiếu; hệ thống đã có thẻ SJC riêng từ nguồn SJC.
  if(commDoc && commDoc.data && Array.isArray(commDoc.data.gold)){
    var sjc=commDoc.data.gold.filter(function(g){return String(g.index||"").indexOf("SJC")>=0;})[0];
    if(sjc&&sjc.sell_vnd_per_luong){
      out+="<div class=\"fhgrid\">"
        +"<div class=\"fhcard\"><div class=\"fhk\">Vàng SJC (Finhay)</div>"
        +"<div class=\"fhv\"><span class=\"mv\">"+trillions(sjc.buy_vnd_per_luong)+" / "+trillions(sjc.sell_vnd_per_luong)+"</span> <span class=\"mu\">tr đ/lượng</span></div>"
        +"<div class=\"fhd\">mua / bán · "+esc(sjc.date||"")+"</div></div>"
        +"</div>";
    }
  }
  // Tỷ giá USD/VND (Finhay, Vietcombank) — đối chiếu.
  if(commDoc && commDoc.data && Array.isArray(commDoc.data.financial_types)){
    var fxT=commDoc.data.financial_types.filter(function(t){return t.financial_type==="USD_EXCHANGE_RATE";})[0];
    var fx=fxT&&Array.isArray(fxT.values)?fxT.values.filter(function(v){return v.index==="USD_VND_EXCHANGE_RATE";})[0]:null;
    if(fx&&fx.sell_value){
      out+="<div class=\"fhgrid\">"
        +"<div class=\"fhcard\"><div class=\"fhk\">Tỷ giá USD/VND ("+esc(fx.name||"")+")</div>"
        +"<div class=\"fhv\"><span class=\"mv\">"+num(fx.buy_value,0)+" / "+num(fx.sell_value,0)+"</span> <span class=\"mu\">₫</span></div>"
        +"<div class=\"fhd\">mua / bán · tiền mặt</div></div>"
        +"</div>";
    }
  }
  // Nhãn nguồn + stale (fail-open): đọc theo ok/errors của envelope.
  function staleNote(doc){
    if(!doc) return "";
    var when=doc.fetched_at_ict||doc.fetched_at||"";
    if(doc.ok===false||(Array.isArray(doc.errors)&&doc.errors.length))
      return "<div class=\"fhstale\">⚠ Bản cũ"+(when?" · "+esc(String(when).slice(0,16)):"")+" (nguồn đang lỗi) — chưa cập nhật mới</div>";
    return "<div class=\"fhnote\">Nguồn: Finhay"+(when?" · lúc "+esc(String(when).replace("T"," ").slice(0,16)):"")+"</div>";
  }
  if(!out) return "<div class=\"hint\">Chưa có dữ liệu vĩ mô từ Finhay</div>";
  return out+staleNote(macroDoc)+ (commDoc&&commDoc._fhnote===undefined?"":staleNote(commDoc));
}

// Doc báo cáo theo mã (reports/<SYM>.json: {reports:[...], symbol}) -> ô khuyến nghị.
function renderFinhayRec(doc){
  if(!doc||typeof doc!=="object") return "<div class=\"hint\" style=\"padding:8px 0\">Chưa có khuyến nghị từ Finhay cho mã này</div>";
  var rep=(doc.reports&&doc.reports[0])||(doc.data&&doc.data.recommendation)||doc.recommendation||null;
  if(!rep||!rep.recommendation_label) return "<div class=\"hint\" style=\"padding:8px 0\">Chưa có khuyến nghị từ Finhay cho mã này</div>";
  var cls=recColor(rep.recommendation_label);
  var h="<div class=\"fhrec\">";
  h+="<span class=\"fhbadge "+cls+"\">"+esc(rep.recommendation_label)+"</span>";
  if(rep.target_price!=null) h+="<span class=\"fhrow\"><span class=\"k\">Giá mục tiêu</span><span class=\"v "+(cls||"")+"\">"+num(rep.target_price,0)+" đ</span></span>";
  h+="<span class=\"fhrow\"><span class=\"k\">Nguồn</span><span class=\"v\">"+esc(rep.source||"")+"</span></span>";
  if(rep.publish_date) h+="<span class=\"fhrow\"><span class=\"k\">Ngày</span><span class=\"v\">"+esc(String(rep.publish_date).slice(0,10))+"</span></span>";
  h+="</div>";
  // fail-open: doc có errors -> vẫn hiện nhãn, không ẩn
  if(doc&&doc.ok===false) h+="<div class=\"fhstale\">⚠ Bản cũ (nguồn đang lỗi)</div>";
  return h;
}

var api_={renderFinhayMacro:renderFinhayMacro,renderFinhayRec:renderFinhayRec,
  macroCard:macroCard,recColor:recColor,num:num,trillions:trillions,
  VN_MACRO:VN_MACRO,VN_XNK_HOLD:VN_XNK_HOLD};
if(typeof module!=="undefined"&&module.exports){ module.exports=api_; }
if(typeof root==="undefined"||!root) return;

// ---------- phần DOM (chỉ chạy trên trình duyệt) ----------
if(typeof document==="undefined") return;
function $(id){ return document.getElementById(id); }
function finApi(p){
  // dùng api() toàn cục ở stocks.html nếu có; không có -> fetch trực tiếp
  if(typeof api==="function") return api(p);
  return fetch("/api/stock"+p).then(function(r){ if(!r.ok) throw new Error(String(r.status)); return r.json(); });
}
// Vĩ mô VN — Finhay: gọi 2 doc (macro + commodities) song song, fail-open từng doc.
function loadFinhay(){
  var w=$("finhayWrap"); if(!w) return Promise.resolve(false);
  var macroP=finApi("/finhay/macro/latest").catch(function(){ return null; });
  var commP=finApi("/finhay/commodities/latest").catch(function(){ return null; });
  return Promise.all([macroP,commP]).then(function(a){
    var html=api_.renderFinhayMacro(a[0],a[1]);
    if(html) w.innerHTML=html;
    return true;
  }).catch(function(){ return false; });
}
// Khuyến nghị (Finhay) cho trang chi tiết mã.
function loadFinhayRec(sym){
  var card=$("dRec"); if(!card) return Promise.resolve(false);
  if(!sym){ card.style.display="none"; return Promise.resolve(false); }
  return finApi("/finhay/reports/"+encodeURIComponent(String(sym).toUpperCase()))
    .then(function(doc){
      var html=api_.renderFinhayRec(doc);
      var sec=$("dRecSec"); if(sec) sec.style.display="";
      card.style.display=""; card.innerHTML=html;
      return true;
    })
    .catch(function(){ // fail-open: ẩn nhẹ, không làm vỡ trang chi tiết
      var sec=$("dRecSec"); if(sec) sec.style.display="none";
      card.style.display="none";
      return false;
    });
}
root.loadFinhay=loadFinhay; root.loadFinhayRec=loadFinhayRec;
})(typeof window!=="undefined"?window:undefined);
