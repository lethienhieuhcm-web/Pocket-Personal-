// worker/src/dac.js — plan "dac-pass": API nhạc cho app Android native.
// Kiến trúc dac-pass (Chốt 2026-10-13):
// - App lấy Drive token từ AccountManager (dialog hệ thống), gửi lên Worker
//   qua header X-Drive-Token mỗi request.
// - Worker KHÔNG lưu token Drive, chỉ validate + gọi Drive API (passthrough).
// - App stream trực tiếp từ Google Drive, Worker không chạm vào bytes.
//
// Endpoints:
//   GET  /api/dac/music       → {files:[{id,name,size,mimeType}]} (user)
//   GET  /api/dac/stream/{id} → {url} direct Drive URL (user)
//   POST /api/dac/resolve     → {id,name,isFolder,files} từ share link (user, 2.1)
//   POST /api/dac/copy        → {copiedId,name,size,method} copy file (user, 2.1)
//   POST /api/dac/resolve     → {id,name,isFolder,files:[...]} từ share link (user)
//   POST /api/dac/copy        → {copiedId,name,size,method} copy file (user)
//
// Auth: session Pocket Personal + X-Drive-Token header.
import { getSession } from './auth.js';
import { jerr, sJson } from './utils.js';
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { driveTokens } from "./schema.js";
import { getOAuthConfig } from "./drive.js";

/**
 * Lấy Drive token: ưu tiên header X-Drive-Token (client gửi),
 * fallback đọc từ D1 driveTokens (user đã kết nối qua /music/).
 * Trả về null nếu không có.
 */
async function getDriveToken(request, env, email){
  const h = request.headers.get('X-Drive-Token');
  if(h) return h;
  if(!email) return null;
  try{
    const db = drizzle(env.DB);
    const rows = await db.select()
      .from(driveTokens).where(eq(driveTokens.email, email.toLowerCase())).limit(1);
    const row = rows[0];
    if(!row || !row.accessToken) return null;
    // Còn hạn thì dùng luôn
    if(row.expiresAt && Date.now() < row.expiresAt - 60000) return row.accessToken;
    // Hết hạn: tự refresh bằng refresh_token (chuẩn OAuth2 như Google/Spotify)
    if(!row.refreshToken) return null;
    const cfg = getOAuthConfig(env);
    if(!cfg.client_secret) return null;
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {"Content-Type":"application/x-www-form-urlencoded"},
      body: new URLSearchParams({
        refresh_token: row.refreshToken,
        client_id: cfg.client_id,
        client_secret: cfg.client_secret,
        grant_type: "refresh_token",
      }).toString(),
    });
    if(!r.ok) return null;
    const t = await r.json();
    await db.update(driveTokens)
      .set({ accessToken: t.access_token, expiresAt: Date.now()+t.expires_in*1000 })
      .where(eq(driveTokens.email, email.toLowerCase()));
    return t.access_token;
  }catch(e){}
  return null;
}

