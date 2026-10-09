import {handleBookResult, handleBookUpload, handleBookList, handleBookGet, handleAdminBooksPending, handleAdminBooksApprove} from './books.js';
import {handleTTS, handleVoices, handleQuota, handleTranslate, handleDict} from './content.js';
import {handleAIExplain, handleAIQuiz} from './ai.js';
import {handleVocabAdd, handleVocabDue, handleVocabReview} from './vocab.js';
import {handleAnalytics, handleInsights, handleBankGet, handleBankPost, handleReadingsList, handleReadingsCreate, handleReadingGet, handleReadingDelete, handleReadingAudioPut, handleAdminUsers, handleAdminRole, handleAdminDelete} from './library.js';
import {handleRegister, handleSendCode, handleVerifyCode, handleLogin, handleLogout, handleMe, handleGoogleLogin, handleGoogleCallback, handleListSessions, handleRevokeSession } from './auth.js';
import {handleGetPlan, handleGetUsage, handleSetPlan} from './billing.js';
import {handleDriveAuthUrl, handleDriveCallback, handleDriveStatus, handleDriveDisconnect, handleDriveMusic, handleDriveStream} from './drive.js';
import {handleSpotifyAuthUrl, handleSpotifyCallback, handleSpotifyStatus, handleSpotifySearch} from './spotify.js';
import {getSession, getUser} from './auth.js';
import {jerr} from './utils.js';
import {hStockVersion, hStockIndices, hStockQuote, hStockOhlcv, hStockSymbols, hStockScreener, hStockScreener2, hStockFundamentals, hStockNews, hStockEvents, hStockBacktest, hStockCompare, hWatchlistGet, hWatchlistAdd, hWatchlistDel, hPortfolio, hTxnAdd, hTxnDel, hTxnNote, hCostHistory, hAlertsGet, hAlertsAdd, hAlertsDel, hAlertsBySymbol, hTargetsGet, hTargetsSet, hTargetsDel, hPinStatus, hPinSet, hPinVerify, hPinDel, hMigrateR2ToD1, hStockPublish, hStockReportData, hStockAlertDone, hStockTargetDone} from './stock.js';

// Build ID - replaced with timestamp on every deploy (see cf_deploy.py)
const BUILD_ID = "__BUILD__";

// Security headers for HTML pages (clickjacking, MIME sniffing protection)
function addSecurityHeaders(h){
  h.set("X-Frame-Options", "SAMEORIGIN");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return h;
}
/* ============================================================
   PHASE 1 — DECLARATIVE ROUTE TABLE
   Every API route lives here exactly once: [method, pattern, handler, auth].
   - pattern ending in "/*" = prefix match, else exact match
   - auth: 'public' | 'user' | 'admin' | 'internal' | 'custom'
     'custom' = handler does its own auth (OAuth callbacks, processor secret)
   Adding a route without a table entry is impossible by construction —
   the dispatcher below is the only path to handlers.
   ============================================================ */
