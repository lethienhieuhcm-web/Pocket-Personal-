// js/features/audio.js — server readings + MP3 library (logged-in: R2, guest: IndexedDB).
import { $, esc, toast, idb } from '../core/dom.js';
import { state } from '../core/state.js';
import { authHeaders } from '../core/api.js';
import { hashStr, chunkText } from '../core/utils.js';
import { t } from '../core/i18n.js';
import { getElBlob, apEnsureBlob, downloadUrl, openArticlePlayer } from './tts.js';

let H = {};
export function setAudioHooks(h){ H = Object.assign(H, h); }
function hook(name, ...args){ const f = H[name]; if(typeof f === "function") return f(...args); }

export async function buildArticleMP3(text){
  const chunks = chunkText(text);
  const blobs = [];
  for(let i=0;i<chunks.length;i++){
    toast(`Creating MP3… ${i+1}/${chunks.length}`);
    blobs.push(await getElBlob(chunks[i]));
  }
  return new Blob(blobs, {type:"audio/mpeg"});
}
export function downloadBlob(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 8000);
}
export async function saveReadingToServer(text, sents){
  if(!state.authToken) return;
  try{
    const meta = state.scanHistory.find(x=>x.id===state.curScanId) || {};
    const r = await fetch("/api/readings", {method:"POST",
      headers:{...authHeaders(), "Content-Type":"application/json"},
      body: JSON.stringify({text: String(text).slice(0,30000), sentences: sents.length, src: meta.src||"✍️"})});
    const j = await r.json();
    if(j && j.id){ state.curServerReadingId = j.id; loadServerReadings(); }
  }catch(e){}
}
export async function loadServerReadings(){
  const card = $("serverReadingsCard"), box = $("serverReadings");
  if(!state.authToken){ card.style.display = "none"; return; }
  card.style.display = "block";
  box.innerHTML = '<div class="hint">Loading…</div>';
  try{
    const r = await fetch("/api/readings", {headers: authHeaders()});
    const j = await r.json();
    const arr = (j && j.readings) || [];
    if(!arr.length){ box.innerHTML = '<div class="hint">'+t("noServerReadings")+'</div>'; return; }
    box.innerHTML = arr.map(x=>{
      const d = new Date(x.ts);
      const ds = d.toLocaleDateString()+" "+d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
      return `<div class="srvrow" data-id="${x.id}">`
        + `<div style="flex:1;min-width:0"><div style="font-weight:600">${x.src==="📷"?'<svg class="ic"><use href="#i-camera"/></svg>':'<svg class="ic"><use href="#i-edit"/></svg>'} ${esc(ds)}</div>`
        + `<div class="hint" style="margin:2px 0 0">${x.words} ${t("wordsU")} · ${x.sentences} ${t("sentencesU")}${x.hasAudio?' · <svg class="ic"><use href="#i-volume"/></svg> MP3':""}</div></div>`
        + `<button class="btn ghost srvOpen" title="${t("open")}"><svg class="ic"><use href="#i-book"/></svg></button>`
        + `<button class="btn ghost srvPlay" title="${t("listen")}"><svg class="ic"><use href="#i-play"/></svg></button>`
        + `<button class="btn ghost srvMp3" title="MP3"><svg class="ic"><use href="#i-download"/></svg></button>`
        + `<button class="btn ghost srvDel" title="${t("delete")}"><svg class="ic"><use href="#i-trash"/></svg></button></div>`;
    }).join("");
    box.querySelectorAll(".srvrow").forEach(row=>{
      const id = row.dataset.id;
      row.querySelector(".srvOpen").onclick = ()=>openServerReading(id);
      row.querySelector(".srvPlay").onclick = ()=>playServerReading(id);
      row.querySelector(".srvMp3").onclick = ()=>mp3ServerReading(id);
      row.querySelector(".srvDel").onclick = ()=>delServerReading(id);
    });
  }catch(e){ box.innerHTML = '<div class="hint">Load failed</div>'; }
}
export async function getServerReading(id){
  const r = await fetch("/api/readings/"+id, {headers: authHeaders()});
  if(!r.ok) throw new Error("load failed");
  return r.json();
}
export async function openServerReading(id){
  try{
    const rec = await getServerReading(id);
    renderReadText(rec.text, {skipBank:true, silent:true, id:"srv"+id, src:rec.src, ts:rec.ts, serverId:id});
    switchTab("read");
  }catch(e){ toast("Open failed"); }
}
export async function playServerReading(id){
  try{
    const rec = await getServerReading(id);
    openArticlePlayer(rec.text, id);
  }catch(e){ toast("Play failed"); }
}
export async function mp3ServerReading(id){
  try{
    const r = await fetch("/api/readings/"+id+"/audio", {headers: authHeaders()});
    if(r.ok){ downloadBlob(await r.blob(), `english-lab-${id}.mp3`); return; }
    if(!needVoice()) return;
    const rec = await getServerReading(id);
    if(!confirmLongAudio(rec.text)) return;
    toast("No saved MP3 — generating…");
    const blob = await buildArticleMP3(rec.text);
    downloadBlob(blob, `english-lab-${id}.mp3`);
    const up = await fetch("/api/readings/"+id+"/audio",
      {method:"PUT", headers:{...authHeaders(), "Content-Type":"audio/mpeg"}, body:blob});
    if(up.ok){ toast("MP3 saved ✅"); loadServerReadings(); }
  }catch(e){ if(!(e&&e.cancelled)) toast("MP3 error: "+(e.message||e)); }
}
export async function autoSaveAudio(text, blob){
  if(!blob) return;
  const title = (state.readTitle || text.trim().split(/\s+/).slice(0,8).join(" ")).slice(0,60) || "Reading";
  try{
    if(state.authToken){
      let id = state.curServerReadingId;
      if(!id){
        const r = await fetch("/api/readings", {method:"POST",
          headers:{...authHeaders(), "Content-Type":"application/json"},
          body: JSON.stringify({text: String(text).slice(0,30000), sentences: state.readData.length, src:"🎧"})});
        const j = await r.json().catch(()=>null);
        if(j && j.id){ id = j.id; state.curServerReadingId = id; }
      }
      if(!id) return;
      const up = await fetch("/api/readings/"+id+"/audio",
        {method:"PUT", headers:{...authHeaders(), "Content-Type":"audio/mpeg"}, body: blob});
      if(up.ok){ toast("🎧 "+t("savedToAudio")); loadServerReadings(); }
    }else{
      const key = "lib|"+hashStr(text);
      if(!(await idb.get(key))){
        await idb.put(key, {title, ts: Date.now(), blob});
        toast("🎧 "+t("savedToAudio"));
      }
    }
  }catch(e){}
}
export async function renderAudioLib(){
  const box = $("audioLib"), hint = $("audioLibHint"), player = $("audioLibPlayer");
  try{ player.pause(); }catch(e){}
  player.style.display = "none"; player.removeAttribute("src");
  hint.textContent = t("audioLibHint");
  if(state.authToken){
    box.innerHTML = '<div class="hint">Loading\u2026</div>';
    try{
      const r = await fetch("/api/readings", {headers: authHeaders()});
      const arr = (((await r.json()).readings)||[]).filter(x=>x.hasAudio);
      if(!arr.length){ box.innerHTML = '<div class="hint">'+t("noAudio")+'</div>'; return; }
      box.innerHTML = arr.map(x=>{
        const d = new Date(x.ts);
        const ds = d.toLocaleDateString()+" "+d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
        return `<div class="srvrow" data-id="${x.id}">`
          + `<div style="flex:1;min-width:0"><div style="font-weight:600">${esc(x.src||"\u270D\uFE0F")} ${esc(ds)}</div>`
          + `<div class="hint" style="margin:2px 0 0">${x.words} ${t("wordsU")} · ${x.sentences} ${t("sentencesU")}</div></div>`
          + `<button class="btn ticonbtn primary srvPlayA" title="${t("listen")}"><svg class="ic"><use href="#i-play"/></svg></button>`
          + `<button class="btn ticonbtn ghost srvDelA" title="${t("delete")}"><svg class="ic"><use href="#i-trash"/></svg></button></div>`;
      }).join("");
      box.querySelectorAll(".srvrow").forEach(row=>{
        const id = row.dataset.id;
        row.querySelector(".srvPlayA").onclick = ()=>playLibAudioSrv(id);
        row.querySelector(".srvDelA").onclick = async ()=>{
          if(!confirm(t("delete")+"?")) return;
          await fetch("/api/readings/"+id+"/audio", {method:"DELETE", headers: authHeaders()});
          renderAudioLib(); loadServerReadings();
        };
      });
    }catch(e){ box.innerHTML = '<div class="hint">Load failed</div>'; }
    return;
  }
  // guest: device library
  const keys = (await idb.keys()).filter(k=>k.startsWith("lib|")).sort().reverse();
  if(!keys.length){ box.innerHTML = '<div class="hint">'+t("noAudio")+"<br>"+t("guestAudioHint")+'</div>'; return; }
  box.innerHTML = '<div class="hint" style="margin-bottom:8px">'+t("guestAudioHint")+'</div>' + keys.map(k=>{
    return `<div class="srvrow" data-k="${esc(k)}">`
      + `<div style="flex:1;min-width:0"><div style="font-weight:600"><svg class="ic ic-h"><use href="#i-headphones"/></svg> <span class="libTitle" data-k="${esc(k)}">\u2026</span></div>`
      + `<div class="hint libDate" style="margin:2px 0 0" data-k="${esc(k)}"></div></div>`
      + `<button class="btn ticonbtn primary libPlay" data-k="${esc(k)}" title="${t("listen")}"><svg class="ic"><use href="#i-play"/></svg></button>`
      + `<button class="btn ticonbtn ghost libDel" data-k="${esc(k)}" title="${t("delete")}"><svg class="ic"><use href="#i-trash"/></svg></button></div>`;
  }).join("");
  for(const k of keys){
    const item = await idb.get(k);
    if(!item) continue;
    box.querySelectorAll(`.libTitle[data-k="${CSS.escape(k)}"]`).forEach(el=>el.textContent = item.title||"Reading");
    const d = new Date(item.ts||Date.now());
    box.querySelectorAll(`.libDate[data-k="${CSS.escape(k)}"]`).forEach(el=>el.textContent = d.toLocaleDateString()+" "+d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}));
  }
  box.querySelectorAll(".libPlay").forEach(b=>b.onclick = async ()=>{
    const item = await idb.get(b.dataset.k);
    if(!item || !item.blob){ toast("Play failed"); return; }
    player.src = URL.createObjectURL(item.blob); player.style.display = "block";
    player.play().catch(()=>{});
  });
  box.querySelectorAll(".libDel").forEach(b=>b.onclick = async ()=>{
    if(!confirm(t("delete")+"?")) return;
    await idb.del(b.dataset.k); renderAudioLib();
  });
}
export async function playLibAudioSrv(id){
  const player = $("audioLibPlayer");
  try{
    const r = await fetch("/api/readings/"+id+"/audio", {headers: authHeaders()});
    if(!r.ok) throw new Error("load failed");
    const blob = await r.blob();
    player.src = URL.createObjectURL(blob); player.style.display = "block";
    player.play().catch(()=>{});
  }catch(e){ toast("Play failed"); }
}
export async function delServerReading(id){
  if(!confirm(t("delete")+"?")) return;
  try{ await fetch("/api/readings/"+id, {method:"DELETE", headers: authHeaders()}); }catch(e){}
  if(state.curServerReadingId === id) state.curServerReadingId = null;
  loadServerReadings();
}
export async function safeSpeak(text, opt){
  try{ await hook("speak", text, opt||{}); }
  catch(e){ toast("Error: "+e.message); }
}
// Wiring for audio surfaces (was top-level in index.html).
export function bindAudio(hooks={}){
  setAudioHooks(hooks);
  $("readPlayAll").onclick = ()=>openArticlePlayer();
  $("readMakeMp3").onclick = async ()=>{
    const text = hook("fullArticleText");
    if(!text){ toast("Nothing to export"); return; }
    if(!hook("needVoice")) return;
    const btn = $("readMakeMp3"); btn.disabled = true;
    try{
      const blob = await apEnsureBlob(text);
      const stamp = new Date().toISOString().slice(0,10);
      downloadUrl(URL.createObjectURL(blob), `english-lab-${stamp}.mp3`);
      if(state.authToken && state.curServerReadingId){
        toast("Saving MP3 to your library\u2026");
        const r = await fetch("/api/readings/"+state.curServerReadingId+"/audio",
          {method:"PUT", headers:{...authHeaders(), "Content-Type":"audio/mpeg"}, body:blob});
        if(r.ok){ toast("MP3 saved to your library \u2705"); loadServerReadings(); }
        else toast("MP3 downloaded \u2014 server save failed");
      }else if(!state.authToken){
        toast("MP3 downloaded \u2014 login to keep it in your library");
      }else{
        toast("MP3 downloaded \u2705");
      }
    }catch(e){ if(!(e&&e.cancelled)) toast("MP3 error: "+(e.message||e)); }
    btn.disabled = false;
  };
  $("srvReadRefresh").onclick = ()=>loadServerReadings();
  $("audioLibRefresh").onclick = ()=>renderAudioLib();
}

