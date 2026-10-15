// js/features/auth.js — server auth, encrypted sentence bank, admin panel.
// Cross-feature calls go through hooks (set by bindAuth); core deps are imported.
import { $, esc, store, toast, inlineConfirm } from '../core/dom.js';
import { state } from '../core/state.js';
import { apiCall , authHeaders} from '../core/api.js';
import { t, applyUIMode } from '../core/i18n.js';

let H = {};
export function setAuthHooks(h){ H = Object.assign(H, h); }
function hook(name, ...args){ const f = H[name]; if(typeof f === "function") return f(...args); }

export const enc = new TextEncoder(), dec = new TextDecoder();
export async function deriveKey(password, salt){
  const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {name:"PBKDF2", salt, iterations:100000, hash:"SHA-256"},
    km, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"]
  );
}
export async function encryptData(key, obj){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, enc.encode(JSON.stringify(obj)));
  return {iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...new Uint8Array(ct)))};
}
export async function decryptData(key, payload){
  const iv = Uint8Array.from(atob(payload.iv), c=>c.charCodeAt(0));
  const ct = Uint8Array.from(atob(payload.data), c=>c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({name:"AES-GCM", iv}, key, ct);
  return JSON.parse(dec.decode(pt));
}
export async function serverRegister(email, password, dob){
  const j = await apiCall("/api/auth/register", {method:"POST", body: JSON.stringify({email, password, dob})});
  return j;
}
export async function serverLogin(email, password){
  const fp = {screen: screen.width+"x"+screen.height, tz: Intl.DateTimeFormat().resolvedOptions().timeZone||"", lang: navigator.language||""};
  const j = await apiCall("/api/auth/login", {method:"POST", body: JSON.stringify({email, password, fp})});
  state.authToken = j.token; state.authUser = {email: j.email, role: j.role, ageGroup: j.ageGroup||"adult"};
  // Token lưu dạng chuỗi thường (RULES.md 8). KHÔNG dùng store.set vì nó JSON.stringify
  // -> token thành "\"abc\"" gây 401 oan ở mọi chỗ đọc raw (Chốt 2026-10-11).
  try{ localStorage.setItem("elab_authToken", state.authToken); }catch(e){}
  store.set("authUser", state.authUser);
  state.uiMode = state.authUser.ageGroup;
  const _at = document.getElementById("menuAdminTile");
  if(_at) _at.style.display = state.authUser.role==="admin" ? "" : "none";
  const _hab = document.getElementById("homeAdminBtn");
  if(_hab) _hab.style.display = state.authUser.role==="admin" ? "" : "none";
  applyUIMode(H);
  const salt = enc.encode("bank-"+j.email.toLowerCase());
  state.userKey = await deriveKey(password, salt);
  state.bank = await loadServerBank();
  hook("loadServerReadings");
  return state.authUser;
}
export async function serverLogout(){
  try{ await apiCall("/api/auth/logout", {method:"POST"}); }catch(e){}
  state.authToken = null; state.authUser = null; state.userKey = null; state.bank = [];
  // Logout phải XOÁ token, không ghi "null" (store.set stringify null thành chuỗi "null" vẫn truthy).
  try{ localStorage.removeItem("elab_authToken"); }catch(e){}
  store.set("authUser", null);
  
  state.readData = []; state.curScanId = null; state.selSentIdx = -1; hook("hideSentBar");
  $("readSents").innerHTML = ""; $("readArticle").innerHTML = "";
  $("readResultCard").style.display = "none"; $("readPreview").style.display = "none";
  state.readCanvas = null; hook("updateReadGo");
  hook("loadScanHist");
  hook("resetPlayAllBtn"); state.curServerReadingId = null; hook("loadServerReadings");
  hook("renderStats"); hook("renderBank"); hook("renderPath"); updateAuthUI();
}
export async function loadServerBank(){
  if(!state.authToken || !state.userKey) return [];
  try{
    const j = await apiCall("/api/bank");
    if(!j.bank) return [];
    return await decryptData(state.userKey, j.bank);
  }catch(e){ return []; }
}
export async function unlockBank(password){
  if(!state.authUser || !state.authToken) throw new Error("No session");
  const salt = enc.encode("bank-"+state.authUser.email.toLowerCase());
  const key = await deriveKey(password, salt);
  const j = await apiCall("/api/bank");
  let data = [];
  if(j.bank) data = await decryptData(key, j.bank); 
  state.userKey = key; state.bank = data;
  hook("renderStats"); hook("renderBank"); hook("renderPath"); updateAuthUI();
}
export async function saveServerBank(){
  if(!state.authToken || !state.userKey) return;
  try{
    // PHASE 4 fix (was critical bug): POST the ENCRYPTED payload, never plaintext.
    const payload = await encryptData(state.userKey, state.bank.slice(-500));
    await apiCall("/api/bank", {method:"POST", body: JSON.stringify({bank: payload})});
  }catch(e){}
}
export function updateAuthUI(){
  // Restore auth state from storage on page load (fix: state.authUser was null after refresh)
  // state.authToken đã được state.js đọc + migrate ở lúc import (chuỗi thường, đã unwrap).
  // Chỉ cần khôi phục authUser; không đọc lại token qua store.get vì nó JSON.parse
  // sẽ trả null với token chuỗi thường.
  if(!state.authUser){
    const savedUser = store.get("authUser", null);
    if(savedUser && state.authToken){
      state.authUser = savedUser;
    }
  }
  const btn = $("userBtn");
  if(btn){
    if(state.authUser){
      const ic = !state.userKey ? "i-lock" : (state.authUser.role === "admin" ? "i-crown" : "i-user");
      btn.innerHTML = `<svg class="ic"><use href="#${ic}"/></svg>`;
      btn.title = state.authUser.email + " (" + state.authUser.role + (state.userKey ? "" : ", locked") + ")";
    }else{
      btn.innerHTML = `<svg class="ic"><use href="#i-key"/></svg>`; btn.title = "Login";
    }
  }
  
  const at = $("tabBtnAdmin");
  if(at) at.style.display = state.authUser && state.authUser.role === "admin" ? "" : "none";
  const hab = $("homeAdminBtn");
  if(hab) hab.style.display = state.authUser && state.authUser.role === "admin" ? "" : "none";
}
export function openAuth(){ renderAuthMain(); $("authBox").style.display = "flex"; }
export function closeAuth(){ $("authBox").style.display = "none"; }
export function renderAuthMain(){
  const body = $("authBody");
  const closeBtn = `<button class="gptX" onclick="closeAuth()" title="Close"><svg class="ic"><use href="#i-close"/></svg></button><button class="gptX" id="authThemeBtn" title="Theme" style="right:58px"><svg class="ic"><use href="#i-moon"/></svg></button>`;
  let h = "";
  if(state.authUser){
    const isAdmin = state.authUser.role === "admin";
    h += `${closeBtn}<div class="gptWrap">
      <div class="gptAvatarBig">${esc(state.authUser.email[0].toUpperCase())}</div>
      <h1 class="gptH1" style="font-size:21px;word-break:break-all">${esc(state.authUser.email)}</h1>
      <p class="gptHint">${isAdmin?"<svg class='ic'><use href='#i-crown'/></svg> ADMINISTRATOR":"<svg class='ic'><use href='#i-book'/></svg> LEARNER"} · <svg class='ic'><use href='#i-lock'/></svg> ${t("bankEncrypted")}</p>`;
    if(!state.userKey){
      h += `<p class="gptHint"><svg class="ic"><use href="#i-lock"/></svg> <b>${t("lockedTitle")}</b> ${t("lockedHint")}</p>
        <label class="gptLabel">${t("passPh")}</label>
        <input class="gptInput" id="authUnlockPass" type="password" autocomplete="current-password">
        <button class="gptBtn" id="authUnlockBtn"><svg class="ic"><use href="#i-unlock"/></svg> ${t("unlockData")}</button>`;
    }
    if(isAdmin) h += `<button class="gptBtnGhost" id="authGoAdmin"><svg class="ic"><use href="#i-crown"/></svg> ${t("adminPanel")}</button>`;
    h += `<button class="gptBtnGhost" id="authLogout"><svg class="ic"><use href="#i-logout"/></svg> ${t("logout")}</button>
      <div class="gptFoot"><a>${t("gptTerms")}</a> · <a>${t("gptPrivacy")}</a></div>
    </div>`;
  }else{
    const isReg = state.authMode === "reg";
    h += `${closeBtn}<div class="gptWrap">
      <div class="gptLogo"><svg class="ic"><use href="#i-book"/></svg></div>
      <h1 class="gptH1">${isReg?t("gptCreateTitle"):t("gptWelcomeBack")}</h1>
      <label class="gptLabel">${t("emailPh")}</label>
      <input class="gptInput" id="authEmail" type="email" autocomplete="email" autocapitalize="off">
      <label class="gptLabel">${t("passPh")}</label>
      <input class="gptInput" id="authPass" type="password" autocomplete="current-password">
      <div id="regDobWrap" style="display:none">
        <label class="gptLabel">${t("dobLbl")}</label>
        <input class="gptInput" id="authDob" type="date" max="${new Date().toISOString().slice(0,10)}">
      </div>
      <button class="gptBtn" id="gptContinue">${t("gptContinue")}</button>
      <div class="gptSwitch">${isReg?t("gptHaveAccount"):t("gptNoAccount")} <a id="gptSwitchMode">${isReg?t("gptLogIn"):t("gptSignUp")}</a></div>
      <div class="gptFoot"><a>${t("gptTerms")}</a> · <a>${t("gptPrivacy")}</a></div>
    </div>`;
  }
  body.innerHTML = h;
  if(state.authUser){
    if($("authUnlockBtn")) $("authUnlockBtn").onclick = async ()=>{
      const pw = $("authUnlockPass").value;
      if(!pw){ toast("Enter password"); return; }
      try{ await unlockBank(pw); renderAuthMain(); toast("Unlocked"); }
      catch(e){ toast("Wrong password"); }
    };
    $("authLogout").onclick = async ()=>{ await serverLogout(); renderAuthMain(); toast("Logged out"); };
    if($("authGoAdmin")) $("authGoAdmin").onclick = ()=>{ closeAuth(); hook("switchTab", "admin"); };
  }else{
    const isReg = state.authMode === "reg";
    const doAuth = async ()=>{
      const em = $("authEmail").value.trim().toLowerCase(), pw = $("authPass").value;
      if(!em || !pw){ toast("Enter email and password"); return; }
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)){ toast("Enter a valid email address"); return; }
      try{
        if(isReg){
          const dob = $("authDob").value;
          if(!dob){ toast("Pick your birth date"); $("regDobWrap").style.display = "block"; return; }
          const j = await serverRegister(em, pw, dob);
          toast(j.role==="admin" ? "Welcome, Admin!" : j.ageGroup==="kid" ? "Chào bé!" : "Account created!");
        }
        await serverLogin(em, pw);
        hook("renderStats"); hook("renderBank"); hook("renderPath"); updateAuthUI();
        hook("restoreLastScan"); 
        closeAuth(); toast(`Welcome!`);
        hook("switchTab", "scan");
      }catch(e){ toast(e.message); }
    };
    $("gptContinue").onclick = ()=>{
      if(!isReg){ doAuth(); return; }
      
      const w = $("regDobWrap");
      if(w.style.display === "none"){ w.style.display = "block"; toast("Pick birth date, then tap Continue again"); }
      else doAuth();
    };
    $("gptSwitchMode").onclick = ()=>{ state.authMode = isReg ? "login" : "reg"; renderAuthMain(); };
    $("authPass").onkeydown = e=>{ if(e.key==="Enter") doAuth(); };
  }
}
// Expose for inline onclick handlers
if(typeof window !== "undefined") window.closeAuth = closeAuth;
export async function renderProfile(){
  const box = $("profileContent");
  const u = state.authUser;
  if(!u){
    box.innerHTML = `<div class="hint">Not logged in.</div><button class="btn primary" onclick="document.querySelector('[data-go=scan]').click()" style="margin-top:12px">Go to login</button>`;
    return;
  }
  // Fetch plan info
  let planInfo = {plan:"free"};
  try{
    const {getPlan} = await import('./billing.js');
    planInfo = await getPlan();
  }catch(e){}
  const planNames = {free:"Free", hocsinh:"Học sinh", sinhvien:"Sinh viên", dilam:"Đi làm", nhadautu:"Nhà đầu tư", admin:"Admin"};
  const planLabel = planNames[planInfo.plan] || planInfo.plan;
  const expiryText = planInfo.expires_at
    ? new Date(planInfo.expires_at).toLocaleDateString() + ` (${planInfo.days_left} days left)`
    : (planInfo.plan==="free" ? "—" : "Lifetime");
  const lookups = (()=>{ try{ return JSON.parse(localStorage.getItem("elab_lookups")||"[]").length; }catch(e){ return 0; } })();
  const readings = (()=>{ try{ return (JSON.parse(localStorage.getItem("elab_readings")||"[]")).length; }catch(e){ return 0; } })();
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
      <div class="profileavatar" style="width:64px;height:64px;font-size:28px">${esc(u.email[0].toUpperCase())}</div>
      <div>
        <div style="font-weight:700;font-size:18px;word-break:break-all">${esc(u.email)}</div>
        <div class="hint">${u.role==="admin"?'<svg class="ic ic-h"><use href="#i-crown"/></svg> Administrator':'<svg class="ic ic-h"><use href="#i-book"/></svg> Learner'} · ${esc(u.ageGroup||"adult")}</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:12px;padding:16px;background:var(--card2)">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><b>Plan:</b> <span style="color:var(--accent);font-weight:700">${planLabel}</span></div>
        ${planInfo.plan==="free" ? `<button class="btn primary" id="profileUpgrade" style="padding:8px 16px">Upgrade</button>` : ""}
      </div>
      ${planInfo.plan!=="free"&&planInfo.plan!=="admin" ? `<div class="hint" style="margin-top:8px">Expires: ${expiryText}</div><button class="btn ghost" id="profileUpgrade" style="width:100%;margin-top:8px">Renew / Extend</button>` : ""}
    </div>
    <div class="row" style="gap:12px">
      <div class="card" style="flex:1;text-align:center;padding:16px"><div style="font-size:24px;font-weight:700">${lookups}</div><div class="hint">Words looked up</div></div>
      <div class="card" style="flex:1;text-align:center;padding:16px"><div style="font-size:24px;font-weight:700">${readings}</div><div class="hint">Readings</div></div>
    </div>
    <button class="btn ghost" id="profileLogout" style="width:100%;margin-top:16px"><svg class="ic"><use href="#i-logout"/></svg> Log out</button>`;
  const _up = $("profileUpgrade");
  if(_up) _up.onclick = ()=>{ try{ document.querySelector('[data-go="upgrade"]').click(); }catch(e){} };
  $("profileLogout").onclick = async ()=>{ await serverLogout(); location.reload(); };
  const _at = $("menuAdminTile");
  if(_at) _at.style.display = u.role==="admin" ? "" : "none";
}
export async function renderAdmin(){
  const box = $("adminContent");
  if(!state.authUser || state.authUser.role !== "admin"){
    box.innerHTML = '<div class="hint">Admin only.</div>'; return;
  }
  box.innerHTML = '<div class="hint">Loading…</div>';
  try{
    const [usersJ, insightsJ] = await Promise.all([
      apiCall("/api/admin/users"),
      fetch("/api/insights").then(r=>r.json()),
    ]);
    let h = `<h4 style="margin:12px 0 8px"><svg class="ic ic-h"><use href="#i-user"/></svg> Users (${usersJ.users.length})</h4>`;
    usersJ.users.forEach(u=>{
      const isSelf = u.email === state.authUser.email;
      const planLbl = u.plan && u.plan!=="free" ? `<span style="color:var(--accent);font-weight:700">${esc(u.plan)}</span>` : '<span class="hint">free</span>';
      h += `<div class="profileitem" style="cursor:default">
        <div class="profileavatar">${esc(u.email[0].toUpperCase())}</div>
        <div style="flex:1"><div style="font-weight:700;word-break:break-all">${esc(u.email)} ${u.role==="admin"?"<svg class='ic'><use href='#i-crown'/></svg>":""}</div>
        <div class="hint">${new Date(u.created).toLocaleDateString()} · ${planLbl}</div></div>
        ${!isSelf ? `<select class="planSel" data-user="${esc(u.email)}" style="padding:6px;border-radius:8px;margin-right:6px">
          <option value="">Set plan…</option>
          <option value="free">Free</option>
          <option value="hocsinh">Học sinh</option>
          <option value="sinhvien">Sinh viên</option>
          <option value="dilam">Đi làm</option>
          <option value="nhadautu">Nhà đầu tư</option>
        </select>
        <button class="btn ghost delUser" data-user="${esc(u.email)}" style="padding:8px 10px"><svg class="ic"><use href="#i-trash"/></svg></button>` : '<span class="hint">you</span>'}
      </div>`;
    });
    // Plan activation handlers
    box.querySelectorAll(".planSel").forEach(sel=>{
      sel.onchange = async ()=>{
        if(!sel.value) return;
        const email = sel.dataset.user;
        if(!await inlineConfirm(t("confirmPlanSet").replace("{email}",email).replace("{plan}",sel.value), t("confirmYes"), t("confirmNo"))) { sel.value=""; return; }
        try{
          const {apiCall} = await import('../core/api.js');
          await apiCall("/api/admin/set-plan", {method:"POST", body:JSON.stringify({email, plan:sel.value})});
          toast("Plan updated!");
          renderAdmin();
        }catch(e){ toast("Failed: "+(e.message||"error")); sel.value=""; }
      };
    });
    // Pending books for shared library
    try{
      const pendingJ = await apiCall("/api/admin/books/pending");
      if(pendingJ.books && pendingJ.books.length){
        h += `<h4 style="margin:16px 0 8px"><svg class="ic ic-h"><use href="#i-book"/></svg> Pending books (${pendingJ.books.length})</h4>`;
        pendingJ.books.forEach(b=>{
          h += `<div class="profileitem" style="cursor:default">
            <div style="flex:1"><div style="font-weight:700">${esc(b.title)}</div>
            <div class="hint">${esc(b.user)} · ${b.chapters} chapters</div></div>
            <button class="btn primary approveBook" data-id="${esc(b.id)}" data-user="${esc(b.user)}" data-title="${esc(b.title)}" style="padding:8px 12px">Approve</button>
          </div>`;
        });
      }
    }catch(e){}
    h += `<h4 style="margin:16px 0 8px"><svg class="ic ic-h"><use href="#i-chart"/></svg> Corpus stats</h4>
      <div class="hint">Learners: <b>${insightsJ.learners||0}</b> · Scans: <b>${insightsJ.scans||0}</b></div>
      <div class="hint">CEFR: ${Object.entries(insightsJ.cefr||{}).map(([k,v])=>k+":"+v).join(" ")}</div>
      <div class="hint" style="margin-top:8px">Top looked up: <b>${(insightsJ.topLookups||[]).slice(0,8).map(x=>x.w).join(", ")||"—"}</b></div>`;
    box.innerHTML = h;
    box.querySelectorAll(".approveBook").forEach(btn=>{
      btn.onclick = async ()=>{
        try{
          await apiCall("/api/admin/books/approve", {method:"POST", body: JSON.stringify({bookId: btn.dataset.id, user: btn.dataset.user, title: btn.dataset.title})});
          toast("Approved!"); renderAdmin();
        }catch(e){ toast("Error: "+e.message); }
      };
    });
    box.querySelectorAll(".delUser").forEach(btn=>{
      btn.onclick = async ()=>{
        if(!await inlineConfirm(t("confirmDeleteUser").replace("{user}",btn.dataset.user), t("confirmYes"), t("confirmNo"))) return;
        try{
          await fetch("/api/admin/users/"+encodeURIComponent(btn.dataset.user), {method:"DELETE", headers: authHeaders()});
          toast("Deleted"); renderAdmin();
        }catch(e){ toast("Error"); }
      };
    });
  }catch(e){
    box.innerHTML = '<div class="hint">Error: '+esc(e.message)+'</div>';
  }
}
// One-time wiring for auth surfaces. Consolidates the previously duplicated
// top-level bindings ($("userBtn").onclick, authBox backdrop, unlock card).
export function bindAuth(hooks={}){
  // Theme toggle on auth page
  document.addEventListener('click', e=>{
    // Dùng chung controller theme toàn app (window.__elabTheme trong <head>).
    // Bản cũ đọc/ghi qua store (JSON) lệch với chuỗi thường của shell.
    if(e.target.closest('#authThemeBtn') && window.__elabTheme) window.__elabTheme.toggle();
  });
  setAuthHooks(hooks);
  // Inline onclick="closeAuth()" inside renderAuthMain templates needs a global.
  window.closeAuth = closeAuth;
  window.openAuth = openAuth;
  $("userBtn").onclick = openAuth;
  $("authBox").addEventListener("click", e=>{ if(e.target.id==="authBox") closeAuth(); });
  $("unlockBtn").onclick = async ()=>{
    const pw = $("unlockPass").value;
    if(!pw){ toast("Enter password"); return; }
    try{ await unlockBank(pw); $("unlockPass").value = ""; toast("Unlocked"); }
    catch(e){ toast("Wrong password"); }
  };
}
