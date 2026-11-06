// worker/src/ai_gateway.js — AI Gateway (Cloudflare, $0) + Workers AI cho
// AI Chat va consensus (quyet trien khai 16:00 06/11, theo bao cao
// workers-ai-gateway-research-20261106).
//
// - Endpoint compat: {GW_BASE}/{account}/{gateway}/compat/chat/completions,
//   model dang {provider}/{model}. Gateway `default` TU SINH o request dau
//   tien (docs 04/11/2026) — khong can tao truoc.
// - Chan leg thu tu: cerebras/gpt-oss-120b → google-ai-studio/gemini-* →
//   workers-ai/@cf/openai/gpt-oss-120b. Gateway lo fallback TANG TRANSPORT
//   (4xx/5xx/timeout/network → key/leg tiep theo).
// - Fallback TANG VERDICT (no-rating → doi leg) VAN o trong code
//   (consensusBrainCall): gateway khong nhay duoc phan quyet cua app.
// - Radox/LLM7: gateway khong ho tro custom endpoint → giu goi truc tiep
//   nhu cu (khong nam trong module nay).
// - Key: KHONG hardcode. Doc tu env secret: CEREBRAS_API_KEY (leg 1),
//   GEMINI_API_KEYS (leg 2, xoay khoa nhu cu), CLOUDFLARE_API_TOKEN +
//   CLOUDFLARE_ACCOUNT_ID (leg workers-ai qua gateway/REST). Binding [ai]
//   trong wrangler.toml → env.AI.run (khong can token).
// - Gateway loi (thieu config, 4xx/5xx het leg, timeout, network) →
//   caller roi ve duong goi truc tiep cu (hanh vi khong doi).

const GW_BASE = 'https://gateway.ai.cloudflare.com/v1/';
export const GW_CEREBRAS_MODEL = 'cerebras/gpt-oss-120b';
export const GW_WORKERSAI_MODEL = 'workers-ai/@cf/openai/gpt-oss-120b';
export const WORKERSAI_MODEL = '@cf/openai/gpt-oss-120b'; // binding/REST $0
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash'; // dung voi ai_chat.js

export function geminiModelName(env) {
  return env.AI_CHAT_MODEL || DEFAULT_GEMINI_MODEL;
}

export function gatewayEnabled(env) {
  return String(env.AI_GATEWAY_ENABLED || '').trim() === '1' &&
    String(env.AI_GATEWAY_ACCOUNT_ID || '').trim().length > 0;
}

export function gatewayUrl(env) {
  const acct = String(env.AI_GATEWAY_ACCOUNT_ID || '').trim();
  const gw = String(env.AI_GATEWAY_ID || 'default').trim() || 'default';
  return GW_BASE + acct + '/' + gw + '/compat/chat/completions';
}

function _trim(v) { return String(v || '').trim(); }

/* Danh sach leg: chi leg nao co key moi duoc them. `keys` la danh sach
   key Gemini xoay vong (duy nhat cho leg google-ai-studio). */
export function gatewayLegs(env, geminiKeys) {
  const legs = [];
  const cerebrasKey = _trim(env.CEREBRAS_API_KEY);
  if (cerebrasKey) legs.push({ model: GW_CEREBRAS_MODEL, keys: [cerebrasKey] });
  const gk = (geminiKeys || []).map(_trim).filter(Boolean);
  if (gk.length) legs.push({ model: 'google-ai-studio/' + geminiModelName(env), keys: gk });
  const cfTok = _trim(env.CLOUDFLARE_API_TOKEN);
  if (cfTok) legs.push({ model: GW_WORKERSAI_MODEL, keys: [cfTok] });
  return legs;
}

/* ---------------- dich body Gemini-native <-> OpenAI-compat ---------------- */
function _lowerSchema(s) {
  if (Array.isArray(s)) return s.map(_lowerSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const k of Object.keys(s)) {
    const v = s[k];
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
    else if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const p of Object.keys(v)) out.properties[p] = _lowerSchema(v[p]);
    } else if (k === 'items') out.items = _lowerSchema(v);
    else out[k] = v;
  }
  return out;
}