// Chỉ nhận file audio
const AUDIO_EXT = /\.(flac|wav|mp3|m4a|aac|ogg|opus|aiff|alac)$/i;
const MIME_BY_EXT = {
  flac: 'audio/flac', wav: 'audio/wav', mp3: 'audio/mpeg',
  m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/opus',
  aiff: 'audio/aiff', alac: 'audio/alac',
};
function mimeFor(key) {
  const ext = (key.split('.').pop() || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'audio/mpeg';
}

// 2.1: Giới hạn copy/ngày (chống abuse)
const COPY_DAILY_MAX_FILES = 100;
const COPY_DAILY_MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const COPY_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;  // 2 GB/file

/**
 * Parse Google Drive share link → file/folder ID.
 * Hỗ trợ: drive.google.com/file/d/ID, /drive/folders/ID, /open?id=ID,
 * docs.google.com/document/d/ID, v.v.
 * @returns string ID hoặc null nếu không parse được.
 */
export function parseDriveLink(link) {
  if (!link || typeof link !== 'string') return null;
  const t = link.trim();
  // Pattern 1: /file/d/ID hoặc /folders/ID hoặc /d/ID
  let m = t.match(/\/(?:file\/d|folders|d)\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // Pattern 2: ?id=ID hoặc &id=ID
  m = t.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // Pattern 3: ID trần (user paste trực tiếp)
  if (/^[a-zA-Z0-9_-]{10,}$/.test(t)) return t;
  return null;
}

/** Lấy metadata file từ Drive API. */
async function driveGetFile(fileId, driveToken, fields = 'id,name,mimeType,size') {
  const r = await driveFetchRetry(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=${encodeURIComponent(fields)}`,
    { 'Authorization': 'Bearer ' + driveToken }
  );
  return r.json();
}

/**
 * 4.3: Gọi Drive API với retry + exponential backoff + jitter.
 * Chỉ retry khi 429 (rate limit) hoặc 5xx (lỗi tạm thời).
 * Tối đa 3 lần thử, chờ 1s → 2s → 4s (+ jitter 0–500ms).
 * Lỗi 4xx khác (401/403/404) throw ngay, không retry.
 */
export async function driveFetchRetry(url, headers, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await fetch(url, { headers });
    if (r.ok) return r;
    const err = new Error(`Drive API ${r.status}`);
    err.status = r.status;
    try { err.body = await r.text(); } catch (e) { /* ignore */ }
    lastErr = err;
    const retryable = r.status === 429 || r.status >= 500;
    if (!retryable || attempt === maxAttempts) throw err;
    const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 500;
    await new Promise(res => setTimeout(res, backoff));
  }
  throw lastErr;
}

/** Kiểm tra có phải audio không (theo tên hoặc mimeType). */
function isAudio(name, mimeType) {
  return AUDIO_EXT.test(name || '') || (mimeType || '').startsWith('audio/');
}

// GET /api/dac/music — liệt kê file nhạc từ Google Drive của user (dac-pass).
// App gửi Drive token qua header X-Drive-Token (lấy từ AccountManager).
// Worker validate session + gọi Drive API trực tiếp, không lưu token.
export async function handleDacMusic(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  // 4.2: Ưu tiên đọc từ D1 index (không giới hạn 100 file như query Drive cũ).
  try {
    const count = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM dac_index WHERE email=? AND is_folder=0'
    ).bind(s.email.toLowerCase()).first();
    if (count && count.c > 0) {
      const rows = await env.DB.prepare(
        `SELECT file_id,name,mime_type,size FROM dac_index
         WHERE email=? AND is_folder=0 ORDER BY name`
      ).bind(s.email.toLowerCase()).all();
      const files = (rows.results || []).map(r => ({
        id: r.file_id,
        name: r.name,
        size: r.size || 0,
        mimeType: r.mime_type || mimeFor(r.name || ''),
      }));
      return sJson({ files });
    }
  } catch (e) { /* fallback live */ }
  const driveToken = await getDriveToken(request, env, s.email);
  if (!driveToken) return jerr('Drive not connected', 400);
  try {
    const q = encodeURIComponent("mimeType contains 'audio/' and trashed=false");
    // 4.3: dùng driveFetchRetry (retry 429/5xx với backoff).
    let r;
    try {
      r = await driveFetchRetry(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size)&pageSize=100&orderBy=name`,
        { 'Authorization': 'Bearer ' + driveToken }
      );
    } catch (e) {
      if (e.status === 401) return jerr('Drive token invalid', 401);
      return jerr('Drive list failed', 502);
    }
    const j = await r.json();
    const files = (j.files || [])
      .filter(f => AUDIO_EXT.test(f.name || ''))
      .map(f => ({
        id: f.id,
        name: f.name,
        size: f.size ? parseInt(f.size, 10) : 0,
        mimeType: f.mimeType || mimeFor(f.name || ''),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return sJson({ files });
  } catch (e) {
    return jerr('List failed', 500);
  }
}

// GET /api/dac/stream/{id} — trả về direct Drive URL cho ExoPlayer (dac-pass).
// App gửi Drive token qua header X-Drive-Token.
// Worker validate session, verify file tồn tại, trả URL có token.
// App stream TRỰC TIẾP từ Google, Worker không proxy bytes.
// Test endpoint: kiểm tra xem Google trả gì cho media URL (debug, không lộ token)
export async function handleDacStreamTest(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const driveToken = await getDriveToken(request, env, s.email);
  if (!driveToken) return jerr('Drive not connected', 400);
  const fileId = new URL(request.url).pathname.split('/').pop() || '';
  if (!fileId) return jerr('Bad file id', 400);
  try {
    const out = {};
    // Test 1: query param token (cũ)
    const testUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&access_token=${encodeURIComponent(driveToken)}`;
    const r1 = await fetch(testUrl, { method: 'HEAD' });
    out.query = { status: r1.status, ct: r1.headers.get('Content-Type')||'' };
    // Test 2: Bearer header (kiểu mihonban) — chưa đo bao giờ
    const r2 = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { method: 'HEAD', headers: { 'Authorization': 'Bearer ' + driveToken } });
    out.bearer = { status: r2.status, ct: r2.headers.get('Content-Type')||'' };
    return sJson(out);
  } catch(e) {
    return jerr('Test failed: ' + e.message, 500);
  }
}

// Trả Drive access token tươi cho browser để gọi Google trực tiếp (mượt P1)
// Token là của chính user, ngắn hạn (~1h), browser vốn đã giữ từ OAuth
// Nguồn: pattern cloudstream (browser fetch Google trực tiếp, né IP block Worker)
export async function handleDacDriveToken(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const driveToken = await getDriveToken(request, env, s.email);
  if (!driveToken) return jerr('Drive not connected', 400);
  // Validate token thật với Google: token bị revoke thì D1 không biết,
  // Google trả 401 không kèm CORS header khiến browser báo "Failed to fetch" mù mờ
  // Nguồn: phân tích cloudstream (họ fetch y hệt, Google có trả CORS khi token đúng)
  try {
    const v = await fetch('https://www.googleapis.com/oauth2/v1/tokeninfo?access_token='+encodeURIComponent(driveToken));
    if (!v.ok) return jerr('Drive token invalid, please reconnect Drive', 401);
  } catch(e) {
    // Không validate được (lỗi mạng): cứ trả token, để browser thử
  }
  return sJson({ token: driveToken });
}

export async function handleDacStream(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const driveToken = await getDriveToken(request, env, s.email);
  if (!driveToken) return jerr('Drive not connected', 400);
  const fileId = new URL(request.url).pathname.split('/').pop() || '';
  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) return jerr('A3: Bad file id', 400);
  // Verify file tồn tại và là audio (chặn IDOR)
  try {
    const meta = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size`,
      { headers: { 'Authorization': 'Bearer ' + driveToken } }
    );
    if (!meta.ok) {
      if (meta.status === 401) return jerr('Drive token invalid', 401);
      return jerr('File not found', 404);
    }
    const info = await meta.json();
    if (!AUDIO_EXT.test(info.name || '') && !(info.mimeType || '').startsWith('audio/')) {
      return jerr('A5: Audio only', 400);
    }
    // Trả direct URL — App dùng cho ExoPlayer
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&access_token=${encodeURIComponent(driveToken)}&confirm=t`;
    return sJson({ url, name: info.name, mimeType: info.mimeType, size: info.size });
  } catch (e) {
    return jerr('Stream failed', 500);
  }
}

// GET /api/dac/audio/{id} — proxy audio cho web browser.
// Browser không fetch được URL Drive trực tiếp (CORS), nên Worker proxy bytes.
// Hỗ trợ Range request để seek được (chuẩn big tech: Spotify/Apple Music đều vậy).
// SHA-256 hex helper cho signed URL
async function sha256hex(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// Tạo signed URL cho audio (big tech pattern: short-lived token)
// Frontend: fetch /api/dac/audio-sign/{id} (cần auth) -> nhận {url} -> gán audio.src trực tiếp
export async function handleDacAudioSign(request, env) {
  try {
    const s = await getSession(request, env);
    if (!s) return jerr('Not logged in', 401);
    const fileId = new URL(request.url).pathname.split('/').pop() || '';
    if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) return jerr('Bad file id', 400);
    // P2b: ký token ngắn hạn (10 phút) — session token không còn nằm trong URL
    const exp = Date.now() + 10*60*1000;
    const secret = env.JWT_SECRET || 'dac-audio-sign';
    const sig = await sha256hex(fileId + '|' + s.email + '|' + exp + '|' + secret);
    const raw = fileId + '|' + s.email + '|' + exp + '|' + sig;
    const t = btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const url = new URL(request.url);
    return sJson({ url: url.origin + '/api/dac/audio/' + fileId + '?t=' + t });
  } catch(e) {
    return jerr('Sign error: ' + e.message, 500);
  }
}

// Serve audio bằng signed token (không cần Authorization header)
// <audio> có thể dùng trực tiếp, browser tự xử lý Range/seek
export async function handleDacAudioToken(request, env) {
  const url = new URL(request.url);
  const fileId = url.pathname.split('/').pop() || '';
  const token = url.searchParams.get('t') || '';
  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) return jerr('Bad file id', 400);
  if (!token) return jerr('Missing token', 401);
  try {
    const decoded = atob(token.replace(/-/g,'+').replace(/_/g,'/'));
    const parts = decoded.split('|');
    if (parts.length !== 4) return jerr('Bad token', 401);
    const [tid, email, expStr, sig] = parts;
    if (tid !== fileId) return jerr('Token mismatch', 401);
    if (Date.now() > parseInt(expStr, 10)) return jerr('Token expired', 401);
    const secret = env.JWT_SECRET || 'dac-audio-sign';
    const expectedSig = await sha256hex(tid + '|' + email + '|' + expStr + '|' + secret);
    if (sig !== expectedSig) return jerr('Bad signature', 401);
  } catch(e) {
    return jerr('Invalid token', 401);
  }
  // Token hợp lệ: proxy audio từ Drive (dùng email từ token)
  const driveToken = await getDriveToken(request, env, email);
  if (!driveToken) return jerr('Drive not connected', 400);
  try {
    const meta = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size`,
      { headers: { 'Authorization': 'Bearer ' + driveToken } }
    );
    if (!meta.ok) return jerr('File not found', 404);
    const info = await meta.json();
    if (!AUDIO_EXT.test(info.name || '') && !(info.mimeType || '').startsWith('audio/')) {
      return jerr('Audio only', 400);
    }
    const headers = { 'Authorization': 'Bearer ' + driveToken };
    const range = request.headers.get('Range');
    if (range) headers['Range'] = range;
    const dr = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers }
    );
    if (!dr.ok) return jerr('Drive fetch failed', 502);
    const rh = new Headers(dr.headers);
    rh.set('Content-Type', mimeFor(info.name || ''));
    rh.set('Cache-Control', 'private, max-age=3600');
    rh.set('Access-Control-Allow-Origin', '*');
    return new Response(dr.body, { status: dr.status, headers: rh });
  } catch(e) {
    return jerr('Audio proxy failed', 502);
  }
}

