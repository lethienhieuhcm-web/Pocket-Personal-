// js/features/read.js — article rendering, sentence interaction, scan history.
import { $, esc, toast, store, inlineConfirm } from '../core/dom.js';
import { state } from '../core/state.js';
import { splitSents, classifyCEFR , chunkText} from '../core/utils.js';
import { t, levelLabel, kidLevelName } from '../core/i18n.js';
import { getElURL, playURL, speakBrowser, resetPlayAllBtn } from './tts.js';
import { openDict, wordAudioUnlock, fetchDict } from './dict.js';
import { makeSentenceEl, wordsHtml, bindWords } from './sentence.js';
import { pushScanHist , removeScanFromHist} from './scan.js';
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
  // Reset article vocabulary
  try{ state.articleVocab = new Map(); }catch(e){}
  const st = splitTitle(text);
  state.readTitle = st.title;
  const sents = splitSents(st.body);
  state.readData = sents.map(s=>({text:s, cefr:classifyCEFR(s)||"B1"}));
  state.selSentIdx = -1; hideSentBar();
  resetPlayAllBtn();
  state.curServerReadingId = opts.serverId || null;
  renderReadView();
  $("readResultCard").style.display = "block";
  const _es = $("readEmptyState"); if(_es) _es.style.display = "none";
  // Auto-extract vocabulary (async, non-blocking)
  try{ autoExtractVocab(); }catch(e){}
  if(opts.skipBank) return; // restored from history — don't re-add to history
  pushScanHist(text, opts);
  // Save the article to the server library (logged-in users)
  saveReadingToServer(text, sents);
  // Auto-save to bank: app learns your level from what you read
  const added = addToBank(sents);
  if(added) toast(`Saved ${added} sentence${added>1?"s":""} to your bank`);
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
  head.innerHTML = `<div class="btitle">${esc(state.readTitle || t("readingRoom"))}</div><div class="bsub">${esc(when.toLocaleDateString())} · ${state.readData.length} ${t("sentencesU")} · ${words} ${t("wordsU")}</div>`;
  box.appendChild(head);
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
// Common words to exclude from auto vocab
const STOP_WORDS = new Set(("a,an,the,and,or,but,if,then,else,when,while,of,at,by,for,with,about,into,through,during,before,after,above,below,to,from,up,down,in,out,on,off,over,under,again,further,once,here,there,when,where,why,how,all,any,both,each,few,more,most,other,some,such,no,nor,not,only,own,same,so,than,too,very,can,will,just,don,should,now,is,are,was,were,be,been,being,have,has,had,having,do,does,did,doing,would,could,ought,i,you,he,she,it,we,they,me,him,her,us,them,my,your,his,its,our,their,this,that,these,those,as,also,may,might,must,shall,may,one,two,three,first,second,new,good,bad,big,small,large,long,short,high,low,old,young,own,last,next,many,much,like,get,got,make,made,take,took,come,came,go,went,know,knew,see,saw,say,said,think,thought,look,looked,want,wanted,use,used,find,found,give,gave,tell,told,work,worked,call,called,try,tried,ask,asked,need,needed,feel,felt,become,became,leave,left,put,mean,meant,keep,kept,let,begin,began,seem,seemed,help,helped,show,showed,hear,heard,play,played,run,ran,move,moved,live,lived,believe,believed,hold,held,bring,brought,happen,happened,write,wrote,provide,provided,sit,sat,stand,stood,lose,lost,pay,paid,meet,met,include,included,continue,continued,set,sit,learn,learned,change,changed,lead,led,understand,understood,watch,watched,follow,followed,stop,stopped,create,created,speak,spoke,read,allow,allowed,add,added,spend,spent,grow,grew,open,opened,walk,walked,win,won,offer,offered,remember,remembered,love,loved,consider,considered,appear,appeared,buy,bought,wait,waited,serve,served,die,died,send,sent,expect,expected,build,built,stay,stayed,fall,fell,cut,cut,reach,reached,kill,killed,remain,remained,suggest,suggested,raise,raised,pass,passed,sell,sold,require,required,report,reported,decide,decided,pull,pulled").split(","));

