// js/features/vocab.js — flashcard review with spaced repetition.
import { $, esc } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { apiCall } from '../core/api.js';

let vocabQueue = [];
let vocabIdx = 0;
let vocabFlipped = false;

export function bindVocab(){
  const btn = $("vocabStart");
  if(btn) btn.onclick = startVocabReview;
}

async function startVocabReview(){
  const box = $("vocabBox");
  if(!box) return;
  box.innerHTML = `<div class="hint">...</div>`;
  try{
    const r = await apiCall("/api/vocab/due");
    vocabQueue = r.words || [];
    vocabIdx = 0;
    if(vocabQueue.length === 0){
      box.innerHTML = `<div class="hint">${esc(t("vocabEmpty"))}</div>
        <button class="btn primary" id="vocabStart2" style="width:100%;margin-top:8px">${esc(t("vocabStartBtn"))}</button>`;
      $("vocabStart2").onclick = startVocabReview;
      return;
    }
    renderVocabCard();
  }catch(e){
    box.innerHTML = `<div class="hint">Error: ${esc(e.message || "failed")}</div>`;
  }
}

function renderVocabCard(){
  const box = $("vocabBox");
  if(!box || vocabIdx >= vocabQueue.length){
    // Done
    box.innerHTML = `<div class="hint">${esc(t("vocabDone"))}</div>
      <button class="btn primary" id="vocabStart3" style="width:100%;margin-top:8px">${esc(t("vocabStartBtn"))}</button>`;
    $("vocabStart3").onclick = startVocabReview;
    return;
  }
  const w = vocabQueue[vocabIdx];
  vocabFlipped = false;
  box.innerHTML = `
    <div style="text-align:center;padding:24px 16px;background:var(--card2);border-radius:12px;margin-bottom:12px;min-height:120px;display:flex;flex-direction:column;justify-content:center">
      <img id="vocabImg" style="width:100%;max-height:240px;object-fit:cover;border-radius:12px;margin-bottom:12px;display:none">
      <div style="font-size:28px;font-weight:700;margin-bottom:8px">${esc(w.word)}</div>
      <div id="vocabMeaning" style="display:none;font-size:16px;color:var(--mut)">${esc(w.meaning || "")}</div>
      <div style="font-size:12px;color:var(--mut);margin-top:8px">${vocabIdx+1} / ${vocabQueue.length}</div>
    </div>
    <button class="btn primary" id="vocabFlip" style="width:100%">${esc(t("vocabFlip"))}</button>
    <div id="vocabRate" style="display:none;margin-top:8px">
      <div class="row" style="gap:8px">
        <button class="btn ghost" id="vocabForgot" style="flex:1">${esc(t("vocabForgot"))}</button>
        <button class="btn primary" id="vocabRemembered" style="flex:1">${esc(t("vocabRemembered"))}</button>
      </div>
    </div>`;
  const vocabImg = $("vocabImg");
  if(vocabImg){
    vocabImg.onload = ()=>{ vocabImg.style.display = "block"; };
    vocabImg.onerror = ()=>{ vocabImg.style.display = "none"; };
    vocabImg.alt = w.word;
    vocabImg.src = "/api/images/vocab/" + encodeURIComponent(w.word) + ".png";
  }
  $("vocabFlip").onclick = ()=>{
    $("vocabMeaning").style.display = "block";
    $("vocabFlip").style.display = "none";
    $("vocabRate").style.display = "block";
    vocabFlipped = true;
  };
  $("vocabForgot").onclick = ()=>submitVocabReview(false);
  $("vocabRemembered").onclick = ()=>submitVocabReview(true);
}

async function submitVocabReview(remembered){
  const w = vocabQueue[vocabIdx];
  if(!w) return;
  try{
    await apiCall("/api/vocab/review", {
      method: "POST",
      body: JSON.stringify({word: w.word, remembered})
    });
  }catch(e){ /* continue even if save fails */ }
  vocabIdx++;
  renderVocabCard();
}

// Called after dict lookup to register word for review
export async function registerVocabWord(word, meaning){
  try{
    await apiCall("/api/vocab/add", {
      method: "POST",
      body: JSON.stringify({word, meaning})
    });
  }catch(e){ /* silent */ }
}
