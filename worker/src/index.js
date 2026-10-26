import {handleBookResult, handleBookUpload, handleBookList, handleBookGet, handleAdminBooksPending, handleAdminBooksApprove} from './books.js';
import {handleTTS, handleVoices, handleQuota, handleTranslate, handleDict} from './content.js';
import {handleCollectionsList, handleCollectionGet} from './collections.js';
import {handleAIExplain, handleAIQuiz, handleByokProxy, handleAiRelay} from './ai.js';
import {handleVocabAdd, handleVocabDue, handleVocabReview} from './vocab.js';
import {handleImageGet} from './images.js';
import {handleAnalytics, handleInsights, handleBankGet, handleBankPost, handleReadingsList, handleReadingsCreate, handleReadingGet, handleReadingDelete, handleReadingAudioPut, handleAdminUsers, handleAdminRole, handleAdminDelete} from './library.js';
import {handleRegister, handleSendCode, handleVerifyCode, handleLogin, handleLogout, handleMe, handleGoogleLogin, handleGoogleCallback, handleGoogleIdToken, handleListSessions, handleRevokeSession, handleVerifyEmail, handleResendVerification, handleForgotPassword, handleResetPassword, handleResetPasswordPage } from './auth.js';
import {handleGetPlan, handleGetUsage, handleSetPlan} from './billing.js';
import {hMcp, hMcpGet} from './mcp.js';
import {hAiChat, hAiChatJob, hAiChatJobCancel, hAiEngineClaim, hAiEngineComplete, hAiEngineHeartbeat} from './ai_chat.js';
import {handleDriveAuthUrl, handleDriveCallback, handleDriveStatus, handleDriveDisconnect, handleDriveMusic, handleDriveStream, handleDriveUpload} from './drive.js';
import {handleDacMusic, handleDacStream, handleDacStreamTest, handleDacDriveToken, handleDacAudio, handleDacAudioSign, handleDacAudioToken, handleDacResolve, handleDacCopy, handleDacFolders, handleDacSync, handleDacSearch, handleDacLibrary, handleDacPlaylistList, handleDacPlaylistCreate, handleDacPlaylistDelete, handleDacPlaylistGet, handleDacPlaylistSetItems, handleDacAuthLogin, handleDacAuthRefresh, handleDacAuthLogout} from './dac.js';
import {handleSpotifyAuthUrl, handleSpotifyCallback, handleSpotifyStatus, handleSpotifySearch} from './spotify.js';
import {handleBrowse, handleBrowseWs, handleHbSession, handleHbDiag} from './browser.js';
import { drizzle } from "drizzle-orm/d1";
import { and, eq, lt, sql } from "drizzle-orm";
import { rateLimits } from "./schema.js";
import {getSession, getUser, OWNER_EMAIL} from './auth.js';
import {jerr} from './utils.js';
import {hStockVersion, hStockIndices, hStockSectorIndices, hStockRegime, hStockSignals, hStockQuote, hStockOhlcv, hStockTrades, hStockScreener, hStockFundamentals, hStockStatements, hStockNews, hStockMarketNews, hStockForeignFlow, hStockForeignHistory, hStockProprietaryFlow, hStockProprietaryHistory, hStockMacro, hStockMacroHistory, hStockConsensus, hStockConsensusDetail, hStockHolders, hStockHoldersShard, hStockHoldersSymbol, hStockSectors, hStockSectorsDetail, hStockListing, hStockEvents, hStockCompanyProfile, hStockCompare, hWatchlistGet, hWatchlistAdd, hWatchlistDel, hPortfolio, hTxnAdd, hCostHistory, hTargetsGet, hTargetsSet, hTargetsDel, hStockPublish, hModalAlert, hStockReportData, hStockAlertDone, hStockTargetDone, hStockRisk, hStockStrategyReview, hRuleAlertsGet, hRuleAlertsAdd, hRuleAlertsDel, hRuleAlertsInternal, hTickStateGet} from './stock.js';

// Build ID - replaced with timestamp on every deploy (see cf_deploy.py)
const BUILD_ID = "__BUILD__";

