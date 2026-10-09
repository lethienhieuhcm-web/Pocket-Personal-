import { jerr, randToken } from './utils.js';
import { getSession, getUser } from './auth.js';
import { loadCorpus, saveCorpus } from './library.js';

/* ---------- book upload + processing pipeline ---------- */
// Flow: POST /api/books/upload (PDF) -> R2 uploads/{user}/{id}.pdf
//   VM cron processes -> R2 books/{user}/{id}.json {title, chapters:[{title, sentences, cefr}]}
//   Vocab/stats auto-merged into shared corpus (no opt-in per owner decision)
export async function handleBookUpload(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const {checkFeature, incrUsage} = await import('./billing.js');
  const chk = await checkFeature(request, env, 'english_upload');
  if(chk.err) return chk.err;
  const ct = request.headers.get("content-type") || "";
  const isPdf = ct.includes("application/pdf");
  const isEpub = ct.includes("application/epub") || ct.includes("application/epub+zip");
  if(!isPdf && !isEpub) return jerr("PDF or EPUB only", 400);
  const buf = await request.arrayBuffer();
  if(buf.byteLength > 50*1024*1024) return jerr("Max 50MB", 413);
  if(buf.byteLength < 100) return jerr("Empty file", 400);
  const bookId = randToken(16);
  const title = (request.headers.get("x-book-title") || "Untitled").slice(0,100);
  const ext = isEpub ? "epub" : "pdf";
  const mime = isEpub ? "application/epub+zip" : "application/pdf";
  const key = `uploads/${s.email}/${bookId}.${ext}`;
  await env.DATA.put(key, buf, {
    httpMetadata: {contentType: mime},
    customMetadata: {title, uploader: s.email, ts: String(Date.now())},
  });
  // Create job marker
  await env.DATA.put(`jobs/${bookId}.json`, JSON.stringify({
    bookId, user: s.email, title, status: "pending", ts: Date.now()
  }), {httpMetadata:{contentType:"application/json"}});
  try { await incrUsage(env, s.email, 'english_uploads', 1); } catch(e){}
  return new Response(JSON.stringify({ok:true, bookId, title}), {headers:{"Content-Type":"application/json"}});
}

export async function handleBookList(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const list = await env.DATA.list({prefix: `books/${s.email}/`});
  const books = [];
  for(const o of list.objects){
    if(!o.key.endsWith(".json")) continue;
    try{
      const obj = await env.DATA.get(o.key);
      const b = await obj.json();
      books.push({id: o.key.split("/").pop().replace(".json",""), title: b.title, chapters: b.chapters.length, ts: b.ts, status: b.status});
    }catch(e){}
  }
  // Also include pending uploads
  const jobs = await env.DATA.list({prefix: "jobs/"});
  for(const o of jobs.objects){
    try{
      const obj = await env.DATA.get(o.key);
      const j = await obj.json();
      if(j.user === s.email && j.status === "pending"){
        books.push({id: j.bookId, title: j.title, chapters: 0, ts: j.ts, status: "processing"});
      }
    }catch(e){}
  }
  books.sort((a,b)=>b.ts-a.ts);
  return new Response(JSON.stringify({books}), {headers:{"Content-Type":"application/json"}});
}

export async function handleBookGet(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const id = request.url.split("/").pop().split("?")[0];
  if(!/^[a-f0-9]{32}$/.test(id)) return jerr("Invalid id", 400);
  try{
    const obj = await env.DATA.get(`books/${s.email}/${id}.json`);
    if(!obj) return jerr("Not found", 404);
    return new Response(await obj.text(), {headers:{"Content-Type":"application/json"}});
  }catch(e){ return jerr("Read error", 500); }
}


export async function handleAdminBooksPending(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const u = await getUser(env, s.email);
  if(!u || u.role !== "admin") return jerr("Admin only", 403);
  // List all processed books (not yet in shared/)
  const shared = await env.DATA.list({prefix: "shared/"});
  const sharedIds = new Set(shared.objects.map(o=>o.key.split("/").pop().replace(".json","")));
  const books = [];
  // List from all users' books
  const all = await env.DATA.list({prefix: "books/"});
  for(const o of all.objects){
    if(!o.key.endsWith(".json")) continue;
    const id = o.key.split("/").pop().replace(".json","");
    if(sharedIds.has(id)) continue;
    try{
      const obj = await env.DATA.get(o.key);
      const b = await obj.json();
      const user = o.key.split("/")[1];
      books.push({id, title: b.title, user, chapters: b.chapters.length, ts: b.ts});
    }catch(e){}
  }
  return new Response(JSON.stringify({books}), {headers:{"Content-Type":"application/json"}});
}

export async function handleAdminBooksApprove(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const u = await getUser(env, s.email);
  if(!u || u.role !== "admin") return jerr("Admin only", 403);
  let d; try{ d = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const {bookId, user} = d;
  if(!bookId || !user) return jerr("Missing bookId/user", 400);
  const srcKey = `books/${user}/${bookId}.json`;
  const obj = await env.DATA.get(srcKey);
  if(!obj) return jerr("Book not found", 404);
  const data = await obj.arrayBuffer();
  await env.DATA.put(`shared/${bookId}.json`, data, {
    httpMetadata: {contentType: "application/json"},
    customMetadata: {title: d.title||"Untitled", approvedBy: s.email, ts: String(Date.now())},
  });
  return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
}

export async function handleBookResult(request, env){
  // VM processor posts results here (protected by secret)
  const secret = request.headers.get("x-processor-secret");
  if(secret !== env.PROCESSOR_SECRET) return jerr("Forbidden", 403);
  let d; try{ d = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const {bookId, user, book} = d;
  if(!bookId || !user || !book) return jerr("Missing fields", 400);
  await env.DATA.put(`books/${user}/${bookId}.json`, JSON.stringify(book), {
    httpMetadata: {contentType: "application/json"}
  });
  await env.DATA.put(`jobs/${bookId}.json`, JSON.stringify({bookId, user, status: "done", ts: Date.now()}), {
    httpMetadata: {contentType: "application/json"}
  });
  // Auto-merge vocab into shared corpus (per owner: no opt-in)
  try{
    const corpus = await loadCorpus(env);
    const words = d.words || {};
    for(const w in words){
      if(/^[a-z'-]{2,30}$/.test(w)) corpus.wordFreq[w] = (corpus.wordFreq[w]||0) + Math.min(100, words[w]|0);
    }
    corpus.scans++;
    await saveCorpus(env, corpus);
  }catch(e){}
  return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json"}});
}

/* ---------- saved readings: article text + MP3 per user (AUTHDB) ---------- */
export function parseReadingPath(pathname){
  const rest = pathname.slice("/api/readings/".length);
  const parts = rest.split("/");
  const id = parts[0]||"";
  if(!/^[0-9a-f]{16}$/.test(id)) return null;
  return {id, sub: parts[1]||""};
}

