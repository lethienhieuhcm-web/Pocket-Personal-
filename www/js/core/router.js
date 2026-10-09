// js/core/router.js — tab navigation. The only core module allowed to import features.
import { $ } from './dom.js';
import { hideDictPop } from '../features/dict.js';
import { renderAdmin } from '../features/auth.js';
// books.js lazy-loaded on first visit (Phase 5B)
import { renderAudioLib } from '../features/audio.js';

export async function switchTab(name){
  hideDictPop();
  try{ const ap=$("audioLibPlayer"); if(ap){ ap.pause(); } }catch(e){}
  ["scan","read","audio","books","progress","admin"].forEach(n=>{
    $("tab"+n[0].toUpperCase()+n.slice(1)).classList.toggle("active", name===n);
    const btn = $("tabBtn"+n[0].toUpperCase()+n.slice(1));
    if(btn) btn.classList.toggle("active", name===n);
  });
  if(name==="admin") renderAdmin();
  if(name==="books"){
    const m = await import('../features/books.js');
    if(!m._bound){ m.bindBooks(); m._bound = true; }
    m.renderBookList();
  }
  if(name==="audio") renderAudioLib();
  window.scrollTo(0,0);
}

// Home logo + Explore menu tiles (was top-level in index.html).
export function bindRouter(){
  $("homeBtn").onclick = ()=>switchTab("scan");
  document.querySelectorAll(".menutile").forEach(b=>{ b.onclick = ()=>switchTab(b.dataset.go); });
}