const ROUTES = [
  // --- library: bank, readings, analytics, insights ---
  ['GET',    '/api/bank',            handleBankGet,          'user'],
  ['POST',   '/api/bank',            handleBankPost,         'user'],
  ['GET',    '/api/readings',        handleReadingsList,     'user'],
  ['POST',   '/api/readings',        handleReadingsCreate,   'user'],
  ['GET',    '/api/readings/*',      handleReadingGet,       'user'],
  ['DELETE', '/api/readings/*',      handleReadingDelete,    'user'],
  ['PUT',    '/api/readings/*',      handleReadingAudioPut,  'user'],
  ['POST',   '/api/analytics',       handleAnalytics,        'public'],
  ['GET',    '/api/insights',        (q,w,e)=>handleInsights(e,w), 'public'],
  // --- books ---
  ['GET',    '/api/books',           handleBookList,         'user'],
  ['POST',   '/api/books/upload',    handleBookUpload,       'user'],
  ['GET',    '/api/books/*',         handleBookGet,          'user'],
  ['POST',   '/api/books/result',    handleBookResult,       'custom'],
  // --- admin ---
  ['GET',    '/api/admin/users',     handleAdminUsers,       'admin'],
  ['DELETE', '/api/admin/users/*',   handleAdminDelete,      'admin'],
  ['GET',    '/api/admin/books/pending', handleAdminBooksPending, 'admin'],
  ['POST',   '/api/admin/books/approve', handleAdminBooksApprove, 'admin'],
  ['POST',   '/api/admin/set-plan',  handleSetPlan,          'admin'],
  // --- auth ---
  ['POST',   '/api/auth/send-code',  handleSendCode,         'public'],
  ['POST',   '/api/auth/verify-code',handleVerifyCode,       'public'],
  ['POST',   '/api/auth/register',   handleRegister,         'public'],
  ['POST',   '/api/auth/login',      handleLogin,            'public'],
  ['GET',    '/api/auth/sessions',         handleListSessions,     'user'],
  ['POST',   '/api/auth/sessions/revoke',  handleRevokeSession,    'user'],
  ['POST',   '/api/auth/logout',     handleLogout,           'user'],
  ['GET',    '/api/auth/me',         handleMe,               'user'],
  ['GET',    '/api/auth/google',     handleGoogleLogin,      'public'],
  ['GET',    '/api/auth/google/callback', handleGoogleCallback, 'custom'],
  // --- billing ---
  ['GET',    '/api/user/plan',       handleGetPlan,          'user'],
  ['GET',    '/api/user/usage',      handleGetUsage,         'user'],
  // --- drive ---
  ['GET',    '/api/drive/auth-url',  handleDriveAuthUrl,     'user'],
  ['GET',    '/api/drive/callback',  handleDriveCallback,    'custom'],
  ['GET',    '/api/drive/status',    handleDriveStatus,      'user'],
  ['GET',    '/api/drive/music',     handleDriveMusic,       'user'],
  ['GET',    '/api/drive/stream/*',  handleDriveStream,      'user'],
  ['POST',   '/api/drive/disconnect',handleDriveDisconnect,  'user'],
  // --- spotify ---
  ['GET',    '/api/spotify/auth-url',handleSpotifyAuthUrl,   'user'],
  ['GET',    '/api/spotify/callback',handleSpotifyCallback,  'custom'],
  ['GET',    '/api/spotify/status',  handleSpotifyStatus,    'user'],
  ['GET',    '/api/spotify/search',  handleSpotifySearch,    'user'],
  // --- content ---
  ['GET',    '/api/dict',            (q,w,e)=>handleDict(e,w,q), 'user'],
  ['POST',   '/api/tts',             handleTTS,              'user'],
  ['GET',    '/api/voices',          handleVoices,           'user'],
  ['GET',    '/api/quota',           handleQuota,            'user'],
  ['POST',   '/api/translate',       handleTranslate,        'user'],
  ['POST',   '/api/ai/explain',      handleAIExplain,        'user'],
  ['POST',   '/api/ai/quiz',         handleAIQuiz,           'user'],
  ['POST',   '/api/vocab/add',        handleVocabAdd,         'user'],
  ['GET',    '/api/vocab/due',        handleVocabDue,         'user'],
  ['POST',   '/api/vocab/review',     handleVocabReview,      'user'],
  // --- stock ---
  ['GET',    '/api/stock/version',   hStockVersion,          'user'],
  ['GET',    '/api/stock/indices',   hStockIndices,          'user'],
  ['GET',    '/api/stock/quote',     hStockQuote,            'user'],
  ['GET',    '/api/stock/ohlcv',     hStockOhlcv,            'user'],
  ['GET',    '/api/stock/symbols',   hStockSymbols,          'user'],
  ['GET',    '/api/stock/screener',  hStockScreener,         'user'],
  ['GET',    '/api/stock/screener2', hStockScreener2,        'user'],
  ['GET',    '/api/stock/fundamentals', hStockFundamentals,  'user'],
  ['GET',    '/api/stock/news',      hStockNews,             'user'],
  ['GET',    '/api/stock/events',    hStockEvents,           'user'],
  ['GET',    '/api/stock/backtest',  hStockBacktest,         'user'],
  ['GET',    '/api/stock/compare',   hStockCompare,          'user'],
  ['GET',    '/api/stock/watchlist', hWatchlistGet,          'user'],
  ['POST',   '/api/stock/watchlist', hWatchlistAdd,          'user'],
  ['DELETE', '/api/stock/watchlist/*', hWatchlistDel,        'user'],
  ['GET',    '/api/stock/portfolio', hPortfolio,             'user'],
  ['POST',   '/api/stock/portfolio/txn', hTxnAdd,            'user'],
  ['DELETE', '/api/stock/portfolio/txn/*', hTxnDel,          'user'],
  ['PUT',    '/api/stock/portfolio/txn/*', hTxnNote,         'user'],
  ['GET',    '/api/stock/portfolio/cost_history', hCostHistory, 'user'],
  ['GET',    '/api/stock/alerts',    hAlertsGet,             'user'],
  ['POST',   '/api/stock/alerts',    hAlertsAdd,             'user'],
  ['DELETE', '/api/stock/alerts/*',  hAlertsDel,             'user'],
  ['GET',    '/api/stock/targets',   hTargetsGet,            'user'],
  ['POST',   '/api/stock/targets',   hTargetsSet,            'user'],
  ['DELETE', '/api/stock/targets/*', hTargetsDel,            'user'],
  ['GET',    '/api/stock/pin/status',hPinStatus,             'user'],
  ['POST',   '/api/stock/pin',       hPinSet,                'user'],
  ['POST',   '/api/stock/pin/verify',hPinVerify,             'user'],
  ['DELETE', '/api/stock/pin',       hPinDel,                'user'],
  // --- internal (VM crons / processor) ---
  ['POST',   '/api/internal/migrate-r2-d1', hMigrateR2ToD1, 'internal'],
  ['GET',    '/api/internal/stock-alerts-by-symbol', hAlertsBySymbol, 'internal'],
  ['POST',   '/api/internal/stock-publish', hStockPublish,   'internal'],
  ['GET',    '/api/internal/stock-report-data', hStockReportData, 'internal'],
  ['POST',   '/api/internal/stock-alert-done', hStockAlertDone, 'internal'],
  ['POST',   '/api/internal/stock-target-done', hStockTargetDone, 'internal'],
];

