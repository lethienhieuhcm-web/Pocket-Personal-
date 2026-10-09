// worker/src/ai.js — AI features (Gemini) for English Lab.
import { jerr, fetchTimeout } from './utils.js';

const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/";

// Simple hash for cache keys
function hashStr(s){
  let h = 0;
  for(let i=0; i<s.length; i++){ h = ((h<<5)-h+s.charCodeAt(i))|0; }
  return (h>>>0).toString(16);
}

async function callGemini(env, prompt){
  const key = env.GEMINI_API_KEY;
  if(!key) throw new Error("AI not configured");
  const url = `${GEMINI_API}${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetchTimeout(url, 30000, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      contents: [{parts: [{text: prompt}]}],
      generationConfig: {temperature: 0.7, maxOutputTokens: 1000}
    })
  });
  if(!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error(`AI error ${r.status}: ${t.slice(0,200)}`);
  }
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if(!text) throw new Error("Empty AI response");
  return text.trim();
}

async function getCache(env, key){
  try{
    const row = await env.DB.prepare("SELECT response FROM ai_cache WHERE cache_key=?").bind(key).first();
    return row ? row.response : null;
  }catch(e){ return null; }
}

async function setCache(env, key, response){
  try{
    await env.DB.prepare("INSERT OR REPLACE INTO ai_cache (cache_key, response, created_at) VALUES (?, ?, ?)")
      .bind(key, response, Date.now()).run();
  }catch(e){ /* cache table may not exist yet */ }
}

// POST /api/ai/explain — explain a word in sentence context
export async function handleAIExplain(request, env){
  const {checkFeature, incrUsage} = await import('./billing.js');
  const chk = await checkFeature(request, env, 'ai_explain');
  if(chk.err) return chk.err;

  let b;
  try{ b = await request.json(); }catch(e){ return jerr("Invalid JSON", 400); }
  const word = String(b.word || b.text || "").trim().slice(0, 500);
  const sentence = String(b.sentence || "").trim().slice(0, 500);
  const lang = String(b.lang || "vi").slice(0, 5);
  if(!word) return jerr("Missing word", 400);

  // Check cache
  const cacheKey = "explain:" + hashStr(word + "|" + sentence + "|" + lang);
  const cached = await getCache(env, cacheKey);
  if(cached){
    return new Response(JSON.stringify({explanation: cached, cached: true}),
      {headers: {"Content-Type": "application/json"}});
  }

  const langName = {vi: "Vietnamese", en: "English", zh: "Chinese", ko: "Korean"}[lang] || "Vietnamese";
  const prompt = `Explain the English word "${word}" as used in this sentence: "${sentence || "(no context)"}". ` +
    `Reply in ${langName}. Include: 1) meaning in this context, 2) part of speech, 3) one example sentence. Keep it concise (under 150 words).`;

  try{
    const explanation = await callGemini(env, prompt);
    await setCache(env, cacheKey, explanation);
    await incrUsage(env, chk.user.email, 'ai_calls', 1).catch(()=>{});
    return new Response(JSON.stringify({explanation, cached: false}),
      {headers: {"Content-Type": "application/json"}});
  }catch(e){
    return jerr(e.message || "AI failed", 500);
  }
}

// POST /api/ai/quiz — generate 5 quiz questions from article text
export async function handleAIQuiz(request, env){
  const {checkFeature, incrUsage} = await import('./billing.js');
  const chk = await checkFeature(request, env, 'ai_quiz');
  if(chk.err) return chk.err;

  let b;
  try{ b = await request.json(); }catch(e){ return jerr("Invalid JSON", 400); }
  const text = String(b.text || "").trim().slice(0, 3000);
  const lang = String(b.lang || "vi").slice(0, 5);
  if(!text || text.length < 50) return jerr("Text too short (min 50 chars)", 400);

  // Check cache
  const cacheKey = "quiz:" + hashStr(text + "|" + lang);
  const cached = await getCache(env, cacheKey);
  if(cached){
    return new Response(JSON.stringify({quiz: JSON.parse(cached), cached: true}),
      {headers: {"Content-Type": "application/json"}});
  }

  const langName = {vi: "Vietnamese", en: "English", zh: "Chinese", ko: "Korean"}[lang] || "Vietnamese";
  const prompt = `Create 5 multiple-choice English quiz questions from this text:\n\n${text}\n\n` +
    `Reply in ${langName} (questions in English, explanations in ${langName}). ` +
    `Return ONLY valid JSON array, no markdown: [{"q":"question","options":["A","B","C","D"],"answer":0,"explain":"why"}]. ` +
    `Keep questions about vocabulary and comprehension.`;

  try{
    let quizText = await callGemini(env, prompt);
    // Extract JSON from response (may have markdown fences)
    const jsonMatch = quizText.match(/\[[\s\S]*\]/);
    if(jsonMatch) quizText = jsonMatch[0];
    const quiz = JSON.parse(quizText);
    if(!Array.isArray(quiz) || quiz.length === 0) throw new Error("Invalid quiz format");
    await setCache(env, cacheKey, JSON.stringify(quiz));
    await incrUsage(env, chk.user.email, 'ai_calls', 1).catch(()=>{});
    return new Response(JSON.stringify({quiz, cached: false}),
      {headers: {"Content-Type": "application/json"}});
  }catch(e){
    return jerr(e.message || "AI failed", 500);
  }
}
