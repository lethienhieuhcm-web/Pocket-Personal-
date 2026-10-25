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
// Oxion (chan API du phong AI Chat, Chot 22:08 24/10 theo ban trinh
// 21:38 + phan key 21:57: key free -> Oxion key 1 -> tab Plus).
// Code chi doc 1 secret OXION_API_KEY (khong xoay vong); model
// mac dinh gemini-3.6-flash, doi duoc qua env OXION_MODEL.
const OXION_URL = 'https://oxionai.com/v1/chat/completions';
const OXION_MODEL_DEFAULT = 'gemini-3.6-flash';
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
    { name: 'analyze_sector', description: 'PHAN TICH 1 nganh (khoan sau): dong tien phien gan nhat theo ma trong nganh + do tap trung + do rong nganh + P/E va chi so nganh + xu huong nhieu phien. Dung cho "phan tich nganh X", "X de ro hon", "X thi sao".', parameters: OBJ({ code: STR('Ma nganh ICB 4 chu so (vd 8600)'), days: INT('So phien cho khoi xu huong, mac dinh 20'), top_n: INT('So ma keo chinh, mac dinh 15') }, ['code']) },
    { name: 'analyze_symbol', description: 'PHAN TICH 1 ma (ky hon): gia so duong trung binh + chi bao + rong ngoai/tu doanh 5/20/60 phien + phan tan dong thuan + co dong lon. Dung cho "phan tich (ky) ma X", "xem ky X".', parameters: OBJ({ symbol: SYM, days: INT('So phien nhin lai, mac dinh 20') }, ['symbol']) },
    { name: 'analyze_compare', description: 'SO SANH 2 ma hoac 2 nganh tren cung bo tieu chi + chenh lech so. Dung cho "so sanh X voi Y", "X va Y cai nao tien vao manh hon".', parameters: OBJ({ kind: { type: 'STRING', enum: ['symbols', 'sectors'], description: 'symbols = 2 ma; sectors = 2 nganh' }, items: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Dung 2 phan tu: 2 ma hoac 2 ma nganh ICB' }, days: INT('Cua so tinh, mac dinh 20') }, ['kind', 'items']) },
    { name: 'analyze_market', description: 'TOAN CANH thi truong: chi so + do rong 3 san + TRIN + tong rong ngoai/tu doanh + vi mo tom tat. Dung cho "thi truong hom nay the nao", "tong quan phien".', parameters: OBJ({ days: INT('So phien cho khoi xu huong, mac dinh 20') }) },
    { name: 'analyze_holders', description: 'CO DONG & SO HUU cua 1 ma (BB-5): co dac CR1/5/10 + HHI tung phan, free float can tren, room ngoai theo tran da thong bao cua ma, thay doi co dong lon giua 2 ky chot, so huu lanh dao. Dung cho "co dong FPT co dac khong", "room ngoai MWG", "lanh dao VCB nam bao nhieu".', parameters: OBJ({ symbol: SYM, window_days: INT('Cua so su kien noi bo 30/60/90, mac dinh 90') }, ['symbol']) },
    { name: 'get_holder_portfolio_changes', description: 'THAY DOI nam giu cua MOT co dong giua 2 ky chot (BB-5): NEW/EXIT/INCREASE/DECREASE theo ma kem delta CP + diem %. Dung cho "ong Truong Gia Binh ky nay tang giam nam giu ma nao". name lay tu find_holder.', parameters: OBJ({ name: STR('Ten co dong (vd Truong Gia Binh)'), limit: INT('So ma toi da quet, mac dinh 50') }, ['name']) },
    { name: 'calc_flow_sum', description: 'Tong dong tien rong cua 1 ma theo cua so phien (server tinh san). symbol + days, kind foreign/proprietary/both.', parameters: OBJ({ symbol: SYM, kind: { type: 'STRING', enum: ['foreign', 'proprietary', 'both'] }, days: INT('So phien, mac dinh 20, toi da 500') }, ['symbol']) },
    { name: 'get_analysis_catalog', description: 'Danh muc cong thuc/chi bao he thong dung (tra cuu khi can giai thich cach tinh).', parameters: OBJ({ kind: { type: 'STRING', enum: ['indicators', 'ratios', 'formulas'] }, name: STR('Ten chinh xac (tuy chon)'), query: STR('Tu khoa (tuy chon)') }, ['kind']) },
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
/* ------------- cong gac mau cau cam (du bao/khuyen nghi) ------------- */
// Lop phan tich chi MO TA bang so da do (thiet ke 4B, ranh gioi cung):
// cau dan chua mau du bao huong tuong lai hoac khuyen nghi mua/ban
// thi bi bo nhu truot gac so. Ap cho ca van xuoi khong-tool lan cau dan.
const _BANNED_LEAD = [
  /se\s+(tang|giam|phuc hoi|bung no|lao doc)/i,
  /sap\s+(tang|giam|toi|dien ra)/i,
  /ky vong\s+(dat|tang|se)/i,
  /nen\s+(mua|ban|nam giu)/i,
  /khuyen nghi\s+(mua|ban)/i,
  /(dang|rat dang|nen)\s+mua\b/i,
  /du bao\s+(la|se|rang)/i,
  /se con\s+(tang|giam)/i,
  /co kha nang\s+(tang|giam)\s+(trong|sap)/i,
];
export function _bannedLead(text) {
  const t = String(text || '');
  return _BANNED_LEAD.some((re) => re.test(t));
}

export function _numericGuard(text, data) {  const tokens = String(text || '').match(
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
      'latency_ms INTEGER, keys_tried INTEGER, lead_kept INTEGER, ' +
      'via TEXT)').run();
    // Bang cu (truoc GĐ2) chua co cot via: them, loi thi bo qua.
    try {
      await env.DB.prepare('ALTER TABLE ai_chat_log ADD COLUMN via TEXT').run();
    } catch (e2) { /* cot da ton tai */ }
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
      'latency_ms, keys_tried, lead_kept, via) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(row.ts, row.user_email, row.lang, row.tool, row.status,
        row.latency_ms, row.keys_tried, row.lead_kept, row.via || null).run();
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
  if (!state.trace) state.trace = []; // nhat ky tung khoa: 200/400/429/503/net
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
        state.trace.push('400');
        if (det) state.errDetail = det;
        lastErr = new Error('gemini_http_400');
        continue;
      }
      if (r.status === 429 || r.status === 503 || !r.ok) {
        state.errDetail = 'http_' + r.status;
        state.dead.add(key);
        state.trace.push('http_' + r.status);
        lastErr = new Error('gemini_http_' + r.status);
        continue;
      }
      state.trace.push('200');
      return await r.json();
    } catch (e) {
      clearTimeout(timer);
      state.trace.push('net');
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

// Gemini khai type HOA (STRING/OBJECT/...); endpoint OpenAI-
// compatible doi type thuong (string/object/...). Chuan hoa de
// quy qua properties/items; truong khac (description/enum/
// required) giu nguyen. (Bai hoc 24/10: gui nguyen type HOA bi
// aggregator tra 400 nhanh, chan Oxion chet ma khong ro ly do.)
function _oxionSchema(node) {
  if (!node || typeof node !== 'object') return { type: 'object', properties: {} };
  const out = Array.isArray(node) ? [] : {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' && typeof v === 'string') out[k] = v.toLowerCase();
    else if (k === 'properties' && v && typeof v === 'object') {
      out[k] = {};
      for (const [pk, pv] of Object.entries(v)) out[k][pk] = _oxionSchema(pv);
    } else if (k === 'items' && v && typeof v === 'object') out[k] = _oxionSchema(v);
    else out[k] = v;
  }
  return out;
}

/* ---------------- goi Oxion (chan API du phong) ---------------- */
// Dich body dang Gemini sang OpenAI chat completions, tra ve dang
// Gemini (candidates[0].content.parts) de tai su dung geminiText /
// geminiFunctionCall / _numericGuard nhu luot key. Chi goi khi luot
// key nem (pass-1 / pass-2); loi -> nem {reason:'oxion_down'} de
// luong xu ly roi xuong engine (b) hoac bo cau dan nhu cu.
async function oxionCall(env, geminiBody, timeoutMs) {
  const key = env.OXION_API_KEY;
  if (!key) {
    const e = new Error('oxion_no_key');
    e.reason = 'oxion_down';
    throw e;
  }
  const messages = [];
  const sys = geminiBody.systemInstruction
    && geminiBody.systemInstruction.parts;
  if (Array.isArray(sys)) {
    const t = sys.filter((p) => typeof p.text === 'string')
      .map((p) => p.text).join('\n');
    if (t) messages.push({ role: 'system', content: t });
  }
  for (const c of (geminiBody.contents || [])) {
    const t = (c.parts || []).filter((p) => typeof p.text === 'string')
      .map((p) => p.text).join('\n');
    messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content: t });
  }
  const body = {
    model: env.OXION_MODEL || OXION_MODEL_DEFAULT,
    messages,
    temperature: (geminiBody.generationConfig
      && geminiBody.generationConfig.temperature) ?? 0.2,
    max_tokens: (geminiBody.generationConfig
      && geminiBody.generationConfig.maxOutputTokens) || 1024,
  };
  const decls = geminiBody.tools && geminiBody.tools[0]
    && geminiBody.tools[0].functionDeclarations;
  if (Array.isArray(decls) && decls.length) {
    body.tools = decls.map((d) => ({
      type: 'function',
      function: {
        name: d.name, description: d.description || '',
        parameters: _oxionSchema(d.parameters),
      },
    }));
    const mode = geminiBody.toolConfig
      && geminiBody.toolConfig.functionCallingConfig
      && geminiBody.toolConfig.functionCallingConfig.mode;
    body.tool_choice = mode === 'ANY' ? 'required' : 'auto';
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 60000);
  let r;
  try {
    r = await fetch(OXION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error('oxion_down');
    err.reason = 'oxion_down';
    throw err;
  }
  clearTimeout(timer);
  if (!r.ok) {
    const err = new Error('oxion_down');
    err.reason = 'oxion_down';
    err.detail = 'http_' + r.status;
    throw err;
  }
  const j = await r.json();
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  if (!msg) {
    const err = new Error('oxion_down');
    err.reason = 'oxion_down';
    throw err;
  }
  const parts = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc && tc.function && tc.function.name) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e2) { /* giu {} */ }
        parts.push({ functionCall: { name: tc.function.name, args } });
      }
    }
  }
  if (typeof msg.content === 'string' && msg.content.trim()) {
    parts.push({ text: msg.content });
  }
  if (!parts.length) {
    const err = new Error('oxion_down');
    err.reason = 'oxion_down';
    throw err;
  }
  return { candidates: [{ content: { parts } }] };
}