export function geminiBodyToOpenAI(body) {
  const messages = [];
  const si = body && body.systemInstruction;
  if (si && Array.isArray(si.parts)) {
    const text = si.parts.map((p) => (p && p.text) || '').join('\n').trim();
    if (text) messages.push({ role: 'system', content: text });
  }
  for (const c of (body && body.contents) || []) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const text = (c.parts || [])
      .filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('\n');
    if (text) messages.push({ role, content: text });
  }
  const out = { messages };
  const gc = (body && body.generationConfig) || {};
  if (typeof gc.temperature === 'number') out.temperature = gc.temperature;
  if (typeof gc.maxOutputTokens === 'number') out.max_tokens = gc.maxOutputTokens;
  const decls = body && body.tools && body.tools[0] && body.tools[0].functionDeclarations;
  if (Array.isArray(decls) && decls.length) {
    out.tools = decls.map((d) => ({
      type: 'function',
      function: {
        name: d.name,
        description: d.description || '',
        parameters: _lowerSchema(d.parameters || { type: 'OBJECT', properties: {} }),
      },
    }));
    const mode = body.toolConfig && body.toolConfig.functionCallingConfig &&
      body.toolConfig.functionCallingConfig.mode;
    out.tool_choice = mode === 'ANY' ? 'required' : 'auto';
  }
  return out;
}

export function openaiToGemini(j) {
  const choice = (j && j.choices && j.choices[0]) || {};
  const msg = choice.message || {};
  const parts = [];
  for (const tc of msg.tool_calls || []) {
    let args = {};
    try {
      args = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch (e) { /* arguments khang phai JSON -> bo trong */ }
    parts.push({ functionCall: { name: (tc.function && tc.function.name) || '', args } });
  }
  if (typeof msg.content === 'string' && msg.content) parts.push({ text: msg.content });
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: choice.finishReason || 'STOP' }],
    usageMetadata: j && j.usage
      ? {
        promptTokenCount: j.usage.prompt_tokens,
        candidatesTokenCount: j.usage.completion_tokens,
        totalTokenCount: j.usage.total_tokens,
      } : null,
  };
}

export function openaiText(j) {
  const msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
  return typeof msg.content === 'string' ? msg.content : '';
}

/* ---------------- goi gateway compat, fallback tang transport ---------------- */
// Thu theo leg → theo key trong leg. 401/403 -> danh dau key chet (mark
// model#idx); loi khac (429/5xx/network/timeout) -> key/leg tiep theo.
// Het leg -> Error reason 'gateway_down' (caller tu quyet duong cu).
export async function gatewayOpenAICall(env, openaiBody, o) {
  o = o || {};
  const url = gatewayUrl(env);
  let legs = gatewayLegs(env, o.keys || []);
  if (o.onlyModel) legs = legs.filter((l) => l.model === o.onlyModel);
  if (!legs.length) {
    const e = new Error('gateway_no_legs'); e.reason = 'gateway_no_legs'; throw e;
  }
  const state = o.state || {};
  if (!state.gwDead) state.gwDead = new Set();
  if (!state.gwTrace) state.gwTrace = [];
  const endAt = Date.now() + (o.deadlineMs || 10000);
  let lastErr = null;
  for (const leg of legs) {
    for (let i = 0; i < leg.keys.length; i++) {
      if (Date.now() > endAt - 300) break;
      const mark = leg.model + '#' + i;
      if (state.gwDead.has(mark)) continue;
      state.gwTried = (state.gwTried || 0) + 1;
      const per = Math.min(o.perAttemptMs || 3000, Math.max(400, endAt - Date.now()));
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), per);
      // Compat endpoint: provider/model dinh trong BODY (khong phai URL).
      const payload = Object.assign({}, openaiBody, { model: leg.model });
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + leg.keys[i],
          },
          body: JSON.stringify(payload),
          signal: ctl.signal,
        });
        clearTimeout(timer);
        if (r.status === 401 || r.status === 403) {
          state.gwDead.add(mark);
          state.gwTrace.push(leg.model + ':auth');
          lastErr = new Error('gateway_http_' + r.status);
          continue;
        }
        if (!r.ok) {
          state.gwTrace.push(leg.model + ':http_' + r.status);
          lastErr = new Error('gateway_http_' + r.status);
          try { lastErr.detail = String(((await r.json()) || {}).error || '').slice(0, 160); }
          catch (e2) { /* body loi khong doc duoc */ }
          continue;
        }
        state.gwTrace.push(leg.model + ':200');
        return { model: leg.model, data: await r.json() };
      } catch (e) {
        clearTimeout(timer);
        state.gwTrace.push(leg.model + ':net');
        lastErr = e; // abort/loi mang -> key tiep
      }
    }
  }
  const e = new Error('gateway_down');
  e.reason = 'gateway_down';
  e.detail = (lastErr && (lastErr.detail || lastErr.message)) || state.gwTrace.join(',');
  e.cause = lastErr;
  throw e;
}

