import { checkRate, jerr, fetchTimeout, stripHtml } from './utils.js';

export async function handleTTS(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "x";
  if (!checkRate(ip)) return jerr("Rate limit exceeded (300/day)", 429);
  // Auth + per-plan quota (lazy import to avoid cycle, same as handleDict)
  const {checkFeature, incrUsage} = await import('./billing.js');
  const chk = await checkFeature(request, env, 'tts_chars');
  if (chk.err) return chk.err;
  const key = env.ELEVENLABS_API_KEY;
  if (!key) return jerr("TTS not configured", 503);
  let b;
  try { b = await request.json(); } catch (e) { return jerr("Invalid JSON", 400); }
  const text = (b.text || "").slice(0, 5000), voice_id = b.voice_id || "", model_id = b.model_id || "eleven_multilingual_v2";
  if (!text || !voice_id) return jerr("Missing text/voice_id", 400);
  const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + voice_id, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id })
  });
  if (!r.ok) return jerr("TTS provider error", r.status);
  const audio = await r.arrayBuffer();
  try { await incrUsage(env, chk.user.email, 'tts_chars', text.length); } catch (e) {}
  return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-TTS-Chars": String(text.length) } });
}

export async function handleVoices(request, env) {
  const {getSession} = await import('./auth.js');
  const s = await getSession(request, env);
  if (!s) return jerr("Not logged in", 401);
  const key = env.ELEVENLABS_API_KEY;
  if (!key) return jerr("TTS not configured", 503);
  const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
  if (!r.ok) return jerr("Voice list error", r.status);
  const j = await r.json();
  const voices = (j.voices || []).map(v => ({ voice_id: v.voice_id, name: v.name, labels: v.labels }));
  return new Response(JSON.stringify({ voices }), { headers: { "Content-Type": "application/json" } });
}

export async function handleQuota(request, env) {
  const {getSession} = await import('./auth.js');
  const s = await getSession(request, env);
  if (!s) return jerr("Not logged in", 401);
  const key = env.ELEVENLABS_API_KEY;
  if (!key) return jerr("TTS not configured", 503);
  const r = await fetch("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": key } });
  if (!r.ok) return jerr("Quota error", r.status);
  const j = await r.json();
  return new Response(JSON.stringify({ subscription: j.subscription || {} }), { headers: { "Content-Type": "application/json" } });
}

/* ---------- translate proxy: same unofficial Google endpoint the app already
   used client-side, moved server-side so ad-blockers can't break the UI ---------- */
const translateCache = new Map(); // "target|text" -> {text, ts}

