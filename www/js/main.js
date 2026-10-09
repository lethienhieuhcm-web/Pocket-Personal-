// js/main.js — application entry point. Wires feature hooks and runs init.
import { $, store } from './core/dom.js';
import { state } from './core/state.js';
import { apiCall } from './core/api.js';
import { applyTheme, applyUIMode } from './core/i18n.js';
import { switchTab, bindRouter } from './core/router.js';

// features
import { updateAuthUI, openAuth, bindAuth } from './features/auth.js';
import { loadVoices, initArticlePlayer, resetPlayAllBtn } from './features/tts.js';
import { bindDict } from './features/dict.js';
import { loadServerReadings, renderAudioLib, bindAudio } from './features/audio.js';
import { updateReadGo, loadScanHist, restoreLastScan, bindScan } from './features/scan.js';
import { renderReadText, bindRead, fullArticleText, speak, hideSentBar } from './features/read.js';
import { renderStats, renderBank, renderPath, bindBank } from './features/bank.js';
// bindBooks lazy-loaded with books.js (Phase 5B)
import { needVoice, bindSettings } from './features/settings.js';

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

// Wire everything (each bind* consolidates the old top-level bindings).
bindAuth(H);
bindAudio(H);
bindScan(H);
bindRead(H);
bindBank();
// bindBooks() called on first books tab visit via router
bindSettings();
bindDict();
bindRouter();

/* ---------- init (was the IIFE at the end of index.html) ---------- */
(function init(){
  // Fresh start (2026-10-05): wipe all local data from the previous test round
  if(store.get("dataV", 0) < 2){
    try{ Object.keys(localStorage).filter(k=>k.startsWith("elab_")).forEach(k=>localStorage.removeItem(k)); }catch(e){}
    store.set("dataV", 2);
  }
  const savedModel = store.get("model", "eleven_turbo_v2_5");
  $("modelSel").value = savedModel;
  loadVoices();
  updateAuthUI();
  // Restore UI mode from saved session
  if(state.authUser && state.authUser.ageGroup) state.uiMode = state.authUser.ageGroup;
  $("langBtn").textContent = state.uiLang.toUpperCase();
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
    renderStats(); renderBank(); renderPath();
    restoreLastScan(); // last scan comes back after refresh
    if(!state.authUser) setTimeout(()=>openAuth(), 800);
  })();
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  }
})();
