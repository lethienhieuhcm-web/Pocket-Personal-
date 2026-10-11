// worker/src/ai.js — AI features (Gemini) for English Lab.
import { jerr, fetchTimeout } from './utils.js';
import { drizzle } from "drizzle-orm/d1";
import { eq, desc } from "drizzle-orm";
import { aiCache, vocabReviews } from "./schema.js";

// Get user's recent vocab words for context (last 5 studied)
async function getRecentVocab(env, email, limit=5){
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({ word: vocabReviews.word })
      .from(vocabReviews)
      .where(eq(vocabReviews.email, email.toLowerCase()))
      .orderBy(desc(vocabReviews.updatedAt))
      .limit(limit);
    return rows.map(r => r.word).filter(Boolean);
  }catch(e){ return []; }
}

// Get user's weak words (low accuracy or short interval)
async function getWeakVocab(env, email, limit=5){
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({
        word: vocabReviews.word,
        reviews: vocabReviews.reviews,
        correct: vocabReviews.correct,
        intervalDays: vocabReviews.intervalDays,
      })
      .from(vocabReviews)
      .where(eq(vocabReviews.email, email.toLowerCase()))
      .orderBy(vocabReviews.intervalDays)
      .limit(20);
    // Score: lower accuracy + shorter interval = weaker
    const scored = rows.map(r => {
      const acc = r.reviews > 0 ? r.correct / r.reviews : 0.5;
      return { word: r.word, score: acc * 0.7 + Math.min(r.intervalDays / 30, 1) * 0.3 };
    }).filter(s => s.word);
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, limit).map(s => s.word);
  }catch(e){ return []; }
}

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/";

// Simple hash for cache keys
function hashStr(s){
  let h = 0;
  for(let i=0; i<s.length; i++){ h = ((h<<5)-h+s.charCodeAt(i))|0; }
  return (h>>>0).toString(16);
}

async function callGeminiViaProxy(env, prompt, jsonMode){
  const proxyUrl = env.MODAL_PROXY_URL;
  const proxyToken = env.MODAL_PROXY_TOKEN;
  if(!proxyUrl || !proxyToken) throw new Error("Proxy not configured");
  const genConfig = {temperature: 0.7, maxOutputTokens: 1000};
  if(jsonMode) genConfig.response_mime_type = "application/json";
  const r = await fetchTimeout(`${proxyUrl}/gemini`, 90000, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Proxy-Token": proxyToken
    },
    body: JSON.stringify({
      api_key: env.GEMINI_API_KEY,
      model: GEMINI_MODEL,
      prompt,
      generationConfig: genConfig
    })
  });
  if(!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error(`Proxy error ${r.status}: ${t.slice(0,200)}`);
  }
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if(!text) throw new Error("Empty proxy response");
  return text.trim();
}

async function callGemini(env, prompt, jsonMode){
  // Try Modal proxy first (dual-stream architecture)
  try {
    return await callGeminiViaProxy(env, prompt, jsonMode);
  } catch(proxyErr) {
    // Fall through to direct call (will fail via IP block, then D1 queue)
  }
  const key = env.GEMINI_API_KEY;
  if(!key) throw new Error("AI not configured");
  const url = `${GEMINI_API}${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const genConfig = {temperature: 0.7, maxOutputTokens: 1000};
  if(jsonMode) genConfig.response_mime_type = "application/json";
  const r = await fetchTimeout(url, 30000, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      contents: [{parts: [{text: prompt}]}],
      generationConfig: genConfig
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
    const db = drizzle(env.DB);
    const rows = await db.select({ response: aiCache.response }).from(aiCache).where(eq(aiCache.cacheKey, key)).limit(1);
    return rows[0] ? rows[0].response : null;
  }catch(e){ return null; }
}

async function setCache(env, key, response){
  try{
    const db = drizzle(env.DB);
    await db.insert(aiCache).values({ cacheKey: key, response, createdAt: Date.now() })
      .onConflictDoUpdate({ target: aiCache.cacheKey, set: { response, createdAt: Date.now() } });
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

  // Context-aware: include user's recent vocab
  const recentWords = await getRecentVocab(env, chk.user.email);
  const contextHint = recentWords.length
    ? ` The user has recently studied: ${recentWords.join(", ")}. If relevant, connect the explanation to these words.`
    : "";

  const prompt = `Explain the English word "${word}" as used in this sentence: "${sentence || "(no context)"}". ` +
    `Reply in ${langName}. Include: 1) meaning in this context, 2) part of speech, 3) one example sentence. Keep it concise (under 150 words).${contextHint}`;

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

  // Context-aware: prioritize user's weak words
  const weakWords = await getWeakVocab(env, chk.user.email);
  const weakHint = weakWords.length
    ? ` The user struggles with these words: ${weakWords.join(", ")}. Prioritize questions about them if they appear in the text.`
    : "";

  const prompt = `Create 5 multiple-choice English quiz questions from this text:\n\n${text}\n\n` +
    `Reply in ${langName} (questions in English, explanations in ${langName}). ` +
    `Return a JSON array: [{"q":"question","options":["A","B","C","D"],"answer":0,"explain":"why"}]. ` +
    `Keep questions about vocabulary and comprehension.${weakHint}`;

  try{
    const quizText = await callGemini(env, prompt, true);
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
