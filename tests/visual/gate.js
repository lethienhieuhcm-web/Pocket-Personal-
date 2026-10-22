/**
 * Cổng so ảnh (visual gate) — cf_deploy.py gọi sau mỗi deploy production.
 * Luồng: mint session test D1 (make_gate_token.py) -> bật relay local nếu
 * chưa có -> capture.js chụp live + so baseline -> verdict theo report.json
 * -> xoá session test.
 *   node gate.js             exit 0 PASS / 1 WARN / 2 FAIL
 *   node gate.js --baseline  chụp lại toàn bộ baseline (chỉ khi được duyệt)
 * Ngưỡng FAIL: lỗi chụp, khác kích thước, trang chưa có baseline, hoặc lệch
 * pixel > 5% (trang stocks > 12% vì giá trực tiếp luôn nhúc nhích).
 * Lệch > 1% = WARN (xem thư mục diff/).
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const DIR = __dirname;
const FAIL_PCT = 5, FAIL_PCT_STOCKS = 12, WARN_PCT = 1;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('error', reject);
    p.on('close', code => resolve(code));
  });
}

function portOpen(port) {
  return new Promise(res => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.end(); res(true); });
    s.once('error', () => res(false));
  });
}

async function main() {
  const baseline = process.argv.includes('--baseline');
  // Khoá chạy đơn: hai lượt gate chồng nhau (vd 2 deploy song song trên cùng
  // cây repo) dùng chung thư mục current/ + report.json sẽ nhiễm số liệu của
  // nhau (gặp thật 22/10: verdict FAIL 81% trong khi ảnh chụp đúng chuẩn).
  // Đang có lượt khác chạy -> thoát 3 (không phải FAIL) để deploy không bị
  // chặn oan; lock quá 25 phút coi như stale (tiến trình chết) và chiếm lại.
  const LOCK = path.join(DIR, 'gate.lock');
  try {
    const fd = fs.openSync(LOCK, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (e) {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age < 25 * 60 * 1000) {
      console.log('VISUAL GATE: SKIP — một lượt gate khác đang chạy (lock ' + Math.round(age / 1000) + 's).');
      process.exit(3);
    }
    fs.writeFileSync(LOCK, String(process.pid));
  }
  process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch (e) {} });
  let relay = null;
  if (!(await portOpen(18899))) {
    relay = spawn('node', [path.join(DIR, 'relay.js')], { stdio: 'ignore' });
    for (let i = 0; i < 20 && !(await portOpen(18899)); i++)
      await new Promise(r => setTimeout(r, 250));
  }
  const token = execFileSync('python3', [path.join(DIR, 'make_gate_token.py')], { encoding: 'utf8' }).trim();
  console.log('Gate: đã mint session test.');
  let code = 0;
  try {
    const args = [path.join(DIR, 'capture.js')];
    if (baseline) args.push('--baseline');
    code = await run('node', args, { env: { ...process.env, TEST_TOKEN: token } });
  } finally {
    try { execFileSync('python3', [path.join(DIR, 'make_gate_token.py'), '--cleanup', token], { stdio: 'ignore' }); } catch (e) {}
    if (relay) relay.kill();
  }
  if (code !== 0) { console.log('VISUAL GATE: FAIL — capture.js lỗi, exit', code); process.exit(2); }
  if (baseline) { console.log('VISUAL GATE: baseline đã cập nhật.'); return; }
  const report = JSON.parse(fs.readFileSync(path.join(DIR, 'report.json'), 'utf8'));
  let verdict = 'PASS';
  const notes = [];
  for (const f of report.files) {
    if (f.status === 'error') { verdict = 'FAIL'; notes.push(`${f.file}: lỗi chụp (${f.error || ''})`); continue; }
    if (f.cmp === 'size-mismatch' || f.cmp === 'new') { verdict = 'FAIL'; notes.push(`${f.file}: ${f.cmp}`); continue; }
    if (typeof f.pct === 'number') {
      const lim = f.file.startsWith('stocks-') ? FAIL_PCT_STOCKS : FAIL_PCT;
      if (f.pct > lim) { verdict = 'FAIL'; notes.push(`${f.file}: lệch ${f.pct}% (ngưỡng ${lim}%)`); }
      else if (f.pct > WARN_PCT) { if (verdict === 'PASS') verdict = 'WARN'; notes.push(`${f.file}: lệch ${f.pct}%`); }
    }
  }
  console.log('VISUAL GATE: ' + verdict);
  notes.forEach(n => console.log('  -', n));
  process.exit(verdict === 'FAIL' ? 2 : verdict === 'WARN' ? 1 : 0);
}

main().catch(e => { console.error('VISUAL GATE: FAIL —', e.message); process.exit(2); });
