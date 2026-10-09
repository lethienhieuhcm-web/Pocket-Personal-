// js/main.js — English Lab (2026-10-08)
// Uses event delegation via addEventListener (onclick attributes don't work in this env)
import { switchTab } from './core/router.js';
import { $ } from './core/dom.js';

function splitSents(text){
  return text.match(/[^.!?]+[.!?]+/g)?.map(s=>s.trim()).filter(Boolean) || [text.trim()];
}

function bindScan(){
  const btn = $("scanGoBtn");
  const input = $("scanTextInput");
  if(!btn || !input) return;
  input.addEventListener("input", ()=>{ btn.disabled = !input.value.trim(); });
  btn.disabled = true;
  btn.addEventListener("click", ()=>{
    const text = input.value.trim();
    if(!text) return;
    window._elabArticleText = text;
    const sents = splitSents(text);
    const box = $("readContent");
    if(box){
      let html = '<div class="card" id="articleCard">';
      html += '<div style="display:flex;gap:8px;margin-bottom:16px"><button class="btn elab-quiz-btn" style="flex:1">Quiz</button></div>';
      html += '<div id="quizBox" style="display:none;margin-bottom:16px"></div>';
      sents.forEach((s, i)=>{
        const words = s.split(/(\s+)/).map(w=>{
          if(/^\s+$/.test(w)) return w;
          return w.replace(/([A-Za-z']+)/g, '<span class="w" data-word="$1" style="cursor:pointer;border-bottom:1px dotted var(--pp-accent)">$1</span>');
        }).join("");
        const escText = s.replace(/"/g, '&quot;');
        html += '<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:12px">';
        html += '<p style="margin:0;flex:1;line-height:1.9" data-sent="'+i+'" data-text="'+escText+'">'+words+'</p>';
        html += '<div style="display:flex;flex-direction:column;gap:4px">';
        html += '<button class="elab-speak-btn" data-idx="'+i+'" style="background:none;border:none;cursor:pointer;padding:4px;color:var(--pp-accent)" aria-label="Listen"><svg class="ic" style="width:20px;height:20px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></button>';
        html += '<button class="elab-ai-btn" data-idx="'+i+'" style="background:var(--pp-accent);color:#fff;border:none;cursor:pointer;padding:6px 10px;border-radius:8px;font-size:12px;font-weight:600">AI</button>';
        html += '</div></div>';
        html += '<div class="dictInline" data-for="'+i+'" style="display:none;margin:-8px 0 12px;padding:10px;background:var(--pp-bg);border-radius:10px;font-size:14px"></div>';
        html += '<div class="aiInline" data-for="'+i+'" style="display:none;margin:-8px 0 12px;padding:10px;background:var(--pp-bg);border-radius:10px;font-size:14px;border-left:3px solid var(--pp-accent)"></div>';
      });
      html += '</div>';
      box.innerHTML = html;
    }
    switchTab("read");
  });
}

// Global click delegation (single listener on document)
document.addEventListener("click", function(e){
  // Word click -> dictionary
  const w = e.target.closest ? e.target.closest(".w") : null;
  if(w && w.dataset.word){
    e.stopPropagation();
    doWordLookup(w.dataset.word, w);
    return;
  }
  // Speak button
  const sb = e.target.closest ? e.target.closest(".elab-speak-btn") : null;
  if(sb){
    e.stopPropagation();
    doSpeak(parseInt(sb.dataset.idx, 10));
    return;
  }
  // AI button
  const ab = e.target.closest ? e.target.closest(".elab-ai-btn") : null;
  if(ab){
    e.stopPropagation();
    doAIExplain(parseInt(ab.dataset.idx, 10));
    return;
  }
  // Quiz button
  const qb = e.target.closest ? e.target.closest(".elab-quiz-btn") : null;
  if(qb){
    e.stopPropagation();
    doGenQuiz();
    return;
  }
});

function doWordLookup(word, el){
  const w = String(word).trim().toLowerCase().replace(/[^a-z']/g, "");
  if(!w) return;
  const p = el.closest("p");
  if(!p) return;
  const sentIdx = p.getAttribute("data-sent");
  const rc = $("readContent");
  if(!rc) return;
  const dictBox = rc.querySelector('.dictInline[data-for="'+sentIdx+'"]');
  if(!dictBox) return;
  dictBox.style.display = "block";
  dictBox.innerHTML = '<div class="hint">Loading...</div>';
  let token = null;
  try{ token = localStorage.getItem("elab_authToken") || localStorage.getItem("elab_token"); }catch(e){}
  const headers = token ? {"Authorization": "Bearer "+token} : {};
  fetch("/api/dict?word="+encodeURIComponent(w), {headers, credentials: "same-origin"}).then(r=>r.json()).then(data=>{
    if(data && data.meanings && data.meanings.length){
      const m = data.meanings[0];
      const def = m.defs && m.defs[0] ? m.defs[0].d : "";
      dictBox.innerHTML = '<div style="font-weight:700;margin-bottom:4px">'+w+(m.pos?' <span class="hint">('+m.pos+')</span>':"")+'</div><div>'+def+'</div>';
    }else if(data && data.error){
      const msg = String(data.error.message || data.error);
      if(msg.includes("Not logged in") || msg.includes("not logged")){
        dictBox.innerHTML = '<div class="hint">Vui lòng <a href="/login">đăng nhập</a> để tra từ điển.</div>';
      }else{
        dictBox.innerHTML = '<div class="hint">'+msg+'</div>';
      }
    }else{
      dictBox.innerHTML = '<div class="hint">No definition found.</div>';
    }
  }).catch(()=>{
    dictBox.innerHTML = '<div class="hint">Lookup failed.</div>';
  });
}

function doSpeak(idx){
  try{
    const rc = $("readContent");
    if(!rc) return;
    const p = rc.querySelector('p[data-sent="'+idx+'"]');
    if(!p) return;
    const text = p.getAttribute("data-text") || p.textContent;
    if(!text || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US"; u.rate = 0.9;
    window.speechSynthesis.speak(u);
  }catch(e){}
}

function doAIExplain(idx){
  try{
    const rc = $("readContent");
    if(!rc) return;
    const p = rc.querySelector('p[data-sent="'+idx+'"]');
    if(!p) return;
    const text = p.getAttribute("data-text") || p.textContent;
    const box = rc.querySelector('.aiInline[data-for="'+idx+'"]');
    if(!box || !text) return;
    box.style.display = "block";
    box.innerHTML = '<div class="hint">AI đang giải thích...</div>';
    let token = null;
    try{ token = localStorage.getItem("elab_authToken") || localStorage.getItem("elab_token"); }catch(e){}
    if(!token){ box.innerHTML = '<div class="hint">Vui lòng đăng nhập để dùng AI.</div>'; return; }
    fetch("/api/ai/explain",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},body:JSON.stringify({text})})
      .then(r=>r.json()).then(data=>{
        if(data && data.explanation) box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">AI giải thích</div><div>'+data.explanation+'</div>';
        else if(data && data.error){
          const msg = String(data.error.message || data.error);
          if(msg.includes("not supported for the API use") || msg.includes("location")){
            box.innerHTML = '<div class="hint">AI tạm không khả dụng ở khu vực của bạn (giới hạn từ Google).</div>';
          }else{
            box.innerHTML = '<div class="hint">'+msg+'</div>';
          }
        }
        else box.innerHTML = '<div class="hint">No explanation available.</div>';
      }).catch(()=>{ box.innerHTML = '<div class="hint">AI failed. Try again.</div>'; });
  }catch(e){}
}

function doGenQuiz(){
  try{
    const rc = $("readContent");
    if(!rc) return;
    const box = rc.querySelector("#quizBox");
    const text = window._elabArticleText || "";
    if(!box) return;
    box.style.display = "block";
    if(!text){ box.innerHTML = '<div class="hint">No article text.</div>'; return; }
    box.innerHTML = '<div class="hint">AI đang tạo quiz...</div>';
    let token = null;
    try{ token = localStorage.getItem("elab_authToken") || localStorage.getItem("elab_token"); }catch(e){}
    if(!token){ box.innerHTML = '<div class="hint">Please log in to use AI Quiz.</div>'; return; }
    fetch("/api/ai/quiz",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},body:JSON.stringify({text})})
      .then(r=>r.json()).then(data=>{
        if(data && data.questions && data.questions.length){
          box.innerHTML = '<div style="font-weight:700;margin-bottom:12px">Quiz ('+data.questions.length+' câu)</div>'+data.questions.map((q,qi)=>{
            let h = '<div style="margin-bottom:16px;padding:12px;background:var(--pp-bg);border-radius:10px">';
            h += '<div style="font-weight:600;margin-bottom:8px">'+(qi+1)+'. '+q.question+'</div>';
            if(q.options) h += q.options.map((opt,oi)=>'<label style="display:block;padding:6px;cursor:pointer"><input type="radio" name="q'+qi+'" value="'+oi+'"> '+opt+'</label>').join("");
            return h+'</div>';
          }).join("");
        }else if(data && data.error) box.innerHTML = '<div class="hint">'+data.error+'</div>';
        else box.innerHTML = '<div class="hint">No quiz generated.</div>';
      }).catch(()=>{ box.innerHTML = '<div class="hint">Quiz failed. Try again.</div>'; });
  }catch(e){}
}

window.__elabTabHook = function(name){};
window._elabSwitchTab = switchTab;

bindScan();
console.log("[elab] main.js loaded (delegation version)");