// Security headers for HTML pages (clickjacking, MIME sniffing protection)
function addSecurityHeaders(h){
  h.set("X-Frame-Options", "SAMEORIGIN");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // CSP: chỉ cho phép tài nguyên từ chính origin + inline script/style (app dùng inline)
  // + unpkg (SDK Hyperbeam) + *.hyperbeam.com (WebRTC interactive tier, Henrry Chốt 19/10)
  h.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.hyperbeam.com wss://*.hyperbeam.com; img-src 'self' data:; media-src 'self' https:;");
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
  ['GET',    '/api/images/*',       handleImageGet,         'user'],
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
  // 2.2: email verification (token link) + password reset
  ['GET',    '/api/auth/verify',     handleVerifyEmail,      'public'],
  ['POST',   '/api/auth/resend-verification', handleResendVerification, 'public'],
  ['POST',   '/api/auth/forgot-password', handleForgotPassword, 'public'],
  ['POST',   '/api/auth/reset-password',  handleResetPassword,  'public'],
  ['GET',    '/reset-password',          handleResetPasswordPage, 'public'],
  ['GET',    '/api/auth/sessions',         handleListSessions,     'user'],
  ['POST',   '/api/auth/sessions/revoke',  handleRevokeSession,    'user'],
  ['POST',   '/api/auth/logout',     handleLogout,           'user'],
  ['GET',    '/api/auth/me',         handleMe,               'user'],
  ['GET',    '/api/auth/google',     handleGoogleLogin,      'public'],
  ['GET',    '/api/auth/google/callback', handleGoogleCallback, 'custom'],
  // 2.4: Android Credential Manager — ID token flow (không cần client_secret).
  ['POST',   '/api/auth/google/idtoken', handleGoogleIdToken, 'public'],
  // --- billing ---
  ['GET',    '/api/user/plan',       handleGetPlan,          'user'],
  ['GET',    '/api/user/usage',      handleGetUsage,         'user'],
  // --- MCP khai thac kho tu chu, GD1 (Chot thiet ke 22/10/2026) ---
  ['POST',   '/api/mcp',           hMcp,                   'user'],
  ['GET',    '/api/mcp',           hMcpGet,                'user'],
  // --- AI Chat Dot B: tang dieu phoi LLM tren MCP (ai_chat.js) ---
  ['POST',   '/api/ai/chat',       hAiChat,                'user'],
  ['GET',    '/api/ai/chat/job',   hAiChatJob,             'user'],
  ['POST',   '/api/ai/chat/job-cancel', hAiChatJobCancel,  'user'],
  ['POST',   '/api/ai/engine/claim', hAiEngineClaim,       'custom'],
  ['POST',   '/api/ai/engine/complete', hAiEngineComplete, 'custom'],
  ['POST',   '/api/ai/engine/heartbeat', hAiEngineHeartbeat, 'custom'],
  // --- drive ---
  ['GET',    '/api/drive/auth-url',  handleDriveAuthUrl,     'user'],
  ['GET',    '/api/drive/callback',  handleDriveCallback,    'custom'],
  ['GET',    '/api/drive/status',    handleDriveStatus,      'user'],
  ['GET',    '/api/drive/music',     handleDriveMusic,       'user'],
  ['GET',    '/api/drive/stream/*',  handleDriveStream,      'user'],
  ['POST',   '/api/drive/disconnect',handleDriveDisconnect,  'user'],
  ['POST',   '/api/drive/upload',    handleDriveUpload,      'user'],
  // --- dac-pass (Chốt 2026-10-13): nhạc từ Drive user, Worker passthrough ---
  // --- DAC auth riêng (tách khỏi web, Chốt 2026-10-18) ---
  ['POST',   '/api/dac/auth/login',   handleDacAuthLogin,       'public'],
  ['POST',   '/api/dac/auth/refresh', handleDacAuthRefresh,     'public'],
  ['POST',   '/api/dac/auth/logout',  handleDacAuthLogout,      'public'],
  ['GET',    '/api/dac/music',       handleDacMusic,           'dac'],
  ['GET',    '/api/dac/folders',     handleDacFolders,         'dac'],
  ['POST',   '/api/dac/sync',        handleDacSync,            'dac'],
  ['GET',    '/api/dac/stream/*',    handleDacStream,                'dac'],
  ['GET',    '/api/dac/stream-test/*', handleDacStreamTest,       'dac'],
  ['GET',    '/api/dac/drive-token',  handleDacDriveToken,        'dac'],
  ['GET',    '/api/dac/audio/*',     handleDacAudio,             'public'],
  ['HEAD',   '/api/dac/audio/*',     handleDacAudio,             'public'],
  ['GET',    '/api/dac/audio-sign/*', handleDacAudioSign,        'dac'],
  ['GET',    '/api/dac/audio-t/*',   handleDacAudioToken,        'public'],
  ['GET',    '/api/dac/search',      handleDacSearch,            'dac'],
  ['GET',    '/api/dac/library',     handleDacLibrary,           'dac'],
  // --- 4.9: playlist D1 (đồng bộ 2 máy) ---
  ['GET',    '/api/dac/playlists',   handleDacPlaylistList,        'dac'],
  ['POST',   '/api/dac/playlists',   handleDacPlaylistCreate,      'dac'],
  ['DELETE', '/api/dac/playlists/*', handleDacPlaylistDelete,      'dac'],
  ['GET',    '/api/dac/playlists/*', handleDacPlaylistGet,         'dac'],
  ['PUT',    '/api/dac/playlists/*', handleDacPlaylistSetItems,    'dac'],
  ['POST',   '/api/dac/resolve',     handleDacResolve,           'dac'],
  ['POST',   '/api/dac/copy',        handleDacCopy,              'dac'],
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
  ['POST',   '/api/ai/relay',        handleAiRelay,          'user'],
  ['POST',   '/api/byok/proxy',      handleByokProxy,        'user'],
  ['POST',   '/api/vocab/add',        handleVocabAdd,         'user'],
  ['GET',    '/api/vocab/due',        handleVocabDue,         'user'],
  ['POST',   '/api/vocab/review',     handleVocabReview,      'user'],
  // --- collections (content library) ---
  ['GET',    '/api/collections',     handleCollectionsList,  'user'],
  ['GET',    '/api/collections/*',   (q,w,e)=>handleCollectionGet(e,w,q.split('/').pop()), 'user'],
  // --- stock ---
  ['GET',    '/api/stock/version',   hStockVersion,          'user'],
  ['GET',    '/api/stock/indices',   hStockIndices,          'user'],
  ['GET',    '/api/stock/sector-indices', hStockSectorIndices, 'user'],
  ['GET',    '/api/stock/regime',    hStockRegime,           'user'],
  ['GET',    '/api/stock/signals',   hStockSignals,          'user'],
  ['GET',    '/api/stock/quote',     hStockQuote,            'user'],
  ['GET',    '/api/stock/ohlcv',     hStockOhlcv,            'user'],
  ['GET',    '/api/stock/trades',    hStockTrades,           'user'],
  ['GET',    '/api/stock/screener',  hStockScreener,         'user'],
  ['GET',    '/api/stock/fundamentals', hStockFundamentals,  'user'],
  ['GET',    '/api/stock/statements', hStockStatements,  'user'],
  ['GET',    '/api/stock/news',      hStockNews,             'user'],
  ['GET',    '/api/stock/news/market', hStockMarketNews,      'user'],
  ['GET',    '/api/stock/foreign-flow', hStockForeignFlow,    'user'],
  ['GET',    '/api/stock/foreign-flow/history', hStockForeignHistory, 'user'],
  ['GET',    '/api/stock/proprietary-flow', hStockProprietaryFlow, 'user'],
  ['GET',    '/api/stock/proprietary-flow/history', hStockProprietaryHistory, 'user'],
  ['GET',    '/api/stock/macro', hStockMacro, 'user'],
  ['GET',    '/api/stock/macro/history', hStockMacroHistory, 'user'],
  ['GET',    '/api/stock/consensus', hStockConsensus, 'user'],
  ['GET',    '/api/stock/consensus/detail', hStockConsensusDetail, 'user'],
  ['GET',    '/api/stock/holders', hStockHolders, 'user'],
  ['GET',    '/api/stock/holders/shard', hStockHoldersShard, 'user'],
  ['GET',    '/api/stock/holders/symbol', hStockHoldersSymbol, 'user'],
  ['GET',    '/api/stock/sectors', hStockSectors, 'user'],
  ['GET',    '/api/stock/sectors/detail', hStockSectorsDetail, 'user'],
  ['GET',    '/api/stock/listing', hStockListing, 'user'],
  ['GET',    '/api/stock/events',    hStockEvents,           'user'],
  ['GET',    '/api/stock/company/profile', hStockCompanyProfile, 'user'],
  ['GET',    '/api/stock/compare',   hStockCompare,          'user'],
  ['GET',    '/api/stock/watchlist', hWatchlistGet,          'user'],
  ['GET',    '/api/stock/risk',      hStockRisk,             'user'],
  ['GET',    '/api/stock/strategy_review', hStockStrategyReview, 'user'],
  ['GET',    '/api/stock/rule-alerts', hRuleAlertsGet,       'user'],
  ['POST',   '/api/stock/rule-alerts', hRuleAlertsAdd,       'user'],
  ['DELETE', '/api/stock/rule-alerts/*', hRuleAlertsDel,     'user'],
  ['POST',   '/api/stock/watchlist', hWatchlistAdd,          'user'],
  ['DELETE', '/api/stock/watchlist/*', hWatchlistDel,        'user'],
  ['GET',    '/api/stock/portfolio', hPortfolio,             'user'],
  ['POST',   '/api/stock/portfolio/txn', hTxnAdd,            'user'],
  ['GET',    '/api/stock/portfolio/cost_history', hCostHistory, 'user'],
  ['GET',    '/api/stock/targets',   hTargetsGet,            'user'],
  ['POST',   '/api/stock/targets',   hTargetsSet,            'user'],
  ['DELETE', '/api/stock/targets/*', hTargetsDel,            'user'],
  // --- proxy browser (P0 Chốt 2026-10-12: Worker fetch trực tiếp, không VM) ---
  ['GET',    '/api/browse',          handleBrowse,           'custom'],
  ['POST',   '/api/browse',          handleBrowse,           'custom'],
  ['GET',    '/api/browse-ws',       handleBrowseWs,        'custom'],
  // --- Hyperbeam interactive tier (Henrry Chốt 19/10/2026) ---
  ['POST',   '/api/hb/session',      handleHbSession,        'custom'],
  ['DELETE', '/api/hb/session',      handleHbSession,        'custom'],
  ['GET',    '/hb-diag',             handleHbDiag,           'public'], // TEMP chan doan mang
  // --- internal (VM crons / processor) ---
  ['GET',    '/api/internal/stock-rule-alerts', hRuleAlertsInternal, 'internal'],
  ['POST',   '/api/internal/stock-publish', hStockPublish,   'internal'],
  ['GET',    '/api/internal/tick-state', hTickStateGet,      'internal'],
  ['POST',   '/api/internal/modal-alert', hModalAlert,     'internal'],
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
  "/api/auth/google/idtoken": [10, 60], // 2.4: như login (10/phút)
  "/api/auth/register": [5, 3600],    // 5 registers/hour per IP
  "/api/auth/send-code": [3, 3600],   // 3 codes/hour per IP
  "/api/auth/verify-code": [10, 60],  // 10 verifies/min per IP
  "/api/auth/resend-verification": [3, 3600], // 3 resends/hour per IP (2.2)
  "/api/auth/forgot-password": [3, 3600],     // 3 resets/hour per IP (2.2)
  "/api/auth/reset-password": [10, 60],       // 10 attempts/min per IP (2.2)
  "/api/analytics": [30, 60],         // 30 analytics/min per IP (spam prevention)
  "/api/tts": [20, 60],               // 20 TTS/min per IP (cost protection)
  "/api/browse": [100, 60],          // 100 browse/min per IP (1 page ≈ 50 asset requests)
};

