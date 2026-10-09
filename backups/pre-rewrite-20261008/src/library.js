import { jerr, randToken } from './utils.js';
import { getSession, requireAdmin } from './auth.js';
import { parseReadingPath } from './books.js';
import { deleteUserCascade, dbListUsers, dbGetBankRaw, dbPutBankRaw } from './db.js';

export async function handleBankGet(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  try{
    const text = await dbGetBankRaw(env, s.email);
    if(!text) return new Response(JSON.stringify({bank:null}), {headers:{"Content-Type":"application/json"}});
    return new Response(text, {headers:{"Content-Type":"application/json"}});
  }catch(e){ return jerr("Read error", 500); }
}

export async function handleBankPost(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const body = await request.text();
  if(body.length > 500000) return jerr("Too large", 413);
  await dbPutBankRaw(env, s.email, body);
  return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
}

export async function handleReadingsCreate(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  let b;
  try{ b = await request.json(); }catch(e){ return jerr("Invalid JSON", 400); }
  const text = String(b.text||"").slice(0, 30000).trim();
  if(!text) return jerr("Empty text", 400);
  const email = s.email, prefix = "readings/"+email+"/";
  const id = randToken(8);
  const words = text.split(/\s+/).filter(Boolean).length;
  const rec = {id, text, words, sentences: Math.max(1, (b.sentences|0)||text.split(/(?<=[.!?])\s+/).length),
    src: String(b.src||"text").slice(0,8), ts: Date.now(), hasAudio:false};
  await env.AUTHDB.put(prefix+id+".json", JSON.stringify(rec), {httpMetadata:{contentType:"application/json"}});
  // cap 100 readings per user: delete oldest
  try{
    const list = await env.AUTHDB.list({prefix});
    const metas = [];
    for(const o of (list.objects||[])) if(o.key.endsWith(".json")) metas.push(o.key);
    if(metas.length > 100){
      const recs = [];
      for(const k of metas){ const o = await env.AUTHDB.get(k); if(o) recs.push({key:k, ts:(await o.json()).ts||0}); }
      recs.sort((a,b)=>a.ts-b.ts);
      for(const r of recs.slice(0, recs.length-100)){
        await env.AUTHDB.delete(r.key);
        await env.AUTHDB.delete(r.key.replace(/\.json$/, ".mp3"));
      }
    }
  }catch(e){}
  return new Response(JSON.stringify({ok:true, id}), {headers:{"Content-Type":"application/json"}});
}

export async function handleReadingsList(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const prefix = "readings/"+s.email+"/";
  const list = await env.AUTHDB.list({prefix});
  const out = [];
  for(const o of (list.objects||[])){
    if(!o.key.endsWith(".json")) continue;
    try{
      const obj = await env.AUTHDB.get(o.key);
      if(!obj) continue;
      const r = await obj.json();
      out.push({id:r.id, ts:r.ts, words:r.words, sentences:r.sentences, src:r.src, hasAudio:!!r.hasAudio});
    }catch(e){}
    if(out.length >= 100) break;
  }
  out.sort((a,b)=>b.ts-a.ts);
  return new Response(JSON.stringify({readings:out}), {headers:{"Content-Type":"application/json"}});
}

export async function handleReadingGet(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const p = parseReadingPath(new URL(request.url).pathname);
  if(!p) return jerr("Invalid id", 400);
  const prefix = "readings/"+s.email+"/"+p.id;
  if(p.sub === "audio"){
    const obj = await env.AUTHDB.get(prefix+".mp3");
    if(!obj) return jerr("No audio", 404);
    return new Response(obj.body, {headers:{"Content-Type":"audio/mpeg","Content-Disposition":'attachment; filename="reading-'+p.id+'.mp3"'}});
  }
  if(p.sub) return jerr("Not found", 404);
  const obj = await env.AUTHDB.get(prefix+".json");
  if(!obj) return jerr("Not found", 404);
  return new Response(await obj.text(), {headers:{"Content-Type":"application/json"}});
}

export async function handleReadingDelete(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const p = parseReadingPath(new URL(request.url).pathname);
  if(!p) return jerr("Invalid id", 400);
  const prefix = "readings/"+s.email+"/"+p.id;
  if(p.sub === "audio"){
    await env.AUTHDB.delete(prefix+".mp3");
    try{
      const metaObj = await env.AUTHDB.get(prefix+".json");
      if(metaObj){
        const rec = await metaObj.json(); rec.hasAudio = false;
        await env.AUTHDB.put(prefix+".json", JSON.stringify(rec), {httpMetadata:{contentType:"application/json"}});
      }
    }catch(e){}
    return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
  }
  if(p.sub) return jerr("Invalid id", 400);
  await env.AUTHDB.delete(prefix+".json");
  await env.AUTHDB.delete(prefix+".mp3");
  return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
}

