// js/features/books.js — book library, PDF upload, chapter reading.
import { $, esc, toast } from '../core/dom.js';
import { state } from '../core/state.js';
import { authHeaders, apiCall } from '../core/api.js';
import { t, kidLevelName } from '../core/i18n.js';
import { openAuth } from './auth.js';
import { makeSentenceEl } from './sentence.js';

export async function renderBookList(){
  const box = $("bookList");
  const _bes = $("bookEmptyState"); if(_bes) _bes.style.display = "none";
  $("bookDetailCard").style.display = "none";
  $("chapterCard").style.display = "none";
  if(!state.authToken){ box.innerHTML = '<div class="hint">Login to see your books.</div>'; return; }
  box.innerHTML = '<div class="pp-skeleton" style="height:54px;margin-bottom:8px"></div>'.repeat(3);
  try{
    const j = await apiCall("/api/books");
    if(!j.books.length){ box.innerHTML = '<div class="hint">No books yet. Upload a PDF or EPUB to start.</div>'; return; }
    box.innerHTML = "";
    j.books.forEach(b=>{
      const d = document.createElement("div");
      d.className = "profileitem";
      d.innerHTML = `<div class="profileavatar"><svg class="ic big"><use href="#i-book"/></svg></div>
        <div style="flex:1"><div style="font-weight:700">${esc(b.title)}</div>
        <div class="hint">${b.status==="processing" ? "Processing…" : b.chapters+" lessons"}</div></div>
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
  box.innerHTML = '<div class="pp-skeleton" style="height:44px;margin-bottom:8px"></div>'.repeat(4);
  try{
    const j = await apiCall("/api/books/"+id);
    box.innerHTML = "";
    j.chapters.forEach((c, i)=>{
      const d = document.createElement("div");
      d.className = "profileitem";
      const lv = c.cefr || "B1";
      d.innerHTML = `<span class="cefr ${lv}">${state.uiMode==="kid"?kidLevelName(lv):lv}</span>
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
  // i18n labels for upload UI (set here; HTML shell dict lacks these keys)
  const upBtn = $("bookUploadBtn"); if(upBtn){ upBtn.textContent = t("uploadBtn") || "Upload"; upBtn.onclick = ()=>$("bookFile").click(); }
  const goBtn = $("bookTitleGo"); if(goBtn) goBtn.textContent = t("uploadBtn") || "Upload";
  const cancelBtn = $("bookTitleCancel"); if(cancelBtn) cancelBtn.textContent = t("cancel") || "Cancel";
  const fileInput = $("bookFile");
  if(fileInput){
  fileInput.onclick = (e)=>{ if(!state.authToken){ e.preventDefault(); toast("Login first"); openAuth(); } };
  let pendingFile = null;
  fileInput.onchange = ()=>{
    const f = fileInput.files[0];
    if(!f) return;
    if(f.size > 50*1024*1024){ toast("Max 50MB"); fileInput.value = ""; return; }
    pendingFile = f;
    $("bookTitleInput").value = f.name.replace(/\.(pdf|epub)$/i,"");
    $("bookTitleInput").placeholder = t("bookTitlePh");
    $("bookTitleRow").style.display = "";
    $("bookTitleInput").focus();
  };
  const cancelUpload = ()=>{ pendingFile = null; fileInput.value = ""; $("bookTitleRow").style.display = "none"; };
  $("bookTitleCancel").onclick = cancelUpload;
  $("bookTitleGo").onclick = async ()=>{
    const f = pendingFile;
    if(!f) return;
    const title = $("bookTitleInput").value.trim() || "Untitled";
    $("bookTitleRow").style.display = "none";
    toast(t("uploading"));
    try{
      const buf = await f.arrayBuffer();
      const r = await fetch("/api/books/upload", {
        method: "POST",
        headers: {...authHeaders(), "Content-Type": "application/pdf", "X-Book-Title": encodeURIComponent(title)},
        body: buf,
      });
      const j = await r.json();
      if(!r.ok) throw new Error(j.error||"Upload failed");
      toast(t("uploadedProcessing"));
      renderBookList();
    }catch(e){ toast(e.message); }
    pendingFile = null; fileInput.value = "";
  };
  }
  const bookBack = $("bookBack"); if(bookBack) bookBack.onclick = ()=>{ $("bookDetailCard").style.display = "none"; };
  const chapterBack = $("chapterBack"); if(chapterBack) chapterBack.onclick = ()=>{ $("chapterCard").style.display = "none"; };
}
// Tab lazy-load hook (inline switchTab calls window._elabLoadBooks like library)
window._elabLoadBooks = renderBookList;

