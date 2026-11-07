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
 * Phạm vi hiển thị:
 *   - NẾN 1D Finhay + đối chiếu giá với nến chính (TASK 06/11) — 2 route mới
 *     `GET /api/stock/finhay-ohlcv?symbol=X` (envelope giống hệt /api/stock/ohlcv
 *     interval 1D: rows[{t,o,h,l,c,v}] + unit NGHIN_VND + stale_days) và
 *     `GET /api/stock/finhay-compare?symbol=X&days=N` (so sánh primary vs finhay
 *     theo từng phiên). Route trả `empty:true` / `partial` thay vì 404/500 khi
 *     mã không có dữ liệu -> khối này TỰ ẨN, không ever làm vỡ trang chi tiết.
 *     Số `stale_days` BẮT BUỘC hiện cho người dùng thấy: lane nến Finhay ĐÓNG
 *     BĂNG từ 03/11 (chưa có writer), chỉ dùng để đối chiếu + lịch sử sâu.
 *     MIỄN PHÍ — route public, không nằm trong GATED, không premium-check.
 *   - Vĩ mô VN Chuỗi MỚI: CPI, PMI, IIP, INTERBANK_RATE, 10Y TPCP  (mục 2)
 *   - Vàng SJC + tỷ giá USD/VND  (mục 3, Finhay = đối chiếu — hệ thống đã có thẻ
 *     riêng từ nguồn NHNN/SJC; khối này là ô Finhay cạnh đó, không thay nguồn cũ)
 *   - Khuyến nghị theo mã: nhãn MUA/BÁN + giá mục tiêu + nguồn + ngày  (mục 5)
 *   KHÔNG hiển thị (ghi rõ lý do):
 *   - Nến 15 PHÚT từ Finhay: KHÔNG TỒN TẠI trong R2 (lane chỉ có resolution
 *     "1D", schema finhay.ohlcv_1d.v1) — không vẽ khung 15m bằng nến ngày.
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

// ---------- Nến 1D Finhay + đối chiếu giá (2 route mới, TASK 06/11) ----------
// Hai route trả giá theo NGHIN_VND (50.4 = 50.400 đ). Đổi ra đ đúng cách biểu
// đồ nến chính đang làm (detail.js chartSvg: fmtN(c*1000)) để hai ô cạnh nhau
// so được bằng mắt.
function fhPrice(v){ if(v==null||!isFinite(v)) return "—"; return num(v*1000,0); }
function fhDay(s){ s=String(s||"").slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(8,10)+"/"+s.slice(5,7)+"/"+s.slice(0,4) : ""; }

// Nhãn ĐÓNG BĂNG — lý do block này tồn tại: lane nến Finhay chưa có writer, dữ
// liệu dừng ở phiên 03/11. stale_days lấy THẲNG từ route (không tự tính bằng
// Date.now của máy client — múi giờ/dồng hồ lệch sẽ nhãn sai).
function fhStaleLabel(staleDays,last){
  if(staleDays==null||!isFinite(staleDays)||staleDays<1) return "";
  var d=fhDay(last);
  return "<div class=\"fhstale\">⚠ Dữ liệu Finhay đóng băng"+(d?" từ phiên "+d:"")+
    " — cũ "+Math.round(staleDays)+" ngày, chưa có writer tự động. Chỉ dùng để đối chiếu, không phải giá trực tiếp.</div>";
}