export async function handleTranslate(request, env){
  const ip = request.headers.get("cf-connecting-ip") || "x";
  if(!checkRate(ip)) return jerr("Rate limit exceeded (300/day)", 429);
  let b;
  try{ b = await request.json(); }catch(e){ return jerr("Invalid JSON", 400); }
  const text = String(b.text||"").slice(0, 500).trim();
  const target = String(b.target||"vi").slice(0, 5);
  if(!text) return jerr("Empty text", 400);
  const ck = target+"|"+text;
  const c = translateCache.get(ck);
  if(c && Date.now()-c.ts < 86400000)
    return new Response(JSON.stringify({text:c.text}), {headers:{"Content-Type":"application/json"}});
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl="
    + encodeURIComponent(target) + "&dt=t&q=" + encodeURIComponent(text);
  try{
    const r = await fetchTimeout(url, 8000, {headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"}});
    if(!r.ok) return jerr("Translate upstream error", 502);
    const j = await r.json();
    const t = (j[0] && j[0][0] && j[0][0][0] || "").trim();
    translateCache.set(ck, {text:t, ts:Date.now()});
    if(translateCache.size > 2000){ const k = translateCache.keys().next().value; translateCache.delete(k); }
    return new Response(JSON.stringify({text:t}), {headers:{"Content-Type":"application/json"}});
  }catch(e){ return jerr("Translate failed", 502); }
}

/* ---------- fullstack dictionary: multi-source with fallback ---------- */
const dictCache = new Map(); // word -> {data, ts}

export async function handleDict(url, env, request){
  const word = (url.searchParams.get("word")||"").trim().toLowerCase();
  if(!word || !/^[a-z'-]{1,40}$/.test(word)) return jerr("Invalid word", 400);
  // Check free limits for logged-in users (lazy import to avoid cycle)
  try{
    const {checkFeature, incrUsage} = await import('./billing.js');
    const chk = await checkFeature(request, env, 'dict');
    if(chk.err) return chk.err;
    // Track usage for free users
    const {getActivePlan} = await import('./auth.js');
    if(getActivePlan(chk.user).plan === 'free'){
      await incrUsage(env, chk.user.email, 'dict_lookups', 1);
    }
  }catch(e){ /* anonymous or error = allow */ }
  const cached = dictCache.get(word);
  if(cached && Date.now() - cached.ts < 86400000) {
    return new Response(JSON.stringify(cached.data), { headers: { "Content-Type": "application/json", "X-Cache": "hit" } });
  }
  // Multi-source aggregator (2026-10-05): race ALL sources in parallel, merge results.
  // Free (no key): Wiktionary, wiktapi.dev EN, wiktapi.dev VI
  // Key-based (env.MW_KEY, env.WORDSAPI_KEY): Merriam-Webster, WordsAPI - skipped if no key
  const UA = { "User-Agent": "EnglishLab/1.0 (https://lethanhdong.one)" };
  const results = await Promise.allSettled([
    // 1. Wiktionary (free)
    (async ()=>{
      const r = await fetchTimeout("https://en.wiktionary.org/api/rest_v1/page/definition/"+encodeURIComponent(word), 6000, {headers: UA});
      if(!r.ok) throw new Error("wikt "+r.status);
      return {src:"wiktionary", data: await r.json()};
    })(),
    // 2. wiktapi.dev EN (free)
    (async ()=>{
      const r = await fetchTimeout("https://api.wiktapi.dev/v1/en/word/"+encodeURIComponent(word)+"/definitions?lang=en", 6000, {headers: UA});
      if(!r.ok) throw new Error("wiktapi "+r.status);
      return {src:"wiktapi", data: await r.json()};
    })(),
    // 3. wiktapi.dev VI definitions (free)
    (async ()=>{
      const r = await fetchTimeout("https://api.wiktapi.dev/v1/vi/word/"+encodeURIComponent(word)+"/definitions?lang=en", 6000, {headers: UA});
      if(!r.ok) throw new Error("wiktapi-vi "+r.status);
      return {src:"wiktapi-vi", data: await r.json()};
    })(),
    // 4. Merriam-Webster Learner's Dictionary (env.MW_KEY)
    (async ()=>{
      if(!env.MW_KEY) throw new Error("no mw key");
      const r = await fetchTimeout("https://www.dictionaryapi.com/api/v3/references/learners/json/"+encodeURIComponent(word)+"?key="+env.MW_KEY, 6000, {headers: UA});
      if(!r.ok) throw new Error("mw "+r.status);
      return {src:"mw", data: await r.json()};
    })(),
    // 4b. Merriam-Webster Intermediate Thesaurus (env.MW_THES_KEY) - synonyms/antonyms
    (async ()=>{
      if(!env.MW_THES_KEY) throw new Error("no mw thes key");
      const r = await fetchTimeout("https://www.dictionaryapi.com/api/v3/references/ithesaurus/json/"+encodeURIComponent(word)+"?key="+env.MW_THES_KEY, 6000, {headers: UA});
      if(!r.ok) throw new Error("mw-thes "+r.status);
      return {src:"mw-thes", data: await r.json()};
    })(),
    // 5. WordsAPI via RapidAPI (needs env.WORDSAPI_KEY)
    (async ()=>{
      if(!env.WORDSAPI_KEY) throw new Error("no wordsapi key");
      const r = await fetchTimeout("https://wordsapiv1.p.rapidapi.com/words/"+encodeURIComponent(word), 6000, {
        headers: {"X-RapidAPI-Key": env.WORDSAPI_KEY, "X-RapidAPI-Host": "wordsapiv1.p.rapidapi.com", ...UA}
      });
      if(!r.ok) throw new Error("wordsapi "+r.status);
      return {src:"wordsapi", data: await r.json()};
    })(),
  ]);
  const ok = results.filter(x=>x.status==="fulfilled").map(x=>x.value);

  let out = { word, phonetic:"", audio:"", meanings:[], sources:[] };
  const seenDefs = new Set();
  const addMeaning = (pos, d, exs)=>{
    const txt = String(d||"").replace(/\s+/g," ").trim().slice(0,300);
    if(!txt || txt.length<3) return;
    const key = txt.toLowerCase().slice(0,60);
    if(seenDefs.has(key)) return;
    seenDefs.add(key);
    let m = out.meanings.find(m=>m.pos===(pos||""));
    if(!m){ m = {pos: pos||"", defs:[]}; out.meanings.push(m); }
    if(m.defs.length<4) m.defs.push({d: txt, exs: (exs||[]).map(e=>({t:String(e).slice(0,200)})).slice(0,2)});
  };
  function mwAudioUrl(file){
    if(!file) return "";
    const sub = file.slice(0,3)==="bix" ? "bix" : file.slice(0,2)==="gg" ? "gg" : /^[a-z]/i.test(file[0]||"") ? file[0].toLowerCase() : "number";
    return "https://media.merriam-webster.com/audio/prons/en/us/mp3/"+sub+"/"+file+".mp3";
  }
  // Parse in quality order: MW > wiktapi > wiktionary > wordsapi
  const bySrc = s => ok.find(x=>x.src===s);
  const mw = bySrc("mw"), wikt = bySrc("wiktapi"), wik = bySrc("wiktionary"), wapi = bySrc("wordsapi"), wvi = bySrc("wiktapi-vi");
  if(mw){
    out.sources.push("merriam-webster");
    try{
      for(const e of (mw.data||[]).slice(0,4)){
        if(typeof e !== "object" || !e) continue;
        const pos = e.fl || "";
        const prs0 = e.hwi && e.hwi.prs && e.hwi.prs[0];
        if(!out.phonetic && prs0 && (prs0.ipa || prs0.mw)) out.phonetic = prs0.ipa || prs0.mw;
        if(!out.audio && prs0 && prs0.sound && prs0.sound.audio) out.audio = mwAudioUrl(prs0.sound.audio);
        for(const sd of (e.shortdef||[]).slice(0,4)) addMeaning(pos, sd, []);
      }
    }catch(e){}
  }
  const mthes = bySrc("mw-thes");
  if(mthes){
    out.sources.push("mw-thesaurus");
    // collect {wd} words under a given list key (syn_list / ant_list) anywhere in sseq
    const collectWds = (node, key, arr)=>{
      if(!node) return;
      if(Array.isArray(node)){ node.forEach(n=>collectWds(n,key,arr)); return; }
      if(typeof node !== "object") return;
      if(node[key] && Array.isArray(node[key])){
        const pull = x=>{
          if(Array.isArray(x)){ x.forEach(pull); return; }
          if(x && typeof x.wd === "string"){
            const c = x.wd.replace(/\*/g,"").trim();
            if(c && !arr.includes(c)) arr.push(c);
          }
        };
        node[key].forEach(pull);
        return;
      }
      Object.values(node).forEach(v=>collectWds(v,key,arr));
    };
    try{
      for(const e of (mthes.data||[]).slice(0,2)){
        if(typeof e !== "object" || !e) continue;
        const syns = [], ants = [];
        (e.def||[]).forEach(d=>{
          collectWds(d.sseq, "syn_list", syns);
          collectWds(d.sseq, "ant_list", ants);
        });
        if(syns.length || ants.length){
          if(!out.thesaurus) out.thesaurus = [];
          out.thesaurus.push({syn: syns.slice(0,10), ant: ants.slice(0,10)});
        }
        // thesaurus shortdef can also add meanings
        for(const sd of (e.shortdef||[]).slice(0,2)) addMeaning(e.fl||"", sd, []);
      }
    }catch(e){}
  }
  if(wikt){
    out.sources.push("wiktapi");
    try{
      for(const d of (wikt.data.definitions||[]).slice(0,4)){
        for(const s of (d.senses||[]).slice(0,3)){
          const exs = (s.examples||[]).map(x=>x.text).filter(Boolean).slice(0,2);
          for(const g of (s.glosses||[]).slice(0,2))
            addMeaning(d.pos||"", g, exs);
        }
      }
    }catch(e){}
  }
  if(wik){
    out.sources.push("wiktionary");
    try{
      for(const e of (wik.data.en||[]).slice(0,4)){
        for(const d of (e.definitions||[]).slice(0,3)){
          const txt = stripHtml(d.definition||"");
          if(txt) addMeaning(e.partOfSpeech||"", txt, []);
        }
      }
    }catch(e){}
  }
  if(wapi){
    out.sources.push("wordsapi");
    try{
      const d = wapi.data||{};
      if(!out.phonetic && d.pronunciation){
        out.phonetic = typeof d.pronunciation === "string" ? d.pronunciation : (d.pronunciation.all||"");
      }
      for(const r of (d.results||[]).slice(0,4)){
        addMeaning(r.partOfSpeech||"", r.definition||"", (r.examples||[]).slice(0,2));
        // synonyms as extra value
        if(r.synonyms && r.synonyms.length && out.meanings.length){
          const m0 = out.meanings[0];
          if(!m0.syn) m0.syn = [...new Set(r.synonyms)].slice(0,6);
        }
      }
    }catch(e){}
  }
  // VI definitions from wiktapi-vi
  let viDefs = [];
  if(wvi){
    try{
      (wvi.data.definitions||[]).forEach(d=>{
        (d.senses||[]).forEach(s=>{
          (s.glosses||[]).slice(0,2).forEach(g=>{
            if(g && viDefs.length<4) viDefs.push({pos: d.pos||"", d: String(g).slice(0,200)});
          });
        });
      });
    }catch(e){}
  }
  if(!out.meanings.length) return jerr("Not found", 404);
  if(viDefs.length) out.viMeanings = viDefs;
  dictCache.set(word, {data: out, ts: Date.now()});
  if(dictCache.size > 2000){ const k = dictCache.keys().next().value; dictCache.delete(k); }
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "X-Cache": "miss" } });
}

