// js/features/books.js — book library, PDF upload, chapter reading.
import { $, esc, toast } from '../core/dom.js';
import { state } from '../core/state.js';
import { authHeaders } from '../core/api.js';
import { t } from '../core/i18n.js';
import { openAuth } from './auth.js';
import { makeSentenceEl } from './sentence.js';

export async function renderBookList(){
  const box = $("bookList");
  $("bookDetailCard").style.display = "none";
  $("chapterCard").style.display = "none";
  if(!state.authToken){ box.innerHTML = '<div class="hint">Login to see your books.</div>'; return; }
  box.innerHTML = '<div class="hint">Loading…</div>';
  try{
    const j = await apiCall("/api/books");
    if(!j.books.length){ box.innerHTML = '<div class="hint">No books yet. Upload a PDF to start.</div>'; return; }
    box.innerHTML = "";
    j.books.forEach(b=>{
      const d = document.createElement("div");
      d.className = "profileitem";
      d.innerHTML = `<div class="profileavatar"><svg class="ic big"><use href="#i-book"/></svg></div>
        <div style="flex:1"><div style="font-weight:700">${esc(b.title)}</div>
        <div class="hint">${b.status==="processing" ? "⏳ Processing…" : b.chapters+" lessons"}</div></div>
        <span style="font-size:20px">›</span>`;
      if(b.status !== "processing") d.onclick = ()=>openBook(b.id, b.title);
      box.appendChild(d);
    });
  }catch(e){ box.innerHTML = '<div class="hint">Error: '+esc(e.message)+'</div>'; }
}
export async function openBook(id, title){
  $("bookDetailTitleTxt").textContent = title;
  $("bookDetailCard").style.display = "";
  const box = $("bookChapters");
  box.innerHTML = '<div class="hint">Loading…</div>';
  try{
    const j = await apiCall("/api/books/"+id);
    box.innerHTML = "";
    j.chapters.forEach((c, i)=>{
      const d = document.createElement("div");
      d.className = "profileitem";
      const lv = c.cefr || "B1";
      d.innerHTML = `<span class="cefr ${lv}">${uiMode==="kid"?kidLevel(lv).icon:lv}</span>
        <div style="flex:1"><div style="font-weight:700">${esc(c.title)}</div>
        <div class="hint">${c.sentences.length} sentences</div></div>
        <span style="font-size:20px">›</span>`;
      d.onclick = ()=>openChapter(c);
      box.appendChild(d);
    });
  }catch(e){ box.innerHTML = '<div class="hint">Error: '+esc(e.message)+'</div>'; }
}
export function openChapter(c){
  $("chapterTitleTxt").textContent = c.title;
  $("chapterCard").style.display = "";
  const box = $("chapterSents");
  box.innerHTML = "";
  c.sentences.forEach(s=>{
    box.appendChild(makeSentenceEl(s, c.cefr, null));
  });
  window.scrollTo(0,0);
}
// Wiring for book surfaces (was top-level in index.html).
export function bindBooks(){
  $("bookUploadBtn").onclick = ()=>{ if(!state.authToken){ toast("Login first"); openAuth(); return; } $("bookFile").click(); };
  $("bookFile").onchange = async ()=>{
    const f = $("bookFile").files[0];
    if(!f) return;
    if(f.size > 50*1024*1024){ toast("Max 50MB"); return; }
    const title = prompt("Book title:", f.name.replace(/\.(pdf|epub)$/i,"")) || "Untitled";
    toast("Uploading\u2026");
    try{
      const buf = await f.arrayBuffer();
      const r = await fetch("/api/books/upload", {
        method: "POST",
        headers: {...authHeaders(), "Content-Type": "application/pdf", "X-Book-Title": encodeURIComponent(title)},
        body: buf,
      });
      const j = await r.json();
      if(!r.ok) throw new Error(j.error||"Upload failed");
      toast("Uploaded! Processing\u2026 \uD83D\uDCDA");
      renderBookList();
    }catch(e){ toast(e.message); }
    $("bookFile").value = "";
  };
  $("bookBack").onclick = ()=>{ $("bookDetailCard").style.display = "none"; };
  $("chapterBack").onclick = ()=>{ $("chapterCard").style.display = "none"; };
}

