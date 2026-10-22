/**
 * FIT F5 — Visual regression capture.
 * Chụp screenshot 5 app + hub + landing ở 3 viewport × sáng/tối.
 * Lần đầu: node capture.js --baseline  (lưu baseline)
 * Sau đó:  node capture.js            (so với baseline, báo diff)
 *
 * Tài khoản test: gate.js tự mint session D1 tạm cho user visual-gate@
 * (make_gate_token.py) rồi truyền TEST_TOKEN. Chạy tay: đặt TEST_TOKEN,
 * hoặc TEST_EMAIL/TEST_PASSWORD của một tài khoản test đã xác thực email.
 * Kết quả so sánh ghi ra report.json (gate.js đọc để ra verdict).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://lethanhdong.one';
const DIR = __dirname;
const BASELINE_DIR = path.join(DIR, 'baseline');
const CURRENT_DIR = path.join(DIR, 'current');
const DIFF_DIR = path.join(DIR, 'diff');

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

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

const THEMES = ['light', 'dark'];

async function getToken() {
  if (process.env.TEST_TOKEN) return process.env.TEST_TOKEN;
  const email = process.env.TEST_EMAIL, pw = process.env.TEST_PASSWORD;
  if (!email || !pw) throw new Error('Thiếu TEST_EMAIL/TEST_PASSWORD');
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  });
  const j = await res.json();
  if (!j.token) throw new Error('Login API thất bại: ' + JSON.stringify(j).slice(0, 100));
  return j.token;
}

async function main() {
  const isBaseline = process.argv.includes('--baseline');
  const outDir = isBaseline ? BASELINE_DIR : CURRENT_DIR;
  [outDir, DIFF_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

  // Qua relay local (relay.js) để tránh vấn đề proxy auth của Chromium
  const browser = await chromium.launch({
    executablePath: '/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    args: ['--no-sandbox'],
    proxy: { server: 'http://127.0.0.1:18899' },
  });
  // Login qua API một lần, inject token vào localStorage
  const token = await getToken();
  console.log('Login API OK.');

  const results = [];
  for (const pg of PAGES) {
    for (const vp of VIEWPORTS) {
      for (const theme of THEMES) {
        const ctx = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
        });
        // Set theme + auth token trước khi load
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
        const file = `${pg.name}-${vp.name}-${theme}.png`;
        try {
          await page.goto(BASE + pg.url, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(2500); // chờ render + font
          await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
          // Trang chess: chỉ chụp khi bàn cờ SVG đã có quân (render JS xong).
          // Thiếu quân = engine chưa/chậm render — chờ tối đa 10s, quá hạn vẫn
          // chụp để diff tự nói (không nuốt lỗi).
          let readyMiss = false;
          if (pg.name === 'chess') {
            await page.waitForFunction(
              () => document.querySelectorAll('#board > *').length > 10,
              { timeout: 10000 }
            ).catch(() => { readyMiss = true; });
          }
          // Ẩn banner update nếu có để screenshot ổn định
          await page.evaluate(() => {
            document.querySelectorAll('[class*="banner"],[id*="banner"]').forEach(el => {
              if (/bản mới|update/i.test(el.textContent || '')) el.style.display = 'none';
            });
          }).catch(() => {});
          // Vòng chờ ảnh ỔN ĐỊNH: chụp 2 lần cách 900ms, giống nhau <=0,1% mới
          // lấy. Chống chụp trúng trang đang render dở khi máy bận (gặp thật
          // 22/10: lượt compare ngay sau deploy chụp chess trắng/music mờ dù
          // baseline sạch — FAIL oan). Tối đa 5 vòng; hết vòng vẫn chụp ảnh
          // cuối và gắn cờ unstable để chẩn đoán.
          const { PNG } = require('pngjs');
          const pixelmatch = require('pixelmatch').default || require('pixelmatch');
          let buf = await page.screenshot({ fullPage: false });
          let unstable = false;
          for (let i = 0; i < 5; i++) {
            await page.waitForTimeout(900);
            const next = await page.screenshot({ fullPage: false });
            const a = PNG.sync.read(buf), b = PNG.sync.read(next);
            if (a.width === b.width && a.height === b.height) {
              const px = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
              const pct = (px / (a.width * a.height)) * 100;
              buf = next;
              if (pct <= 0.1) { unstable = false; break; }
              unstable = true;
            } else { buf = next; unstable = true; }
          }
          fs.writeFileSync(path.join(outDir, file), buf);
          results.push({ file, status: 'captured', ...(unstable ? { unstable: true } : {}), ...(readyMiss ? { readyMiss: true } : {}) });
          console.log('OK', file, unstable ? '(chưa ổn định hẳn)' : '', readyMiss ? '(thiếu tín hiệu render)' : '');
        } catch (e) {
          results.push({ file, status: 'error', error: e.message });
          console.log('LỖI', file, e.message);
        }
        await ctx.close();
      }
    }
  }
  await browser.close();

  if (!isBaseline) {
    // So sánh pixel thật bằng pixelmatch (chuẩn big tech)
    const { PNG } = require('pngjs');
    const pixelmatch = require('pixelmatch').default || require('pixelmatch');
    console.log('\n=== So sánh pixel với baseline ===');
    let diffs = 0;
    for (const r of results) {
      if (r.status !== 'captured') continue;
      const b = path.join(BASELINE_DIR, r.file), c = path.join(CURRENT_DIR, r.file);
      if (!fs.existsSync(b)) { console.log('MỚI (chưa có baseline):', r.file); r.cmp = 'new'; diffs++; continue; }
      const imgB = PNG.sync.read(fs.readFileSync(b));
      const imgC = PNG.sync.read(fs.readFileSync(c));
      if (imgB.width !== imgC.width || imgB.height !== imgC.height) {
        console.log(`KHÁC KÍCH THƯỚC ${imgB.width}x${imgB.height} vs ${imgC.width}x${imgC.height}:`, r.file);
        r.cmp = 'size-mismatch'; diffs++; continue;
      }
      const diff = new PNG({ width: imgB.width, height: imgB.height });
      const px = pixelmatch(imgB.data, imgC.data, diff.data, imgB.width, imgB.height, { threshold: 0.1 });
      const pct = (px / (imgB.width * imgB.height)) * 100;
      r.pct = +pct.toFixed(3); r.cmp = pct > 1 ? 'diff' : 'ok';
      if (pct > 1) {
        console.log(`KHÁC ${pct.toFixed(2)}% (${px}px):`, r.file);
        fs.writeFileSync(path.join(DIFF_DIR, r.file), PNG.sync.write(diff));
        diffs++;
      }
    }
    console.log(diffs === 0 ? 'Không có khác biệt pixel đáng kể.' : `${diffs} ảnh khác biệt cần xem lại (xem thư mục diff/).`);
  }
  fs.writeFileSync(path.join(DIR, 'report.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    mode: isBaseline ? 'baseline' : 'compare',
    files: results,
  }, null, 2));
  console.log('Xong.');
}

main().catch(e => { console.error(e); process.exit(1); });
