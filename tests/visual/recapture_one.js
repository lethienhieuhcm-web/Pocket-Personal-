/**
 * Chụp lại MỘT ảnh baseline bị lỗi (vd timeout) mà không chạy lại cả bộ.
 *   node recapture_one.js <page> <viewport> <theme>
 *   vd: node recapture_one.js hub tablet light
 * Dùng đúng tham số như capture.js (viewport, init script, chờ render).
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const DIR = __dirname;
const BASE = 'https://lethanhdong.one';
const PAGES = {
  landing: { url: '/' }, login: { url: '/login' },
  hub: { url: '/hub', auth: true }, english: { url: '/english/', auth: true },
  music: { url: '/music/', auth: true }, voice: { url: '/voice/', auth: true },
  chess: { url: '/chess/', auth: true }, stocks: { url: '/stocks/', auth: true },
};
const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
};

function portOpen(port) {
  return new Promise(res => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.end(); res(true); });
    s.once('error', () => res(false));
  });
}

async function main() {
  const [name, vpName, theme] = process.argv.slice(2);
  const pg = PAGES[name], vp = VIEWPORTS[vpName];
  if (!pg || !vp || !['light', 'dark'].includes(theme)) {
    console.error('Tham số: <page> <mobile|tablet|desktop> <light|dark>');
    process.exit(1);
  }
  let relay = null;
  if (!(await portOpen(18899))) {
    relay = spawn('node', [path.join(DIR, 'relay.js')], { stdio: 'ignore' });
    for (let i = 0; i < 20 && !(await portOpen(18899)); i++)
      await new Promise(r => setTimeout(r, 250));
  }
  const token = execFileSync('python3', [path.join(DIR, 'make_gate_token.py')], { encoding: 'utf8' }).trim();
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    executablePath: '/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--no-sandbox'],
    proxy: { server: 'http://127.0.0.1:18899' },
  });
  try {
    const ctx = await browser.newContext({ viewport: vp });
    await ctx.addInitScript(({ t, tok }) => {
      try {
        localStorage.setItem('hub_theme', t);
        localStorage.setItem('pp_theme', t);
        localStorage.setItem('elab_theme', t);
        localStorage.setItem('theme', t);
        if (tok) {
          localStorage.setItem('elab_authToken', tok);
          localStorage.setItem('elab_token', tok);
        }
      } catch (e) {}
    }, { t: theme, tok: pg.auth ? token : null });
    const page = await ctx.newPage();
    const file = `${name}-${vpName}-${theme}.png`;
    await page.goto(BASE + pg.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      document.querySelectorAll('[class*="banner"],[id*="banner"]').forEach(el => {
        if (/bản mới|update/i.test(el.textContent || '')) el.style.display = 'none';
      });
    }).catch(() => {});
    await page.screenshot({ path: path.join(DIR, 'baseline', file), fullPage: false });
    console.log('OK', file);
    await ctx.close();
  } finally {
    await browser.close();
    try { execFileSync('python3', [path.join(DIR, 'make_gate_token.py'), '--cleanup', token], { stdio: 'ignore' }); } catch (e) {}
    if (relay) relay.kill();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