// Sọc nến thu nhỏ (mặc định 40 phiên cuối). SVG thuần string — node test được.
// Nét vẽ theo đơn vị 10/phiên, full-bleed khung chứa (preserveAspectRatio=none +
// vector-effect để râu nến không bị kéo dày); cao 132 để ĐỌC được trên điện thoại
// — bản cũ 80px nằm trong ô 55% nên không phân biệt nổi nến nào.
function fhCandles(rows,n){
  var r=rows.slice(-(n||40)); if(r.length<2) return "";
  var hi=-1e18,lo=1e18,i;
  var top=function(b){ return (b.h!=null&&isFinite(b.h))?b.h:Math.max(b.o==null?-1e18:b.o,b.c==null?-1e18:b.c); };
  var bot=function(b){ return (b.l!=null&&isFinite(b.l))?b.l:Math.min(b.o==null?1e18:b.o,b.c==null?1e18:b.c); };
  for(i=0;i<r.length;i++){ var h=top(r[i]),l=bot(r[i]); if(h>hi)hi=h; if(l<lo)lo=l; }
  if(!(isFinite(hi)&&isFinite(lo))||!(hi>lo)) return "";
  var hiRaw=hi,loRaw=lo, pad=(hi-lo)*0.06; hi+=pad; lo-=pad;
  var W=r.length*10,H=132,xw=10,Y=function(v){ return H-(v-lo)/(hi-lo)*H; };
  var s="<svg class=\"fhspark\" viewBox=\"0 0 "+W+" "+H+"\" preserveAspectRatio=\"none\" aria-hidden=\"true\">";
  r.forEach(function(b,idx){
    var o=(b.o==null?b.c:b.o), c=(b.c==null?b.o:b.c);
    if(o==null||c==null||!isFinite(o)||!isFinite(c)) return;
    var x=(idx*xw+xw/2).toFixed(1), cls=(c>=o)?"up":"down";
    s+="<line class=\"w "+cls+"\" x1=\""+x+"\" y1=\""+Y(top(b)).toFixed(1)+"\" x2=\""+x+"\" y2=\""+Y(bot(b)).toFixed(1)+"\" vector-effect=\"non-scaling-stroke\"/>";
    var yO=Y(o),yC=Y(c);
    s+="<rect class=\"b "+cls+"\" x=\""+(idx*xw+2.6).toFixed(1)+"\" y=\""+Math.min(yO,yC).toFixed(1)+
       "\" width=\""+(xw-5.2).toFixed(1)+"\" height=\""+Math.max(0.8,Math.abs(yC-yO)).toFixed(1)+"\"/>";
  });
  s+="</svg>";
  // Thang giá cho dải nến (max/min của ĐÚNG số phiên đang vẽ — không thêm số mới).
  s+="<div class=\"fhaxis\"><span>"+num(r.length,0)+" phiên gần nhất</span>"
    +"<span>cao "+fhPrice(hiRaw)+" ₫</span><span>thấp "+fhPrice(loRaw)+" ₫</span></div>";
  return s;
}

// Doc /api/stock/finhay-ohlcv -> khối "nền 1D Finhay". empty/rows=[] -> placeholder.
// Bố cục theo app Finhay: nhãn nhỏ -> GIÁ LỚN -> dòng thay đổi (màu theo hướng) ->
// phụ chú kỳ dữ liệu -> dải nến full-bleed. Không còn ô grid 2 cột bị bóp.
function renderFinhayOhlcv(doc){
  if(!doc||doc.empty||!Array.isArray(doc.rows)||!doc.rows.length)
    return "<div class=\"hint\" style=\"padding:8px 0\">Finhay chưa có nến ngày cho mã này</div>";
  var rows=doc.rows, last=rows[rows.length-1]||{}, prev=rows.length>1?rows[rows.length-2]:null;
  var c=(last.c!=null)?last.c:null, pc=(prev&&prev.c!=null)?prev.c:null;
  var diff=(c!=null&&pc!=null)?c-pc:null;
  var pct=(diff!=null&&pc)?diff/Math.abs(pc)*100:null;
  var chg="";
  if(diff!=null&&diff!==0){
    var cls=diff>0?"up":"down";
    chg="<span class=\""+cls+"\">"+(diff>0?"▲ +":"▼ −")+fhPrice(Math.abs(diff))+(pct!=null?" ("+(pct>0?"+":"")+pct.toFixed(2)+"%)":"")+"</span>";
  } else if(diff===0) chg="<span>=</span>";
  var h="<div class=\"fhq\">"
    +"<div class=\"fhk\">Đóng cửa phiên cuối · Finhay</div>"
    +"<div class=\"fhbig\"><span class=\"mv\">"+fhPrice(c)+"</span><span class=\"mu\">₫</span></div>"
    +"<div class=\"fhchg\"><span class=\"when\">phiên "+esc(fhDay(last.t)||String(last.t||""))+"</span>"+chg+"</div>"
    +"<div class=\"fhsub\">Nền 1D "+num(doc.total!=null?doc.total:rows.length,0)+" phiên · "
      +esc(fhDay(doc.first)||String(doc.first||""))+" → "+esc(fhDay(doc.last)||String(doc.last||""))+"</div>"
    +"</div>";
  h+="<div class=\"fhchart\">"+fhCandles(rows,40)+"</div>";
  return h;
}

