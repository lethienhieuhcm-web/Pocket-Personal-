// worker/src/drive.js — Google Drive integration for user file storage.
import { getSession, getUser } from './auth.js';
import { dbPutUser, dbGetSession } from './db.js';
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { driveTokens } from "./schema.js";

function jerr(msg, code){ return new Response(JSON.stringify({error: msg}), {status: code||400, headers:{"Content-Type":"application/json"}}); }
function jok(d){ return new Response(JSON.stringify(d), {headers:{"Content-Type":"application/json"}}); }

// Get OAuth config from env
function getOAuthConfig(env){
  return {
    client_id: env.GOOGLE_CLIENT_ID || "",
    client_secret: env.GOOGLE_CLIENT_SECRET || "",
    redirect_uri: "https://lethanhdong.one/api/drive/callback",
  };
}

// GET /api/drive/auth-url — get Google OAuth URL
export async function handleDriveAuthUrl(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const cfg = getOAuthConfig(env);
  if(!cfg.client_id) return jerr("Drive not configured", 500);
  // return_to: frontend truyền path muốn quay về sau OAuth (vd /dacplayer/)
  const url = new URL(request.url);
  let returnTo = url.searchParams.get("return_to") || "/english/#settings";
  // Chỉ cho phép path nội bộ để chống open redirect
  if(!returnTo.startsWith("/")) returnTo = "/english/#settings";
  const state = s.token + "|" + returnTo;
  const params = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: cfg.redirect_uri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    access_type: "offline",
    prompt: "consent",
    state: state,
  });
  return jok({url: "https://accounts.google.com/o/oauth2/v2/auth?"+params.toString()});
}

// GET /api/drive/callback?code=...&state=...
export async function handleDriveCallback(request, env){
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if(!code || !state){
    return new Response("Missing code/state", {status:400});
  }
  const cfg = getOAuthConfig(env);
  // Exchange code for tokens
  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      code, client_id: cfg.client_id, client_secret: cfg.client_secret,
      redirect_uri: cfg.redirect_uri, grant_type: "authorization_code",
    }).toString(),
  });
  if(!tokRes.ok) return new Response("Token exchange failed", {status:500});
  const tok = await tokRes.json();

  // state = "session_token|return_path"
  const sepIdx = state.indexOf("|");
  const sessToken = sepIdx >= 0 ? state.slice(0, sepIdx) : state;
  let returnTo = sepIdx >= 0 ? state.slice(sepIdx + 1) : "/english/#settings";
  if(!returnTo.startsWith("/")) returnTo = "/english/#settings";

  // Get user email from session
  const sess = await dbGetSession(env, sessToken);
  if(!sess) return new Response("Invalid session", {status:401});

  // Store tokens
  const db = drizzle(env.DB);
  await db.insert(driveTokens).values({
    email: sess.email,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token||"",
    expiresAt: Date.now()+tok.expires_in*1000,
    createdAt: Date.now(),
  }).onConflictDoUpdate({
    target: driveTokens.email,
    set: {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token||"",
      expiresAt: Date.now()+tok.expires_in*1000,
    },
  });

  // Redirect về đúng app đã bắt đầu OAuth
  // Nếu returnTo có hash, thêm param trước hash
  let dest = "https://lethanhdong.one" + returnTo;
  if(returnTo.includes("#")){
    const [p, h] = returnTo.split("#");
    dest = "https://lethanhdong.one" + p + (p.includes("?") ? "&" : "?") + "drive=ok#" + h;
  } else {
    dest = "https://lethanhdong.one" + returnTo + (returnTo.includes("?") ? "&drive=ok" : "?drive=ok");
  }
  return Response.redirect(dest, 302);
}

// GET /api/drive/status — check if connected
export async function handleDriveStatus(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const db = drizzle(env.DB);
  const rows = await db.select({ email: driveTokens.email }).from(driveTokens).where(eq(driveTokens.email, s.email)).limit(1);
  return jok({connected: rows.length > 0});
}

// GET /api/drive/music — list audio files in user's Drive
export async function handleDriveMusic(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const token = await getDriveToken(env, s.email);
  if(!token) return jerr("Drive not connected", 400);
  // List audio files
  const q = encodeURIComponent("mimeType contains 'audio/' and trashed=false");
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size)&pageSize=100&orderBy=name`, {
    headers: {"Authorization":"Bearer "+token},
  });
  if(!r.ok) return jerr("Drive list failed", 500);
  const j = await r.json();
  return jok({files: (j.files||[]).map(f=>({id:f.id, name:f.name, size:f.size}))});
}

// GET /api/drive/stream/:id — redirect to Drive download URL
export async function handleDriveStream(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const id = new URL(request.url).pathname.split("/").pop();
  const token = await getDriveToken(env, s.email);
  if(!token) return jerr("Drive not connected", 400);
  // Return direct download URL (frontend uses it in <audio>)
  return jok({url: `https://www.googleapis.com/drive/v3/files/${id}?alt=media&access_token=${token}`});
}

// POST /api/drive/disconnect
export async function handleDriveDisconnect(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const db = drizzle(env.DB);
  await db.delete(driveTokens).where(eq(driveTokens.email, s.email));
  return jok({ok:true});
}

// Get valid access token (refresh if needed)
export async function getDriveToken(env, email){
  const db = drizzle(env.DB);
  const rows = await db.select().from(driveTokens).where(eq(driveTokens.email, email)).limit(1);
  const row = rows[0];
  if(!row) return null;
  if(Date.now() < row.expiresAt - 60000) return row.accessToken;
  // Refresh
  const cfg = getOAuthConfig(env);
  if(!row.refreshToken || !cfg.client_secret) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      refresh_token: row.refreshToken, client_id: cfg.client_id,
      client_secret: cfg.client_secret, grant_type: "refresh_token",
    }).toString(),
  });
  if(!r.ok) return null;
  const t = await r.json();
  await db.update(driveTokens)
    .set({ accessToken: t.access_token, expiresAt: Date.now()+t.expires_in*1000 })
    .where(eq(driveTokens.email, email));
  return t.access_token;
}

// POST /api/drive/upload — upload file to user's Drive (dùng cho Voice "Lưu vào Drive").
// Body JSON: {name, mimeType, data (base64)}.
// Verify 2026-10-12: đúng format multipart/related của Google Drive API v3.
export async function handleDriveUpload(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  let body;
  try{ body = await request.json(); }catch(e){ return jerr("Bad JSON", 400); }
  const name = String(body.name || "").slice(0, 120) || "voice.wav";
  const mimeType = String(body.mimeType || "audio/wav").slice(0, 80);
  const b64 = String(body.data || "");
  // Giới hạn 25MB (Workers cho 100MB, audio thường <10MB)
  if(!b64 || b64.length > 35_000_000) return jerr("Bad data", 400);
  if(!/^audio\//.test(mimeType)) return jerr("Audio only", 400);
  const token = await getDriveToken(env, s.email);
  if(!token) return jerr("Drive not connected", 400);
  let bytes;
  try{
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }catch(e){ return jerr("Bad data", 400); }
  const boundary = "voice-" + Date.now().toString(36);
  const meta = JSON.stringify({ name, mimeType });
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const enc = new TextEncoder();
  const payload = new Blob([enc.encode(head), bytes, enc.encode(tail)]);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: payload,
  });
  if(!r.ok){
    const t = await r.text().catch(() => "");
    return jerr("Drive upload failed: " + r.status, 500);
  }
  const j = await r.json();
  return jok({ id: j.id, name: j.name, url: j.webViewLink || ("https://drive.google.com/file/d/" + j.id + "/view") });
}
