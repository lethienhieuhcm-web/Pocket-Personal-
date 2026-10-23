// worker/src/ai_chat.js — AI Chat Dot B: tang dieu phoi LLM (Gemini)
// tren 15 tool MCP cua kho tu chu (thiet ke ai-chat-phase-b-design
// 2026-10-23, Henrry Chot khung 07:44 23/10).
//
// POST /api/ai/chat {messages: [{role, text}...], lang}
//   -> {ok:true, tool, args, envelope, lead} khi LLM chon duoc tool
//   -> {ok:true, tool:null, text} khi cau hoi khong can so lieu
//   -> {ok:true, tool, args, errorText} khi tool bao thieu du lieu
//   -> {fallback:true, reason} cho MOI loi mem: client tu roi ve bo
//      khop regex Dot A (chatRoute) — hanh vi te nhat bang Dot A.
//
// Nguyen tac cung (thiet ke muc 1-2):
// - So lieu CHI tu envelope cua tool (chatToolRun trong mcp.js chay
//   dung ham tool, khong qua HTTP). LLM chi (a) chon tool/tham so,
//   (b) viet 1-2 cau dan va cau dan PHAI qua cong gac so bang code
//   (_numericGuard): so nao khong co nguon trong envelope -> bo
//   ca cau dan, chi hien the du lieu.
// - Ngan sach: moi cau hoi toi da 2 luot goi Gemini (dieu phoi +
//   viet dan); moi luot tran 6s/5s, thu toi da 4 khoa (env
//   GEMINI_API_KEYS, ngan phay — tap con cua chuoi 17 xo dat lam
//   Worker secret theo phuong an A cua thiet ke muc 4).
// - Giai doan test (lenh Henrry 10:28 23/10): KHONG dat tran so
//   cau LLM. Van dem (aiRateCount) + ghi ai_chat_log moi luot de
//   sau nay dat tran co so that; nguong cu giu o RATE_LIMIT_PER_HOUR
//   lam tham khao khi bat lai.
// - Log rieng ai_chat_log (90 ngay nhu mcp_log) de bao cao su dung
//   khoa tach bach chat / trich xuat dong thuan.

import { chatToolRun, resolveCaller } from './mcp.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_MODEL = 'gemini-3.5-flash';
const RATE_LIMIT_PER_HOUR = 30; // tam tat o giai doan test (xem handler)

