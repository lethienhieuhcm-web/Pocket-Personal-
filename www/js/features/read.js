// js/features/read.js — article rendering, sentence interaction, scan history.
import { $, esc, toast, store } from '../core/dom.js';
import { state } from '../core/state.js';
import { splitSents, classifyCEFR } from '../core/utils.js';
import { t, levelLabel, kidLevel } from '../core/i18n.js';
import { getElURL, playURL, speakBrowser, resetPlayAllBtn } from './tts.js';
import { openDict, wordAudioUnlock } from './dict.js';
import { makeSentenceEl, wordsHtml, bindWords } from './sentence.js';
import { pushScanHist } from './scan.js';
import { saveReadingToServer } from './audio.js';
import { addToBank } from './bank.js';
import { trackScan } from './analytics.js';
import { hideDictPop } from './dict.js';
import { apStop } from './tts.js';
import { safeSpeak } from './audio.js';

let H = {};
export function setReadHooks(h){ H = Object.assign(H, h); }
function hook(name, ...args){ const f = H[name]; if(typeof f === "function") return f(...args); }

export async function speak(text, {slow=false}={}){
  if(state.ttsProvider==="browser") return speakBrowser(text, {slow});
  const my = ++state.speechToken;
  const chunks = chunkText(text);
  for(const ch of chunks){
    if(my !== state.speechToken) break;
    const url = await getElURL(ch);
    if(my !== state.speechToken) break;
    await playURL(url, slow ? 0.7 : 1);
  }
  if(my === state.speechToken) state.speechToken++;
}

/* ---------- whole-article audio player ---------- */
export function fullArticleText(){ return state.readData.map(s=>s.text).join(" "); }

/* ---------- scan history: survive page refresh ---------- */
export function splitTitle(text){
  const lines = String(text).split(/\n+/).map(s=>s.trim()).filter(Boolean);
  if(lines.length > 1 && lines[0].length <= 60 && !/[.?!\u2026:;]$/.test(lines[0]) && lines[0].split(/\s+/).length <= 10){
    return {title: lines[0], body: lines.slice(1).join("\n")};
  }
  const words = String(text).trim().split(/\s+/);
  return {title: words.slice(0,8).join(" ") + (words.length > 8 ? "\u2026" : ""), body: String(text)};
}
export function renderReadText(text, opts){
  opts = opts || {};
  const st = splitTitle(text);
  state.readTitle = st.title;
  const sents = splitSents(st.body);
  state.readData = sents.map(s=>({text:s, cefr:classifyCEFR(s)||"B1"}));
  state.selSentIdx = -1; hideSentBar();
  resetPlayAllBtn();
  state.curServerReadingId = opts.serverId || null;
  renderReadView();
  $("readResultCard").style.display = "block";
  pushScanHist(text, opts);
  if(opts.skipBank) return; // restored from history — bank/analytics already counted
  // Save the article to the server library (logged-in users)
  saveReadingToServer(text, sents);
  // Auto-save to bank: app learns your level from what you read
  const added = addToBank(sents);
  if(added) toast(`Saved ${added} sentence${added>1?"s":""} to your bank 📚`);
  // Anonymous corpus for app improvement (opt-in)
  trackScan(sents);
}
export function renderReadView(){
  if(state.readView==="article") renderArticleView(); else renderCardsView();
  $("readArticle").classList.toggle("on", state.readView==="article");
  $("readSents").classList.toggle("on", state.readView==="cards");
  $("viewArticle").classList.toggle("active", state.readView==="article");
  $("viewCards").classList.toggle("active", state.readView==="cards");
}
export function renderArticleView(){
  const box = $("readArticle");
  box.innerHTML = "";
  if(!state.readData.length){ box.innerHTML = '<div class="hint">No clear sentences found.</div>'; return; }
  // Book-page header: date + sentence/word count
  const meta = state.scanHistory.find(x=>x.id===state.curScanId);
  const when = meta && meta.ts ? new Date(meta.ts) : new Date();
  const words = state.readData.reduce((n,d)=>n+String(d.text).split(/\s+/).filter(Boolean).length, 0);
  const head = document.createElement("div");
  head.className = "bookhead";
  head.innerHTML = `<div class="btitle"><button class="bplay" id="artTitlePlay" title="${t("listen")}"><svg viewBox="0 0 24 24" width="20" height="20" fill="#fff"><path d="M8 5.5v13l11-6.5z"/></svg></button>${esc(state.readTitle || t("readingRoom"))}</div><div class="bsub">${esc(when.toLocaleDateString())} · ${state.readData.length} ${t("sentencesU")} · ${words} ${t("wordsU")}</div>`;
  box.appendChild(head);
  const tp = $("artTitlePlay");
  if(tp) tp.onclick = e=>{ e.stopPropagation(); openArticlePlayer(); };
  // Group into paragraphs (~4 sentences each) like book paragraphs
  let para = null, count = 0;
  state.readData.forEach((d, idx)=>{
    if(count % 4 === 0){
      para = document.createElement("p");
      para.className = "apara";
      box.appendChild(para);
    }
    count++;
    const sp = document.createElement("span");
    sp.className = "asent";
    sp.dataset.idx = idx;
    sp.innerHTML = wordsHtml(d.text);
    bindWords(sp, true);
    sp.onclick = ()=>selectArticleSent(idx);
    para.appendChild(sp);
    para.appendChild(document.createTextNode(" "));
  });
}
export function renderCardsView(){
  const box = $("readSents");
  box.innerHTML = "";
  if(!state.readData.length){ box.innerHTML = '<div class="hint">No clear sentences found.</div>'; return; }
  state.readData.forEach((d, idx)=>{
    box.appendChild(makeSentenceEl(d.text, d.cefr, (div)=>{
      div.remove();
      state.readData.splice(idx, 1);
      if(!state.readData.length){ $("readResultCard").style.display = "none"; }
    }));
  });
}
export function hideSentBar(){
  $("sentBar").classList.remove("show");
  document.querySelectorAll(".asent.sel").forEach(x=>x.classList.remove("sel"));
  state.selSentIdx = -1;
}