async function checkRateLimit(request, env, path){
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  for(const [pattern, [maxReq, windowSec]] of Object.entries(RATE_LIMITS)){
    if(!path.startsWith(pattern)) continue;
    const windowStart = Math.floor(Date.now()/1000/windowSec)*windowSec;
    try{
      const db = drizzle(env.DB);
      // Clean old windows (opportunistic) — CHỈ dọn đúng endpoint này (1.1 root-cause fix).
      // Bản cũ không filter endpoint → xoá cả hàng của endpoint khác (vd: login-failed
      // dùng cửa sổ 15 phút bị login 1 phút xoá mất ngay request sau, lock không bao giờ đạt 5).
      await db.delete(rateLimits).where(and(eq(rateLimits.endpoint, pattern), lt(rateLimits.windowStart, windowStart - windowSec)));
      // Increment or insert
      const rows = await db.insert(rateLimits).values({ ip, endpoint: pattern, windowStart, count: 1 })
        .onConflictDoUpdate({
          target: [rateLimits.ip, rateLimits.endpoint, rateLimits.windowStart],
          set: { count: sql`${rateLimits.count} + 1` },
        }).returning({ count: rateLimits.count });
      const count = rows[0]?.count || 1;
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
   }else if(auth === 'dac'){
      // DAC auth riêng — chấp nhận cả web session (tương thích ngược)
      // và DAC access token
      const { getDacSession } = await import('./dac.js');
      const s = await getDacSession(request, env) || await getSession(request, env);
      if(!s) return jerr('Not logged in', 401);
   }else if(auth === 'internal'){
      if(!internalOk(request, env)) return jerr('Forbidden', 403);
   }
    return handler(request, env, url);
 }
  return null;
}

  
// Serve static asset with no-store for HTML (ensures fresh ?v= for JS/CSS after deploys)
async function serveAsset(env, path){
  const r = await env.ASSETS.fetch(new Request(new URL(path, "https://lethanhdong.one")));
  if(!r.ok) return r;
  const h = new Headers(r.headers);
  if(path.includes(".html")){
    h.set("Cache-Control", "no-store");
    h.set("X-Build-Id", BUILD_ID);
    addSecurityHeaders(h);
 }
  return new Response(r.body, {status: r.status, headers: h});
}