/* Bang nganh ICB cho fallback TAT DINH (giong bang rule 6 cua
   SYSTEM_PROMPT; dai truoc ngan sau de tranh trung chuoi con). */
const SECTOR_DRILL = [
  ['bất động sản', '8600'], ['bđs', '8600'],
  ['ngân hàng', '8300'],
  ['dầu khí', '0500'],
  ['tài nguyên cơ bản', '1700'],
  ['thực phẩm và đồ uống', '3500'], ['thực phẩm', '3500'],
  ['điện, nước', '7500'], ['xăng dầu khí đốt', '7500'], ['điện', '7500'],
  ['bán lẻ', '5300'],
  ['hàng & dịch vụ công nghiệp', '2700'],
  ['xây dựng và vật liệu', '2300'], ['xây dựng', '2300'],
  ['du lịch và giải trí', '5700'], ['du lịch', '5700'],
  ['hóa chất', '1300'],
  ['hàng cá nhân & gia dụng', '3700'], ['gia dụng', '3700'],
  ['ô tô và phụ tùng', '3300'], ['ô tô', '3300'],
  ['dịch vụ tài chính', '8700'], ['chứng khoán', '8700'],
  ['công nghệ thông tin', '9500'], ['công nghệ', '9500'],
  ['viễn thông', '6500'],
  ['y tế', '4500'],
  ['truyền thông', '5500'],
  ['bảo hiểm', '8500'],
];
/* Y dinh co cau truc cho cau khoan nganh: "phan tich <nganh>",
   "<nganh> de ro hon", "xem them/khoan sau <nganh>", "<nganh> thi
   sao" -> analyze_sector nhu duong chip khoan (khong qua LLM). */
