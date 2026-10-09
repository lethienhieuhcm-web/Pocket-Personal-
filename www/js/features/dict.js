// js/features/dict.js — multi-source dictionary popup with MW audio.
import { $, esc, store, toast } from '../core/dom.js';
import { state } from '../core/state.js';
import { t } from '../core/i18n.js';
import { speakWordBrowser } from './tts.js';
import { trackLookup } from './analytics.js';

// Restore persisted dictionary cache (was top-level init in index.html).
try{ (store.get("dict", [])||[]).forEach(([w,v])=>state.dictCache.set(w,v)); }catch(e){}

export function saveDictCache(){
  const arr = [...dictCache.entries()].slice(-300);
  state.dictCache = new Map(arr);
  try{ store.set("dict", arr); }catch(e){}
}
/* Translate: try our worker proxy first (same-origin), fall back to direct Google.
   Both are best-effort — the popup works with or without Vietnamese glosses. */
export async function translateText(text, target){
  target = target || "vi";
  text = String(text).slice(0, 500);
  if(!text.trim()) return "";
  try{
    const ctl = new AbortController(); const timer = setTimeout(()=>ctl.abort(), 3500);
    const r = await fetch("/api/translate", {method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({text, target}), signal: ctl.signal});
    clearTimeout(timer);
    if(r.ok){ const j = await r.json(); const t = (j.text||"").trim(); if(t) return t; }
  }catch(e){}
  try{
    const ctl = new AbortController(); const timer = setTimeout(()=>ctl.abort(), 5000);
    const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl="+encodeURIComponent(target)+"&dt=t&q="+encodeURIComponent(text), {signal: ctl.signal});
    clearTimeout(timer);
    const j = await r.json();
    return (j[0] && j[0][0] && j[0][0][0] || "").trim();
  }catch(e){ return ""; }
}
export async function fetchDict(word){
  const w = word.trim().toLowerCase();
  if(!w) return null;
  if(state.dictCache.has(w)) return state.dictCache.get(w);
  // EN via worker (18s timeout, own controller)
  const enCtl = new AbortController();
  const enTimer = setTimeout(()=>enCtl.abort(), 18000);
  // VI via worker translate proxy: best-effort, NEVER blocks EN
  const viP = translateText(w).catch(()=>null);
  try{
    const r = await fetch("/api/dict?word="+encodeURIComponent(w), {signal: enCtl.signal});
    if(r.status===404){ const miss={miss:true}; state.dictCache.set(w,miss); saveDictCache(); return miss; }
    if(!r.ok){ const err = new Error("HTTP "+r.status); err.httpStatus = r.status; throw err; }
    const out = await r.json();
    // VI translation (best-effort, don't wait long)
    try{
      const t = await Promise.race([viP, new Promise(res=>setTimeout(()=>res(null), 2000))]);
      if(t && t.toLowerCase() !== w) out.vi = t;
    }catch(e){}
    state.dictCache.set(w, out); saveDictCache();
    return out;
  }finally{ clearTimeout(enTimer); }
}
/* ---------- dictionary popup near the tapped word ---------- */
const SRC_NAMES = {"merriam-webster":"Merriam-Webster","mw-thesaurus":"MW Thesaurus","wiktapi":"WiktAPI","wiktionary":"Wiktionary","wordsapi":"WordsAPI"};

