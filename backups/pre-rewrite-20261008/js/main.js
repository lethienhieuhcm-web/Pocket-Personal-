// js/main.js — application entry point. Wires feature hooks and runs init.
import { $, store, toast } from './core/dom.js';
import { state } from './core/state.js';
import { apiCall } from './core/api.js';
import { applyTheme, applyUIMode, LANG_LABELS } from './core/i18n.js';
import { switchTab, bindRouter } from './core/router.js';

// features
import { updateAuthUI, openAuth, bindAuth } from './features/auth.js';
import { loadVoices, initArticlePlayer, resetPlayAllBtn } from './features/tts.js';
import { bindDict } from './features/dict.js';
import { loadServerReadings, renderAudioLib, bindAudio } from './features/audio.js';
import { updateReadGo, loadScanHist, restoreLastScan, bindScan } from './features/scan.js';
import { renderReadText, bindRead, fullArticleText, speak, hideSentBar } from './features/read.js';
import { bindBank, renderStats, renderBank, renderPath } from './features/bank.js';
// import { bindVocab } from './features/vocab.js'; // TEMP DISABLED

// bindBooks lazy-loaded with books.js (Phase 5B)
import { needVoice, bindSettings, setSettingsHook } from './features/settings.js';

// Shared hooks for cross-feature calls.
const H = {
  switchTab,
  loadServerReadings,
  resetPlayAllBtn,
  hideSentBar,
  updateReadGo,
  loadScanHist,
  renderStats,
  renderBank,
  renderPath,
  restoreLastScan,
  renderReadText,
  fullArticleText,
  needVoice,
  speak,
};

// Global fallback for inline onclick (if bindScan fails)
window._elabGo = function(txt){
  try{
    renderReadText(txt, {src:"text"});
    switchTab("read");
  }catch(e){ console.error("[_elabGo]", e); }
};

// Wire everything (each bind* consolidates the old top-level bindings).
// Wrapped individually so one failure doesn't block the rest.
for(const [name, fn] of [["bindAuth",bindAuth],["bindAudio",bindAudio],["bindScan",bindScan],["bindRead",bindRead]]){
  try{ fn(H); }catch(e){ console.error("[init] "+name+" failed:", e); }
}
// bindBank() now via ensureBank() on first progress visit / stats hook
// bindBooks() called on first books tab visit via router
setSettingsHook((name)=>{ try{ switchTab(name); }catch(e){ console.error("[settings] switchTab failed:", e); } });
bindSettings();
bindDict();
// bindVocab(); // TEMP DISABLED
bindRouter();

/* ---------- init (was the IIFE at the end of index.html) ---------- */
(function init(){
  // Notify user when app itself resets local data (e.g., version migration)
  if(store.get("dataV", 0) < 2){
    try{ Object.keys(localStorage).filter(k=>k.startsWith("elab_")).forEach(k=>localStorage.removeItem(k)); }catch(e){}
    store.set("dataV", 2);
    setTimeout(()=>toast("App updated: local data was reset. Log in to restore your library."), 1500);
  }
  const savedModel = store.get("model", "eleven_turbo_v2_5");
  $("modelSel").value = savedModel;
  loadVoices();
  updateAuthUI();
  // Restore UI mode from saved session
  if(state.authUser && state.authUser.ageGroup) state.uiMode = state.authUser.ageGroup;
  $("langBtn").textContent = LANG_LABELS[state.uiLang]||state.uiLang.toUpperCase();
  applyTheme(); initArticlePlayer();
  applyUIMode(H);
  // Try to restore session
  (async ()=>{
    if(state.authToken){
      try{
        const me = await apiCall("/api/auth/me");
        state.authUser = {email: me.email, role: me.role, ageGroup: me.ageGroup||"adult"};
        state.uiMode = state.authUser.ageGroup; applyUIMode(H);
        store.set("authUser", state.authUser);
        const _at = document.getElementById("menuAdminTile");
        if(_at) _at.style.display = state.authUser.role==="admin" ? "" : "none";
        updateAuthUI();
        loadServerReadings();
        // Bank stays encrypted until the user unlocks with their password —
        // the 🔒 icon + unlock card make this visible instead of looking empty
      }catch(e){
        state.authToken = null; state.authUser = null;
        store.set("authToken", null); store.set("authUser", null);
        updateAuthUI();
      }
    }
    // Bank/stats render lazily via ensureBank() on first progress visit or auth hook
    restoreLastScan(); // last scan comes back after refresh
    if(!state.authUser) setTimeout(()=>openAuth(), 800);
  })();
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("sw.js",{updateViaCache:"none"}).then(function(r){r.update();}).catch(()=>{});
  }
})();
