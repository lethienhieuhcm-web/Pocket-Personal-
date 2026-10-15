// js/features/library.js — content library browser.
import { $, esc } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { apiCall } from '../core/api.js';

export function bindLibrary(){
  const backBtn = $("libraryBackBtn");
  if(backBtn) backBtn.addEventListener("click", ()=> window._elabSwitchTab("home"));
  const backToList = $("libraryBackToList");
  if(backToList) backToList.addEventListener("click", showLibraryList);
  // Loading is triggered by inline switchTab via window._elabLoadLibrary
}

async function loadLibraryList(){
  const box = $("libraryList");
  if(!box) return;
  box.innerHTML = `<div class="hint">...</div>`;
  try{
    const r = await apiCall("/api/collections");
    const cols = r.collections || [];
    if(cols.length === 0){
      box.innerHTML = `<div class="hint">${esc(t("libraryEmpty") || "Chưa có bộ sưu tập nào.")}</div>`;
      return;
    }
    box.innerHTML = cols.map(c=>`
      <button class="pp-app-row" data-col="${esc(c.id)}" style="width:100%;text-align:left;cursor:pointer;border:1px solid var(--pp-line);margin-bottom:8px">
        <span class="pp-app-tx"><span class="pp-app-name">${esc(c.title)}</span><span class="pp-app-desc">${esc(c.description || "")} · ${c.item_count || 0} bài</span></span>
        <span class="pp-app-go">›</span>
      </button>`).join("");
    box.querySelectorAll("[data-col]").forEach(btn=>{
      btn.addEventListener("click", ()=> showCollectionDetail(btn.getAttribute("data-col")));
    });
  }catch(e){
    box.innerHTML = `<div class="hint">Error: ${esc(e.message || "failed")}</div>`;
  }
}

function showLibraryList(){
  $("libraryDetail").style.display = "none";
  $("libraryList").style.display = "block";
}

async function showCollectionDetail(id){
  const detail = $("libraryDetail");
  const list = $("libraryList");
  if(!detail || !list) return;
  list.style.display = "none";
  detail.style.display = "block";
  $("libraryDetailItems").innerHTML = `<div class="hint">...</div>`;
  try{
    const r = await apiCall("/api/collections/" + encodeURIComponent(id));
    $("libraryDetailTitle").textContent = r.collection.title;
    const items = r.items || [];
    if(items.length === 0){
      $("libraryDetailItems").innerHTML = `<div class="hint">Chưa có bài nào.</div>`;
      return;
    }
    $("libraryDetailItems").innerHTML = items.map((it, i)=>`
      <div style="padding:10px;border:1px solid var(--pp-line);border-radius:8px;margin-bottom:8px">
        <div style="font-weight:600">${i+1}. ${esc(it.title)}</div>
        ${it.excerpt ? `<div style="font-size:13px;color:var(--pp-mut);margin-top:4px">${esc(it.excerpt)}</div>` : ""}
        ${it.content_url ? `<a href="${esc(it.content_url)}" target="_blank" style="font-size:13px;color:var(--pp-accent)">Mở bài học →</a>` : ""}
      </div>`).join("");
  }catch(e){
    $("libraryDetailItems").innerHTML = `<div class="hint">Error: ${esc(e.message || "failed")}</div>`;
  }
}

// Expose for inline switchTab hook (no module dependency in inline script)
window._elabLoadLibrary = loadLibraryList;