let _wUnlocked = false;
export function wordAudioUnlock(){
  // play silent clip inside the tap gesture so later auto-play isn't blocked
  if(_wUnlocked) return; _wUnlocked = true;
  try{ const a = new Audio(typeof SILENT_WAV!=="undefined"?SILENT_WAV:""); const pr=a.play(); if(pr&&pr.catch) pr.catch(()=>{}); }catch(e){}
}
export async function openDict(word, anchor, autoSpeak){
  const w = (word||"").trim().toLowerCase(); if(!w) return;
  trackLookup(w);
  const pop = $("dictBox"), body = $("dictBoxBody");
  state.dictBoxAnchor = (anchor && anchor.getBoundingClientRect) ? anchor : null;
  body.innerHTML = `<div class="dbox-head"><div style="flex:1;min-width:0"><div class="dword">${esc(w)}</div><div class="dphon">Looking up…</div></div><button class="diconbtn" id="dboxClose" title="Close"><svg class="ic"><use href="#i-close"/></svg></button></div><div class="dloading"><svg class="ic"><use href="#i-book"/></svg> …</div>`;
  pop.classList.add("show");
  state.dictBoxOpenedAt = Date.now();
  placeDictPop(state.dictBoxAnchor);
  $("dboxClose").onclick = hideDictPop;
  try{
    const entry = await fetchDict(w);
    renderDictPop(w, entry);
    if(autoSpeak && entry && !entry.miss){
      if(entry.audio){ new Audio(entry.audio).play().catch(()=>speakWordBrowser(w)); }
      else speakWordBrowser(w);
    }
    placeDictPop(state.dictBoxAnchor);
  }catch(e){
    const msg = (e && e.name==="AbortError") ? "Lookup timed out — check your connection."
      : (e && e.httpStatus===429) ? "Too many lookups — wait a few seconds, then retry."
      : "Network error — check your connection.";
    body.innerHTML = `<div class="dbox-head"><div style="flex:1;min-width:0"><div class="dword">${esc(w)}</div></div><button class="diconbtn" id="dboxClose" title="Close"><svg class="ic"><use href="#i-close"/></svg></button></div><div class="dbox-sec"><div class="hint">${msg}</div><button class="btn primary" id="dboxRetry" style="width:100%;margin-top:10px"><svg class="ic"><use href="#i-refresh"/></svg> <span id="dboxRetryLbl">Retry</span></button></div>`;
    $("dboxClose").onclick = hideDictPop;
    $("dboxRetry").onclick = ()=>openDict(w, state.dictBoxAnchor);
    placeDictPop(state.dictBoxAnchor);
  }
}
export function hideDictPop(){ $("dictBox").classList.remove("show"); state.dictBoxAnchor = null; }
export function placeDictPop(anchor){
  const pop = $("dictBox");
  const pw = Math.min(400, Math.floor(window.innerWidth*0.94));
  pop.style.width = pw+"px";
  let x, y;
  if(anchor){
    const r = anchor.getBoundingClientRect();
    x = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left + r.width/2 - pw/2));
    pop.style.left = x+"px";
    const ph = pop.offsetHeight || 220;
    y = r.bottom + 10;
    if(y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 10);
  }else{
    x = Math.max(8, (window.innerWidth - pw)/2);
    pop.style.left = x+"px";
    const ph = pop.offsetHeight || 220;
    y = Math.max(8, (window.innerHeight - ph)/2 - 30);
  }
  pop.style.top = y+"px";
}
// tap outside closes (small delay so the opening tap doesn't instantly close it)
export async function translateExamples(){
  const spans = [...document.querySelectorAll("#dictBoxBody span[data-exvi]")].slice(0,3);
  await Promise.all(spans.map(async sp=>{
    const t = await translateText(sp.dataset.exvi);
    if(t && document.body.contains(sp)) sp.textContent = t;
  }));
}

// Popup dismiss wiring (was top-level in index.html).
export function bindDict(){
  document.addEventListener("click", e=>{
    const pop = $("dictBox");
    if(!pop.classList.contains("show")) return;
    if(Date.now() - state.dictBoxOpenedAt < 350) return;
    if(pop.contains(e.target)) return;
    if(state.dictBoxAnchor && state.dictBoxAnchor.contains(e.target)) return;
    hideDictPop();
  });
  window.addEventListener("scroll", (e)=>{ const pop=$("dictBox"); if(pop.classList.contains("show") && !pop.contains(e.target)) hideDictPop(); }, {passive:true, capture:true});
  window.addEventListener("resize", ()=>{ if($("dictBox").classList.contains("show")) placeDictPop(state.dictBoxAnchor); });
}

