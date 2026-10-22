/**
 * Rà đích chạm (touch target audit) — đo mọi phần tử tương tác hiển thị
 * ở bề ngang điện thoại 390px trên các trang chính, báo phần tử nào
 * thấp/hẹp hơn chuẩn 44px (Apple HIG). Dùng chung hạ tầng với gate.js:
 * relay local + session test D1 tạm.
 *   node touch_audit.js   -> in bảng tóm tắt + ghi touch-audit.json
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const DIR = __dirname;
const BASE = 'https://lethanhdong.one';
const PAGES = [
  { name: 'landing', url: '/' },
  { name: 'login', url: '/login' },
  { name: 'hub', url: '/hub', auth: true },
  { name: 'english', url: '/english/', auth: true },
  { name: 'music', url: '/music/', auth: true },
  { name: 'voice', url: '/voice/', auth: true },
  { name: 'chess', url: '/chess/', auth: true },
  { name: 'stocks', url: '/stocks/', auth: true },
];
const MIN = 44;

function portOpen(port) {
  return new Promise(res => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.end(); res(true); });
    s.once('error', () => res(false));
  });
}

async function main() {
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
  const report = [];
  try {
    for (const pg of PAGES) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx.addInitScript(tok => {
        try {
          localStorage.setItem('elab_authToken', tok);
          localStorage.setItem('elab_token', tok);
        } catch (e) {}
      }, pg.auth ? token : '');
      const page = await ctx.newPage();
      try {
        await page.goto(BASE + pg.url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);
        const data = await page.evaluate(min => {
          const els = [...document.querySelectorAll('a,button,input,select,textarea,[onclick],[role="button"],summary')];
          const bad = [];
          let total = 0;
          for (const el of els) {
            let r = el.getBoundingClientRect();
            // Checkbox/radio: đích bấm thật là <label> bọc ngoài (bấm chữ cũng
            // toggle) — đo theo label tổ tiên nếu có.
            if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
              const lab = el.closest('label');
              if (lab) r = lab.getBoundingClientRect();
            }
            if (!r.width || !r.height) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
            total++;
            if (r.height < min || r.width < min) {
              bad.push({
                tag: el.tagName.toLowerCase(),
                cls: typeof el.className === 'string' ? el.className.slice(0, 60) : '',
                id: el.id || '',
                text: (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 30),
                w: Math.round(r.width), h: Math.round(r.height),
              });
            }
          }
          return { total, bad };
        }, MIN);
        report.push({ page: pg.name, ...data });
        console.log(`${pg.name}: ${data.total} phần tử tương tác, ${data.bad.length} dưới ${MIN}px`);
      } catch (e) {
        report.push({ page: pg.name, error: e.message });
        console.log(pg.name + ': LỖI', e.message);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    try { execFileSync('python3', [path.join(DIR, 'make_gate_token.py'), '--cleanup', token], { stdio: 'ignore' }); } catch (e) {}
    if (relay) relay.kill();
  }
  fs.writeFileSync(path.join(DIR, 'touch-audit.json'), JSON.stringify(report, null, 2));
  // Tóm tắt theo chữ ký (tag+class): số lần xuất hiện + kích thước nhỏ nhất
  const agg = new Map();
  for (const p of report) for (const b of p.bad || []) {
    const k = `${b.tag}.${b.cls}`;
    const a = agg.get(k) || { n: 0, minH: 999, minW: 999, sample: b.text, pages: new Set() };
    a.n++; a.minH = Math.min(a.minH, b.h); a.minW = Math.min(a.minW, b.w); a.pages.add(p.page);
    agg.set(k, a);
  }
  console.log('\n=== Nhóm dưới chuẩn (theo tag.class) ===');
  [...agg.entries()].sort((x, y) => x[1].minH - y[1].minH).forEach(([k, a]) =>
    console.log(`${k}  x${a.n}  min ${a.minW}x${a.minH}px  [${[...a.pages].join(',')}]  vd: "${a.sample}"`));
}

main().catch(e => { console.error(e); process.exit(1); });