/* Voi ai_chat.js: vao body Gemini-native, tra ra dang Gemini-native
   (geminiText/geminiFunctionCall giu nguyen). j.gw_model = leg thanh cong. */
export async function gatewayGeminiCall(env, keys, state, geminiBody, deadlineMs, perAttemptMs, onlyModel) {
  const res = await gatewayOpenAICall(env, geminiBodyToOpenAI(geminiBody), {
    keys, state, deadlineMs, perAttemptMs, onlyModel,
  });
  const j = openaiToGemini(res.data);
  j.gw_model = res.model;
  return j;
}

/* ---------------- Workers AI $0 (binding hoac REST) ---------------- */
// Free 10.000 Neuron/ngay: het quota la request LOI (khong tu tru tien).
// Bien loi do thanh reason 'workers_ai_quota' de caller xu ly co kiem soat
// (khong crash, khong dot quota them).
function _workersAiText(r) {
  if (typeof r === 'string') return r;
  if (!r || typeof r !== 'object') return '';
  if (typeof r.response === 'string') return r.response;
  if (Array.isArray(r.choices) && r.choices[0]) {
    const m = r.choices[0].message || {};
    if (typeof m.content === 'string') return m.content;
  }
  return '';
}
function _isQuotaError(e) {
  if (!e) return false;
  if (e.status === 429 || e.status === 402) return true;
  return /quota|neuron|exceed|allocation|out of/i.test(String(e.message || e));
}

export async function workersAiChat(env, messages, opts) {
  opts = opts || {};
  const model = opts.model || WORKERSAI_MODEL;
  const body = {
    messages,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
    max_tokens: typeof opts.maxTokens === 'number' ? opts.maxTokens : 1024,
  };
  try {
    if (env.AI && typeof env.AI.run === 'function') {
      const r = await env.AI.run(model, body);
      return { text: _workersAiText(r), via: 'workersai-binding' };
    }
    const acct = _trim(env.CLOUDFLARE_ACCOUNT_ID);
    const tok = _trim(env.CLOUDFLARE_API_TOKEN);
    if (!acct || !tok) {
      const e = new Error('workersai_unconfigured'); e.reason = 'workersai_unconfigured';
      throw e;
    }
    const r = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + acct + '/ai/run/' + model,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
        body: JSON.stringify(body),
      });
    let j = null;
    try { j = await r.json(); } catch (e2) { /* body khong phai JSON */ }
    if (!r.ok) {
      const e = new Error('workersai_http_' + r.status); e.status = r.status;
      e.detail = String(((j && j.errors && j.errors[0]) || {}).message || '').slice(0, 160);
      throw e;
    }
    return { text: _workersAiText(j), via: 'workersai-rest' };
  } catch (e) {
    if (_isQuotaError(e)) {
      const q = new Error('workers_ai_quota');
      q.reason = 'workers_ai_quota';
      q.detail = String(e.detail || e.message || e).slice(0, 160);
      throw q;
    }
    throw e;
  }
}

/* ---------------- consensus: transport + verdict fallback ---------------- */
// Quyet (verdict) cua consensus: JSON co truong rating. ratingrong/no-rating
// -> DOI LEG (tang verdict, o lai trong code — gateway khong nhin thay).
// Leg: gw cerebras → gw gemini → Workers AI $0. Gateway tat thi
// gemini truc tiep → Workers AI $0 (hanh vi cu duoc giu).
export function defaultParseVerdict(text) {
  const t = String(text || '');
  const i = t.indexOf('{');
  const k = t.lastIndexOf('}');
  if (i < 0 || k <= i) return { rating: null, raw: t };
  try {
    const j = JSON.parse(t.slice(i, k + 1));
    return j && typeof j === 'object' ? j : { rating: null, raw: t };
  } catch (e) { return { rating: null, raw: t }; }
}
export function isNoRating(verdict) {
  if (!verdict || typeof verdict !== 'object') return true;
  const r = verdict.rating;
  if (r == null || String(r).trim() === '') return true;
  return /no.?\s*-?\s*rating|khong.?\s*co.?\s*(khuyen nghi|dong thuan)/i.test(String(r));
}

