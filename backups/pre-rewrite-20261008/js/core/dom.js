// js/core/dom.js — DOM helpers, storage. Zero dependencies.
export const $ = id => document.getElementById(id);
export function toast(msg, ms=3500){
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(t._tm); t._tm = setTimeout(()=>t.style.display="none", ms);
}
export function esc(s){ return String(s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

/* Inline confirm bar (replaces confirm()): bottom action bar, page stays interactive.
   Returns Promise<boolean>. */
export function inlineConfirm(msg, yesLabel="Yes", noLabel="No"){
  return new Promise(resolve=>{
    let bar = $("confirmBar");
    if(!bar){
      bar = document.createElement("div");
      bar.id = "confirmBar";
      document.body.appendChild(bar);
    }
    bar.innerHTML = `<span style="flex:1;min-width:0">${esc(msg)}</span>`
      + `<button class="btn primary" id="cfYes" style="padding:9px 18px;flex:none">${esc(yesLabel)}</button>`
      + `<button class="btn ghost" id="cfNo" style="padding:9px 18px;flex:none">${esc(noLabel)}</button>`;
    bar.style.display = "flex";
    const done = v=>{ bar.style.display = "none"; resolve(v); };
    $("cfYes").onclick = ()=>done(true);
    $("cfNo").onclick = ()=>done(false);
  });
}export const store = {
  get(k, d){ try{ const v = localStorage.getItem("elab_"+k); return v===null? d : JSON.parse(v);}catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem("elab_"+k, JSON.stringify(v)); }catch(e){ toast("Storage full!"); } }
};

/* ---------- audio cache (IndexedDB) ---------- */
export const idb = {
  db:null,
  open(){ return new Promise((res, rej)=>{
    if(this.db) return res(this.db);
    const r = indexedDB.open("readlearn", 1);
    r.onupgradeneeded = ()=>r.result.createObjectStore("audio");
    r.onsuccess = ()=>{ this.db = r.result; res(this.db); };
    r.onerror = ()=>rej(r.error);
  });},
  async get(k){ try{ const db = await this.open();
    return new Promise(res=>{ const t = db.transaction("audio").objectStore("audio").get(k);
      t.onsuccess = ()=>res(t.result||null); t.onerror = ()=>res(null); });
  }catch(e){ return null; } },
  async put(k, v){ try{ const db = await this.open();
    db.transaction("audio","readwrite").objectStore("audio").put(v, k);
  }catch(e){} },
  async del(k){ try{ const db = await this.open();
    db.transaction("audio","readwrite").objectStore("audio").delete(k);
  }catch(e){} },
  async keys(){ try{ const db = await this.open();
    return new Promise(res=>{ const t = db.transaction("audio").objectStore("audio").getAllKeys();
      t.onsuccess = ()=>res(t.result||[]); t.onerror = ()=>res([]); });
  }catch(e){ return []; } }
};