/* ---------------- khai bao ham cho Gemini (15 tool) ---------------- */
// Viet gon rieng cho tang dieu phoi (mo ta toi uu dinh tuyen, tham
// so toi gian) nhung TRUNG THUC voi inputSchema that trong mcp.js.
function _buildDecls() {
  const STR = (description) => ({ type: 'STRING', description });
  const INT = (description) => ({ type: 'INTEGER', description });
  const OBJ = (properties, required) => ({
    type: 'OBJECT', properties: properties || {}, required: required || [],
  });
  const SYM = STR('Ma chung khoan (vd FPT) hoac ma chi so (vd VNINDEX)');
  return [
    { name: 'get_quote', description: 'Gia phien gan nhat cua 1 ma: dong cua, % thay doi, khoi luong, gia tri, mua/ban khoi ngoai.', parameters: OBJ({ symbol: SYM }, ['symbol']) },
    { name: 'get_ohlcv', description: 'Chuoi nen ngay (OHLCV) cua 1 ma hoac chi so; mac dinh 120 nen, toi da 500.', parameters: OBJ({ symbol: SYM, limit: INT('So nen, toi da 500') }, ['symbol']) },
    { name: 'get_indices', description: 'Chi so thi truong hien tai (VNINDEX, VN30, HNX, UPCOM...) kem trang thai thi truong.', parameters: OBJ({}) },
    { name: 'get_company_profile', description: 'Ho so cong ty cua 1 ma: thong tin chung, co dong lon, lanh dao, co cau so huu.', parameters: OBJ({ symbol: SYM }, ['symbol']) },
    { name: 'get_macro', description: 'Vi mo: khong series = tong quan (lai suat SBV, ty gia trung tam USD/VND, vang SJC, OMO, lai suat My); series = lich su 1 series. Cac series: omo, fx_center, fx_vcb, gold_sjc, us10y, fed_effr.', parameters: OBJ({ series: STR('Ma series (vd gold_sjc); rong = tong quan') }) },
    { name: 'get_sector', description: 'Nganh ICB (P/E, ROE, doanh thu, LNST cua nganh — KHONG phai dong tien): khong code = bang tong quan 19 nganh; code = chi tiet 1 nganh. Ngan hang = 8300.', parameters: OBJ({ code: STR('Ma nganh ICB 4 chu so (vd 8300); rong = tong quan') }) },
    { name: 'get_flow', description: 'Dong tien khoi ngoai (foreign) hoac tu doanh (proprietary) THEO MA: co symbol = lich su mua/ban rong theo ma; khong symbol = bang theo ma toan thi truong phien gan nhat (dang liet ke).', parameters: OBJ({ kind: { type: 'STRING', enum: ['foreign', 'proprietary'], description: 'Loai dong tien' }, symbol: STR('Ma (tuy chon)'), days: INT('So ngay lich su khi co symbol, toi da 500') }, ['kind']) },
    { name: 'get_flow_summary', description: 'Tong hop dong tien theo DICH DEN (phien gan nhat): tien do ve dau, vao nganh nao/san nao, tong rong toan thi truong. group_by=sector (theo nganh ICB) / exchange (theo san) / market (tong). sector_code = chi tiet 1 nganh + top ma trong nganh.', parameters: OBJ({ kind: { type: 'STRING', enum: ['foreign', 'proprietary', 'both'], description: 'Loai dong tien, mac dinh both' }, group_by: { type: 'STRING', enum: ['sector', 'exchange', 'market'], description: 'Chieu tong hop, mac dinh sector' }, sector_code: STR('Ma nganh ICB 4 chu so (tuy chon, vd 8300)') }) },
    { name: 'get_consensus', description: 'Dong thuan CTCK (chi ban verified): co symbol = tung hang (khuyen nghi, gia muc tieu, ngay bao cao) + trung binh/min/max/upside; khong symbol = bang toan thi truong.', parameters: OBJ({ symbol: STR('Ma (tuy chon)') }) },
    { name: 'get_screener', description: 'Loc/xep hang co phieu toan thi truong: filters {exchange, sector, min_pe, max_pe, min_roe, min_value, min_pct, max_pct}, sort_by (value_vnd/pct_change/volume/close/pe_ttm/roe_ttm), order asc/desc, limit toi da 200.', parameters: OBJ({ filters: { type: 'OBJECT', properties: { exchange: STR('San: HOSE/HNX/UPCOM'), sector: STR('Ten nganh'), min_pe: { type: 'NUMBER' }, max_pe: { type: 'NUMBER' }, min_roe: { type: 'NUMBER' }, min_value: { type: 'NUMBER' }, min_pct: { type: 'NUMBER' }, max_pct: { type: 'NUMBER' } } }, sort_by: STR('Truong sap xep'), order: { type: 'STRING', enum: ['asc', 'desc'] }, limit: INT('So ma tra ve, toi da 200') }) },
    { name: 'get_fundamentals', description: 'Ty so tai chinh TTM cua 1 ma (EPS, BVPS, ROE, ROA, P/E, P/B...).', parameters: OBJ({ symbol: SYM }, ['symbol']) },
    { name: 'get_statements', description: 'Bao cao tai chinh cac ky gan nhat cua 1 ma (doanh thu, loi nhuan...); periods mac dinh 8, toi da 20.', parameters: OBJ({ symbol: SYM, periods: INT('So ky, mac dinh 8, toi da 20') }, ['symbol']) },
    { name: 'find_holder', description: 'Tra cuu nguoc co dong: nhap ten nguoi/to chuc -> cac ma dang nam giu, so co phieu, ty le, chuc danh.', parameters: OBJ({ name: STR('Ten co dong (co dau hoac khong dau)'), limit: INT('So ket qua toi da') }, ['name']) },
    { name: 'get_events', description: 'Su kien sap toi cua 1 ma (DHDCD, co tuc, phat hanh...) trong days_ahead ngay (mac dinh 90).', parameters: OBJ({ symbol: SYM, days_ahead: INT('So ngay sap toi, mac dinh 90') }, ['symbol']) },
    { name: 'get_news', description: 'Tin tuc: co symbol = tin theo ma; khong symbol = tin thi truong.', parameters: OBJ({ symbol: STR('Ma (tuy chon)'), limit: INT('So tin toi da') }) },
  ];
}

