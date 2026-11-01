/* js/stocks/alerts.js — P5 module 7: khoi Canh bao (v-alert) tach tu stocks.html, giu nguyen hanh vi. Classic script, nap lazy khi mo tab. */
// __AL_BEGIN__
try{
(function(){
const AL_TYPE_LBL={ff_buy:"NN mua ròng >",ff_sell:"NN bán ròng >",pf_buy:"Tự doanh mua ròng >",pf_sell:"Tự doanh bán ròng >",signal:"Tín hiệu mới",price:"Giá chạm"};
async function loadAlerts(){
  try{
    const rules=await api("/rule-alerts");
    if(!Array.isArray(rules)||!rules.length){$("alertCards").innerHTML='<div class="hint">'+T("Chưa có cảnh báo — thêm mới ở dưới.")+'</div>';return;}
    $("alertCards").innerHTML=rules.map(r=>`<div class="card" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div><b>${esc(r.symbol)}</b> <span style="color:var(--pp-mut);font-size:12px">${esc(AL_TYPE_LBL[r.type]||r.type)} ${r.type==="signal"?"":fmtN(r.threshold)+(r.type==="price"?" đ":" tỷ")}</span></div><button onclick="delRuleAlert(${r.id})" style="background:none;border:none;color:var(--pp-danger);font-size:16px;cursor:pointer;padding:4px 8px">✕</button></div>`).join("");
  }catch(e){$("alertCards").innerHTML='<div class="hint">Lỗi tải cảnh báo</div>';}
}
async function delRuleAlert(id){
  try{await apip("/rule-alerts/"+id,"DELETE");loadAlerts();}catch(e){alert("Lỗi xoá: "+e.message);}
}
window.delRuleAlert=delRuleAlert;
$("alAdd").onclick=async()=>{
  const sym=$("alSym").value.trim().toUpperCase(), type=$("alType").value, thr=parseFloat($("alVal").value);
  if(!/^[A-Z]{3,10}$/.test(sym)){alert("Mã không hợp lệ (3-10 ký tự chữ)");return;}
  if(type!=="signal"&&!(thr>0)){alert("Ngưỡng phải > 0");return;}
  try{
    await apip("/rule-alerts","POST",{symbol:sym,type,threshold:type==="signal"?1:thr});
    $("alSym").value="";$("alVal").value="";loadAlerts();
  }catch(e){alert("Lỗi thêm cảnh báo: "+e.message);}
};
  if(typeof window!=="undefined"){ window.loadAlerts=loadAlerts; window.delRuleAlert=delRuleAlert;
    window.__alTest={load:loadAlerts,del:delRuleAlert}; }
})();
}catch(e){}
// __AL_END__