// Doc /api/stock/finhay-compare -> khối đối chiếu giá vs nến chính.
function renderFinhayCompare(doc){
  if(!doc||typeof doc!=="object")
    return "<div class=\"hint\" style=\"padding:8px 0\">Chưa đối chiếu được với nến chính</div>";
  if(doc.partial==="no_finhay_candles")
    return "<div class=\"hint\" style=\"padding:8px 0\">Finhay chưa có nến ngày cho mã này</div>";
  if(doc.partial==="no_primary_ohlcv")
    return "<div class=\"hint\" style=\"padding:8px 0\">Nến chính chưa có dữ liệu để đối chiếu mã này</div>";
  var cmp=doc.compared||0, ok=doc.within_tol||0, bad=cmp-ok;
  var h="";
  if(!cmp){
    h+="<div class=\"fhsub\">Không có phiên trùng nhau giữa hai nguồn trong "+num(doc.days||60,0)+" phiên gần nhất.</div>";
  } else {
    h+="<div class=\"fhr\"><span class=\"fhk\">Phiên khớp nhau · Finhay vs nến chính</span>"
      +"<span class=\"fhv\"><span class=\"mv\">"+ok+"/"+cmp+"</span> <span class=\"mu\">("+(ok/cmp*100).toFixed(1)+"%)</span></span></div>"
      +"<div class=\"fhsub\">giá đóng cửa "+num(doc.days||60,0)+" phiên · lệch tối đa "+
        (doc.max_abs_diff==null?"—":fhPrice(Math.abs(doc.max_abs_diff))+" ₫")+
        " · ngưỡng "+fhPrice(doc.tick_tolerance)+" ₫ (1/2 bước nhảy)</div>";
    if(bad>0) h+="<div class=\"fhstale\">⚠ "+bad+" phiên lệch quá ngưỡng.</div>";
    else h+="<div class=\"fhnote\">✓ Hai nguồn khớp nhau trong phạm vi bước nhảy giá.</div>";
  }
  if(Array.isArray(doc.mismatches)&&doc.mismatches.length){
    h+="<div class=\"fhcmp\"><table><tr><th>Phiên</th><th>Nến chính</th><th>Finhay</th><th>Lệch</th><th>%</th></tr>";
    doc.mismatches.slice(0,20).forEach(function(m){
      var d=(m.diff==null||!isFinite(m.diff))?null:m.diff;
      h+="<tr><td>"+esc(m.t||"")+"</td><td>"+fhPrice(m.primary)+"</td><td>"+fhPrice(m.finhay)+"</td>"
        +"<td class=\""+(d==null?"":d>0?"up":d<0?"down":"")+"\">"+(d==null?"—":(d>0?"+":"−")+fhPrice(Math.abs(d)))+"</td>"
        +"<td>"+(m.diff_pct==null||!isFinite(m.diff_pct)?"—":(m.diff_pct>0?"+":"")+Number(m.diff_pct).toFixed(2)+"%")+"</td></tr>";
    });
    h+="</table></div>";
  }
  if(doc.missing_in_finhay) h+="<div class=\"fhsub\">+ "+num(doc.missing_in_finhay,0)+" phiên nến chính có mà Finhay chưa có (lane đóng băng).</div>";
  return h;
}

// MỘT dòng ghi chú duy nhất cho CẢ section (TASK 06/11, lỗi "cảnh báo lặp 2 lần").
// Ưu tiên stale_days từ doc nến; nếu khối nến ẩn thì lấy từ doc đối chiếu (finhay.*).
function fhSectionNote(ohlcvDoc,cmpDoc){
  var st=null;
  if(ohlcvDoc&&ohlcvDoc.stale_days!=null&&isFinite(ohlcvDoc.stale_days)) st={d:ohlcvDoc.stale_days,l:ohlcvDoc.last};
  else if(cmpDoc&&cmpDoc.finhay&&cmpDoc.finhay.stale_days!=null&&isFinite(cmpDoc.finhay.stale_days))
    st={d:cmpDoc.finhay.stale_days,l:cmpDoc.finhay.last};
  if(st){
    var lbl=fhStaleLabel(st.d,st.l);
    if(lbl) return lbl;
  }
  if(ohlcvDoc&&!ohlcvDoc.stale_days) return "<div class=\"fhnote\">Nguồn: Finhay · nến ngày, độ sâu ~5 năm (sâu hơn nến chính)</div>";
  return "";
}

