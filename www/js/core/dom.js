// js/core/dom.js — DOM helpers, storage. Zero dependencies.
export const $ = id => document.getElementById(id);
export function toast(msg, ms=3500){
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(t._tm); t._tm = setTimeout(()=>t.style.display="none", ms);
}
export function esc(s){ return String(s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
export const store = {
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
