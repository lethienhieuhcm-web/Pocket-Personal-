// js/features/tts.js — ElevenLabs TTS proxy, word audio, article player.
import { $, toast, idb, store, inlineConfirm } from '../core/dom.js';
import { state, SILENT_WAV } from '../core/state.js';
import { apiCall, apiFetchRaw , authHeaders} from '../core/api.js';
import { hashStr, chunkText, fmtT } from '../core/utils.js';
import { t } from '../core/i18n.js';

export async function updateQuota(){
  try{
    const j = await apiCall("/api/quota");
    const s = j.subscription || {};
    const left = (s.character_limit||0) - (s.character_count||0);
    $("quotaLine").innerHTML = `<b>${left.toLocaleString()}</b> credits left — plan <b>${s.tier||"?"}</b>`;
  }catch(e){ try{ $("quotaLine").textContent = ""; }catch(e2){} }
}

export async function getElBlob(text){
  const voice = $("voiceSel").value, model = $("modelSel").value;
  if(!voice){ toast("Pick a voice in Settings"); throw new Error("no voice"); }
  const key = "el|"+voice+"|"+model+"|"+text;
  const cached = await idb.get(key);
  if(cached) return cached;
  const r = await apiFetchRaw("/api/tts", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({text, voice_id: voice, model_id: model})
  });
  const blob = await r.blob();
  idb.put(key, blob);
  return blob;
}
export async function getElURL(text){
  const voice = $("voiceSel").value, model = $("modelSel").value;
  const key = "el|"+voice+"|"+model+"|"+text;
  if(state.memCache.has(key)) return state.memCache.get(key);
  const url = URL.createObjectURL(await getElBlob(text));
  state.memCache.set(key, url);
  return url;
}
export function stopSpeaking(){
  state.speechToken++;
  if(state.playerResolve){ const r = state.playerResolve; state.playerResolve = null; r(); }
  try{ const a = $("player"); a.pause(); a.removeAttribute("src"); a.load(); }catch(e){}
}
export function playURL(url, rate=1){
  return new Promise((res, rej)=>{
    const a = $("player");
    state.playerResolve = res;
    a.src = url; a.playbackRate = rate;
    a.onended = ()=>{ state.playerResolve = null; res(); };
    a.onerror = ()=>{ state.playerResolve = null; rej(new Error("play fail")); };
    a.play().catch(e=>{ state.playerResolve = null; rej(e); });
  });
}
export function speakWordBrowser(text){
  try{
    speechSynthesis.pause();
    const u=new SpeechSynthesisUtterance(text);
    u.lang="en-US";
    u.onend=u.onerror=()=>{ try{ speechSynthesis.resume(); }catch(e){} };
    speechSynthesis.speak(u);
    setTimeout(()=>{ try{ speechSynthesis.resume(); }catch(e){} }, Math.max(2500, text.length*150));
  }catch(e){ try{ speechSynthesis.resume(); }catch(_){} }
}
export function resetPlayAllBtn(){ apStop(); } // legacy name: close the article player
export async function confirmLongAudio(text){
  if(text.length <= 3000) return true;
  const c = text.length.toLocaleString("en-US");
  const m = Math.max(1, Math.round(text.length/800));
  return inlineConfirm(t("longAudioConfirm").split("{c}").join(c).split("{m}").join(m), t("confirmYes"), t("confirmNo"));
}
export function apShow(){ $("artPlayer").classList.add("show"); }
export function apHide(){ $("artPlayer").classList.remove("show"); }
export function apStop(){
  try{ const a=$("player"); a.pause(); a.removeAttribute("src"); a.load(); }catch(e){}
  const pb=$("apPlay"); if(pb) pb.innerHTML='<svg class="ic" style="width:28px;height:28px"><use href="#i-play"/></svg>';
  apHide();
}
export function apSetStatus(t){ const el=$("apStatus"); if(!el) return; if(!t){ el.style.display="none"; return; } el.style.display="block"; el.textContent=t; }
export async function apEnsureBlob(text){
  const key = "art|"+text.length+"|"+hashStr(text);
  state.apLastGen = false;
  if(state.apBlob && state.apBlobKey===key) return state.apBlob;
  if(state.curServerReadingId){
    try{
      const r = await fetch("/api/readings/"+state.curServerReadingId+"/audio", {headers:authHeaders()});
      if(r.ok){
        const blob = await r.blob();
        if(state.apBlobUrl) URL.revokeObjectURL(state.apBlobUrl);
        state.apBlob=blob; state.apBlobUrl=URL.createObjectURL(blob); state.apBlobKey=key;
        return blob;
      }
    }catch(e){}
  }
  if(!confirmLongAudio(text)){ const e=new Error("cancelled"); e.cancelled=true; throw e; }
  state.apLastGen = true; // real ElevenLabs generation happened below
  const chunks = chunkText(text);
  const blobs = [];
  for(let i=0;i<chunks.length;i++){
    apSetStatus(`Creating audio\u2026 ${i+1}/${chunks.length}`);
    blobs.push(await getElBlob(chunks[i]));
  }
  const blob = new Blob(blobs,{type:"audio/mpeg"});
  if(state.apBlobUrl) URL.revokeObjectURL(state.apBlobUrl);
  state.apBlob=blob; state.apBlobUrl=URL.createObjectURL(blob); state.apBlobKey=key;
  return blob;
}
export async function openArticlePlayer(text, serverId){
  // Unlock audio inside the tap gesture (mobile browsers block play() after async gaps)
  try{
    const u = $("player");
    if(!u.dataset.unlocked){
      u.dataset.unlocked = "1";
      u.src = SILENT_WAV;
      const pr = u.play();
      if(pr && pr.catch) pr.catch(()=>{});
    }
  }catch(e){}
  if(!text){ try{ const m = await import('./read.js'); text = m.fullArticleText(); }catch(e){} }
  if(!text){ toast("Nothing to play"); return; }
  if(!(await import("./settings.js")).needVoice()) return;
  if(serverId !== undefined) state.curServerReadingId = serverId;
  stopSpeaking(); // stop any sentence-level playback on the shared element
  apShow(); apSetStatus("Creating audio\u2026");
  const pb=$("apPlay"); pb.innerHTML='<svg class="ic" style="width:28px;height:28px"><use href="#i-play"/></svg>'; pb.disabled=true;
  try{
    await apEnsureBlob(text);
    if(state.apLastGen){ state.apLastGen = false; (await import("./audio.js")).autoSaveAudio(text, state.apBlob); }
    const a = $("player");
    a.src = state.apBlobUrl; a.playbackRate = state.apSpeeds[state.apSpeedIdx]; a.loop = state.apLoop;
    apSetStatus(null); pb.disabled=false;
    await a.play();
  }catch(e){ if(e&&e.cancelled){ apStop(); return; } toast("Playback error: "+(e.message||e)); apStop(); }
}
export function downloadUrl(url, name){
  const a=document.createElement("a"); a.href=url; a.download=name;
  document.body.appendChild(a); a.click(); a.remove();
}
export function initArticlePlayer(){
  const card = $("readResultCard"), hint = $("readResultHint"), pl = $("artPlayer");
  if(card && hint && pl.parentElement !== card) card.insertBefore(pl, hint);
  const a = $("player");
  a.addEventListener("play", ()=>{ $("apPlay").innerHTML='<svg class="ic" style="width:28px;height:28px"><use href="#i-pause"/></svg>'; });
  a.addEventListener("pause", ()=>{ $("apPlay").innerHTML='<svg class="ic" style="width:28px;height:28px"><use href="#i-play"/></svg>'; });
  a.addEventListener("loadedmetadata", ()=>{ $("apDur").textContent=fmtT(a.duration); });
  a.addEventListener("ended", ()=>{ if(!a.loop){ try{a.currentTime=0;}catch(e){} } });
  a.addEventListener("timeupdate", ()=>{
    if(state.apSeeking) return;
    const d=a.duration||0, p=d?(a.currentTime/d*100):0;
    $("apFill").style.width=p+"%"; $("apKnob").style.left=p+"%";
    $("apCur").textContent=fmtT(a.currentTime);
    if(d) $("apDur").textContent=fmtT(d);
  });
  $("apPlay").onclick = ()=>{ const x=$("player"); if(x.paused) x.play().catch(e=>toast(e.message||"Play failed")); else x.pause(); };
  $("apBack").onclick = ()=>{ const x=$("player"); x.currentTime=Math.max(0,x.currentTime-10); };
  $("apFwd").onclick = ()=>{ const x=$("player"); x.currentTime=Math.min(x.duration||0,x.currentTime+10); };
  $("apSpeed").onclick = ()=>{ state.apSpeedIdx=(state.apSpeedIdx+1)%state.apSpeeds.length; $("player").playbackRate=state.apSpeeds[state.apSpeedIdx]; $("apSpeed").textContent=state.apSpeeds[state.apSpeedIdx]+"x"; };
  $("apLoop").onclick = ()=>{ state.apLoop=!state.apLoop; $("player").loop=state.apLoop; $("apLoop").style.opacity=state.apLoop?1:.4; };
  $("apDl").onclick = ()=>{
    if(!state.apBlob){ toast("Audio not ready yet"); return; }
    downloadUrl(state.apBlobUrl, `english-lab-${new Date().toISOString().slice(0,10)}.mp3`);
  };
  $("apClose").onclick = ()=>apStop();
  const seek=$("apSeek");
  const doSeek = e=>{
    const r=seek.getBoundingClientRect();
    const cx=(e.touches&&e.touches[0])?e.touches[0].clientX:e.clientX;
    const p=Math.min(1,Math.max(0,(cx-r.left)/r.width));
    const x=$("player");
    if(x.duration) x.currentTime=p*x.duration;
    $("apFill").style.width=(p*100)+"%"; $("apKnob").style.left=(p*100)+"%";
  };
  seek.addEventListener("pointerdown", e=>{ state.apSeeking=true; try{seek.setPointerCapture(e.pointerId);}catch(_){} doSeek(e); });
  seek.addEventListener("pointermove", e=>{ if(state.apSeeking) doSeek(e); });
  seek.addEventListener("pointerup", ()=>{ state.apSeeking=false; });
  seek.addEventListener("pointercancel", ()=>{ state.apSeeking=false; });
}
export async function loadVoices(){
  try{
    const j = await apiCall("/api/voices");
    const sel = $("voiceSel"); sel.innerHTML = "";
    (j.voices||[]).forEach(v=>{
      const o = document.createElement("option");
      const accent = v.labels && v.labels.accent ? " ("+v.labels.accent+")" : "";
      o.value = v.voice_id; o.textContent = v.name + accent;
      sel.appendChild(o);
    });
    const saved = store.get("voice","");
    if(saved && [...sel.options].some(o=>o.value===saved)) sel.value = saved;
    else{
      const pref = [...sel.options].find(o=>/rachel/i.test(o.textContent))
                || [...sel.options].find(o=>/adam/i.test(o.textContent));
      if(pref) sel.value = pref.value;
    }
    sel.onchange = ()=>store.set("voice", sel.value);
    updateQuota();
  }catch(e){ toast("Voice load error: "+e.message); }
}

export function speakBrowserOne(text, rate){
  return new Promise(res=>{
    try{
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US"; u.rate = rate;
      u.onend = u.onerror = ()=>res();
      speechSynthesis.cancel(); speechSynthesis.speak(u);
      setTimeout(res, Math.max(3000, text.length*120));
    }catch(e){ res(); }
  });
}
export async function speakBrowser(text, {slow=false}={}){
  await speakBrowserOne(text, slow ? 0.7 : 1);
}
