// js/core/router.js — tab navigation. The only core module allowed to import features.
import { $ } from './dom.js';
import { hideDictPop } from '../features/dict.js';
import { renderAdmin, renderProfile } from '../features/auth.js';
import { renderAudioLib, bindAudio } from '../features/audio.js';
// renderUpgrade moved to /upgrade page
// books.js lazy-loaded on first visit (Phase 5B)

export async function switchTab(name){
  try{ hideDictPop(); }catch(e){}
  try{ const ap=$("audioLibPlayer"); if(ap){ ap.pause(); } }catch(e){}
  ["scan","read","audio","books","progress","settings","profile","admin"].forEach(n=>{
    try{
      const el = $("tab"+n[0].toUpperCase()+n.slice(1)) || $("tab-"+n);
      if(el) el.classList.toggle("active", name===n);
      const btn = $("tabBtn"+n[0].toUpperCase()+n.slice(1)) || $("tab-btn-"+n);
      if(btn) btn.classList.toggle("active", name===n);
    }catch(e){}
  });
  if(name==="admin") renderAdmin();
  if(name==="profile") renderProfile();
  if(name==="upgrade"){ location.href = "/upgrade"; return; }
  if(name==="books"){
    const m = await import('../features/books.js');
    if(!m._bound){ m.bindBooks(); m._bound = true; }
    m.renderBookList();
  }
  if(name==="progress"){
    const m = await import('../features/bank.js');
    m.bindBank(); // idempotent
    m.renderStats(); m.renderBank(); m.renderPath();
  }
  if(name==="audio"){ try{ await renderAudioLib(); }catch(e){ console.error("[router] renderAudioLib failed:", e); } }
  window.scrollTo(0,0);
}

// Home logo + Explore menu tiles (was top-level in index.html).
export function bindRouter(){
  $("homeBtn").onclick = ()=>switchTab("scan");
  document.querySelectorAll(".menutile").forEach(b=>{ b.onclick = ()=>switchTab(b.dataset.go); });
  document.querySelectorAll("#mainTabbar button").forEach(b=>{
    b.onclick = ()=>switchTab(b.id.replace("tabBtn","").toLowerCase());
  });
}