/* ---------------- cong gac so cho cau dan ---------------- */
// Moi so viet trong cau dan phai doi chieu duoc ve mot so trong
// envelope (nguyen ban hoac quy doi /1e3 /1e6 /1e9 /1e12 / *100),
// dung sai tuong doi 0,6%. Lech -> gac truot (bo ca cau dan).
function _collectNumbers(x, out) {
  if (x == null) return;
  if (typeof x === 'number') { if (isFinite(x)) out.push(x); return; }
  if (Array.isArray(x)) { for (const v of x) _collectNumbers(v, out); return; }
  if (typeof x === 'object') { for (const k of Object.keys(x)) _collectNumbers(x[k], out); }
}
function _parseViNumber(tok) {
  let s = String(tok).replace(/\s/g, '');
  let neg = false;
  if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
  let v;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    v = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  } else {
    v = parseFloat(s.replace(',', '.'));
  }
  return neg ? -v : v;
}
export function _numericGuard(text, data) {
  const tokens = String(text || '').match(
    /(?<![A-Za-z0-9])-?\d{1,3}(?:\.\d{3})+(?:,\d+)?|(?<![A-Za-z0-9])-?\d+(?:,\d+)?/g);
  if (!tokens || !tokens.length) return true; // cau khong so: dat
  const raw = [];
  _collectNumbers(data, raw);
  const allowed = [];
  for (const v of raw) {
    allowed.push(v, v / 1e3, v / 1e6, v / 1e9, v / 1e12, v * 100);
  }
  for (const tok of tokens) {
    const t = _parseViNumber(tok);
    if (!isFinite(t)) return false;
    let ok = false;
    for (const av of allowed) {
      const tol = Math.max(Math.abs(av) * 0.006, 1e-9);
      if (Math.abs(t - av) <= tol) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

/* ---------------- ai_chat_log (D1) ---------------- */
let _aiLogReady = false;
async function ensureAiLog(env) {
  if (_aiLogReady) return;
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS ai_chat_log (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ' +
      'user_email TEXT, lang TEXT, tool TEXT, status TEXT NOT NULL, ' +
      'latency_ms INTEGER, keys_tried INTEGER, lead_kept INTEGER)').run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_ai_chat_log_ts ON ai_chat_log(ts)').run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_ai_chat_log_user ON ai_chat_log(user_email, ts)').run();
    _aiLogReady = true;
  } catch (e) { /* log khong duoc lam hong luot chat */ }
}
async function aiLog(env, row) {
  try {
    await ensureAiLog(env);
    await env.DB.prepare(
      'INSERT INTO ai_chat_log (ts, user_email, lang, tool, status, ' +
      'latency_ms, keys_tried, lead_kept) VALUES (?,?,?,?,?,?,?,?)')
      .bind(row.ts, row.user_email, row.lang, row.tool, row.status,
        row.latency_ms, row.keys_tried, row.lead_kept).run();
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    await env.DB.prepare('DELETE FROM ai_chat_log WHERE ts < ?')
      .bind(cutoff).run();
  } catch (e) { /* logging fail-open */ }
}
async function aiRateCount(env, email) {
  await ensureAiLog(env);
  const rs = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM ai_chat_log WHERE user_email = ? AND ts > ?')
    .bind(email, Date.now() - 3600 * 1000).first();
  return (rs && rs.c) || 0;
}

/* ---------------- goi Gemini co failover khoa ---------------- */
// Goi 1 luot generateContent: thu toi da 4 khoa (xoay vong), tong
// thoi gian khong vuot deadlineMs. 429/503/400/loi mang/timeout ->
// khoa ke tiep. (Sua sau ca loi 11:35 23/10: ban dau coi 400 la
// "sai request, dung ngay" — thuc te Gemini tra 400 ca cho loi
// nhat thoi va loi phia khoa, mot 400 chop nhoang lam sap toan bo
// luot chat, log keys_tried=1. Nay 400 thu khoa ke nhu cac loi
// khac; ma loi chi tiet cua Google ghi vao state.errDetail de
// dua vao ai_chat_log.)
async function geminiCall(env, keys, state, body, deadlineMs, perAttemptMs) {
  const model = env.AI_CHAT_MODEL || DEFAULT_MODEL;
  const url = GEMINI_BASE + model + ':generateContent';
  const endAt = Date.now() + deadlineMs;
  let lastErr = null;
  let tried = 0; // ngan sach 4 lan thu ap cho TUNG luot goi
  // Khoa chet trong PHAM VI 1 LUOT HOI (429/400/503): cac pass sau
  // (ep chon tool, viet cau dan) bo qua, khong dot lai khoa da chet
  // — do that 23/10 keys_tried toi 7 vi moi pass chay lai tu khoa 1.
  if (!state.dead) state.dead = new Set();
  while (tried < 4 && Date.now() < endAt - 300) {
    const key = keys[state.idx % keys.length];
    state.idx++;
    if (state.dead.has(key)) continue;
    tried++; state.keysTried++;
    // Moi lan thu co tran rieng: mot khoa treo khong an het ngan
    // sach cua cac khoa con lai (do that 23/10: luot song 8-13s,
    // luot chet fail nhanh ~200ms/khoa theo dot).
    const remain = Math.max(400, endAt - Date.now());
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(),
      Math.min(perAttemptMs || 3000, remain));
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (r.status === 400) {
        let det = '';
        try {
          const ej = await r.json();
          det = (ej && ej.error && ej.error.status) || '';
        } catch (e2) { /* body loi khong doc duoc */ }
        state.saw400 = true;
        state.dead.add(key);
        if (det) state.errDetail = det;
        lastErr = new Error('gemini_http_400');
        continue;
      }
      if (r.status === 429 || r.status === 503 || !r.ok) {
        state.errDetail = 'http_' + r.status;
        state.dead.add(key);
        lastErr = new Error('gemini_http_' + r.status);
        continue;
      }
      return await r.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e; // abort / loi mang -> khoa ke
    }
  }
  const e = new Error(state.saw400 ? 'gemini_400' : 'gemini_down');
  e.reason = state.saw400 ? 'gemini_400' : 'gemini_down';
  e.detail = state.errDetail || null;
  e.cause = lastErr;
  throw e;
}