var api_={renderFinhayMacro:renderFinhayMacro,renderFinhayRec:renderFinhayRec,
  macroCard:macroCard,recColor:recColor,num:num,trillions:trillions,
  VN_MACRO:VN_MACRO,VN_XNK_HOLD:VN_XNK_HOLD,
  renderFinhayOhlcv:renderFinhayOhlcv,renderFinhayCompare:renderFinhayCompare,
  fhPrice:fhPrice,fhDay:fhDay,fhStaleLabel:fhStaleLabel,fhCandles:fhCandles,
  fhSectionNote:fhSectionNote};
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
// ---------- Nền 1D + đối chiếu giá: 2 route MỚI (TASK 06/11) ----------
// Fail-open tuyệt đối: mã không có nến (index, mã ngoài 1517 mã), route trả
// empty/partial, hay mạng lỗi -> xoá nội dung + ẨN cả khối. Không throw ra
// ngoài, nên trang chi tiết mã vẫn chạy y như trước khi có khối này.
var FH_COUNT=250, FH_DAYS=60;
var _fhParts={o:false,c:false};
var _fhDocs={o:null,c:null};   // bản doc gần nhất của 2 khối -> 1 dòng ghi chú chung
function fhSym(sym){ return encodeURIComponent(String(sym||"").toUpperCase()); }
function fhSync(){
  var any=_fhParts.o||_fhParts.c, c=$("dFinhay"), s=$("dFinhaySec");
  if(c) c.style.display=any?"":"none";
  if(s) s.style.display=any?"":"none";
  var n=$("dFinhayNote");
  if(n) n.innerHTML=any?api_.fhSectionNote(_fhDocs.o,_fhDocs.c):"";
}
function fhHide(key,flag){
  _fhParts[flag]=false; _fhDocs[flag]=null;
  var e=$(key); if(e) e.innerHTML=""; fhSync(); return false;
}
// GET /api/stock/finhay-ohlcv?symbol=X&count=250 — đếm rows, có mới vẽ.
function loadFinhayOhlcv(sym){
  var el=$("dFinhayOhlcv"); if(!el) return Promise.resolve(false);
  if(!sym||!sym.trim()) return Promise.resolve(fhHide("dFinhayOhlcv","o"));
  _fhParts.o=false; _fhDocs.o=null;
  return finApi("/finhay-ohlcv?symbol="+fhSym(sym)+"&count="+FH_COUNT).then(function(doc){
    var rows=(doc&&Array.isArray(doc.rows))?doc.rows:[];
    if(!rows.length) return fhHide("dFinhayOhlcv","o");
    el.innerHTML=api_.renderFinhayOhlcv(doc); _fhDocs.o=doc; _fhParts.o=true; fhSync(); return true;
  }).catch(function(){ return fhHide("dFinhayOhlcv","o"); });
}
// GET /api/stock/finhay-compare?symbol=X&days=60 — partial (thiếu một nguồn) -> ẩn.
function loadFinhayCompare(sym){
  var el=$("dFinhayCmp"); if(!el) return Promise.resolve(false);
  if(!sym||!sym.trim()) return Promise.resolve(fhHide("dFinhayCmp","c"));
  _fhParts.c=false; _fhDocs.c=null;
  return finApi("/finhay-compare?symbol="+fhSym(sym)+"&days="+FH_DAYS).then(function(doc){
    if(!doc||doc.partial) return fhHide("dFinhayCmp","c");
    el.innerHTML=api_.renderFinhayCompare(doc); _fhDocs.c=doc; _fhParts.c=true; fhSync(); return true;
  }).catch(function(){ return fhHide("dFinhayCmp","c"); });
}
// Điểm vào duy nhất từ detail.js (gọi song song, mỗi bên tự fail-open).
function loadFinhayCross(sym){
  _fhParts.o=false; _fhParts.c=false; _fhDocs.o=null; _fhDocs.c=null;
  return Promise.all([loadFinhayOhlcv(sym),loadFinhayCompare(sym)])
    .then(function(a){ return !!(a[0]||a[1]); })
    .catch(function(){ return false; });
}
root.loadFinhay=loadFinhay; root.loadFinhayRec=loadFinhayRec;
root.loadFinhayOhlcv=loadFinhayOhlcv; root.loadFinhayCompare=loadFinhayCompare;
root.loadFinhayCross=loadFinhayCross;
root.__fhTest=api_;
})(typeof window!=="undefined"?window:undefined);