// mượt P1c: Range engine chuẩn RFC 7233 (học audioneko)
// Không forward Range verbatim nữa — parse, validate theo file size, tự dựng lại.

// Cache metadata trong memory Worker (1h) — tránh gọi Drive API mỗi lần seek
const _audioMetaCache = new Map();

function parseRangeHeader(rangeHeader, totalSize) {
  // Không có Range → stream từ đầu (nhưng vẫn trả 206 để browser biết hỗ trợ seek)
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return { start: 0, end: totalSize - 1 };
  }
  const spec = rangeHeader.slice(6).trim();
  // Suffix range: "bytes=-500" (500 bytes cuối)
  if (spec.startsWith('-')) {
    const n = parseInt(spec.slice(1), 10);
    if (isNaN(n) || n <= 0) return { start: 0, end: totalSize - 1 };
    return { start: Math.max(0, totalSize - n), end: totalSize - 1 };
  }
  const parts = spec.split('-');
  const start = parts[0] ? parseInt(parts[0].trim(), 10) : 0;
  if (isNaN(start) || start < 0 || start >= totalSize) return null;
  let end;
  if (parts[1] && parts[1].trim()) {
    end = parseInt(parts[1].trim(), 10);
    if (isNaN(end) || end >= totalSize) end = totalSize - 1;
  } else {
    end = totalSize - 1;
  }
  if (start > end) return null;
  return { start, end };
}