export function renderDictPop(w, entry){
  const body = $("dictBoxBody");
  if(!entry || entry.miss){
    body.innerHTML = `<div class="dbox-head"><div style="flex:1;min-width:0"><div class="dword">${esc(w)}</div></div><button class="diconbtn" id="dboxClose"><svg class="ic"><use href="#i-close"/></svg></button></div><div class="dbox-sec"><div class="hint">No definition found for this word.</div></div>`;
    $("dboxClose").onclick = hideDictPop;
    return;
  }
  const firstPos = entry.meanings[0] && entry.meanings[0].pos;
  let h = `<div class="dbox-head"><div style="flex:1;min-width:0"><div class="dword">${esc(w)}</div><div class="dphon">${entry.phonetic?esc(entry.phonetic)+" · ":""}${firstPos?esc(firstPos):""}</div></div><button class="diconbtn" id="dboxPlay" title="Pronounce"><svg class="ic"><use href="#i-volume"/></svg></button><button class="diconbtn" id="dboxClose" title="Close"><svg class="ic"><use href="#i-close"/></svg></button></div>`;
  h += `<div class="dbox-sec">`;
  // Vietnamese meanings first — most useful for learners
  const viList = [];
  (entry.viMeanings||[]).forEach(m=>{ if(m.d && !viList.includes(m.d)) viList.push(m.d); });
  if(entry.vi && !viList.includes(entry.vi)) viList.unshift(entry.vi);
  if(viList.length) h += `<div class="dvi">${viList.slice(0,4).map(v=>`<span class="vimean">🇻🇳 ${esc(v)}</span>`).join("")}</div>`;
  // Meanings grouped by part of speech, merged from all dictionaries
  entry.meanings.slice(0,4).forEach(m=>{
    if(m.pos) h += `<div class="dpos">${esc(m.pos)}</div>`;
    (m.defs||[]).slice(0,4).forEach((d,i)=>{
      h += `<div class="ddef"><span class="n">${i+1}.</span>${esc(d.d)}</div>`;
      const exs = (d.exs && d.exs.length ? d.exs : (d.ex ? [{t:d.ex}] : [])).slice(0,2);
      exs.forEach(ex=>{
        if(ex.t) h += `<div class="dex">“${esc(ex.t)}”<span class="dexvi" data-exvi="${esc(ex.t)}"></span></div>`;
      });
    });
  });
  // Synonyms / antonyms as tappable chips
  const syns = [], ants = [];
  (entry.thesaurus||[]).forEach(t=>{
    (t.syn||[]).forEach(s=>{ if(s && !syns.includes(s)) syns.push(s); });
    (t.ant||[]).forEach(s=>{ if(s && !ants.includes(s)) ants.push(s); });
  });
  (entry.meanings||[]).forEach(m=>{ (m.syn||[]).forEach(s=>{ if(s && !syns.includes(s)) syns.push(s); }); });
  if(syns.length) h += `<div class="synrow"><span class="synlbl">≈ Synonyms</span><br>${syns.slice(0,10).map(s=>`<button class="synchip" data-w="${esc(s)}">${esc(s)}</button>`).join("")}</div>`;
  if(ants.length) h += `<div class="synrow"><span class="synlbl">≠ Antonyms</span><br>${ants.slice(0,10).map(s=>`<button class="synchip" data-w="${esc(s)}">${esc(s)}</button>`).join("")}</div>`;
  h += `</div>`;
  if(entry.sources && entry.sources.length)
    h += `<div class="dfoot"><svg class="ic"><use href="#i-book"/></svg> ${entry.sources.map(s=>esc(SRC_NAMES[s]||s)).join(" · ")}</div>`;
  body.innerHTML = h;
  $("dboxClose").onclick = hideDictPop;
  $("dboxPlay").onclick = ()=>{
    if(entry.audio){ new Audio(entry.audio).play().catch(()=>speakWordBrowser(w)); }
    else speakWordBrowser(w);
  };
  body.querySelectorAll(".synchip").forEach(c=>{
    c.onclick = e=>{ e.stopPropagation(); openDict(c.dataset.w, null); };
  });
  translateExamples();
}