function deterministicDrill(text) {
  const t = ' ' + String(text || '').toLowerCase()
    .replace(/\s+/g, ' ').trim() + ' ';
  if (!/phân tích|để rõ hơn|khoan sâu|xem thêm|thì sao|kỹ hơn|chi tiết hơn/
    .test(t)) return null;
  for (const [nm, code] of SECTOR_DRILL) {
    if (t.includes(nm)) return { name: 'analyze_sector', args: { code } };
  }
  return null;
}

/* ---------------- engine (b) GĐ2: queue qua D1 (quyet B 16:44 24/10) -------- */
/* Chot 16:09 24/10 + quyet van chuyen B 16:44 24/10 (bo tunnel): key free
   van chinh; engine chi vao khi luot dieu phoi chet vi khoa
   (gemini_down/gemini_400) + co AI_ENGINE = engine-fallback + probe xanh.
   Engine CHI SOAN DAP, khong chon tool, khong tu tinh so.
   - _numericGuard voi data=null = dap khong duoc chua so nao khong co
     nguon. Voi dap engine (khong co envelope), ap dung dung luat nay
     bang cach LUOC BO moi token so truoc khi hien (giu phan tich dinh
     tinh) thay vi bo ca dap — kem co figures_removed de client ghi chu.
   - Khung CHU PHAN TICH: prompt cam khuyen nghi + loc cau khuyen nghi
     o phia Worker truoc khi tra (stripRecommendationSentences).
   - Timeout 120s ap cho buoc lai tab trong 1 browser-task (do that
     harness: dap tab ve trong 15-30s); TTL job 30 phut o D1 bao hang
     doi toi da 3 job x nhip runner 5 phut + thoi gian lai.
   - Probe xanh = co engine-fallback + heartbeat runner tuoi (< 900s)
     + khong bi chan tab (chan chi khi lan kiem tra tab gan nhat la
     wrong_account va chua qua 30 phut; sau 30 phut chan tu het de
     khoi ket vinh vien khi khong co job -> khong co lan kiem tra moi).
   - Hook test staging-only: neu secret ENGINE_FORCE_ENGINE ton tai (chi
     dat tren staging, gia tri ngau nhien, production khong bao gio co
     secret nay) thi luot dieu phoi bi ep vao nhanh catch engine that
     — dung cho S3, go secret sau S3 la hook chet ca staging. Khong
     lam gia dap an. Thu tu S3: go secret hook TRUOC khi doi co ve keys
     (khi hook con bat, moi luot chat deu di vao nhanh engine). */
