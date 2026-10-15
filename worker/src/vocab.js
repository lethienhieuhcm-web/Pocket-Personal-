// worker/src/vocab.js — vocabulary review (spaced repetition).
import { drizzle } from "drizzle-orm/d1";
import { eq, and, lte, asc, sql } from "drizzle-orm";
import { vocabReviews } from "./schema.js";
function jerr(msg, code){ return new Response(JSON.stringify({error: msg}), {status: code||400, headers:{"Content-Type":"application/json"}}); }
function jok(d){ return new Response(JSON.stringify(d), {headers:{"Content-Type":"application/json"}}); }

// POST /api/vocab/add — register a word for review (called after dict lookup)
export async function handleVocabAdd(request, env){
  const {getSession} = await import('./auth.js');
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  let b;
  try{ b = await request.json(); }catch(e){ return jerr("Invalid JSON", 400); }
  const word = String(b.word || "").trim().toLowerCase().slice(0, 50);
  const meaning = String(b.meaning || "").trim().slice(0, 200);
  if(!word) return jerr("Missing word", 400);
  const now = Date.now();
  try{
    const db = drizzle(env.DB);
    await db.insert(vocabReviews).values({
      email: s.email, word, meaning, nextReview: now,
      intervalDays: 1, reviews: 0, correct: 0, updatedAt: now,
    }).onConflictDoUpdate({
      target: [vocabReviews.email, vocabReviews.word],
      set: { meaning, updatedAt: now },
    });
  }catch(e){ return jerr("DB error", 500); }
  return jok({ok: true});
}

// GET /api/vocab/due — get words due for review (max 20)
export async function handleVocabDue(request, env){
  const {getSession} = await import('./auth.js');
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const now = Date.now();
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({
      word: vocabReviews.word, meaning: vocabReviews.meaning,
      interval_days: vocabReviews.intervalDays, reviews: vocabReviews.reviews, correct: vocabReviews.correct,
    }).from(vocabReviews)
      .where(and(eq(vocabReviews.email, s.email), lte(vocabReviews.nextReview, now)))
      .orderBy(asc(vocabReviews.nextReview)).limit(20);
    return jok({words: rows});
  }catch(e){ return jerr("DB error", 500); }
}

// POST /api/vocab/review — record review result {word, remembered: bool}
export async function handleVocabReview(request, env){
  const {getSession} = await import('./auth.js');
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  let b;
  try{ b = await request.json(); }catch(e){ return jerr("Invalid JSON", 400); }
  const word = String(b.word || "").trim().toLowerCase().slice(0, 50);
  const remembered = !!b.remembered;
  if(!word) return jerr("Missing word", 400);
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({
      interval_days: vocabReviews.intervalDays, reviews: vocabReviews.reviews, correct: vocabReviews.correct,
    }).from(vocabReviews)
      .where(and(eq(vocabReviews.email, s.email), eq(vocabReviews.word, word))).limit(1);
    const row = rows[0];
    if(!row) return jerr("Word not found", 404);
    // Spaced repetition: double interval if remembered, reset to 1 if not
    const newInterval = remembered ? Math.min((row.interval_days || 1) * 2, 60) : 1;
    const nextReview = Date.now() + newInterval * 86400000;
    await db.update(vocabReviews)
      .set({
        intervalDays: newInterval, nextReview,
        reviews: sql`${vocabReviews.reviews} + 1`,
        correct: sql`${vocabReviews.correct} + ${remembered ? 1 : 0}`,
        updatedAt: Date.now(),
      })
      .where(and(eq(vocabReviews.email, s.email), eq(vocabReviews.word, word)));
    return jok({ok: true, next_interval: newInterval});
  }catch(e){ return jerr("DB error", 500); }
}
