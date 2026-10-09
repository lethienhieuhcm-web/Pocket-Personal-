// js/core/router.js — Simple tab router (rewrite 2026-10-08)
// Single switchTab function, no dual system, no complex logic.
import { $ } from './dom.js';

const TABS = ["scan","read","audio","books","progress","settings","profile"];

export function switchTab(name){
  if(!TABS.includes(name)) name = "scan";
  TABS.forEach(n => {
    const el = $("tab" + n.charAt(0).toUpperCase() + n.slice(1));
    if(el) el.classList.toggle("active", n === name);
    const btn = $("tabBtn" + n.charAt(0).toUpperCase() + n.slice(1));
    if(btn) btn.classList.toggle("active", n === name);
  });
  try{ window.scrollTo(0,0); }catch(e){}
  // Notify main.js to lazy-load tab content
  if(window.__elabTabHook){
    try{ window.__elabTabHook(name); }catch(e){ console.error("[router] tab hook failed:", e); }
  }
}

export function bindRouter(){
  // All bindings are done inline in index.html.
  // This is kept for compatibility; the inline script is the source of truth.
  // Expose switchTab globally for inline use.
  window._elabSwitchTab = switchTab;
}
