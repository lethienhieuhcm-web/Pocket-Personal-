// worker/src/vocab.js — vocabulary review (spaced repetition).
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
    await env.DB.prepare(`INSERT INTO vocab_reviews (email, word, meaning, next_review, interval_days, reviews, correct, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, 0, ?)
      ON CONFLICT(email, word) DO UPDATE SET meaning=excluded.meaning, updated_at=excluded.updated_at`)
      .bind(s.email, word, meaning, now, now).run();
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
    const rows = await env.DB.prepare(
      "SELECT word, meaning, interval_days, reviews, correct FROM vocab_reviews WHERE email=? AND next_review<=? ORDER BY next_review ASC LIMIT 20"
    ).bind(s.email, now).all();
    return jok({words: rows.results || []});
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
    const row = await env.DB.prepare(
      "SELECT interval_days, reviews, correct FROM vocab_reviews WHERE email=? AND word=?"
    ).bind(s.email, word).first();
    if(!row) return jerr("Word not found", 404);
    // Spaced repetition: double interval if remembered, reset to 1 if not
    const newInterval = remembered ? Math.min((row.interval_days || 1) * 2, 60) : 1;
    const nextReview = Date.now() + newInterval * 86400000;
    await env.DB.prepare(
      "UPDATE vocab_reviews SET interval_days=?, next_review=?, reviews=reviews+1, correct=correct+?, updated_at=? WHERE email=? AND word=?"
    ).bind(newInterval, nextReview, remembered ? 1 : 0, Date.now(), s.email, word).run();
    return jok({ok: true, next_interval: newInterval});
  }catch(e){ return jerr("DB error", 500); }
}