const ENGINE_INSTRUCTION =
  'Ban la chuyen gia phan tich thi truong chung khoan Viet Nam. Nhiem vu: ' +
  'CHI PHAN TICH dinh tinh cau hoi duoi day. TUYET DOI KHONG dua khuyen nghi ' +
  'mua/ban/nam giu, khong muc tieu gia, khong cat lo/chot loi, khong du bao ' +
  'chac chan gia se tang/giam. Khong bia so lieu: neu khong chac ve mot con ' +
  'so thi noi dinh tinh, khong neu so cu the.';
function enginePrompt(question, lang) {
  return ENGINE_INSTRUCTION + '\nCAU HOI: ' + question +
    '\nTra loi bang ngon ngu: ' + lang + '.';
}

let _flagCache = { v: null, at: 0 };
async function aiEngineFlag(env) {
  if (Date.now() - _flagCache.at < 60000 && _flagCache.v !== null) return _flagCache.v;
  let v = 'keys';
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS ai_engine_flag (value TEXT)').run();
    const row = await env.DB.prepare(
      'SELECT value FROM ai_engine_flag LIMIT 1').first();
    if (row && row.value) v = row.value;
  } catch (e) { /* loi doc co -> fail-closed ve keys */ }
  _flagCache = { v, at: Date.now() };
  return v;
}

const ENGINE_MAX_PENDING = 3;
const ENGINE_PENDING_TTL_MS = 30 * 60 * 1000;
const ENGINE_RUNNING_TTL_MS = 10 * 60 * 1000;
const ENGINE_HEARTBEAT_FRESH_MS = 900 * 1000;
const ENGINE_TAB_BLOCK_MS = 30 * 60 * 1000;
const ENGINE_JOB_RETENTION_MS = 7 * 24 * 3600 * 1000;
async function ensureEngineTables(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS engine_jobs (' +
    'id TEXT PRIMARY KEY, prompt TEXT NOT NULL, lang TEXT, ' +
    'status TEXT NOT NULL, created_at INTEGER NOT NULL, ' +
    'claimed_at INTEGER, completed_at INTEGER, answer TEXT, ' +
    'error TEXT, account_checked TEXT)').run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS engine_runner_state (' +
    'id INTEGER PRIMARY KEY CHECK (id = 1), last_heartbeat_ms INTEGER, ' +
    'last_tab_check_ms INTEGER, last_tab_ok INTEGER, last_account TEXT)').run();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO engine_runner_state (id) VALUES (1)').run();
}
async function engineSweep(env, now) {
  await env.DB.prepare(
    "UPDATE engine_jobs SET status = 'expired', error = 'ttl_pending' " +
    'WHERE status = ? AND created_at < ?')
    .bind('pending', now - ENGINE_PENDING_TTL_MS).run();
  await env.DB.prepare(
    "UPDATE engine_jobs SET status = 'expired', error = 'ttl_running' " +
    'WHERE status = ? AND claimed_at < ?')
    .bind('running', now - ENGINE_RUNNING_TTL_MS).run();
  await env.DB.prepare(
    'DELETE FROM engine_jobs WHERE status IN ' +
    "('done', 'failed', 'expired', 'cancelled') AND completed_at < ?")
    .bind(now - ENGINE_JOB_RETENTION_MS).run();
}
async function engineProbe(env) {
  try {
    await ensureEngineTables(env);
    const row = await env.DB.prepare(
      'SELECT last_heartbeat_ms, last_tab_check_ms, last_tab_ok ' +
      'FROM engine_runner_state WHERE id = 1').first();
    if (!row || !row.last_heartbeat_ms) return { ok: false };
    const now = Date.now();
    if (now - row.last_heartbeat_ms > ENGINE_HEARTBEAT_FRESH_MS) {
      return { ok: false };
    }
    // Chan tab am tinh: chi chan khi lan kiem tra gan nhat la
    // wrong_account va chua qua 30 phut.
    if (row.last_tab_ok === 0 && row.last_tab_check_ms &&
      now - row.last_tab_check_ms < ENGINE_TAB_BLOCK_MS) {
      return { ok: false, blocked_tab: true };
    }
    return { ok: true };
  } catch (e) { return { ok: false }; }
}
function _engineJobId() {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  } catch (e) {
    return Date.now().toString(36) +
      Math.floor(Math.random() * 0xffffff).toString(36);
  }
}
async function engineEnqueue(env, prompt, lang) {
  await ensureEngineTables(env);
  const now = Date.now();
  await engineSweep(env, now);
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM engine_jobs WHERE status = ?')
    .bind('pending').first();
  if (row && row.n >= ENGINE_MAX_PENDING) return { queue_full: true };
  const id = _engineJobId();
  await env.DB.prepare(
    'INSERT INTO engine_jobs (id, prompt, lang, status, created_at) ' +
    'VALUES (?, ?, ?, ?, ?)')
    .bind(id, String(prompt).slice(0, 4000), lang, 'pending', now).run();
  return { job_id: id };
}
/* So sanh hang thoi gian cho secret runner (khong short-circuit). */
function _ctEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function engineRunnerAuth(request, env) {
  const secret = env.ENGINE_RUNNER_SECRET;
  if (!secret) return false;
  const got = request.headers.get('X-Engine-Runner') || '';
  return _ctEqual(got, secret);
}

