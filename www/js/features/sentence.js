// js/features/sentence.js — interactive sentence element (words tap -> dictionary).
import { esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { levelLabel } from '../core/i18n.js';
import { openDict, wordAudioUnlock } from './dict.js';

export function makeSentenceEl(text, cefrLv, onDelete){
  const s = text;
  const lv = cefrLv || classifyCEFR(s) || "B1";
  const div = document.createElement("div");
  div.className = "rsent";
  const body = document.createElement("div");
  body.className = "rbody";
  const btn = document.createElement("button");
  btn.className = "btn ghost rplay";
  btn.innerHTML = '<svg class="ic"><use href="#i-volume"/></svg>';
  btn.title = "Hear sentence";
  btn.onclick = e=>{ e.stopPropagation(); apStop(); safeSpeak(s); };
  body.appendChild(btn);
  const badge = document.createElement("span");
  badge.className = "cefr " + lv;
  badge.textContent = state.uiMode==="kid" ? kidLevel(lv).icon : lv;
  badge.title = levelLabel(lv);
  body.appendChild(badge);
  // Build words via innerHTML (more reliable rendering than many text nodes)
  const escS = esc(s);
  const wordsHtmlLocal = escS.replace(/([A-Za-z]+(?:&#39;[a-z]+)?)/g, '<span class="rword">$1</span>');
  const span = document.createElement("span");
  span.innerHTML = wordsHtmlLocal;
  span.querySelectorAll(".rword").forEach(w=>{
    const raw = w.textContent;
    w.onclick = e=>{ e.stopPropagation(); wordAudioUnlock(); openDict(raw, w, true); };
  });
  body.appendChild(span);
  div.appendChild(body);
  if(onDelete){
    const del = document.createElement("button");
    del.className = "btn ghost rdel";
    del.innerHTML = '<svg class="ic"><use href="#i-close"/></svg>';
    del.title = "Delete";
    del.onclick = e=>{ e.stopPropagation(); onDelete(div); };
    div.appendChild(del);
  }
  return div;
}

export function wordsHtml(s){
  const escS = esc(s);
  return escS.replace(/([A-Za-z]+(?:&#39;[a-z]+)?)/g, '<span class="rword">$1</span>');
}
export function bindWords(container, stopProp){
  container.querySelectorAll(".rword").forEach(w=>{
    const raw = w.textContent;
    w.onclick = e=>{ if(stopProp) e.stopPropagation(); wordAudioUnlock(); openDict(raw, w, true); };
  });
}