async function getAudioMetadata(fileId, driveToken) {
  const now = Date.now();
  const cached = _audioMetaCache.get(fileId);
  if (cached && cached.expiresAt > now) return cached.meta;
  try {
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size`,
      { headers: { 'Authorization': 'Bearer ' + driveToken } }
    );
    if (!r.ok) {
      return null;
    }
    const info = await r.json();
    const size = parseInt(info.size || '0', 10);
    if (!size || size <= 0) return null;
    // Chuẩn hóa MIME: Drive đôi khi trả audio/x-flac, browser cần audio/flac
    let mime = info.mimeType || '';
    if (mime === 'audio/x-flac') mime = 'audio/flac';
    if (!mime.startsWith('audio/')) {
      // Fallback theo đuôi file nếu Drive trả sai
      mime = mimeFor(info.name || '');
    }
    const meta = { name: info.name || '', mimeType: mime, size };
    _audioMetaCache.set(fileId, { meta, expiresAt: now + 3600000 });
    // Giới hạn cache 500 file để không tràn memory
    if (_audioMetaCache.size > 500) {
      const firstKey = _audioMetaCache.keys().next().value;
      _audioMetaCache.delete(firstKey);
    }
    return meta;
  } catch (e) {
    return null;
  }
}

export async function handleDacAudio(request, env) {
  // P2b: chấp nhận signed token ngắn hạn (?t=) — session token không còn nằm trong URL
  // Fallback: token qua query param (?token=) hoặc Authorization header (backward compat)
  let s = await getSession(request, env);
  const url = new URL(request.url);
  if (!s) {
    const sigToken = url.searchParams.get('t');
    if (sigToken) {
      try {
        // padding base64url
        let b64 = sigToken.replace(/-/g,'+').replace(/_/g,'/');
        while (b64.length % 4) b64 += '=';
        const decoded = atob(b64);
        const parts = decoded.split('|');
        if (parts.length === 4) {
          const [tid, email, expStr, sig] = parts;
          const fileIdFromPath = url.pathname.split('/').pop() || '';
          const secret = env.JWT_SECRET || 'dac-audio-sign';
          const expectedSig = await sha256hex(tid + '|' + email + '|' + expStr + '|' + secret);
          if (tid === fileIdFromPath && sig === expectedSig && Date.now() <= parseInt(expStr, 10)) {
            s = { email }; // signed token hợp lệ
          }
        }
      } catch(e) { /* invalid token → s vẫn null */ }
    }
  }
  if (!s) {
    const qToken = url.searchParams.get('token');
    if (qToken) {
      const fakeReq = new Request(request.url, {
        headers: { 'Authorization': 'Bearer ' + qToken }
      });
      s = await getSession(fakeReq, env);
    }
  }
  if (!s) return jerr('A1: Not logged in', 401);
  const driveToken = await getDriveToken(request, env, s.email);
  if (!driveToken) return jerr('A2: Drive not connected', 400);
  const fileId = new URL(request.url).pathname.split('/').pop() || '';
  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) return jerr('A3: Bad file id', 400);

  try {
    // Lấy metadata để validate (IDOR protection) và biết MIME
    const meta = await getAudioMetadata(fileId, driveToken);
    if (!meta) return jerr('A4: File not found', 404);
    if (!AUDIO_EXT.test(meta.name || '') && !meta.mimeType.startsWith('audio/')) {
      return jerr('A5: Audio only', 400);
    }

    // HEAD: chỉ trả headers
    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers: {
        'Content-Type': meta.mimeType,
        'Content-Length': meta.size.toString(),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      }});
    }

    // Forward verbatim: giữ nguyên Range của client (nếu có), không tự tạo
    // Học mihonban/drivecast: đơn giản, Google xử lý Range chuẩn
    const headers = { 'Authorization': 'Bearer ' + driveToken };
    const clientRange = request.headers.get('Range');
    if (clientRange) {
      headers['Range'] = clientRange;
    }

    let dr = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      { headers }
    );
    // Retry 401 một lần (học mihonban)
    if (dr.status === 401) {
      _audioMetaCache.delete(fileId);
      dr = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
        { headers }
      );
    }
    if (!dr.ok) {
      return jerr('Không tải được nhạc', 502);
    }
    // Không pipe HTML (virus scan page) vào <audio>
    const ct = dr.headers.get('Content-Type') || '';
    if (ct.includes('text/html')) {
      return jerr('File quá lớn, Google yêu cầu xác nhận', 502);
    }

    // Relay response từ Google, nhưng override:
    // - Content-Type: từ metadata (chuẩn audio/flac)
    // - Content-Disposition: Google trả "attachment" (bắt tải về) → "inline" để browser phát
    const rh = new Headers(dr.headers);
    rh.set('Content-Type', meta.mimeType);
    rh.set('Content-Disposition', 'inline');
    rh.set('Accept-Ranges', 'bytes');
    return new Response(dr.body, { status: dr.status, headers: rh });
  } catch (e) {
    return jerr('Không phát được nhạc', 502);
  }
}


// dac-pass: đã xoá handleDacUpload và handleDacCopy (R2 không còn cần).
// Nhạc nằm trên Google Drive của user, native app stream trực tiếp, web qua proxy.

// --- 4.2: D1 index + sync tăng dần ---

/**
 * POST /api/dac/sync — đồng bộ index nhạc Drive vào D1.
 * Body: {} (không cần gì thêm).
 * Auth: session Pocket Personal + X-Drive-Token (token chỉ dùng để gọi
 * Drive API lúc sync, không lưu).
 *
 * - Lần đầu (chưa có page_token): full scan — chỉ lấy audio + folder,
 *   phân trang 1000, xoá index cũ rồi chèn mới.
 * - Lần sau: Drive changes API (incremental) — chỉ xử lý file đổi.
 * Trả về: {full: bool, synced: n, total: m}
 */
export async function handleDacSync(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const driveToken = await getDriveToken(request, env, s.email);
  if (!driveToken) return jerr('Drive not connected', 400);
  const email = s.email.toLowerCase();
  const headers = { 'Authorization': 'Bearer ' + driveToken };
  const now = Date.now();

  async function driveFetch(url) {
    const r = await driveFetchRetry(url, headers);
    return r.json();
  }

  /** Chuẩn hoá parent: ID thật của My Drive root → '' (để query root đơn giản). */
  function normParent(parents, rootId) {
    const p = (parents || [])[0] || '';
    return (p === rootId) ? '' : p;
  }

  /** Chèn batch vào dac_index (chia nhỏ để tránh giới hạn D1). */
  async function upsertBatch(files, rootId) {
    for (let i = 0; i < files.length; i += 50) {
      const chunk = files.slice(i, i + 50);
      const stmts = chunk.map(f => {
        const isFolder = f.mimeType === 'application/vnd.google-apps.folder' ? 1 : 0;
        // 4.8: metadata tìm kiếm — artist/title parse từ tên file ngay lúc sync;
        // album điền sau từ tên thư mục cha (refreshDacMetadata).
        let artist = '', title = '', searchText = '';
        if (!isFolder) {
          const at = parseArtistTitle(f.name || '');
          artist = at.artist; title = at.title;
          searchText = dacSearchText(f.name || '', artist, title, '');
        }
        return env.DB.prepare(
          `INSERT INTO dac_index (email,file_id,name,mime_type,size,parent_id,is_folder,updated_at,artist,title,album,search_text)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(email,file_id) DO UPDATE SET
             name=excluded.name, mime_type=excluded.mime_type, size=excluded.size,
             parent_id=excluded.parent_id, is_folder=excluded.is_folder, updated_at=excluded.updated_at,
             artist=excluded.artist, title=excluded.title, search_text=excluded.search_text`
        ).bind(email, f.id, f.name || '', f.mimeType || '',
               f.size ? parseInt(f.size, 10) : 0, normParent(f.parents, rootId), isFolder, now,
               artist, title, '', searchText);
      });
      await env.DB.batch(stmts);
    }
  }

  try {
    // 4.8: migration idempotent cho cột metadata + bảng FTS (chạy mỗi lần sync).
    await ensureDacSearchSchema(env);
    // Lấy ID thật của My Drive root (để chuẩn hoá parent).
    let rootId = '';
    try {
      const rm = await driveFetch('https://www.googleapis.com/drive/v3/files/root?fields=id');
      rootId = rm.id || '';
    } catch (e) { /* không bắt buộc */ }

    const state = await env.DB.prepare(
      'SELECT page_token FROM dac_sync_state WHERE email=?'
    ).bind(email).first();

    let synced = 0;
    if (!state) {
      // --- Full scan lần đầu ---
      await env.DB.prepare('DELETE FROM dac_index WHERE email=?').bind(email).run();
      let pageToken = null;
      const q = encodeURIComponent(
        "(mimeType contains 'audio/' or mimeType='application/vnd.google-apps.folder') and trashed=false"
      );
      do {
        let url = `https://www.googleapis.com/drive/v3/files?q=${q}` +
          `&fields=files(id,name,mimeType,size,parents),nextPageToken&pageSize=1000&orderBy=name_natural`;
        if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
        const j = await driveFetch(url);
        const keep = (j.files || []).filter(f =>
          f.mimeType === 'application/vnd.google-apps.folder' || isAudio(f.name, f.mimeType)
        );
        await upsertBatch(keep, rootId);
        synced += keep.length;
        pageToken = j.nextPageToken || null;
      } while (pageToken);
      // Lưu start page token cho incremental sau này
      const st = await driveFetch('https://www.googleapis.com/drive/v3/changes/getStartPageToken');
      await env.DB.prepare(
        'INSERT OR REPLACE INTO dac_sync_state (email,page_token,updated_at) VALUES (?,?,?)'
      ).bind(email, st.startPageToken, now).run();
      const total = await env.DB.prepare(
        'SELECT COUNT(*) as c FROM dac_index WHERE email=?'
      ).bind(email).first();
      // 4.8: điền album (tên thư mục cha) + rebuild search_text sau full scan.
      await refreshDacMetadata(env, email);
      return sJson({ full: true, synced, total: total ? total.c : 0 });
    }

    // --- Incremental sync ---
    // Đồng bộ thông minh: nếu page token hết hạn (410) → tự full sync lại
    let pageToken = state.page_token;
    let newStart = null;
    let needFullSync = false;
    do {
      let j;
      const url = `https://www.googleapis.com/drive/v3/changes?pageToken=${encodeURIComponent(pageToken)}` +
        `&fields=changes(fileId,removed,file(id,name,mimeType,size,parents)),nextPageToken,newStartPageToken&pageSize=1000`;
      try {
        j = await driveFetch(url);
      } catch (e) {
        if (e.status === 410) { needFullSync = true; break; }
        throw e;
      }
      const upserts = [];
      const deletes = [];
      for (const c of (j.changes || [])) {
        if (c.removed || !c.file) {
          deletes.push(c.fileId);
        } else {
          const f = c.file;
          if (f.mimeType === 'application/vnd.google-apps.folder' || isAudio(f.name, f.mimeType)) {
            upserts.push(f);
          }
        }
      }
      if (deletes.length) {
        for (let i = 0; i < deletes.length; i += 50) {
          const chunk = deletes.slice(i, i + 50);
          await env.DB.batch(chunk.map(id =>
            env.DB.prepare('DELETE FROM dac_index WHERE email=? AND file_id=?').bind(email, id)
          ));
        }
      }
      await upsertBatch(upserts, rootId);
      synced += upserts.length + deletes.length;
      newStart = j.newStartPageToken || newStart;
      pageToken = j.nextPageToken || null;
    } while (pageToken);
    if (newStart) {
      await env.DB.prepare(
        'UPDATE dac_sync_state SET page_token=?, updated_at=? WHERE email=?'
      ).bind(newStart, now, email).run();
    }
    const total = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM dac_index WHERE email=?'
    ).bind(email).first();
    // 4.8: điền album (tên thư mục cha) + rebuild search_text sau incremental.
    await refreshDacMetadata(env, email);
    if (needFullSync) {
      // Page token hết hạn → xoá state, lần sync sau sẽ full scan
      await env.DB.prepare('DELETE FROM dac_sync_state WHERE email=?').bind(email).run();
      return sJson({ full: false, synced: 0, total: total ? total.c : 0, needFullSync: true });
    }
    return sJson({ full: false, synced, total: total ? total.c : 0 });
  } catch (e) {
    if (e.status === 401) return jerr('Drive token invalid', 401);
    return jerr('Sync failed', 500);
  }
}

/**
 * Đọc index từ D1 cho 1 thư mục. Trả về null nếu user chưa sync lần nào.
 */