function geminiText(j) {
  const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content
    ? (j.candidates[0].content.parts || []) : [];
  return parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join(' ').trim();
}
function geminiFunctionCall(j) {
  const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content
    ? (j.candidates[0].content.parts || []) : [];
  for (const p of parts) {
    if (p && p.functionCall && p.functionCall.name) {
      return { name: p.functionCall.name, args: p.functionCall.args || {} };
    }
  }
  return null;
}

/* ---------------- handler ---------------- */
const SYSTEM_PROMPT = [
  'Ban la tang dieu phoi cua tro ly chung khoan Viet Nam. Nhiem vu: doc cau hoi va lich su hoi thoai, chon DUNG MOT tool de lay so lieu thi truong, hoac tra loi ngan gon neu khong can so lieu.',
  'LUAT BAT BUOC:',
  '1. Cau sua y cua nguoi dung ("khong phai X", "y toi la Y", "chu khong phai...") THANG moi y truoc do: bo qua huong cua tool da goi o luot truoc neu mau thuan.',
  '2. Cau hoi khuyet chu ngu (vd "Do ve dau?", "Con ty gia?", "The khoi ngoai?") thi lay chu ngu/chu de tu luot gan nhat. Cac dong "TOOL ten {args}" trong lich su la tom tat luot truoc (tool da goi va tham so).',
  '3. "Do ve dau", "tien do ve dau", "dong tien theo nganh/san", "tien vao nganh nao" -> get_flow_summary (group_by=sector mac dinh; group_by=exchange khi hoi theo san; group_by=market khi chi hoi tong toan thi truong), TRU KHI dang bam mot ma cu the thi dung get_flow voi symbol do.',
  '4. P/E, ROE, doanh thu, loi nhuan CUA NGANH -> get_sector (khong phai dong tien). Hoi ve mot nguoi nam giu co phieu -> find_holder. Hoi co dong lon cua mot ma -> get_company_profile.',
  '5. Chi goi tool khi cau hoi can so lieu thi truong. Chao hoi xa giao thi tra loi text ngan gon, khong goi tool. Khong co tool nao phu hop thi tra loi text ngan noi chua co du lieu cho cau do. TUYET DOI khong bia so, khong tu tinh so, khong du doan gia, khong khuyen nghi mua/ban.',
  '6. KHOAN SAU THEO NGANH: neu lich su co luot "TOOL get_flow_summary" va nguoi dung noi "phan tich <ten nganh> de ro hon", "xem them/khoan sau <ten nganh>", "<ten nganh> thi sao" -> goi get_flow_summary voi sector_code cua nganh do (giu kind cua luot truoc neu ro). Neu KHONG co ngu canh dong tien ma chi hoi "phan tich nganh X" chung chung -> get_sector voi code tuong ung. Bang ma ICB: 0500 Dau khi; 8600 Bat dong san; 1700 Tai nguyen Co ban; 3500 Thuc pham va do uong; 7500 Dien, nuoc & xang dau khi dot; 5300 Ban le; 2700 Hang & Dich vu Cong nghiep; 2300 Xay dung va Vat lieu; 5700 Du lich va Giai tri; 1300 Hoa chat; 3700 Hang ca nhan & Gia dung; 3300 O to va phu tung; 8700 Dich vu tai chinh; 9500 Cong nghe Thong tin; 6500 Vien thong; 4500 Y te; 5500 Truyen thong; 8300 Ngan hang; 8500 Bao hiem.',
  '7. VI MO: hoi ty gia, lai suat, gia vang, OMO, chinh sach tien te -> get_macro (co series thi dat series tuong ung); khong tra loi van xuoi thay cho so lieu vi mo.',
].join('\n');

