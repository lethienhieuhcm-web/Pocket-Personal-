// js/main.js — English Lab (2026-10-08)
// Uses event delegation via addEventListener (onclick attributes don't work in this env)
import { switchTab } from './core/router.js';
import { $ } from './core/dom.js';
import { bindVocab } from './features/vocab.js';
import { bindLibrary } from './features/library.js';
import { bindBooks } from './features/books.js';
import { renderAdmin, updateAuthUI } from './features/auth.js';

function splitSents(text){
  return text.match(/[^.!?]+[.!?]+/g)?.map(s=>s.trim()).filter(Boolean) || [text.trim()];
}

function bindScan(){
  const btn = $("scanGoBtn");
  const input = $("scanTextInput");
  if(!btn || !input) return;
  input.addEventListener("input", ()=>{ btn.disabled = !input.value.trim(); });
  btn.disabled = true;

  // Hidden file inputs for photo/gallery (created once)
  let camInput = $("scanCamInput");
  if(!camInput){
    camInput = document.createElement("input");
    camInput.type = "file";
    camInput.id = "scanCamInput";
    camInput.accept = "image/*";
    camInput.style.display = "none";
    // Android: capture="environment" opens camera directly
    if(!/iPad|iPhone|iPod/.test(navigator.userAgent)){
      camInput.setAttribute("capture", "environment");
    }
    document.body.appendChild(camInput);
  }
  let libInput = $("scanLibInput");
  if(!libInput){
    libInput = document.createElement("input");
    libInput.type = "file";
    libInput.id = "scanLibInput";
    libInput.accept = "image/*";
    libInput.style.display = "none";
    document.body.appendChild(libInput);
  }
  const photoBtn = $("scanPhotoBtn");
  const galleryBtn = $("scanGalleryBtn");
  if(photoBtn) photoBtn.addEventListener("click", ()=>camInput.click());
  if(galleryBtn) galleryBtn.addEventListener("click", ()=>libInput.click());
  const handleFile = (file)=>{
    if(!file) return;
    // OCR flow not yet wired in this UI — log for now.
    // TODO(ai-ux): connect to OCR (see js/features/scan.js handleReadFile).
    console.log("[elab] scan photo selected:", file.name, file.size);
  };
  camInput.addEventListener("change", e=>handleFile(e.target.files[0]));
  libInput.addEventListener("change", e=>handleFile(e.target.files[0]));
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
      // Direct word handlers (delegation fallback for .w spans)
      box.querySelectorAll("span.w").forEach(function(sp){
        sp.addEventListener("click", function(e){
          e.stopPropagation();
          doWordLookup(sp.getAttribute("data-word"), sp);
        });
      });
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

async function doAIExplain(idx){
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
    // 8b 2026-10-12: y chang file đính kèm — thử key user qua relay trước, lỗi thì fallback server.
    try{
      const m = await import('./core/aiClient.js');
      const key = await m.getUserKey().catch(()=>null);
      const base = await m.getEffectiveEndpoint('english').catch(()=>null);
      const model = await m.getEffectiveModel('english').catch(()=>null);
      if(key && base && model){
        let lang = "en";
        try{ lang = (localStorage.getItem("elab_uiLang") || "en").replace(/"/g, ""); }catch(e){}
        const prompt = 'Explain this English sentence: "' + text.slice(0, 500) + '". Answer in ' + (lang === "vi" ? "Vietnamese" : "English") + ', concise.';
        const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        const rlen = await m.getResponseLength().catch(()=>2048);
        // tốc T2: stream chữ chảy dần vào box (thay vì chờ full).
        box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">AI giải thích</div><div class="aiStreamBody"></div>';
        const ansDiv = box.querySelector('.aiStreamBody');
        let streamed = "";
        // tốc T5-router: việc dễ → thử model nhỏ trước (nếu có), hỏng thì
        // sang model chính. Cache check theo từng model.
        const models = await m.getRouterModels('english').catch(()=> [model]);
        for(const mdl of models){
          try{
            // tốc T5: câu đã giải thích rồi → trả cache ngay, không gọi AI.
            const cacheKey = m.cacheKeyFor(['explain-sentence', base, mdl, prompt]);
            const cached = await m.aiCacheGet(cacheKey).catch(()=>null);
            if(cached){
              ansDiv.innerHTML = esc(cached).replace(/\n/g,"<br>");
              return;
            }
            const answer = await m.proxyChat({ baseUrl: base, key, model: mdl, messages: [{ role: "user", text: prompt }], maxTokens: rlen,
              onToken: function(chunk){
                streamed += chunk;
                ansDiv.innerHTML = esc(streamed).replace(/\n/g,"<br>");
              } });
            if(answer && answer.trim()){
              ansDiv.innerHTML = esc(answer).replace(/\n/g,"<br>");
              await m.aiCacheSet(cacheKey, answer).catch(()=>{});
              return;
            }
          }catch(e){
            // Model này hỏng → thử model tiếp theo (cuối cùng rớt server).
            // Reset phần đã stream (model này chưa đưa chữ nào — stream hỏng
            // trước chữ đầu mới throw; nếu đã có chữ thì proxyChat đã trả
            // phần đó, không vào đây).
            streamed = "";
            continue;
          }
        }
      }
    }catch(e){ /* rớt relay → fallback server bên dưới */ }
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

/* 8b: parse JSON array từ text AI (model có thể bọc trong prose). */
function parseQuizJson(text){
  try{
    const s = String(text || "");
    const start = s.indexOf("[");
    const end = s.lastIndexOf("]");
    if(start < 0 || end <= start) return [];
    const arr = JSON.parse(s.slice(start, end + 1));
    return (Array.isArray(arr) ? arr : []).filter(q =>
      q && typeof q.q === "string" && Array.isArray(q.options) && q.options.length >= 2);
  }catch(e){ return []; }
}
const escHtml = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

async function doGenQuiz(){
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

    const renderQuiz = (questions) => {
      box.innerHTML = '<div style="font-weight:700;margin-bottom:12px">Quiz ('+questions.length+' câu)</div>'+questions.map((q,qi)=>{
        let h = '<div style="margin-bottom:16px;padding:12px;background:var(--pp-bg);border-radius:10px">';
        h += '<div style="font-weight:600;margin-bottom:8px">'+(qi+1)+'. '+escHtml(q.q || q.question)+'</div>';
        if(q.options) h += q.options.map((opt,oi)=>'<label style="display:block;padding:6px;cursor:pointer"><input type="radio" name="q'+qi+'" value="'+oi+'"> '+escHtml(opt)+'</label>').join("");
        return h+'</div>';
      }).join("");
    };

    // 8b 2026-10-12: y chang file đính kèm (như Talk) — thử key user qua relay trước, lỗi thì fallback server.
    try{
      const m = await import('./core/aiClient.js');
      const key = await m.getUserKey().catch(()=>null);
      const base = await m.getEffectiveEndpoint('english').catch(()=>null);
      const model = await m.getEffectiveModel('english').catch(()=>null);
      if(key && base && model){
        let lang = "vi";
        try{ lang = (localStorage.getItem("elab_uiLang") || "vi").replace(/"/g, ""); }catch(e){}
        const langName = {vi:"Vietnamese",en:"English",zh:"Chinese",ko:"Korean"}[lang] || "Vietnamese";
        const prompt = 'Create 5 multiple-choice English quiz questions from this text:\n\n'+text.slice(0,3000)+'\n\n'+
          'Reply in '+langName+' (questions in English, explanations in '+langName+'). '+
          'Return ONLY a JSON array: [{"q":"question","options":["A","B","C","D"],"answer":0,"explain":"why"}].';
        // Quiz cần đủ tokens cho JSON đầy đủ — tối thiểu 2000.
        const rlen = Math.max(await m.getResponseLength().catch(()=>2048), 2000);
        // tốc T5: cùng bài + ngôn ngữ → trả quiz cũ, không gọi AI.
        // Chỉ cache khi parse ra quiz hợp lệ (không cache rác).
        const quizKey = m.cacheKeyFor(['quiz', base, model, prompt]);
        const quizCached = await m.aiCacheGet(quizKey).catch(()=>null);
        if(quizCached){
          const cachedQuestions = parseQuizJson(quizCached);
          if(cachedQuestions.length){ renderQuiz(cachedQuestions); return; }
        }
        const answer = await m.proxyChat({ baseUrl: base, key, model, messages: [{role:"user", text: prompt}], maxTokens: rlen });
        const questions = parseQuizJson(answer);
        if(questions.length){ await m.aiCacheSet(quizKey, answer).catch(()=>{}); renderQuiz(questions); return; }
      }
    }catch(e){ /* rớt relay → fallback server bên dưới */ }

    // Fallback: server. 8b: server trả {quiz} (không phải {questions}), câu hỏi dùng q.q.
    try{
      const r = await fetch("/api/ai/quiz",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},body:JSON.stringify({text})});
      const data = await r.json();
      const questions = data.quiz || data.questions || [];
      if(questions.length) renderQuiz(questions);
      else if(data && data.error) box.innerHTML = '<div class="hint">'+escHtml(String(data.error.message || data.error))+'</div>';
      else box.innerHTML = '<div class="hint">No quiz generated.</div>';
    }catch(e){ box.innerHTML = '<div class="hint">Quiz failed. Try again.</div>'; }
  }catch(e){}
}

window.__elabTabHook = function(name){
  if(name === "admin"){
    try{ renderAdmin(); }catch(e){ console.error("[main] renderAdmin failed:", e); }
  }
};
window._elabSwitchTab = switchTab;

bindScan();
bindVocab();
bindLibrary();
bindBooks();
try{ updateAuthUI(); }catch(e){ console.error("[main] updateAuthUI failed:", e); }
console.log("[elab] main.js loaded (delegation version)");