async function dacIndexFolder(env, email, parentId) {
  const count = await env.DB.prepare(
    'SELECT COUNT(*) as c FROM dac_index WHERE email=?'
  ).bind(email).first();
  if (!count || count.c === 0) return null; // chưa sync → fallback live Drive
  const pid = parentId === 'root' ? '' : parentId;
  // Lưu ý: file ở root Drive có parent_id='' (do full scan lấy parents[0]).
  // Nhưng file trong "My Drive" root có parents=['root']? Drive API trả parents
  // là ID thật; với root thì parents chứa ID của My Drive root folder.
  // Để đơn giản và đúng: query cả '' và 'root'.
  const rows = await env.DB.prepare(
    `SELECT file_id,name,mime_type,size,parent_id,is_folder FROM dac_index
     WHERE email=? AND (parent_id=? OR (?='root' AND parent_id=''))`
  ).bind(email, parentId === 'root' ? '' : parentId, parentId).all();
  const folders = [];
  const tracks = [];
  for (const r of (rows.results || [])) {
    if (r.is_folder) folders.push({ id: r.file_id, name: r.name });
    else tracks.push({
      id: r.file_id, name: r.name,
      size: r.size || 0, mimeType: r.mime_type || mimeFor(r.name || ''),
    });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  tracks.sort((a, b) => a.name.localeCompare(b.name));
  // Breadcrumb từ D1
  const breadcrumb = [];
  let cur = parentId;
  let parentName = 'Drive của tôi';
  if (cur !== 'root') {
    const me = await env.DB.prepare(
      'SELECT name FROM dac_index WHERE email=? AND file_id=?'
    ).bind(email, cur).first();
    parentName = (me && me.name) || parentName;
  }
  breadcrumb.unshift({ id: parentId, name: parentName });
  for (let i = 0; i < 20 && cur !== 'root'; i++) {
    const row = await env.DB.prepare(
      'SELECT parent_id FROM dac_index WHERE email=? AND file_id=?'
    ).bind(email, cur).first();
    const p = row ? row.parent_id : '';
    if (!p) break;
    cur = p;
    let pname = 'Drive của tôi';
    if (cur !== 'root') {
      const pm = await env.DB.prepare(
        'SELECT name FROM dac_index WHERE email=? AND file_id=?'
      ).bind(email, cur).first();
      pname = (pm && pm.name) || pname;
    }
    breadcrumb.unshift({ id: cur === '' ? 'root' : cur, name: pname });
  }
  return { parentId, parentName, breadcrumb, folders, tracks };
}

// --- 4.1: Duyệt theo thư mục Drive ---

/**
 * GET /api/dac/folders?parentId=<id|root>
 * Trả về: { parentId, parentName, breadcrumb: [{id,name}], folders: [{id,name}], tracks: [{id,name,size,mimeType}] }
 *
 * - parentId=root (mặc định): thư mục gốc Drive.
 * - folders: thư mục con trực tiếp (không đệ quy — app duyệt từng cấp).
 * - tracks: file audio nằm TRỰC TIẾP trong thư mục này.
 * - breadcrumb: đường dẫn từ root đến thư mục hiện tại (đi ngược qua parents).
 * Auth: session Pocket Personal + X-Drive-Token (không lưu token).
 */
export async function handleDacFolders(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const url = new URL(request.url);
  let parentId = url.searchParams.get('parentId') || 'root';
  if (parentId !== 'root' && !/^[a-zA-Z0-9_-]+$/.test(parentId)) {
    return jerr('Bad folder id', 400);
  }
  // 4.2: Ưu tiên đọc từ D1 index (nhanh, chỉ cần session).
  // Chưa sync lần nào → fallback live Drive (cần X-Drive-Token) như 4.1.
  try {
    const indexed = await dacIndexFolder(env, s.email.toLowerCase(), parentId);
    if (indexed) return sJson(indexed);
  } catch (e) { /* fallback live */ }
  const driveToken = await getDriveToken(request, env, s.email);
  if (!driveToken) return jerr('Drive not connected', 400);
  const headers = { 'Authorization': 'Bearer ' + driveToken };
  try {
    // 1. Liệt kê con trực tiếp của thư mục.
    const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
    // 4.3: dùng driveFetchRetry (retry 429/5xx với backoff).
    let lr;
    try {
      lr = await driveFetchRetry(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size)&pageSize=200&orderBy=name_natural`,
        headers
      );
    } catch (e) {
      if (e.status === 401) return jerr('Drive token invalid', 401);
      return jerr('Drive list failed', 502);
    }
    const lj = await lr.json();
    const folders = [];
    const tracks = [];
    for (const f of (lj.files || [])) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        folders.push({ id: f.id, name: f.name });
      } else if (isAudio(f.name, f.mimeType)) {
        tracks.push({
          id: f.id,
          name: f.name,
          size: f.size ? parseInt(f.size, 10) : 0,
          mimeType: f.mimeType || mimeFor(f.name || ''),
        });
      }
    }
    // 2. Dựng breadcrumb đi ngược qua parents.
    const breadcrumb = [];
    let cur = parentId;
    let parentName = 'Drive của tôi';
    // Lấy tên thư mục hiện tại (trừ root).
    if (cur !== 'root') {
      try {
        const meta = await driveGetFile(cur, driveToken, 'id,name,parents');
        parentName = meta.name || parentName;
      } catch (e) {
        if (e.status === 401) return jerr('Drive token invalid', 401);
        return jerr('Folder not found', 404);
      }
    }
    breadcrumb.unshift({ id: parentId, name: parentName });
    // Đi ngược tối đa 20 cấp để tránh vòng lặp.
    for (let i = 0; i < 20 && cur !== 'root'; i++) {
      try {
        const meta = await driveGetFile(cur, driveToken, 'id,name,parents');
        const p = (meta.parents || [])[0];
        if (!p) break;
        cur = p;
        let pname = 'Drive của tôi';
        if (cur !== 'root') {
          const pm = await driveGetFile(cur, driveToken, 'id,name');
          pname = pm.name || pname;
        }
        breadcrumb.unshift({ id: cur, name: pname });
      } catch (e) {
        break;
      }
    }
    return sJson({ parentId, parentName, breadcrumb, folders, tracks });
  } catch (e) {
    return jerr('List failed', 500);
  }
}

// --- 2.1: Drive Copy từ share link ---

/**
 * POST /api/dac/resolve — parse share link → metadata + danh sách file audio.
 * Body: { "link": "https://drive.google.com/file/d/ID/view..." }
 * Trả về: { id, name, isFolder, files: [{id,name,size,mimeType}] }
 *
 * Nếu là folder: liệt kê đệ quy (tối đa 500 file audio).
 * Nếu là file: files = [file đó] (nếu là audio).
 */
export async function handleDacResolve(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const driveToken = await getDriveToken(request, env, s.email);
  if (!driveToken) return jerr('Drive not connected', 400);

  let body;
  try { body = await request.json(); } catch (e) { return jerr('Bad JSON', 400); }
  const fileId = parseDriveLink(body.link || '');
  if (!fileId) return jerr('Không nhận diện được link Drive', 400);

  try {
    const meta = await driveGetFile(fileId, driveToken);
    const isFolder = meta.mimeType === 'application/vnd.google-apps.folder';

    if (!isFolder) {
      // File đơn — chỉ nhận audio
      if (!isAudio(meta.name, meta.mimeType)) {
        return jerr('Chỉ hỗ trợ file nhạc (FLAC/WAV/MP3...)', 400);
      }
      return sJson({
        id: meta.id,
        name: meta.name,
        isFolder: false,
        files: [{
          id: meta.id,
          name: meta.name,
          size: meta.size ? parseInt(meta.size, 10) : 0,
          mimeType: meta.mimeType || mimeFor(meta.name || ''),
        }],
      });
    }

    // Folder — liệt kê đệ quy file audio
    const files = [];
    const queue = [fileId];
    const seen = new Set([fileId]);

    while (queue.length > 0 && files.length < 500) {
      const folderId = queue.shift();
      let pageToken = null;
      do {
        const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
        let url = `https://www.googleapis.com/drive/v3/files?q=${q}` +
          `&fields=files(id,name,mimeType,size),nextPageToken&pageSize=100`;
        if (pageToken) url += `&pageToken=${pageToken}`;
        // 4.3: dùng driveFetchRetry (retry 429/5xx với backoff).
        let r;
        try {
          r = await driveFetchRetry(url, { 'Authorization': 'Bearer ' + driveToken });
        } catch (e) {
          if (e.status === 401) return jerr('Drive token invalid', 401);
          return jerr('Drive list failed', 502);
        }
        const j = await r.json();
        for (const f of (j.files || [])) {
          if (f.mimeType === 'application/vnd.google-apps.folder') {
            if (!seen.has(f.id)) { seen.add(f.id); queue.push(f.id); }
          } else if (isAudio(f.name, f.mimeType) && files.length < 500) {
            files.push({
              id: f.id,
              name: f.name,
              size: f.size ? parseInt(f.size, 10) : 0,
              mimeType: f.mimeType || mimeFor(f.name || ''),
            });
          }
        }
        pageToken = j.nextPageToken || null;
      } while (pageToken && files.length < 500);
    }

    files.sort((a, b) => a.name.localeCompare(b.name));
    return sJson({ id: meta.id, name: meta.name, isFolder: true, files });
  } catch (e) {
    if (e.status === 401) return jerr('Drive token invalid', 401);
    if (e.status === 404) return jerr('Không tìm thấy file (link sai hoặc chưa share)', 404);
    return jerr('Resolve failed', 500);
  }
}

