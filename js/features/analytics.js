// js/features/analytics.js — opt-in anonymous usage analytics.
import { store } from '../core/dom.js';
import { classifyCEFR } from '../core/utils.js';

export function analyticsOn(){ return store.get("analytics", false) === true; }
export function trackLookup(word){
  if(!analyticsOn()) return;
  try{
    fetch("/api/analytics", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({type:"lookup", word: String(word).toLowerCase().slice(0,40)})});
  }catch(e){}
}
export function trackScan(sents){
  if(!analyticsOn() || !sents.length) return;
  try{
    const words = {};
    sents.join(" ").toLowerCase().replace(/[^a-z\s']/g," ").split(/\s+/)
      .forEach(w=>{ if(w.length>2) words[w]=(words[w]||0)+1; });
    const cefr = {};
    sents.forEach(s=>{ const c=classifyCEFR(s); if(c) cefr[c]=(cefr[c]||0)+1; });
    fetch("/api/analytics", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({type:"scan", words, cefr, scans: sents.length})});
  }catch(e){}
}