function internalOk(request, env){
  const got = request.headers.get('X-Internal-Secret') || '';
  // E4: dedicated INTERNAL_SECRET, falls back to STOCK_PUBLISH_SECRET so
  // existing VM crons keep working until they migrate to the new secret.
  const want = env.INTERNAL_SECRET || env.STOCK_PUBLISH_SECRET || '';
  return want !== '' && got === want;
}


// Rate limiting (DDoS/brute-force protection for public endpoints)
// Limits: {endpoint_pattern: [max_requests, window_seconds]}
const RATE_LIMITS = {
  "/api/auth/login": [10, 60],       // 10 logins/min per IP
  "/api/auth/register": [5, 3600],    // 5 registers/hour per IP
  "/api/auth/send-code": [3, 3600],   // 3 codes/hour per IP
  "/api/auth/verify-code": [10, 60],  // 10 verifies/min per IP
  "/api/analytics": [30, 60],         // 30 analytics/min per IP (spam prevention)
  "/api/tts": [20, 60],               // 20 TTS/min per IP (cost protection)
};

async function checkRateLimit(request, env, path){
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  for(const [pattern, [maxReq, windowSec]] of Object.entries(RATE_LIMITS)){
    if(!path.startsWith(pattern)) continue;
    const windowStart = Math.floor(Date.now()/1000/windowSec)*windowSec;
    try{
      // Clean old windows (opportunistic)
      await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
        .bind(windowStart - windowSec).run();
      // Increment or insert
      const r = await env.DB.prepare(
        "INSERT INTO rate_limits (ip, endpoint, window_start, count) VALUES (?, ?, ?, 1) " +
        "ON CONFLICT(ip, endpoint, window_start) DO UPDATE SET count = count + 1 RETURNING count"
      ).bind(ip, pattern, windowStart).run();
      const count = r.results?.[0]?.count || 1;
      if(count > maxReq){
        return new Response(JSON.stringify({error: "Too many requests. Please try again later."}),
          {status: 429, headers: {"Content-Type": "application/json", "Retry-After": String(windowSec)}});
      }
    }catch(e){
      // If rate limit check fails, allow the request (fail-open for availability)
    }
    break;
  }
  return null;
}

