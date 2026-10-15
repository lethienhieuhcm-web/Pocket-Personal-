// js/shared/i18n.js — Shared i18n module (Gốc G2, 2026-10-12)
// Big-tech pattern: một nơi duy nhất quản lý ngôn ngữ.
// Hỗ trợ cả key mới (namespaced: 'byok.saved') và key cũ (flat: 'byok_saved').

import { vi } from './locales/vi.js';
import { en } from './locales/en.js';
import { zh } from './locales/zh.js';
import { ko } from './locales/ko.js';

const LOCALES = { vi, en, zh, ko };

// Flatten nested objects: {byok: {saved: "x"}} → {"byok.saved": "x", "byok_saved": "x"}
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') {
      flatten(v, newKey, out);
      // Also add flat version with underscore for backward compat
      const flatPrefix = prefix ? `${prefix}_${k}` : k;
      flattenFlat(v, flatPrefix, out);
    } else {
      out[newKey] = v;
    }
  }
  return out;
}

function flattenFlat(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const newKey = `${prefix}_${k}`;
    if (v && typeof v === 'object') {
      flattenFlat(v, newKey, out);
    } else {
      out[newKey] = v;
    }
  }
}

const FLAT = {};
for (const [lang, data] of Object.entries(LOCALES)) {
  FLAT[lang] = flatten(data);
}

let currentLang = 'vi';
let currentApp = null; // Namespace của app hiện tại (hub, stocks, ...)

export function setApp(app) {
  currentApp = app;
}

export function setLang(lang) {
  if (LOCALES[lang]) currentLang = lang;
}

export function getLang() {
  return currentLang;
}

export function t(key) {
  const dict = FLAT[currentLang] || FLAT.en;
  // Ưu tiên namespace của app hiện tại (vd: hub.subtitle)
  if (currentApp) {
    const appKey = currentApp + '.' + key;
    if (dict[appKey] !== undefined) return dict[appKey];
  }
  // Ưu tiên namespace elab cho key byok_* (tránh xung đột với namespace byok gốc)
  if (key.startsWith('byok_')) {
    const elabKey = 'elab.' + key;
    if (dict[elabKey] !== undefined) return dict[elabKey];
  }
  // Thử key như-is (hỗ trợ cả 'byok.saved' và 'byok_saved')
  if (dict[key] !== undefined) return dict[key];
  // Fallback: thử với namespace elab (tương thích key cũ flat của English Lab)
  const elabKey = 'elab.' + key;
  if (dict[elabKey] !== undefined) return dict[elabKey];
  // Fallback về tiếng Anh
  const enDict = FLAT.en;
  if (currentApp) {
    const appKey = currentApp + '.' + key;
    if (enDict[appKey] !== undefined) return enDict[appKey];
  }
  if (key.startsWith('byok_')) {
    const elabKeyEn = 'elab.' + key;
    if (enDict[elabKeyEn] !== undefined) return enDict[elabKeyEn];
  }
  if (enDict[key] !== undefined) return enDict[key];
  if (enDict[elabKey] !== undefined) return enDict[elabKey];
  // Cuối cùng trả về key
  return key;
}

// Khởi tạo từ localStorage nếu có
try {
  const saved = localStorage.getItem('pp_lang') || localStorage.getItem('elab_uiLang');
  if (saved && LOCALES[saved]) currentLang = saved;
} catch (e) {}

// Tương thích với code cũ: expose ra window
if (typeof window !== 'undefined') {
  window.__elabI18n = { t, setLang, getLang, setApp };
}