// Goi Gemini truc tiep (generateContent, xoay key) — dung khi gateway tat.
async function directGeminiText(env, keys, messages, o) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    geminiModelName(env) + ':generateContent';
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    }));
  const sys = messages.find((m) => m.role === 'system');
  const body = {
    contents,
    generationConfig: { temperature: 0.2, maxOutputTokens: o.maxTokens || 1024 },
  };
  if (sys) body.systemInstruction = { parts: [{ text: String(sys.content || '') }] };
  let lastErr = null;
  for (let tried = 0; tried < Math.min(4, keys.length); tried++) {
    const key = keys[(o.keyStart + tried) % keys.length];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
      if (!r.ok) { lastErr = new Error('gemini_http_' + r.status); continue; }
      const j = await r.json();
      const parts = (j.candidates && j.candidates[0] && j.candidates[0].content &&
        j.candidates[0].content.parts) || [];
      return parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join(' ').trim();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('gemini_down');
}

export async function consensusBrainCall(env, messages, opts) {
  opts = opts || {};
  const parseVerdict = typeof opts.parseVerdict === 'function'
    ? opts.parseVerdict : defaultParseVerdict;
  const geminiKeys = String(env.GEMINI_API_KEYS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const gw = gatewayEnabled(env);
  const cerebrasKey = _trim(env.CEREBRAS_API_KEY);

  const legs = [];
  if (gw && cerebrasKey) legs.push({ via: 'gw', model: GW_CEREBRAS_MODEL });
  if (gw && geminiKeys.length) legs.push({ via: 'gw', model: 'google-ai-studio/' + geminiModelName(env) });
  if (!gw && geminiKeys.length) legs.push({ via: 'direct' });
  legs.push({ via: 'workersai' }); // chan $0 du phong (binding/REST)

  const openaiBody = {
    messages,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
    max_tokens: typeof opts.maxTokens === 'number' ? opts.maxTokens : 1024,
  };
  const state = {};
  const trace = [];
  let lastNoRating = null;
  let quotaHit = false;
  let lastErr = null;
  const keyStart = Math.floor(Math.random() * Math.max(1, geminiKeys.length));

  for (const leg of legs) {
    try {
      let text = '';
      if (leg.via === 'gw') {
        const res = await gatewayOpenAICall(env, openaiBody, {
          keys: leg.model === GW_CEREBRAS_MODEL ? [cerebrasKey] : geminiKeys,
          onlyModel: leg.model,
          state,
          deadlineMs: opts.perLegDeadlineMs || 10000,
          perAttemptMs: opts.perAttemptMs || 6000,
        });
        text = openaiText(res.data);
        trace.push('gw:' + leg.model + ':200');
      } else if (leg.via === 'direct') {
        text = await directGeminiText(env, geminiKeys, messages,
          { maxTokens: opts.maxTokens, keyStart });
        trace.push('direct-gemini:200');
      } else {
        const r = await workersAiChat(env, messages, opts);
        text = r.text;
        trace.push(r.via + ':200');
      }
      const verdict = parseVerdict(text);
      if (!isNoRating(verdict)) {
        const viaTag = leg.via === 'workersai' ? 'workersai-0$'
          : (leg.via === 'gw' ? 'gw:' + leg.model : leg.via);
        return { ok: true, via: viaTag, verdict, text, trace };
      }
      // Verdict no-rating -> leg tiep theo (logic giu trong code).
      lastNoRating = { via: leg.via === 'gw' ? 'gw:' + leg.model : leg.via,
        text, verdict };
      trace.push((leg.via === 'gw' ? 'gw:' + leg.model : leg.via) + ':no-rating');
    } catch (e) {
      if (e && e.reason === 'workers_ai_quota') {
        quotaHit = true;
        trace.push('workersai:quota');
        lastErr = e;
        continue; // loi co kiem soat: sang leg (day la leg cuoi -> ket luan ben duoi)
      }
      lastErr = e;
      trace.push((leg.via === 'gw' ? 'gw:' + leg.model : leg.via) + ':' + ((e && (e.reason || e.message)) || 'err'));
    }
  }
  // Het leg: no-rating cuoi cung van la ket qua hop le cua ca luot
  // (app tu quyet xu ly — khong phai loi truyen dan).
  if (lastNoRating) {
    return { ok: true, noRating: true, via: lastNoRating.via,
      verdict: lastNoRating.verdict, text: lastNoRating.text, trace,
      quota: quotaHit || null };
  }
  if (quotaHit) {
    return { ok: false, reason: 'workers_ai_quota', trace,
      detail: (lastErr && lastErr.detail) || null };
  }
  return { ok: false, reason: 'brain_down', trace,
    detail: (lastErr && (lastErr.detail || lastErr.message)) || null };
}
