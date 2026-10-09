// js/features/scan.js — OCR/photo scan input, scan history.
import { $, esc, toast, store } from '../core/dom.js';
import { state } from '../core/state.js';
import { cleanOCRText } from '../core/utils.js';
import { t } from '../core/i18n.js';

let H = {};
export function setScanHooks(h){ H = Object.assign(H, h); }
function hook(name, ...args){ const f = H[name]; if(typeof f === "function") return f(...args); }

export function handleReadFile(file){
  if(!file) return;
  const img = new Image();
  img.onload = ()=>{
    const MAXW = 1600;
    const scale = Math.min(1, MAXW / img.width);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width*scale));
    c.height = Math.max(1, Math.round(img.height*scale));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    state.readCanvas = c;
    const pv = $("readPreview");
    pv.src = c.toDataURL("image/jpeg", 0.85);
    pv.style.display = "block";
    updateReadGo();
    $("readResultCard").style.display = "none";
    URL.revokeObjectURL(img.src);
  };
  img.onerror = ()=>toast("Can't read the image file");
  img.src = URL.createObjectURL(file);
}

export function loadReadTesseract(){
  if(state.readTessLoading) return state.readTessLoading;
  state.readTessLoading = new Promise((res, rej)=>{
    if(window.Tesseract) return res();
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
    s.onload = res;
    s.onerror = ()=>rej(new Error("Can't download OCR engine — check connection"));
    document.head.appendChild(s);
  });
  return state.readTessLoading;
}

export async function runReadOCR(){
  if(!state.readCanvas){ toast("Take or pick a photo first"); return; }
  const btn = $("readGo"); btn.disabled = true;
  $("readProg").style.display = "block";
  const setP = (p, msg)=>{
    $("readBar").style.width = Math.round(p*100)+"%";
    if(msg) $("readStatus").textContent = msg;
  };
  try{
    setP(0.03, "Downloading OCR engine (first time only)…");
    await loadReadTesseract();
    setP(0.08, "Starting…");
    const worker = await Tesseract.createWorker("eng", 1, {
      logger: m=>{
        if(m.status==="recognizing text")
          setP(0.1 + m.progress*0.9, "Reading… "+Math.round(m.progress*100)+"%");
      }
    });
    const { data } = await worker.recognize(state.readCanvas);
    await worker.terminate();
    const text = (data.text||"").trim();
    $("readProg").style.display = "none";
    if(!text){ toast("No text found — try a closer, clearer shot"); return; }
    hook("renderReadText", text, {src:"scan"});
    state.readCanvas = null; // consumed — button now follows the textarea
    hook("switchTab", "read");
    toast("Done! Tap a sentence or word.");
  }catch(e){
    $("readProg").style.display = "none";
    toast("OCR error: "+(e.message||e));
  }finally{ updateReadGo(); }
};

/* Reusable interactive sentence: hear all, tap word = speak + dict */
export function scanHistKey(){
  const u = state.authUser && state.authUser.email ? String(state.authUser.email).toLowerCase() : "guest";
  return "scans_" + u; // stored via store → elab_ prefix, per-user isolation
}
export function loadScanHist(){
  state.scanHistory = store.get(scanHistKey(), []) || [];
  if(!Array.isArray(state.scanHistory)) state.scanHistory = [];
  state.curScanId = null;
  renderScanHistSel();
}
export function saveScanHist(){
  store.set(scanHistKey(), state.scanHistory.slice(-10));
}
export function renderScanHistSel(){
  const sel = $("scanHistSel"), row = $("scanHistRow");
  if(!sel || !row) return;
  if(!state.scanHistory.length){ row.style.display = "none"; return; }
  row.style.display = "";
  sel.innerHTML = [...state.scanHistory].reverse().map(s=>{
    const d = new Date(s.ts || Date.now());
    const wc = String(s.text||"").split(/\s+/).filter(Boolean).length;
    const lbl = `${s.src||"scan"} ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})} · ${wc} ${t("wordsU")}`;
    return `<option value="${s.id}"${s.id===state.curScanId?" selected":""}>${esc(lbl)}</option>`;
  }).join("");
}
export function restoreLastScan(){
  loadScanHist();
  if(state.scanHistory.length){
    const last = state.scanHistory[state.scanHistory.length-1];
    hook("renderReadText", last.text, {skipBank:true, silent:true, id:last.id, src:last.src, ts:last.ts});
  }
}
export function updateReadGo(){
  const btn = $("readGo");
  const hasImg = !!state.readCanvas;
  const hasText = $("readTextInput").value.trim().length > 0;
  btn.disabled = !(hasImg || hasText);
  const lbl = $("readGoLbl"), use = $("readGoUse");
  if(hasImg){ lbl.textContent = t("readGoPhoto"); use.setAttribute("href", "#i-camera"); }
  else if(hasText){ lbl.textContent = t("readGoText"); use.setAttribute("href", "#i-doc"); }
  else { lbl.textContent = t("readGoIdle"); use.setAttribute("href", "#i-book"); }
}
// Wiring for scan input surfaces (was top-level in index.html).
export function bindScan(hooks={}){
  setScanHooks(hooks);
  $("readTextInput").addEventListener("input", updateReadGo);
  // Android: capture="environment" opens camera directly. iOS Chrome: capture is buggy.
  if(!/iPad|iPhone|iPod/.test(navigator.userAgent)){
    $("readFileCam").setAttribute("capture", "environment");
  }
  $("readFileCam").onchange = e=>handleReadFile(e.target.files[0]);
  $("readFileLib").onchange = e=>handleReadFile(e.target.files[0]);
  $("scanHistSel").addEventListener("change", e=>{
    const s = state.scanHistory.find(x=>String(x.id)===e.target.value);
    if(s) hook("renderReadText", s.text, {skipBank:true, silent:true, id:s.id, src:s.src, ts:s.ts});
  });
  $("readGo").onclick = ()=>{
    try{
      if(state.readCanvas){ runReadOCR(); return; }
      const txt = $("readTextInput").value.trim();
      if(!txt){ toast(t("readGoNeed")); return; }
      const r = hook("renderReadText", txt, {src:"text"});
      if(r === undefined) console.warn("[scan] renderReadText hook not registered");
      hook("switchTab", "read");
    }catch(e){
      console.error("[scan] Create reading failed:", e);
      toast("Error: " + (e.message || "failed"));
    }
  };
}

export function pushScanHist(text, meta){
  meta = meta || {};
  const txt = String(text);
  // Deduplicate: if same text already in history, just select it
  const existing = state.scanHistory.find(x=>x.text === txt);
  if(existing){ state.curScanId = existing.id; saveScanHist(); renderScanHistSel(); return; }
  const last = state.scanHistory[state.scanHistory.length-1];
  if(last && last.text === txt){ state.curScanId = last.id; }
  else{
    const id = meta.id != null ? meta.id : Date.now();
    state.scanHistory.push({id, text: txt.slice(0,30000), ts: meta.ts||Date.now(), src: meta.src||"scan"});
    state.scanHistory = state.scanHistory.slice(-10);
    state.curScanId = id;
  }
  saveScanHist(); renderScanHistSel();
}

export function removeScanFromHist(id){
  state.scanHistory = state.scanHistory.filter(x=>x.id!==id);
  state.curScanId = null;
  saveScanHist(); renderScanHistSel();
}
