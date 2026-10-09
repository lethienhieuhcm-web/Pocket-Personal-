// js/features/settings.js — settings panel, voice/model selection, quota display.
import { $, store, toast } from '../core/dom.js';
import { state } from '../core/state.js';
import { elFetch, loadVoices } from './tts.js';
import { setLang, applyTheme } from '../core/i18n.js';

export function needVoice(){
  if(state.ttsProvider === "browser") return true;
  if($("voiceSel").value) return true;
  toast("Pick a voice in Settings"); return false;
}
export async function updateQuota(){
  try{
    const r = await elFetch("/quota");
    const j = await r.json();
    const s = j.subscription || {};
    const left = (s.character_limit||0) - (s.character_count||0);
    $("quotaLine").innerHTML = `<b>${left.toLocaleString()}</b> credits left — plan <b>${s.tier||"?"}</b>`;
  }catch(e){ $("quotaLine").textContent = ""; }
}
// Wiring for settings surfaces (was top-level in index.html).
export function bindSettings(){
  $("settingsBtn").onclick = ()=>{
    $("settingsBox").style.display = "flex"; document.body.style.overflow = "hidden";
    document.querySelectorAll(".langBtn").forEach(b=>{
      b.classList.toggle("primary", b.dataset.lang===state.uiLang);
      b.classList.toggle("ghost", b.dataset.lang!==state.uiLang);
    });
  };
  $("reloadVoices").onclick = loadVoices;
  $("modelSel").onchange = ()=>store.set("model", $("modelSel").value);
  $("langBtn").onclick = ()=>setLang(state.uiLang==="en" ? "vi" : "en");
  $("themeBtn").onclick = ()=>{ store.set("elab_theme", document.body.classList.contains("dark")?"light":"dark"); applyTheme(); };
  $("settingsClose").onclick = ()=>{ $("settingsBox").style.display = "none"; document.body.style.overflow = ""; };
  $("settingsBox").onclick = e=>{ if(e.target===$("settingsBox")) $("settingsClose").onclick(); };
}