export async function handleReadingAudioPut(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const p = parseReadingPath(new URL(request.url).pathname);
  if(!p || p.sub !== "audio") return jerr("Invalid id", 400);
  const ct = request.headers.get("content-type")||"";
  if(!ct.includes("audio/")) return jerr("Expected audio upload", 400);
  const buf = await request.arrayBuffer();
  if(!buf.byteLength || buf.byteLength > 15728640) return jerr("Audio too large (max 15MB)", 413);
  const prefix = "readings/"+s.email+"/"+p.id;
  const metaObj = await env.AUTHDB.get(prefix+".json");
  if(!metaObj) return jerr("Reading not found", 404);
  await env.AUTHDB.put(prefix+".mp3", buf, {httpMetadata:{contentType:"audio/mpeg"}});
  try{
    const rec = await metaObj.json();
    rec.hasAudio = true;
    await env.AUTHDB.put(prefix+".json", JSON.stringify(rec), {httpMetadata:{contentType:"application/json"}});
  }catch(e){}
  return new Response(JSON.stringify({ok:true, bytes:buf.byteLength}), {headers:{"Content-Type":"application/json"}});
}

export async function handleAdminUsers(request, env){
  const {err} = await requireAdmin(request, env);
  if(err) return err;
  const list = await dbListUsers(env);
  const users = list.map(u => ({email: u.email, role: u.role, created: u.created, plan: u.plan||"free", plan_expires: u.plan_expires||null}));
  return new Response(JSON.stringify({users}), {headers:{"Content-Type":"application/json"}});
}

export async function handleAdminRole(request, env){
  // DISABLED: no user may be promoted to admin (policy 2026-10-05)
  return jerr("Role changes disabled", 403);
}

export async function handleAdminDelete(request, env){
  const {err, user} = await requireAdmin(request, env);
  if(err) return err;
  const email = decodeURIComponent(request.url.split("/").pop()).toLowerCase();
  if(email === user.email.toLowerCase()) return jerr("Can't delete self", 400);
  // PHASE 2: single cascade — R2 (user, bank, sessions) + D1 (all email rows).
  const report = await deleteUserCascade(env, email);
  return new Response(JSON.stringify({ok:true, deleted: report}), {headers:{"Content-Type":"application/json"}});
}

// Privacy: only aggregated word frequencies + CEFR counts, never raw sentences.
// Stored in R2 bucket "english-lab-data" -> analytics/corpus.json
// Used to improve CEFR classifier, pre-cache dictionary, suggest vocabulary.
export async function loadCorpus(env){
  try{
    const obj = await env.DATA.get("analytics/corpus.json");
    if(obj) return await obj.json();
  }catch(e){}
  return {wordFreq:{}, lookupFreq:{}, cefr:{A1:0,A2:0,B1:0,B2:0,C1:0,C2:0}, scans:0, learners:[]};
}

export async function saveCorpus(env, corpus){
  // prune to keep file small
  const prune = (o, n)=>{
    const e = Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,n);
    return Object.fromEntries(e);
  };
  corpus.wordFreq = prune(corpus.wordFreq, 3000);
  corpus.lookupFreq = prune(corpus.lookupFreq, 3000);
  corpus.learners = [...new Set(corpus.learners)].slice(-5000);
  await env.DATA.put("analytics/corpus.json", JSON.stringify(corpus), {
    httpMetadata: {contentType: "application/json"}
  });
}

export async function handleAnalytics(request, env){
  let d;
  try{ d = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const corpus = await loadCorpus(env);
  if(d.uid && !corpus.learners.includes(d.uid.slice(0,64))) corpus.learners.push(d.uid.slice(0,64));
  if(d.words && typeof d.words === "object"){
    for(const w in d.words){
      const word = String(w).toLowerCase().slice(0,30);
      if(/^[a-z'-]{2,30}$/.test(word)) corpus.wordFreq[word] = (corpus.wordFreq[word]||0) + Math.min(50, d.words[w]|0);
    }
  }
  if(Array.isArray(d.lookups)) d.lookups.slice(0,50).forEach(w=>{
    const word = String(w).toLowerCase().slice(0,30);
    if(/^[a-z'-]{2,30}$/.test(word)) corpus.lookupFreq[word] = (corpus.lookupFreq[word]||0)+1;
  });
  if(d.cefr) for(const lv of ["A1","A2","B1","B2","C1","C2"]) corpus.cefr[lv] += (d.cefr[lv]|0);
  if(d.words || d.lookups) corpus.scans++;
  await saveCorpus(env, corpus);
  return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
}

export async function handleInsights(url, env){
  const corpus = await loadCorpus(env);
  const top = (o, n)=>Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([w,c])=>({w,c}));
  const out = {
    scans: corpus.scans, learners: corpus.learners.length, cefr: corpus.cefr,
    topWords: top(corpus.wordFreq, 50),
    topLookups: top(corpus.lookupFreq, 50),
  };
  return new Response(JSON.stringify(out), {headers:{"Content-Type":"application/json"}});
}