/** Đọc limit copy hôm nay của user từ KV. */
async function getCopyUsage(env, userId) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `dac_copy/${userId}/${today}`;
  try {
    const raw = await env.AUTHDB.get(key);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return { count: 0, bytes: 0 };
}

/** Cộng dồn usage + ghi log copy. */
async function recordCopy(env, userId, sourceId, name, size, method) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `dac_copy/${userId}/${today}`;
  const usage = await getCopyUsage(env, userId);
  usage.count += 1;
  usage.bytes += size;
  try {
    await env.AUTHDB.put(key, JSON.stringify(usage), { expirationTtl: 86400 * 2 });
    // Log chi tiết (giữ 30 ngày để audit)
    const logKey = `dac_copy_log/${Date.now()}_${userId}_${sourceId.slice(0, 8)}`;
    await env.AUTHDB.put(logKey, JSON.stringify({
      userId, sourceId, name, size, method, at: new Date().toISOString(),
    }), { expirationTtl: 86400 * 30 });
  } catch (e) { /* log fail không chặn copy */ }
  return usage;
}

/**
 * POST /api/dac/copy — copy 1 file audio từ share link vào Drive của user.
 * Body: { "sourceId": "...", "destName": "..." (optional) }
 *
 * Thử server-side copy (files.copy) trước — nhanh (~30s cho 10GB).
 * Nếu 403 (scope không đủ — D7): trả về lỗi chi tiết để app hiện thông báo
 * và ghi log. Không tự fallback download+upload ở Worker (tốn băng thông Worker).
 *
 * Trả về: { copiedId, name, size, method: 'server' }
 * Lỗi scope: 403 { error: 'insufficient_scope', details }
 */
