// js/features/settings.js — settings panel, voice/model selection, quota display.
import { $, store, toast } from '../core/dom.js';
import { state } from '../core/state.js';
import { loadVoices, updateQuota } from './tts.js';
export { updateQuota };

export function needVoice(){
  if(state.ttsProvider === "browser") return true;
  if($("voiceSel").value) return true;
  toast("Pick a voice in Settings"); return false;
}
// Wiring for settings surfaces — now a dedicated tab page.
let _settingsHook = null;
export function setSettingsHook(fn){ _settingsHook = fn; }
function goSettings(){
  if(_settingsHook) _settingsHook("settings");
  else { document.querySelectorAll(".tabpage").forEach(t=>t.classList.remove("active")); $("tabSettings").classList.add("active"); window.scrollTo(0,0); }
  document.querySelectorAll(".langBtn").forEach(b=>{
    b.classList.toggle("primary", b.dataset.lang===state.uiLang);
    b.classList.toggle("ghost", b.dataset.lang!==state.uiLang);
  });
}
async function refreshDriveStatus(){
  const st = $("driveStatus"), cn = $("driveConnect"), dc = $("driveDisconnect");
  if(!st) return;
  try{
    const headers = {};
    const tok = state.authToken || localStorage.getItem("elab_authToken");
    if(tok) headers["Authorization"] = "Bearer "+tok.replace(/^"|"$/g, "");
    const r = await fetch("/api/drive/status", {headers});
    const j = await r.json();
    if(j.connected){
      st.textContent = "Connected";
      if(cn) cn.style.display = "none";
      if(dc) dc.style.display = "";
    }else{
      st.textContent = "Not connected";
      if(cn) cn.style.display = "";
      if(dc) dc.style.display = "none";
    }
  }catch(e){ st.textContent = "Not connected"; if(cn) cn.style.display = ""; if(dc) dc.style.display = "none"; }
}
export function bindSettings(){
  // Show success message after Drive OAuth callback
  if(location.hash.includes("drive=ok")){
    setTimeout(()=>toast("Google Drive connected!"), 500);
    history.replaceState(null, "", location.pathname + "#settings");
  }
  const _sb = $("settingsBtn");
  if(_sb) _sb.onclick = goSettings;
  // Drive
  const _dc = $("driveConnect");
  if(_dc) _dc.onclick = async ()=>{
    try{
      const headers = {};
      const tok = state.authToken || localStorage.getItem("elab_authToken");
      if(tok) headers["Authorization"] = "Bearer "+tok.replace(/^"|"$/g, "");
      const r = await fetch("/api/drive/auth-url", {headers});
      const j = await r.json();
      if(j.url) window.location.href = j.url;
      else toast(j.error||"Drive not configured");
    }catch(e){ toast("Failed"); }
  };
  const _dd = $("driveDisconnect");
  if(_dd) _dd.onclick = async ()=>{
    try{
      const headers = {"Content-Type":"application/json"};
      if(state.authToken) headers["Authorization"] = "Bearer "+state.authToken;
      await fetch("/api/drive/disconnect", {method:"POST", headers});
      refreshDriveStatus();
    }catch(e){}
  };
  // Refresh drive status when settings tab opens
  setInterval(()=>{ if($("tabSettings") && $("tabSettings").classList.contains("active")) refreshDriveStatus(); }, 3000);
  $("reloadVoices").onclick = loadVoices;
  $("modelSel").onchange = ()=>store.set("model", $("modelSel").value);
  // Nút lang/theme ở shell (index.html) đã có handler duy nhất; không ghi đè ở đây
  // (bản cũ ghi đè onclick khiến một click chạy hai logic khác nhau).
}

