// js/shared/theme.js — Shared theme module (Gốc G3, 2026-10-12)
// Big-tech pattern: một controller duy nhất cho mọi app.
// HTML cần inline script tối thiểu trong <head> để tránh flash (xem THEME_HEAD_SNIPPET).
// Module này dùng cho toggle buttons và đồng bộ.

const THEME_KEY = 'pp_theme';
const LEGACY_KEYS = ['elab_theme', 'hub_theme'];

function getSavedTheme() {
  try {
    // Migrate từ key cũ sang pp_theme thống nhất (2026-10-13)
    let v = localStorage.getItem(THEME_KEY);
    if (!v) {
      for (const k of LEGACY_KEYS) {
        v = localStorage.getItem(k);
        if (v === 'dark' || v === 'light') {
          localStorage.setItem(THEME_KEY, v);
          break;
        }
      }
    }
    return v === 'dark' ? 'dark' : 'light';
  } catch (e) {
    return 'light';
  }
}

function paint(mode) {
  const dark = mode === 'dark';
  const d = document.documentElement;
  d.setAttribute('data-theme', dark ? 'dark' : 'light');
  d.classList.toggle('pp-dark', dark);
  if (document.body) document.body.classList.toggle('dark', dark);
  // Cập nhật icon nút theme nếu có
  const tb = document.getElementById('themeBtn');
  if (tb) tb.innerHTML = '<svg class="ic"><use href="#' + (dark ? 'i-sun' : 'i-moon') + '"/></svg>';
}

export function getTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function applyTheme(mode) {
  paint(mode);
  try {
    localStorage.setItem(THEME_KEY, mode === 'dark' ? 'dark' : 'light');
  } catch (e) {}
}

export function toggleTheme() {
  applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

// Khởi tạo: áp dụng theme đã lưu + gắn controller vào window (tương thích code cũ)
export function initTheme() {
  applyTheme(getSavedTheme());
  // Tương thích với code cũ dùng window.__elabTheme
  window.__elabTheme = {
    get: getTheme,
    apply: applyTheme,
    toggle: toggleTheme,
  };
  // Đồng bộ lại khi DOM sẵn sàng (body có thể chưa có lúc script chạy)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => paint(getTheme()));
  }
}

// Auto-init khi import (cho các app dùng ES module)
if (typeof document !== 'undefined') {
  initTheme();
}

// THEME_HEAD_SNIPPET: inline script tối thiểu cho <head>, chống flash.
// Copy nguyên văn vào mọi HTML (giữa <head>), KHÔNG sửa:
// <script>try{var s=localStorage.getItem('pp_theme');if(!s){s=localStorage.getItem('elab_theme')||localStorage.getItem('hub_theme');if(s)localStorage.setItem('pp_theme',s)}var d=s?s==='dark':matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('pp-dark')}catch(e){}</script>
export const THEME_HEAD_SNIPPET = `<script>try{var s=localStorage.getItem('pp_theme');if(!s){s=localStorage.getItem('elab_theme')||localStorage.getItem('hub_theme');if(s)localStorage.setItem('pp_theme',s)}var d=s?s==='dark':matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('pp-dark')}catch(e){}</script>`;