export async function handleDacCopy(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const driveToken = await getDriveToken(request, env, s.email);
  if (!driveToken) return jerr('Drive not connected', 400);

  let body;
  try { body = await request.json(); } catch (e) { return jerr('Bad JSON', 400); }
  const sourceId = (body.sourceId || '').trim();
  if (!sourceId || !/^[a-zA-Z0-9_-]+$/.test(sourceId)) {
    return jerr('Bad source id', 400);
  }

  try {
    // 1. Verify source là audio + lấy size
    const meta = await driveGetFile(sourceId, driveToken);
    if (!isAudio(meta.name, meta.mimeType)) {
      return jerr('Chỉ copy file nhạc', 400);
    }
    const size = meta.size ? parseInt(meta.size, 10) : 0;
    if (size > COPY_MAX_FILE_BYTES) {
      return jerr('File quá lớn (tối đa 2GB)', 400);
    }

    // 2. Check daily limit
    const userId = s.email || s.id || 'unknown';
    const usage = await getCopyUsage(env, userId);
    if (usage.count >= COPY_DAILY_MAX_FILES) {
      return jerr(`Hết lượt copy hôm nay (${COPY_DAILY_MAX_FILES} file/ngày)`, 429);
    }
    if (usage.bytes + size > COPY_DAILY_MAX_BYTES) {
      return jerr('Hết dung lượng copy hôm nay (10GB/ngày)', 429);
    }

    // 3. Server-side copy
    const destName = (body.destName || meta.name || '').trim() || meta.name;
    const copyBody = { name: destName };
    // Copy nhạc vào root Drive của user (đơn giản, không tạo thêm thư mục)
    // (đơn giản: copy vào root, user tự sắp xếp; tạo folder thêm 1 API call)
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${sourceId}/copy?fields=id,name,size,mimeType`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + driveToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(copyBody),
      }
    );

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      // D7: ghi lại lỗi scope chi tiết để quyết định
      if (r.status === 403) {
        console.log(`[dac-copy] 403 insufficient scope: user=${userId} source=${sourceId} body=${errText.slice(0, 200)}`);
        return jerr('insufficient_scope', 403, {
          details: 'Token Drive hiện tại không đủ quyền copy file này. ' +
            'Thử cấp quyền Drive đầy đủ trong Cài đặt → Kết nối lại Drive.',
          driveError: errText.slice(0, 300),
        });
      }
      if (r.status === 401) return jerr('Drive token invalid', 401);
      if (r.status === 404) return jerr('Không tìm thấy file nguồn', 404);
      return jerr('Copy failed', 502);
    }

    const copied = await r.json();
    const copiedSize = copied.size ? parseInt(copied.size, 10) : size;
    await recordCopy(env, userId, sourceId, copied.name, copiedSize, 'server');

    return sJson({
      copiedId: copied.id,
      name: copied.name,
      size: copiedSize,
      mimeType: copied.mimeType || mimeFor(copied.name || ''),
      method: 'server',
    });
  } catch (e) {
    if (e.status === 401) return jerr('Drive token invalid', 401);
    return jerr('Copy failed', 500);
  }
}

/**
 * 4.8: Tìm kiếm metadata trong D1 index (FTS5).
 * GET /api/dac/search?q=...&limit=50&offset=0
 * → {files:[{id,name,artist,title,album,size,mimeType}], total, limit, offset}
 *
 * - Tìm theo tên file + artist + title + album (không chỉ tên file),
 *   không phân biệt hoa thường; gõ không dấu vẫn trúng (bản unaccent trong index).
 * - artist/title parse từ quy ước tên file "Nghệ sĩ - Tên bài.ext";
 *   không khớp thì artist rỗng, title = tên file không đuôi (không bịa).
 * - album = tên thư mục chứa file (quy ước thư viện nhạc); rỗng nếu ở root.
 * - Có index nhưng query không trúng → files:[], total:0 (KHÔNG fallback Drive).
 * - Chưa sync (không có index) → fallback tìm live trên Drive
 *   (name contains), trả total=-1 (Drive không đếm tổng rẻ được).
 */
export async function handleDacSearch(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return jerr('Missing q', 400);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const email = s.email.toLowerCase();

  await ensureDacSearchSchema(env);

  // Chỉ fallback Drive khi user chưa từng sync (hoàn toàn không có index).
  let hasIndex = false;
  try {
    const c = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM dac_index WHERE email=?'
    ).bind(email).first();
    hasIndex = !!(c && c.c > 0);
  } catch (e) { /* coi như chưa có index → fallback bên dưới */ }

  if (hasIndex) {
    // FTS5: tách token chữ/số, mỗi token thành prefix query (tìm theo từng chữ).
    // Ký tự đặc biệt của FTS (" * :) bị loại ở tokenize nên không phá query.
    const tokens = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
      .map(t => t.replace(/["*]/g, '')).filter(Boolean);
    if (!tokens.length) return sJson({ files: [], total: 0, limit, offset });
    const match = tokens.map(t => t + '*').join(' ');
    const fromWhere = `FROM dac_index_fts JOIN dac_index d ON d.rowid = dac_index_fts.rowid
      WHERE dac_index_fts MATCH ? AND dac_index_fts.email = ? AND d.is_folder = 0`;
    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) as c ${fromWhere}`
    ).bind(match, email).first();
    const total = totalRow ? totalRow.c : 0;
    const rows = await env.DB.prepare(
      `SELECT d.file_id, d.name, d.artist, d.title, d.album, d.mime_type, d.size
       ${fromWhere} ORDER BY rank LIMIT ? OFFSET ?`
    ).bind(match, email, limit, offset).all();
    const files = (rows.results || []).map(r => ({
      id: r.file_id,
      name: r.name,
      artist: r.artist || '',
      title: r.title || (r.name || '').replace(/\.[^.]+$/, ''),
      album: r.album || '',
      size: r.size || 0,
      mimeType: r.mime_type || mimeFor(r.name || ''),
    }));
    return sJson({ files, total, limit, offset });
  }

  // Fallback: tìm live trên Drive (chưa sync index)
  const driveToken = await getDriveToken(request, env, s.email);
  if (!driveToken) return jerr('Drive not connected', 400);
  try {
    // Escape dấu ' cho query Drive
    const dq = q.replace(/'/g, "\\'");
    const driveQ = encodeURIComponent(
      `mimeType contains 'audio/' and name contains '${dq}' and trashed=false`
    );
    const r = await driveFetchRetry(
      `https://www.googleapis.com/drive/v3/files?q=${driveQ}` +
      `&fields=files(id,name,mimeType,size)&pageSize=${limit}&orderBy=name`,
      { 'Authorization': 'Bearer ' + driveToken }
    );
    const j = await r.json();
    const files = (j.files || []).map(f => {
      const at = parseArtistTitle(f.name || '');
      return {
        id: f.id, name: f.name, artist: at.artist, title: at.title, album: '',
        size: parseInt(f.size || '0', 10) || 0,
        mimeType: f.mimeType || mimeFor(f.name || ''),
      };
    });
    return sJson({ files, total: -1, limit, offset: 0 });
  } catch (e) {
    if (e.status === 401) return jerr('Drive token invalid', 401);
    return jerr('Drive search failed', 502);
  }
}

// GET /api/dac/library — flat list tất cả nhạc (cho tab Bài hát)
export async function handleDacLibrary(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const email = s.email.toLowerCase();

  await ensureDacSearchSchema(env);

  const totalRow = await env.DB.prepare(
    'SELECT COUNT(*) as c FROM dac_index WHERE email=? AND is_folder=0'
  ).bind(email).first();
  const total = totalRow ? totalRow.c : 0;

  const rows = await env.DB.prepare(
    `SELECT file_id, name, artist, title, album, mime_type, size
     FROM dac_index WHERE email=? AND is_folder=0
     ORDER BY name LIMIT ? OFFSET ?`
  ).bind(email, limit, offset).all();

  const files = (rows.results || []).map(r => ({
    id: r.file_id,
    name: r.name,
    artist: r.artist || '',
    title: r.title || (r.name || '').replace(/\.[^.]+$/, ''),
    album: r.album || '',
    size: r.size || 0,
    mimeType: r.mime_type || mimeFor(r.name || ''),
  }));
  // Đồng bộ thông minh: trả lastSync để client quyết định có cần refresh
  let lastSync = 0;
  try {
    const st = await env.DB.prepare(
      'SELECT updated_at FROM dac_sync_state WHERE email=?'
    ).bind(email).first();
    lastSync = (st && st.updated_at) || 0;
  } catch (e) { /* bỏ qua */ }
  return sJson({ files, total, limit, offset, lastSync });
}

/**
 * Parse "Nghệ sĩ - Tên bài.ext" → {artist, title}.
 * Không khớp quy ước → artist='', title=tên file không đuôi.
 */
function parseArtistTitle(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: base };
}