async function dispatch(request, env, url){
  const method = request.method;
  const path = url.pathname;
  // Rate limit public endpoints before auth checks
  const rl = await checkRateLimit(request, env, path);
  if(rl) return rl;
  for(const [m, pat, handler, auth] of ROUTES){
    if(m !== method) continue;
    const hit = pat.endsWith('/*') ? path.startsWith(pat.slice(0, -1)) : path === pat;
    if(!hit) continue;
    if(auth === 'user' || auth === 'admin'){
      const s = await getSession(request, env);
      if(!s) return jerr('Not logged in', 401);
      if(auth === 'admin'){
        const u = await getUser(env, s.email);
        if(!u || u.email !== OWNER_EMAIL) return jerr('Admin only', 403);
     }
   }else if(auth === 'internal'){
      if(!internalOk(request, env)) return jerr('Forbidden', 403);
   }
    return handler(request, env, url);
 }
  return null;
}

  
// Serve static asset with no-cache for HTML (ensures fresh ?v= for JS/CSS after deploys)
async function serveAsset(env, path){
  const r = await env.ASSETS.fetch(new Request(new URL(path, "https://lethanhdong.one")));
  if(!r.ok) return r;
  const h = new Headers(r.headers);
  if(path.includes(".html")){
    h.set("Cache-Control", "no-cache, must-revalidate");
    h.set("X-Build-Id", BUILD_ID);
    addSecurityHeaders(h);
 }
  return new Response(r.body, {status: r.status, headers: h});
}



export default {
  async fetch(request, env, ctx){
    const _u = new URL(request.url);
    const url = new URL(request.url);
    if (url.pathname === "/voice/" || url.pathname === "/voice") {
      return serveAsset(env, "/english/voice.html"+url.search);
   }
    /* design-system.css lives at /english/design-system.css in assets;
       rewrite root path so all pages share one file (keep ?v= for cache bust) */
    if (url.pathname === "/design-system.css") {
      return env.ASSETS.fetch(new Request(new URL("/english/design-system.css"+url.search, url.origin), request));
   }
    /* per-app PWA files live as /english/* assets; expose under app scopes */
    const PWA_MAP = {
      "/stocks/manifest.json": "/english/stocks-manifest.json",
      "/stocks/sw.js": "/english/stocks-sw.js",
      "/voice/manifest.json": "/english/voice-manifest.json",
      "/voice/sw.js": "/english/voice-sw.js",
      "/chess/manifest.json": "/english/chess-manifest.json",
      "/chess/sw.js": "/english/chess-sw.js",
      "/music/manifest.json": "/english/music-manifest.json",
      "/music/sw.js": "/english/music-sw.js",
   };
    if (PWA_MAP[url.pathname]) {
      const r = await env.ASSETS.fetch(new Request(new URL(PWA_MAP[url.pathname], url.origin), request));
      if (r.ok) return r;
   }
    /* hub PWA (installable launcher) */
    if (url.pathname === "/manifest.json") {
      return env.ASSETS.fetch(new Request(new URL("/english/hub-manifest.json", url.origin), request));
   }
    if (url.pathname === "/sw.js") {
      return env.ASSETS.fetch(new Request(new URL("/english/hub-sw.js", url.origin), request));
   }
    if (url.pathname === "/policy" || url.pathname === "/policy.html") {
      return serveAsset(env, "/english/policy.html"+url.search);
   }
    if (url.pathname === "/privacy" || url.pathname === "/privacy.html" ||
        url.pathname === "/terms" || url.pathname === "/terms.html") {
      return Response.redirect(new URL("/policy", url.origin), 301);
   }
    const routed = await dispatch(request, env, url);
    if(routed) return routed;
    const r = await env.ASSETS.fetch(request);
    if(url.pathname.endsWith(".html") || url.pathname === "/" || !url.pathname.includes(".")){
      const h = new Headers(r.headers);
      h.set("Cache-Control", "no-cache, must-revalidate");
      h.set("X-Build-Id", BUILD_ID);
      addSecurityHeaders(h);
      return new Response(r.body, {status: r.status, headers: h});
   }
    return r;
 }
};