const _NUM_RE = /(?<![A-Za-z0-9])-?\d{1,3}(?:\.\d{3})+(?:,\d+)?|(?<![A-Za-z0-9])-?\d+(?:,\d+)?/g;
function stripNumbersForDraft(text) {
  const cleaned = String(text || '').replace(_NUM_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
  return { text: cleaned, removed: cleaned !== String(text || '').trim() };
}
const _REC_RE = [
  /nên\s+(mua|bán|nắm giữ)/i, /khuyến nghị/i, /cắt lỗ/i, /chốt lời/i,
  /mục tiêu\s+(giá|chốt)/i, /đáng\s+mua/i, /mua\s+vào/i, /bán\s+ra\s+ngay/i,
];
function stripRecommendationSentences(text) {
  const parts = String(text || '').split(/(?<=[.!?\n])\s+/);
  const kept = [];
  let removed = 0;
  for (const s of parts) {
    if (_REC_RE.some((re) => re.test(s))) { removed++; continue; }
    kept.push(s);
  }
  return { text: kept.join(' ').replace(/[ \t]{2,}/g, ' ').trim(), removed };
}
function cleanEngineDraft(answer) {
  const n = stripNumbersForDraft(answer);
  const r = stripRecommendationSentences(n.text);
  return { text: r.text, figures_removed: n.removed, rec_removed: r.removed };
}

/* Poll 1 job engine tu D1: client goi sau khi nhan engine_job o luot
   fallback. Giu 'user' nhu route chat goc (resolveCaller chi lay email
   ghi log, khong dung quyen nang gi them). */
export async function hAiChatJob(request, env) {
  const json = (o) => new Response(JSON.stringify(o), {
    headers: { 'Content-Type': 'application/json' },
  });
  let caller = null;
  try { caller = await resolveCaller(request, env); } catch (e) { /* bo qua */ }
  const email = caller ? caller.email : '';
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ fallback: true, reason: 'bad_request' });
  try {
    await ensureEngineTables(env);
    await engineSweep(env, Date.now());
    const j = await env.DB.prepare(
      'SELECT status, answer FROM engine_jobs WHERE id = ?').bind(id).first();
    if (!j) return json({ fallback: true, reason: 'engine_not_found' });
    if (j.status === 'done') {
      const c = cleanEngineDraft(j.answer || '');
      await aiLog(env, { ts: Date.now(), user_email: email, lang: 'vi',
        tool: null, status: 'ok:engine', latency_ms: 0, keys_tried: 0,
        lead_kept: 0, via: 'engine' });
      return json({ ok: true, text: c.text, via: 'engine',
        figures_removed: c.figures_removed, rec_removed: c.rec_removed });
    }
    if (j.status === 'pending' || j.status === 'running') {
      return json({ pending: true });
    }
    return json({ fallback: true, reason: 'engine_failed' });
  } catch (e) {
    return json({ fallback: true, reason: 'engine_unreachable' });
  }
}
export async function hAiChatJobCancel(request, env) {
  const json = (o) => new Response(JSON.stringify(o), {
    headers: { 'Content-Type': 'application/json' },
  });
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: true }); }
  const id = body && body.job_id;
  if (!id) return json({ ok: true });
  try {
    await ensureEngineTables(env);
    await env.DB.prepare(
      "UPDATE engine_jobs SET status = 'cancelled' " +
      'WHERE id = ? AND status = ?').bind(id, 'pending').run();
  } catch (e) { /* huy best-effort: job tu het TTL neu khong huy duoc */ }
  return json({ ok: true });
}