/** Bỏ dấu tiếng Việt để tìm không dấu vẫn trúng (gõ "tinh" ra "tình"). */
function unaccent(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * 4.8: text cho FTS — tên file + artist + title + album, kèm bản không dấu,
 * lowercase. Chỉ dùng những gì có, không bịa metadata.
 */
function dacSearchText(name, artist, title, album) {
  const raw = [name, artist, title, album].filter(Boolean).join(' ');
  return (raw + ' ' + unaccent(raw)).toLowerCase();
}

/**
 * 4.8: migration idempotent cho cột metadata + bảng FTS5 + trigger đồng bộ.
 * Chạy mỗi lần sync/search nên phải rẻ và không fail khi đã chạy rồi.
 */
async function ensureDacSearchSchema(env) {
  for (const c of ['artist', 'title', 'album', 'search_text']) {
    try {
      await env.DB.prepare(
        `ALTER TABLE dac_index ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`
      ).run();
    } catch (e) { /* cột đã tồn tại */ }
  }
  await env.DB.prepare(
    `CREATE VIRTUAL TABLE IF NOT EXISTS dac_index_fts USING
     fts5(text, email UNINDEXED, file_id UNINDEXED, tokenize='unicode61')`
  ).run();
  await env.DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS trg_dac_fts_ins AFTER INSERT ON dac_index BEGIN
       INSERT INTO dac_index_fts(rowid, text, email, file_id)
       VALUES (new.rowid, new.search_text, new.email, new.file_id);
     END`
  ).run();
  await env.DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS trg_dac_fts_upd AFTER UPDATE ON dac_index BEGIN
       DELETE FROM dac_index_fts WHERE rowid = old.rowid;
       INSERT INTO dac_index_fts(rowid, text, email, file_id)
       VALUES (new.rowid, new.search_text, new.email, new.file_id);
     END`
  ).run();
  await env.DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS trg_dac_fts_del AFTER DELETE ON dac_index BEGIN
       DELETE FROM dac_index_fts WHERE rowid = old.rowid;
     END`
  ).run();
}

/**
 * 4.8: điền album = tên thư mục cha + rebuild search_text cho mọi track.
 * album ở đây là quy ước thư viện nhạc (thư mục chứa file), không phải
 * tag đọc từ trong file — rỗng nếu file nằm ở root Drive.
 * Idempotent, chạy sau mỗi lần sync (full + incremental).
 */
async function refreshDacMetadata(env, email) {
  const rows = await env.DB.prepare(
    `SELECT d.rowid AS rid, d.name, d.artist, d.title, p.name AS pname
     FROM dac_index d LEFT JOIN dac_index p
       ON p.email = d.email AND p.file_id = d.parent_id AND p.is_folder = 1
     WHERE d.email = ? AND d.is_folder = 0`
  ).bind(email).all();
  const list = rows.results || [];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    await env.DB.batch(chunk.map(r => {
      const album = r.pname || '';
      const st = dacSearchText(r.name || '', r.artist || '', r.title || '', album);
      return env.DB.prepare(
        'UPDATE dac_index SET album=?, search_text=? WHERE rowid=?'
      ).bind(album, st, r.rid);
    }));
  }
}

// --- 4.9: Playlist lưu trên D1 (đồng bộ giữa 2 máy) ---
//
// Schema tạo qua D1 REST API khi deploy (bài học 4.8: DDL qua worker
// binding không tin được). ensureDacPlaylistSchema chỉ giữ IF NOT EXISTS.

async function ensureDacPlaylistSchema(env) {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS dac_playlists (
         email TEXT NOT NULL, playlist_id TEXT NOT NULL, name TEXT NOT NULL,
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
         PRIMARY KEY (email, playlist_id))`
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS dac_playlist_items (
         email TEXT NOT NULL, playlist_id TEXT NOT NULL, position INTEGER NOT NULL,
         file_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
         artist TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
         mime_type TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (email, playlist_id, position))`
    ).run();
  } catch (e) { /* schema đã có từ migration */ }
}

function dacPlaylistId(requestUrl) {
  const id = new URL(requestUrl).pathname.split('/').pop() || '';
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : '';
}

/** GET /api/dac/playlists → {playlists:[{id,name,itemCount,createdAt,updatedAt}]} */
export async function handleDacPlaylistList(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const email = s.email.toLowerCase();
  await ensureDacPlaylistSchema(env);
  const rows = await env.DB.prepare(
    `SELECT p.playlist_id, p.name, p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM dac_playlist_items i
             WHERE i.email=p.email AND i.playlist_id=p.playlist_id) AS n
     FROM dac_playlists p WHERE p.email=? ORDER BY p.updated_at DESC`
  ).bind(email).all();
  return sJson({
    playlists: (rows.results || []).map(r => ({
      id: r.playlist_id, name: r.name, itemCount: r.n || 0,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })),
  });
}

/** POST /api/dac/playlists {name} → {id,name} */
export async function handleDacPlaylistCreate(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const email = s.email.toLowerCase();
  let name = '';
  try { name = String((await request.json()).name || '').trim().slice(0, 80); }
  catch (e) { /* giữ name rỗng → 400 bên dưới */ }
  if (!name) return jerr('Missing name', 400);
  await ensureDacPlaylistSchema(env);
  const id = 'pl_' + [...crypto.getRandomValues(new Uint8Array(8))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO dac_playlists(email,playlist_id,name,created_at,updated_at) VALUES(?,?,?,?,?)'
  ).bind(email, id, name, now, now).run();
  return sJson({ id, name });
}

/** DELETE /api/dac/playlists/{id} → {ok:true} */
export async function handleDacPlaylistDelete(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const email = s.email.toLowerCase();
  const id = dacPlaylistId(request.url);
  if (!id) return jerr('Bad id', 400);
  await ensureDacPlaylistSchema(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM dac_playlist_items WHERE email=? AND playlist_id=?').bind(email, id),
    env.DB.prepare('DELETE FROM dac_playlists WHERE email=? AND playlist_id=?').bind(email, id),
  ]);
  return sJson({ ok: true });
}

/** GET /api/dac/playlists/{id} → {id,name,items:[{fileId,name,artist,title,mimeType,size}]} */
export async function handleDacPlaylistGet(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const email = s.email.toLowerCase();
  const id = dacPlaylistId(request.url);
  if (!id) return jerr('Bad id', 400);
  await ensureDacPlaylistSchema(env);
  const p = await env.DB.prepare(
    'SELECT playlist_id,name,created_at,updated_at FROM dac_playlists WHERE email=? AND playlist_id=?'
  ).bind(email, id).first();
  if (!p) return jerr('Not found', 404);
  const rows = await env.DB.prepare(
    `SELECT file_id,name,artist,title,mime_type,size FROM dac_playlist_items
     WHERE email=? AND playlist_id=? ORDER BY position`
  ).bind(email, id).all();
  return sJson({
    id: p.playlist_id, name: p.name, createdAt: p.created_at, updatedAt: p.updated_at,
    items: (rows.results || []).map(r => ({
      fileId: r.file_id, name: r.name, artist: r.artist || '', title: r.title || '',
      mimeType: r.mime_type || '', size: r.size || 0,
    })),
  });
}

/** PUT /api/dac/playlists/{id} {items:[...]} → thay toàn bộ items, {ok:true,count} */
export async function handleDacPlaylistSetItems(request, env) {
  const s = await getSession(request, env);
  if (!s) return jerr('Not logged in', 401);
  const email = s.email.toLowerCase();
  const id = dacPlaylistId(request.url);
  if (!id) return jerr('Bad id', 400);
  let items = null;
  try { items = (await request.json()).items; } catch (e) { /* → 400 */ }
  if (!Array.isArray(items) || items.length > 500) return jerr('Bad items', 400);
  await ensureDacPlaylistSchema(env);
  const p = await env.DB.prepare(
    'SELECT playlist_id FROM dac_playlists WHERE email=? AND playlist_id=?'
  ).bind(email, id).first();
  if (!p) return jerr('Not found', 404);
  const now = Date.now();
  const stmts = [
    env.DB.prepare('DELETE FROM dac_playlist_items WHERE email=? AND playlist_id=?').bind(email, id),
  ];
  items.forEach((it, i) => {
    stmts.push(env.DB.prepare(
      `INSERT INTO dac_playlist_items
         (email,playlist_id,position,file_id,name,artist,title,mime_type,size)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).bind(email, id, i,
      String(it.fileId || '').slice(0, 64), String(it.name || '').slice(0, 200),
      String(it.artist || '').slice(0, 100), String(it.title || '').slice(0, 200),
      String(it.mimeType || '').slice(0, 100), parseInt(it.size, 10) || 0));
  });
  stmts.push(env.DB.prepare(
    'UPDATE dac_playlists SET updated_at=? WHERE email=? AND playlist_id=?'
  ).bind(now, email, id));
  for (let i = 0; i < stmts.length; i += 80) {
    await env.DB.batch(stmts.slice(i, i + 80));
  }
  return sJson({ ok: true, count: items.length });
}