export default {
  async fetch(request, env, ctx){
    const _u = new URL(request.url);
    const url = new URL(request.url);
    // FIT F6: ép HTTPS — Safari iPhone báo "Not Secure" nếu vào bằng http://
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/voice/" || url.pathname === "/voice") {
      return serveAsset(env, "/english/voice.html"+url.search);
   }
    /* design-system.css lives at /english/design-system.css in assets;
       rewrite root path so all pages share one file (supports content-hashed filenames) */
    const dsMatch = url.pathname.match(/^\/design-system\.([a-f0-9]{8})\.css$/);
    if (url.pathname === "/design-system.css" || dsMatch) {
      // For hashed version, find the actual hashed file in assets
      // The HTML references /design-system.HASH.css, assets has /english/design-system.HASH.css
      const targetPath = dsMatch ? `/english/design-system.${dsMatch[1]}.css` : "/english/design-system.css";
      return env.ASSETS.fetch(new Request(new URL(targetPath+url.search, url.origin), request));
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
      "/browser/manifest.json": "/english/browser-manifest.json",
      "/browser/sw.js": "/english/browser-sw.js",
      "/talk/manifest.json": "/english/talk-manifest.json",
      "/talk/sw.js": "/english/talk-sw.js",
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
    if (url.pathname === "/dac" || url.pathname === "/dac.html") {
      return serveAsset(env, "/english/dac.html"+url.search);
   }
    // dacweb v2.1: Web Player cho dac-app (đổi tên DAC Player → DAC Pocket 2026-10-16)
    if (url.pathname === "/dacpocket" || url.pathname === "/dacpocket/") {
      return serveAsset(env, "/english/dacplayer.html"+url.search);
   }
    // Redirect tên cũ → tên mới (giữ query string, 301 permanent)
    if (url.pathname === "/dacplayer" || url.pathname === "/dacplayer/") {
      return Response.redirect(url.origin + "/dacpocket/" + url.search, 301);
   }
    if (url.pathname === "/dac-player-debug.apk") {
      // 2.5: APK vượt 25 MiB giới hạn Workers Assets → serve từ R2 DATA.
      const obj = await env.DATA.get("dac-player-debug.apk");
      if (!obj) return new Response("Not found", {status: 404});
      const h = new Headers();
      h.set("Content-Type", "application/vnd.android.package-archive");
      h.set("Content-Length", String(obj.size));
      h.set("Cache-Control", "public, max-age=3600");
      h.set("Content-Disposition", 'attachment; filename="dac-player-debug.apk"');
      return new Response(obj.body, {headers: h});
   }
    if (url.pathname === "/admin" || url.pathname === "/admin/" || url.pathname === "/admin.html") {
      return serveAsset(env, "/english/admin.html"+url.search);
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
      h.set("Cache-Control", "no-store");
      h.set("X-Build-Id", BUILD_ID);
      addSecurityHeaders(h);
      return new Response(r.body, {status: r.status, headers: h});
   }
    return r;
 }
};