export async function hAiChat(request, env) {
  const t0 = Date.now();
  const json = (o) => new Response(JSON.stringify(o), {
    headers: { 'Content-Type': 'application/json' },
  });
  let caller = null;
  try { caller = await resolveCaller(request, env); } catch (e) { /* email de trong */ }
  const email = caller ? caller.email : '';
  let lang = 'vi';
  let tool = null;
  const finish = async (payload, status, extra) => {
    await aiLog(env, {
      ts: Date.now(), user_email: email, lang, tool,
      status, latency_ms: Date.now() - t0,
      keys_tried: (extra && extra.keys_tried) || 0,
      lead_kept: (extra && extra.lead_kept) || 0,
    });
    return json(payload);
  };
  const fallback = (reason, extra) => finish(
    { fallback: true, reason },
    'fallback:' + reason +
      ((extra && extra.detail) ? ':' + String(extra.detail).slice(0, 40) : ''),
    extra);

  let body;
  try { body = await request.json(); } catch (e) { return fallback('bad_request'); }
  if (['vi', 'en', 'zh', 'ko'].includes(body && body.lang)) lang = body.lang;
  const msgs = body && body.messages;
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > 12) {
    return fallback('bad_request');
  }
  for (const m of msgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')
      || typeof m.text !== 'string' || !m.text.trim() || m.text.length > 2000) {
      return fallback('bad_request');
    }
  }
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  if (!lastUser) return fallback('bad_request');

  const keys = String(env.GEMINI_API_KEYS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!keys.length) return fallback('no_keys');

  // Giai doan test: KHONG ap tran (lenh 10:28 23/10). Chi dem de
  // giu so lieu that cho viec dat tran sau nay; loi dem thi bo qua.
  try { await aiRateCount(env, email); } catch (e) { /* bo qua */ }

  const state = {
    idx: Math.floor(Math.random() * keys.length), keysTried: 0,
    saw400: false, errDetail: null,
  };
  const contents = msgs.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text }],
  }));

  // Luot 1: dieu phoi (chon tool)
  let j1;
  try {
    j1 = await geminiCall(env, keys, state, {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT + '\n8. Tra loi bang ngon ngu: ' + lang + '.' }] },
      contents,
      tools: [{ functionDeclarations: _buildDecls() }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    }, 10000, 3000);
  } catch (e) {
    return fallback((e && e.reason) || 'gemini_down',
      { keys_tried: state.keysTried, detail: (e && e.detail) || null });
  }

  let fc = geminiFunctionCall(j1);
  if (!fc) {
    // Khong can so lieu: chi chap nhan text neu khong chua con so
    // nao khong kiem chung duoc (khong co envelope de gac).
    const text = geminiText(j1);
    if (text && _numericGuard(text, null)) {
      return finish({ ok: true, tool: null, text }, 'ok', { keys_tried: state.keysTried });
    }
    // Van xuoi khong kiem chung duoc (hoac rong): ep model CHON
    // TOOL 1 luot (mode ANY) truoc khi roi du phong. Ca loi
    // 23/10: cau khoan nganh sau the dong tien bi tra van xuoi
    // chua so -> fallback:no_tool lap 2 lan du prompt da co luat.
    try {
      const j1b = await geminiCall(env, keys, state, {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT + '\n8. Tra loi bang ngon ngu: ' + lang + '.' }] },
        contents,
        tools: [{ functionDeclarations: _buildDecls() }],
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
      }, 6000, 2500);
      fc = geminiFunctionCall(j1b);
    } catch (e) { /* het ngan sach / loi -> giu duong fallback cu */ }
    if (!fc) {
      return fallback('no_tool', { keys_tried: state.keysTried });
    }
  }

  tool = fc.name;
  let envelope;
  try {
    envelope = await chatToolRun(env, fc.name, fc.args);
  } catch (e) {
    if (e && e.code && e.message) {
      // ToolError co cau truc: noi ro thieu gi, khong bia.
      return finish(
        { ok: true, tool: fc.name, args: fc.args, errorText: e.message },
        'tool_error', { keys_tried: state.keysTried });
    }
    return fallback('tool_error', { keys_tried: state.keysTried });
  }

  // Luot 2: viet cau dan tu envelope, qua cong gac so. Bo qua khi
  // luot 1 da an gan het ngan sach thoi gian (the du lieu la chinh).
  let lead = null;
  try {
    if (Date.now() - t0 < 10000) {
    const dataJson = JSON.stringify(envelope.data || {}).slice(0, 6000);
    const leadPrompt =
      'Duoi day la du lieu thi truong (JSON) vua truy van duoc cho cau hoi cua nguoi dung. ' +
      'Hay viet 1-2 cau dan ngan gon bang ngon ngu "' + lang + '" mo ta diem chinh cua du lieu.\n' +
      'LUAT: CHI dung cac con so co mat trong JSON; khong nhac ngay thang; khong du doan, ' +
      'khong khuyen nghi mua/ban; so tien lon quy ve don vi "ty" (1 ty = 1e9 dong), ' +
      'so phan tram giu nguyen nhu trong JSON.\n' +
      'CAU HOI: ' + lastUser.text + '\nDU LIEU: ' + dataJson;
    const j2 = await geminiCall(env, keys, state, {
      contents: [{ role: 'user', parts: [{ text: leadPrompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    }, 4000, 2000);
    const txt = geminiText(j2).replace(/\s+/g, ' ').slice(0, 400);
    if (txt && _numericGuard(txt, envelope.data)) lead = txt;
    }
  } catch (e) { /* cau dan loi/gac truot -> chi hien the du lieu */ }

  return finish(
    { ok: true, tool: fc.name, args: fc.args, envelope, lead },
    'ok', { keys_tried: state.keysTried, lead_kept: lead ? 1 : 0 });
}

export { _buildDecls };