// Wiring for read-view surfaces (was top-level in index.html).
export function bindRead(hooks={}){
  setReadHooks(hooks);
  $("sentBarPlay").onclick = ()=>{ if(state.selSentIdx>=0){ apStop(); safeSpeak(state.readData[state.selSentIdx].text); } };
  $("sentBarClose").onclick = hideSentBar;
  $("viewArticle").onclick = ()=>{ state.readView="article"; hideSentBar(); hideDictPop(); renderReadView(); };
  $("viewCards").onclick = ()=>{ state.readView="cards"; hideSentBar(); hideDictPop(); renderReadView(); };
  $("readClear").onclick = ()=>{
    if(!confirm(t("clearScanQ"))) return;
    hideDictPop();
    if(state.curScanId != null) removeScanFromHist(state.curScanId);
    state.readData = []; state.selSentIdx = -1; state.curScanId = null; hideSentBar();
    $("readSents").innerHTML = "";
    $("readArticle").innerHTML = "";
    $("readTextInput").value = "";
    $("readResultCard").style.display = "none";
    $("readPreview").style.display = "none";
    state.readCanvas = null;
    hook("updateReadGo");
  };
}

export function selectArticleSent(idx){
  document.querySelectorAll(".asent.sel").forEach(x=>x.classList.remove("sel"));
  state.selSentIdx = idx;
  const sp = document.querySelector(`.asent[data-idx="${idx}"]`);
  if(!sp) return;
  sp.classList.add("sel");
  const d = state.readData[idx];
  $("sentBarLevel").innerHTML = `<span class="cefr ${d.cefr}">${state.uiMode==="kid"?kidLevel(d.cefr).icon:d.cefr}</span>`;
  $("sentBarText").textContent = d.text.length>60 ? d.text.slice(0,60)+"…" : d.text;
  $("sentBar").classList.add("show");
}