/* ---------------- route runner (auth ENGINE_RUNNER_SECRET) ---------------- */
export async function hAiEngineClaim(request, env) {
  const json = (o, status) => new Response(JSON.stringify(o), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
  if (!engineRunnerAuth(request, env)) {
    return json({ error: 'unauthorized' }, 401);
  }
  try {
    await ensureEngineTables(env);
    await engineSweep(env, Date.now());
    const j = await env.DB.prepare(
      'SELECT id, prompt, lang FROM engine_jobs ' +
      "WHERE status = ? ORDER BY created_at ASC LIMIT 1")
      .bind('pending').first();
    if (!j) return json({ error: 'no_pending_job' }, 404);
    await env.DB.prepare(
      "UPDATE engine_jobs SET status = 'running', claimed_at = ? " +
      'WHERE id = ? AND status = ?')
      .bind(Date.now(), j.id, 'pending').run();
    return json({ job_id: j.id, prompt: j.prompt, lang: j.lang });
  } catch (e) {
    return json({ error: 'engine_error' }, 500);
  }
}
export async function hAiEngineComplete(request, env) {
  const json = (o, status) => new Response(JSON.stringify(o), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
  if (!engineRunnerAuth(request, env)) {
    return json({ error: 'unauthorized' }, 401);
  }
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_request' }, 400); }
  const id = body && body.job_id;
  if (!id) return json({ error: 'bad_request' }, 400);
  try {
    await ensureEngineTables(env);
    const now = Date.now();
    const failed = !!body.error;
    const rs = await env.DB.prepare(
      'UPDATE engine_jobs SET status = ?, answer = ?, error = ?, ' +
      'account_checked = ?, completed_at = ? ' +
      "WHERE id = ? AND status = 'running'")
      .bind(failed ? 'failed' : 'done',
        failed ? null : (body.answer || null),
        failed ? String(body.error).slice(0, 100) : null,
        body.account_checked ? String(body.account_checked).slice(0, 100) : null,
        now, id).run();
    if (!rs || rs.meta.changes === 0) {
      return json({ error: 'job_not_running' }, 404);
    }
    // Ghi trang thai tab cho probe: timeout van la tab song (chi cham),
    // chi wrong_account moi danh tab chet.
    await env.DB.prepare(
      'UPDATE engine_runner_state SET last_tab_check_ms = ?, ' +
      'last_tab_ok = ?, last_account = ? WHERE id = 1')
      .bind(now, body.error === 'wrong_account' ? 0 : 1,
        body.account_checked ? String(body.account_checked).slice(0, 100) : null).run();
    return json({ job_id: id, status: failed ? 'failed' : 'done' });
  } catch (e) {
    return json({ error: 'engine_error' }, 500);
  }
}
export async function hAiEngineHeartbeat(request, env) {
  const json = (o, status) => new Response(JSON.stringify(o), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
  if (!engineRunnerAuth(request, env)) {
    return json({ error: 'unauthorized' }, 401);
  }
  try {
    await ensureEngineTables(env);
    const now = Date.now();
    await env.DB.prepare(
      'UPDATE engine_runner_state SET last_heartbeat_ms = ? WHERE id = 1')
      .bind(now).run();
    return json({ heartbeat_at: now });
  } catch (e) {
    return json({ error: 'engine_error' }, 500);
  }
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
  '6. PHAN TICH NGANH (BB-1): "phan tich <ten nganh>", "<ten nganh> de ro hon", "xem them/khoan sau <ten nganh>", "<ten nganh> thi sao" -> analyze_sector voi code cua nganh do (ke ca khi lich su dang o the dong tien hay the nganh). Bang ma ICB: 0500 Dau khi; 8600 Bat dong san; 1700 Tai nguyen Co ban; 3500 Thuc pham va do uong; 7500 Dien, nuoc & xang dau khi dot; 5300 Ban le; 2700 Hang & Dich vu Cong nghiep; 2300 Xay dung va Vat lieu; 5700 Du lich va Giai tri; 1300 Hoa chat; 3700 Hang ca nhan & Gia dung; 3300 O to va phu tung; 8700 Dich vu tai chinh; 9500 Cong nghe Thong tin; 6500 Vien thong; 4500 Y te; 5500 Truyen thong; 8300 Ngan hang; 8500 Bao hiem.',
  '7. VI MO: hoi ty gia, lai suat, gia vang, OMO, chinh sach tien te -> get_macro (co series thi dat series tuong ung); khong tra loi van xuoi thay cho so lieu vi mo.',
  '8. PHAN TICH MA (BB-2): "phan tich (ky) <ma>", "xem ky ma <ma>", "<ma> ky hon" -> analyze_symbol(symbol). Hoi nhanh gia/dong tien 1 ma thi van dung get_quote/get_flow nhu thuong.',
  '9. SO SANH (BB-3): "so sanh X voi Y" -> analyze_compare: 2 ma thi kind=symbols, 2 ten nganh thi kind=sectors kem 2 ma ICB tuong ung.',
  '10. TOAN CANH (BB-4): "thi truong hom nay the nao", "tong quan phien/thi truong" -> analyze_market.',
  '11. Cau hoi DU BAO ("nganh X sap toi co tang khong", "ma Y ngay mai the nao") -> VAN goi tool phan tich tuong ung (BB-1/BB-2/BB-4) de lay phan mo ta hien trang; he thong khong du bao va se noi ro dieu do — khong tu choi trong, khong tra loi van xuoi du bao.',
  '12. CO DONG & SO HUU (BB-5): hoi ve co dong/co dac so huu/room ngoai/lanh dao nam giu CUA 1 MA -> analyze_holders(symbol). Hoi MOT CO DONG cu the ky nay tang giam nam giu nhung ma nao -> get_holder_portfolio_changes(name). Ranh gioi cung cua BB-5: khong goi bat ky so nao la "tin hieu", khong dung khai niem blackout (TT 96/2020 khong co), tran room chi theo ma da thong bao, thay doi theo ky ke kem loai dinh ngay (interval), so huu lanh dao khong suy ra chat luong quan tri.',
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
      via: (extra && extra.via) || null,
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
  let viaOxion = false;
  const pass1Body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT + '\n13. Tra loi bang ngon ngu: ' + lang + '.' }] },
    contents,
    tools: [{ functionDeclarations: _buildDecls() }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
  };
  try {
    // Hook test staging-only (xem ghi chu engine): secret nay chi dat
    // tren staging (gia tri ngau nhien, chi can ton tai); production
    // khong co secret nay nen nhanh nay chet han o prod.
    if (env.ENGINE_FORCE_ENGINE) {
      const fe = new Error('gemini_down');
      fe.reason = 'gemini_down'; fe.detail = 'forced_test';
      throw fe;
    }
    j1 = await geminiCall(env, keys, state, pass1Body, 10000, 3000);
  } catch (e) {
    // Oxion (chan API du phong, Chot 22:08 24/10): chi khi luot key
    // nem + co secret OXION_API_KEY. Thanh cong -> j1 dang Gemini,
    // roi xuong xu ly fc/text phia duoi nhu luot key (kem co
    // viaOxion de log via rieng). That bai -> engine (b) nhu cu.
    if (env.OXION_API_KEY) {
      try {
        j1 = await oxionCall(env, pass1Body, 60000);
        viaOxion = true;
      } catch (e3) { /* Oxion chet -> engine nhu cu */ }
    }
    if (!viaOxion) {
      // Engine (b): chi khi luot dieu phoi chet vi khoa + co engine-fallback
      // + probe xanh. Tra fallback KEM engine_job (client cu bo qua truong
      // moi va dung chatRoute nhu cu; client moi chi poll engine khi
      // chatRoute khong giai quyet duoc) — khong lam cham luot fallback.
      const fbExtra = { keys_tried: state.keysTried, detail: (e && e.detail) || null };
      try {
        const flag = await aiEngineFlag(env);
        if (flag === 'engine-fallback') {
          const probe = await engineProbe(env);
          if (probe.ok) {
            const enq = await engineEnqueue(env,
              enginePrompt(lastUser.text, lang), lang);
            if (enq.job_id) {
              return finish({ fallback: true, reason: (e && e.reason) || 'gemini_down',
                engine_job: enq.job_id, engine_available: true },
                'fallback:engine_pending', fbExtra);
            }
            if (enq.queue_full) {
              return finish({ fallback: true, reason: (e && e.reason) || 'gemini_down',
                engine_busy: true }, 'fallback:engine_busy', fbExtra);
            }
          }
        }
      } catch (e2) { /* probe/enqueue loi -> fallback thuong */ }
      return fallback((e && e.reason) || 'gemini_down', fbExtra);
    }
  }

  let fc = geminiFunctionCall(j1);
  if (!fc) {
    // Khong can so lieu: chi chap nhan text neu khong chua con so
    // nao khong kiem chung duoc (khong co envelope de gac).
    let text = geminiText(j1);
    if (viaOxion) text = stripRecommendationSentences(text).text;
    if (text && _numericGuard(text, null) && !_bannedLead(text)) {
      return finish(viaOxion ? { ok: true, tool: null, text, via: 'oxion' } : { ok: true, tool: null, text },
        viaOxion ? 'ok:oxion' : 'ok',
        { keys_tried: state.keysTried, via: viaOxion ? 'oxion' : null });
    }
    // Van xuoi khong kiem chung duoc (hoac rong): ep model CHON
    // TOOL 1 luot (mode ANY) truoc khi roi du phong. Ca loi
    // 23/10: cau khoan nganh sau the dong tien bi tra van xuoi
    // chua so -> fallback:no_tool lap 2 lan du prompt da co luat.
    try {
      const j1b = await geminiCall(env, keys, state, {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT + '\n13. Tra loi bang ngon ngu: ' + lang + '.' }] },
        contents,
        tools: [{ functionDeclarations: _buildDecls() }],
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
      }, 6000, 2500);
      fc = geminiFunctionCall(j1b);
    } catch (e) { /* het ngan sach / loi -> giu duong fallback cu */ }
    if (!fc) {
      // Du phong TAT DINH (lenh dau moi 21:39 23/10): cau khoan nganh
      // ma model khong map duoc — ke ca khi ANY-enforcement khong sinh
      // tool call hay quota chet giua chung — di qua lop y dinh co cau
      // truc nhu duong chip khoan, thay vi tra no_tool ra giao dien.
      fc = deterministicDrill(lastUser.text);
    }
    if (!fc) {
      return fallback('no_tool', { keys_tried: state.keysTried,
        detail: (state.trace || []).join(',') });
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
  const dataJson = JSON.stringify(envelope.data || {}).slice(0, 6000);
  const leadPrompt =
    'Duoi day la du lieu thi truong (JSON) vua truy van duoc cho cau hoi cua nguoi dung. ' +
    'Hay viet 1-2 cau dan ngan gon bang ngon ngu "' + lang + '" mo ta diem chinh cua du lieu.\n' +
    'LUAT: CHI dung cac con so co mat trong JSON; khong nhac ngay thang; khong du doan, ' +
    'khong khuyen nghi mua/ban; so tien lon quy ve don vi "ty" (1 ty = 1e9 dong), ' +
    'so phan tram giu nguyen nhu trong JSON.\n' +
    'CAU HOI: ' + lastUser.text + '\nDU LIEU: ' + dataJson;
  try {
    if (Date.now() - t0 < 10000 || viaOxion) {
    const j2 = await geminiCall(env, keys, state, {
      contents: [{ role: 'user', parts: [{ text: leadPrompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    }, 4000, 2000);
    const txt = geminiText(j2).replace(/\s+/g, ' ').slice(0, 400);
    if (txt && _numericGuard(txt, envelope.data) && !_bannedLead(txt)) lead = txt;
    }
  } catch (e) {
    // Cau dan qua Oxion khi luot key chet (luot viaOxion: khoa da
    // chet nen geminiCall truot nhanh qua dead-set). Van qua cong
    // gac so + loc cau khuyen nghi nhu luot key.
    if (env.OXION_API_KEY) {
      try {
        const oj = await oxionCall(env, {
          contents: [{ role: 'user', parts: [{ text: leadPrompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
        }, 60000);
        let txt = geminiText(oj).replace(/\s+/g, ' ').slice(0, 400);
        txt = stripRecommendationSentences(txt).text;
        if (txt && _numericGuard(txt, envelope.data) && !_bannedLead(txt)) lead = txt;
      } catch (e3) { /* Oxion chet -> chi hien the du lieu */ }
    }
  }

  return finish(
    viaOxion ? { ok: true, tool: fc.name, args: fc.args, envelope, lead, via: 'oxion' }
      : { ok: true, tool: fc.name, args: fc.args, envelope, lead },
    viaOxion ? 'ok:oxion' : 'ok',
    { keys_tried: state.keysTried, lead_kept: lead ? 1 : 0, via: viaOxion ? 'oxion' : null });
}

export { _buildDecls };