export async function autoExtractVocab(){
  const runId = (state.vocabRunId = (state.vocabRunId||0) + 1);
  try{
    if(!state.articleVocab) state.articleVocab = new Map();
    // Extract candidate words from article
    const text = state.readData.map(s=>s.text).join(" ").toLowerCase();
    const words = text.match(/[a-z]{4,}/g) || [];
    const freq = {};
    words.forEach(w=>{
      if(w.length < 5 || STOP_WORDS.has(w)) return;
      if(state.articleVocab.has(w)) return; // already tracked (user lookup or prior extract)
      try{ if(state.dictCache.has(w) && !state.dictCache.get(w).miss) return; }catch(e){} // already known
      freq[w] = (freq[w]||0) + 1;
    });
    const scored = Object.entries(freq)
      .map(([w,c])=>({w, score: w.length*2 - Math.min(c,5)}))
      .sort((a,b)=>b.score - a.score)
      .slice(0, 8)
      .map(x=>x.w);
    if(scored.length === 0){ try{ renderArticleVocab(); }catch(e){} return; }
    // Add as placeholders, render immediately
    scored.forEach(w=>{ if(!state.articleVocab.has(w)) state.articleVocab.set(w, null); });
    try{ renderArticleVocab(); }catch(e){}
    // Fill definitions in parallel batches (fetchDict updates articleVocab + re-renders)
    const fillOne = async (w)=>{
      if(runId !== state.vocabRunId) return;
      try{ await fetchDict(w); }catch(e){}
    };
    for(let i=0; i<scored.length; i+=3){
      if(runId !== state.vocabRunId) return;
      await Promise.all(scored.slice(i, i+3).map(fillOne));
    }
  }catch(e){}
}export function bindRead(hooks={}){
  setReadHooks(hooks);
  const _bb = $("readBackBtn");
  if(_bb) _bb.onclick = (e)=>{ e.preventDefault(); e.stopPropagation();
    var done = false;
    try{ var r = hook("switchTab", "scan"); if(r !== undefined) done = true; }catch(err){}
    if(!done){
      // Fallback: manual tab switch (hook not registered or failed)
      document.querySelectorAll(".tabpage").forEach(t=>t.classList.remove("active"));
      const _s = $("tabScan"); if(_s) _s.classList.add("active");
      window.scrollTo(0,0);
    }
  };
  $("sentBarPlay").onclick = ()=>{ if(state.selSentIdx>=0){ apStop(); safeSpeak(state.readData[state.selSentIdx].text); } };
  $("sentBarClose").onclick = hideSentBar;
  $("viewArticle").onclick = ()=>{ state.readView="article"; hideSentBar(); hideDictPop(); renderReadView(); };
  $("viewCards").onclick = ()=>{ state.readView="cards"; hideSentBar(); hideDictPop(); renderReadView(); };
  const qBtn = $("readQuizBtn"); if(qBtn) qBtn.onclick = ()=>openQuiz();
  $("readClear").onclick = async ()=>{
    if(!await inlineConfirm(t("clearScanQ"), t("confirmYes"), t("confirmNo"))) return;
    hideDictPop();
    if(state.curScanId != null) removeScanFromHist(state.curScanId);
    state.readData = []; state.selSentIdx = -1; state.curScanId = null; hideSentBar();
    $("readSents").innerHTML = "";
    $("readArticle").innerHTML = "";
    $("readTextInput").value = "";
    $("readResultCard").style.display = "none";
    const _esc = $("readEmptyState"), _src = $("serverReadingsCard");
    if(_esc && (!_src || _src.style.display === "none")) _esc.style.display = "block";
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
  $("sentBarLevel").innerHTML = `<span class="cefr ${d.cefr}">${state.uiMode==="kid"?kidLevelName(d.cefr):d.cefr}</span>`;
  $("sentBarText").textContent = d.text.length>60 ? d.text.slice(0,60)+"…" : d.text;
  $("sentBar").classList.add("show");
}

// AI Quiz — generate quiz from article text
async function openQuiz(){
  const box = document.getElementById("readQuiz");
  if(!box) return;
  let text = "";
  try{
    const art = document.getElementById("readArticle");
    if(art) text = art.textContent.slice(0, 3000);
  }catch(e){}
  text = text.trim();
  if(text.length < 50){
    box.style.display = "block";
    box.innerHTML = '<div class="hint">Need article text first</div>';
    return;
  }
  box.style.display = "block";
  box.innerHTML = '<div class="hint">...</div>';
  try{
    const {apiCall} = await import('../core/api.js');
    const r = await apiCall("/api/ai/quiz", {
      method: "POST",
      body: JSON.stringify({text, lang: "vi"})
    });
    if(r.quiz && Array.isArray(r.quiz)){
      let h = '<div style="margin-top:8px">';
      r.quiz.forEach((q, qi)=>{
        h += `<div style="margin-bottom:12px;padding:10px;background:var(--card2);border-radius:8px">`;
        h += `<div style="font-weight:600;margin-bottom:6px">${qi+1}. ${q.q}</div>`;
        (q.options || []).forEach((opt, oi)=>{
          h += `<label style="display:block;padding:4px"><input type="radio" name="q${qi}" value="${oi}"> ${opt}</label>`;
        });
        h += `<div id="qe${qi}" style="display:none;margin-top:6px;font-size:13px"></div>`;
        h += `<button data-qc="${qi}" style="margin-top:4px">Check</button></div>`;
      });
      h += '</div>';
      box.innerHTML = h;
      box.querySelectorAll("[data-qc]").forEach(b=>{
        b.onclick = ()=>{
          const qi = parseInt(b.dataset.qc);
          const q = r.quiz[qi];
          const sel = box.querySelector(`input[name="q${qi}"]:checked`);
          const ed = document.getElementById(`qe${qi}`);
          if(!sel || !ed) return;
          const ok = parseInt(sel.value) === q.answer;
          ed.style.display = "block";
          ed.textContent = (ok ? "✓ " : "✗ ") + (q.explain || "");
        };
      });
    }else{
      box.innerHTML = '<div class="hint">' + (r.error || "Failed") + '</div>';
    }
  }catch(e){
    box.innerHTML = '<div class="hint">Error</div>';
  }
}
