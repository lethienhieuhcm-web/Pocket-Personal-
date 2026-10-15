// js/shared/byok.js — Shared BYOK UI component (Gốc G1, 2026-10-12)
// Dùng chung cho: Stocks, English Lab, Talk, app tương lai.
// Pattern big tech: 1 codebase, tham số hoá bằng config, không copy-paste.
//
// Cách dùng:
//   import { initByok } from '../shared/byok.js';
//   initByok({ prefix: 'stk', app: 'stocks', t: t });
//
// Config:
//   prefix: tiền tố ID ('stk' → stkByokKey, '' → byokKey)
//   app: tên app ('stocks' | 'english' | 'talk') cho per-app override
//   t: hàm dịch (key) → string

import { $ } from '../core/dom.js';
import {
  getUserKey, saveUserKey, deleteUserKey,
  getUserModel, saveUserModel,
  getBaseUrl, saveBaseUrl,
  getResponseLength, saveResponseLength,
  getAppEndpoint, saveAppEndpoint, deleteAppEndpoint,
  getAppModel, saveAppModel, deleteAppModel,
  isAppCustom, proxyModels,
  getSmallModel, saveSmallModel
} from '../core/aiClient.js';

let boundPrefixes = {};

export function initByok(config){
  const prefix = config.prefix || '';
  const APP = config.app || 'stocks';
  const t = config.t || ((k) => k);

  // Chống bind 2 lần cùng prefix
  if(boundPrefixes[prefix]) return;
  boundPrefixes[prefix] = true;

  const id = (name) => prefix ? prefix + 'Byok' + name : 'byok' + name;

  const keyInput = $(id('Key'));
  const testBtn = $(id('Test'));
  // Stocks dùng stkByokDel, English Lab dùng byokDelete
  const delBtnFinal = $(id('Del')) || $(id('Delete'));
  const statusEl = $(id('Status'));
  const endpointInput = $(id('Endpoint'));
  const modelSel = $(id('Model'));

  if(!keyInput || !testBtn || !delBtnFinal) return;

  function setStatus(msg, ok){
    if(statusEl){
      statusEl.textContent = msg;
      statusEl.style.color = ok ? "var(--pp-accent)" : "var(--pp-danger)";
    }
  }

  const customToggle = $(id('Custom'));
  const shareHint = $(id('ShareHint'));
  let useCustom = false;

  function updateHint(){
    if(shareHint) shareHint.textContent = useCustom
      ? (t("byok_custom_hint") || "Custom")
      : (t("byok_shared_hint") || "Shared");
  }

  const customWrap = $(id('ModelCustomWrap'));
  const customInput = $(id('ModelCustom'));

  function toggleCustomModel(){
    const isCustomM = modelSel && modelSel.value === "__custom__";
    if(customWrap) customWrap.style.display = isCustomM ? "" : "none";
  }

  async function loadFields(){
    const ep = useCustom
      ? await getAppEndpoint(APP).catch(() => null)
      : await getBaseUrl().catch(() => null);
    const mo = useCustom
      ? await getAppModel(APP).catch(() => null)
      : await getUserModel().catch(() => null);
    if(endpointInput) endpointInput.value = ep || "";
    if(modelSel && modelSel.tagName === "SELECT"){
      if(mo){
        let has = false;
        for(let i = 0; i < modelSel.options.length; i++){
          if(modelSel.options[i].value === mo){ has = true; break; }
        }
        if(!has){
          const o = document.createElement("option");
          o.value = mo; o.textContent = mo;
          modelSel.appendChild(o);
        }
        modelSel.value = mo;
      } else modelSel.value = "";
    } else if(modelSel && mo) modelSel.value = mo;
    toggleCustomModel();
    updateHint();
  }

  // Khởi tạo toggle custom
  if(customToggle){
    isAppCustom(APP).then(v => {
      useCustom = !!v;
      customToggle.checked = useCustom;
      loadFields();
    }).catch(() => { loadFields(); });
    customToggle.addEventListener("change", async () => {
      useCustom = customToggle.checked;
      if(useCustom){
        const sharedEp = await getBaseUrl().catch(() => null);
        const sharedMo = await getUserModel().catch(() => null);
        const curEp = await getAppEndpoint(APP).catch(() => null);
        const curMo = await getAppModel(APP).catch(() => null);
        if(sharedEp && !curEp) await saveAppEndpoint(APP, sharedEp).catch(() => {});
        if(sharedMo && !curMo) await saveAppModel(APP, sharedMo).catch(() => {});
      } else {
        await deleteAppEndpoint(APP).catch(() => {});
        await deleteAppModel(APP).catch(() => {});
      }
      loadFields();
    });
  } else {
    loadFields();
  }

  // Load existing key (luôn dùng chung)
  getUserKey().then(k => { if(k) keyInput.value = k; }).catch(() => {});

  // Chọn độ dài trả lời (luôn dùng chung qua IDB)
  const rlenSel = $(id('RLen'));
  if(rlenSel){
    getResponseLength().then(v => { rlenSel.value = String(v); }).catch(() => {});
    rlenSel.addEventListener("change", () => {
      saveResponseLength(rlenSel.value).catch(() => {});
    });
  }

  // tốc T5-router: Model nhỏ cho việc dễ (tra từ). Text input, để trống =
  // dùng model chính. Chỉ bind khi ô tồn tại (English Lab có, Stocks không).
  const smallModelInput = $(id('SmallModel'));
  if(smallModelInput){
    getSmallModel().then(v => { if(v) smallModelInput.value = v; }).catch(() => {});
    smallModelInput.addEventListener("change", () => {
      saveSmallModel(smallModelInput.value).catch(() => {});
    });
  }

  // Endpoint: lưu theo chế độ
  if(endpointInput){
    endpointInput.addEventListener("input", () => {
      const v = endpointInput.value.trim();
      if(!v) return;
      if(useCustom) saveAppEndpoint(APP, v).catch(() => {});
      else saveBaseUrl(v).catch(() => {});
    });
  }

  // Auto-save key on input (luôn dùng chung)
  keyInput.addEventListener("input", () => {
    const v = keyInput.value.trim();
    if(v) saveUserKey(v)
      .then(() => setStatus(t("byok_saved") || "Saved", true))
      .catch(() => {});
  });

  // Model selection
  if(modelSel){
    modelSel.addEventListener("change", () => {
      const v = modelSel.value;
      if(v === "__custom__"){
        toggleCustomModel();
        if(customInput) customInput.focus();
        return;
      }
      toggleCustomModel();
      if(!v) return;
      if(useCustom) saveAppModel(APP, v).catch(() => {});
      else saveUserModel(v).catch(() => {});
    });
  }

  if(customInput){
    customInput.addEventListener("change", () => {
      const v = customInput.value.trim();
      if(!v) return;
      if(useCustom) saveAppModel(APP, v).catch(() => {});
      else saveUserModel(v).catch(() => {});
    });
  }

  // Test button
  testBtn.addEventListener("click", async () => {
    const k = keyInput.value.trim();
    if(!k){
      setStatus((t("byok_test_fail") || "Key failed: ") + (t("byok_err_empty") || "empty"), false);
      return;
    }
    testBtn.disabled = true;
    setStatus("...", true);
    try{
      const base = endpointInput ? endpointInput.value.trim() : null;
      const models = await proxyModels({ baseUrl: base, key: k });
      if(models && models.length > 0){
        // Populate dropdown
        if(modelSel && modelSel.tagName === "SELECT"){
          const curVal = modelSel.value;
          modelSel.innerHTML = "";
          const ph = document.createElement("option");
          ph.value = ""; ph.textContent = t("byok_model_select") || "Select model...";
          modelSel.appendChild(ph);
          models.forEach(m => {
            const o = document.createElement("option");
            o.value = m; o.textContent = m;
            modelSel.appendChild(o);
          });
          const co = document.createElement("option");
          co.value = "__custom__"; co.textContent = t("byok_model_custom") || "Enter manually...";
          modelSel.appendChild(co);
          if(curVal) modelSel.value = curVal;
        }
        setStatus(t("byok_test_ok") || "Key works!", true);
      } else {
        setStatus(t("byok_test_fail") || "Key failed", false);
      }
    }catch(e){
      const st = e.status || 0;
      if(st === 0 || st === 404 || st === 405){
        setStatus(t("byok_err_unreachable") || "Manual mode", true);
        if(modelSel && modelSel.tagName === "SELECT"){
          let hasC = false;
          for(let i = 0; i < modelSel.options.length; i++){
            if(modelSel.options[i].value === "__custom__"){ hasC = true; break; }
          }
          if(!hasC){
            const co2 = document.createElement("option");
            co2.value = "__custom__";
            co2.textContent = t("byok_model_custom") || "Enter manually...";
            modelSel.appendChild(co2);
          }
          modelSel.value = "__custom__";
          if(customWrap) customWrap.style.display = "";
          if(customInput) customInput.focus();
        } else if(modelSel) modelSel.focus();
      } else {
        setStatus((t("byok_test_fail") || "Key failed: ") + (e.detail || ("HTTP " + st)), false);
      }
    }finally{
      testBtn.disabled = false;
    }
  });

  // Delete button
  delBtnFinal.addEventListener("click", async () => {
    await deleteUserKey();
    keyInput.value = "";
    if(modelSel){
      modelSel.innerHTML = "";
      const ph = document.createElement("option");
      ph.value = ""; ph.textContent = t("byok_model_select") || "Select model...";
      modelSel.appendChild(ph);
    }
    setStatus(t("byok_deleted") || "Key deleted", true);
  });
}
