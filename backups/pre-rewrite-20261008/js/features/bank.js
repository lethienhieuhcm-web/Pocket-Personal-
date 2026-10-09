// js/features/bank.js — sentence bank, stats, learning path.
import { $, esc, store, toast, inlineConfirm } from '../core/dom.js';
import { state , LV_W, LV_ORDER, LV_COLOR} from '../core/state.js';
import { classifyCEFR } from '../core/utils.js';
import { t, levelLabel, kidLevelName } from '../core/i18n.js';
import { saveServerBank } from './auth.js';
import { makeSentenceEl } from './sentence.js';

export function saveBank(){
  state.bank = state.bank.slice(-500);
  // Only save to server when fully authenticated (token + key)
  // Otherwise keep in memory only — NEVER write to shared storage
  if(state.authToken && state.userKey){ saveServerBank(); }
}
export function normSent(s){
  return s.toLowerCase().replace(/[^a-z0-9\s]/g,"").replace(/\s+/g," ").trim();
}
export function addToBank(sentences){
  const now = Date.now();
  const have = new Set(state.bank.map(b => normSent(b.t)));
  let added = 0;
  sentences.forEach(s => {
    const n = normSent(s);
    if(n.length < 10) return;
    // skip near-duplicates: 80%+ word overlap with existing
    let dup = have.has(n);
    if(!dup){
      const words = new Set(n.split(" "));
      for(const b of state.bank){
        const bw = new Set(normSent(b.t).split(" "));
        const inter = [...words].filter(w=>bw.has(w)).length;
        const union = new Set([...words, ...bw]).size;
        if(union > 0 && inter/union > 0.8){ dup = true; break; }
      }
    }
    if(!dup){
      state.bank.push({ t: s, cefr: classifyCEFR(s) || "B1", ts: now });
      have.add(n);
      added++;
    }
  });
  state.bank = state.bank.slice(-500);
  saveBank();
  renderStats(); renderBank(); renderPath();
  return added;
}
export function bankLevel(){ // estimated level or null
  if(!state.bank.length) return null;
  const dist = {A1:0,A2:0,B1:0,B2:0,C1:0,C2:0};
  state.bank.forEach(b => { if(dist[b.cefr]!==undefined) dist[b.cefr]++; });
  const weights = {A1:1,A2:2,B1:3,B2:4,C1:5,C2:6};
  let total = 0, sum = 0;
  for(const lv in dist){ total += dist[lv]; sum += dist[lv]*weights[lv]; }
  const avg = total ? sum/total : 3;
  return avg<1.5?"A1":avg<2.5?"A2":avg<3.5?"B1":avg<4.5?"B2":avg<5.5?"C1":"C2";
}
export function renderStats(){
  const locked = !!(state.authUser && !state.userKey);
  $("unlockCard").style.display = locked ? "" : "none";
  const has = state.bank.length > 0;
  $("progressDash").style.display = has ? "" : "none";
  $("emptyBankCard").style.display = (!has && !locked) ? "" : "none";
  if(!has) return;
  const dist = {A1:0,A2:0,B1:0,B2:0,C1:0,C2:0};
  state.bank.forEach(b => { if(dist[b.cefr]!==undefined) dist[b.cefr]++; });
  const level = bankLevel() || "B1";
  // stat tiles
  $("stSent").textContent = state.bank.length;
  $("stLevel").textContent = state.uiMode==="kid" ? kidLevelName(level) : level;
  const days = new Set(state.bank.map(b=>new Date(b.ts||Date.now()).toDateString())).size;
  $("stDays").textContent = days;
  const words = state.bank.reduce((n,b)=>n + String(b.t).split(/\s+/).length, 0);
  $("stWords").textContent = words>999 ? (words/1000).toFixed(1)+"k" : words;
  // profile
  const total = state.bank.length;
  $("levelEstimate").innerHTML = `Estimated reading level: <b style="color:var(--accent);font-size:20px">${state.uiMode==="kid"?kidLevelName(level):level}</b>`;
  const colors = {A1:"#4ade80",A2:"#a3e635",B1:"#facc15",B2:"#fb923c",C1:"#f87171",C2:"#c084fc"};
  const lvLbl = lv => state.uiMode==="kid" ? kidLevelName(lv) : lv;
  let bars = "";
  for(const lv of ["A1","A2","B1","B2","C1","C2"]){
    const pct = total ? Math.round(dist[lv]/total*100) : 0;
    bars += `<div class="row" style="margin:5px 0"><span style="width:34px;font-weight:800;font-size:14px">${lvLbl(lv)}</span><div style="flex:1;background:var(--card2);border-radius:6px;height:14px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${colors[lv]};transition:width .5s"></div></div><span style="width:40px;text-align:right;font-size:13px;color:#6e6e80">${dist[lv]}</span></div>`;
  }
  $("levelBars").innerHTML = bars;
}
export function renderBank(){
  if(!state.bank.length) return;
  $("bankCount").textContent = state.bank.length;
  // level filter options
  const sel = $("bankFilter");
  const cur = sel.value;
  sel.innerHTML = `<option value="">${t("allLevels")}</option>` +
    ["A1","A2","B1","B2","C1","C2"].map(lv=>`<option value="${lv}" ${cur===lv?"selected":""}>${state.uiMode==="kid"?kidLevelName(lv):lv}</option>`).join("");
  const box = $("bankList");
  box.innerHTML = "";
  const q = state.bankQ.trim().toLowerCase();
  [...state.bank].reverse().forEach((b, idx) => {
    if(state.bankLv && b.cefr !== state.bankLv) return;
    if(q && !String(b.t).toLowerCase().includes(q)) return;
    const realIdx = state.bank.length - 1 - idx;
    box.appendChild(makeSentenceEl(b.t, b.cefr, ()=>{
      state.bank.splice(realIdx, 1); saveBank(); renderStats(); renderBank(); renderPath();
    }));
  });
  if(!box.children.length) box.innerHTML = `<div class="hint">${t("noMatch")}</div>`;
}
export function renderPath(){
  const card = $("pathCard"), box = $("pathContent");
  if(state.bank.length < 5){
    card.style.display = "";
    box.innerHTML = `<div class="hint">Scan at least ${5-state.bank.length} more sentence${5-state.bank.length>1?"s":""} and I'll build your personalized learning path.</div>`;
    return;
  }
  card.style.display = "";
  const recent = state.bank.slice(-30);
  let sum = 0;
  recent.forEach(b => sum += LV_W[b.cefr] || 3);
  const avg = sum / recent.length;
  const curIdx = Math.min(5, Math.max(0, Math.round(avg)-1));
  const cur = LV_ORDER[curIdx];
  const next = curIdx < 5 ? LV_ORDER[curIdx+1] : null;

  // Progress: share of recent sentences at next level or above
  let pct = 100, needMsg = "";
  if(next){
    const nw = LV_W[next];
    const hit = recent.filter(b => (LV_W[b.cefr]||0) >= nw).length;
    pct = Math.round(hit / recent.length * 100);
    const need = Math.max(0, Math.ceil(recent.length*0.4) - hit);
    needMsg = need > 0
      ? `Read <b>${need}</b> more ${next}-level sentence${need>1?"s":""} to level up`
      : `Ready to level up! Keep reading ${next} material.`;
  } else {
    needMsg = "You've reached C2 — keep challenging yourself!";
  }

  // Personalized recommendations from data
  const recs = [];
  const dist = {};
  recent.forEach(b => dist[b.cefr] = (dist[b.cefr]||0)+1);
  const curShare = (dist[cur]||0)/recent.length;
  if(next && curShare > 0.6){
    recs.push(`<b>Push harder:</b> ${Math.round(curShare*100)}% of what you read is ${cur}. Try ${next}-level articles (news, essays) to stretch.`);
  }
  // Vocabulary sophistication trend
  const words = recent.join(" ").match(/[A-Za-z]{8,}/g) || [];
  const avgLong = words.length / recent.length;
  if(avgLong < 1.5){
    recs.push(`<b>Vocabulary:</b> your texts use simple words (avg ${avgLong.toFixed(1)} long words/sentence). Tap unfamiliar words to learn them.`);
  }
  // Consistency
  const days = new Set(state.bank.map(b => new Date(b.ts).toDateString())).size;
  if(days < 3 && state.bank.length >= 10){
    recs.push(`<b>Consistency:</b> you've scanned on ${days} day${days>1?"s":""}. A little every day beats cramming.`);
  }
  // Variety
  const uniqStarts = new Set(recent.map(b => b.t.slice(0,20).toLowerCase())).size;
  if(uniqStarts < recent.length * 0.7){
    recs.push(`<b>Variety:</b> some sentences look similar. Try different topics — tech, science, stories.`);
  }
  if(!recs.length && next){
    recs.push(`<b>On track:</b> good mix of levels. Keep reading ${next} material to advance.`);
  }

  box.innerHTML = `
    <div class="pathlevel">
      <span class="pathbadge" style="background:${LV_COLOR[cur]}">${cur}</span>
      <div style="flex:1">
        <div style="font-weight:700">Level ${cur}${next ? ` → ${next}` : ""}</div>
        <div class="hint">${needMsg}</div>
      </div>
    </div>
    ${next ? `<div class="pathbar"><div style="width:${pct}%"></div></div>
    <div class="hint" style="text-align:right;margin-top:4px">${pct}% to ${next}</div>` : ""}
    <div style="margin-top:10px">${recs.map(r=>`<div class="rec">${r}</div>`).join("")}</div>
    <div class="hint" style="margin-top:8px">Based on your last ${recent.length} sentences · ${state.bank.length} total</div>
  `;
}

// Wiring for bank surfaces (was top-level in index.html).
// Idempotent: safe to call from both main.js lazy hooks and router.
let _bound = false;
export function bindBank(){
  if(_bound) return; _bound = true;
  $("bankSearch").oninput = e=>{ state.bankQ = e.target.value; renderBank(); };
  $("bankFilter").onchange = e=>{ state.bankLv = e.target.value; renderBank(); };
  $("bankClear").onclick = async ()=>{
    if(!await inlineConfirm(t("confirmClearBank"), t("confirmYes"), t("confirmNo"))) return;
    state.bank = []; saveBank(); renderStats(); renderBank(); renderPath();
  };
}
