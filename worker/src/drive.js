// worker/src/drive.js — Google Drive integration for user file storage.
import { getSession, getUser } from './auth.js';
import { dbPutUser, dbGetSession } from './db.js';

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
  const params = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: cfg.redirect_uri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
    state: s.token, // use session token as state
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

  // Get user email from session
  const sess = await dbGetSession(env, state);
  if(!sess) return new Response("Invalid session", {status:401});

  // Store tokens
  await env.DB.prepare(`INSERT INTO drive_tokens (email, access_token, refresh_token, expires_at, created_at)
    VALUES (?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET access_token=?, refresh_token=?, expires_at=?`)
    .bind(sess.email, tok.access_token, tok.refresh_token||"", Date.now()+tok.expires_in*1000, Date.now(),
          tok.access_token, tok.refresh_token||"", Date.now()+tok.expires_in*1000).run();

  // Redirect to settings with success
  return Response.redirect("https://lethanhdong.one/english/#settings?drive=ok", 302);
}

// GET /api/drive/status — check if connected
export async function handleDriveStatus(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const row = await env.DB.prepare("SELECT email FROM drive_tokens WHERE email=?").bind(s.email).first();
  return jok({connected: !!row});
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
  await env.DB.prepare("DELETE FROM drive_tokens WHERE email=?").bind(s.email).run();
  return jok({ok:true});
}

// Get valid access token (refresh if needed)
export async function getDriveToken(env, email){
  const row = await env.DB.prepare("SELECT * FROM drive_tokens WHERE email=?").bind(email).first();
  if(!row) return null;
  if(Date.now() < row.expires_at - 60000) return row.access_token;
  // Refresh
  const cfg = getOAuthConfig(env);
  if(!row.refresh_token || !cfg.client_secret) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      refresh_token: row.refresh_token, client_id: cfg.client_id,
      client_secret: cfg.client_secret, grant_type: "refresh_token",
    }).toString(),
  });
  if(!r.ok) return null;
  const t = await r.json();
  await env.DB.prepare("UPDATE drive_tokens SET access_token=?, expires_at=? WHERE email=?")
    .bind(t.access_token, Date.now()+t.expires_in*1000, email).run();
  return t.access_token;
}

// POST /api/drive/upload — upload file to user's Drive
