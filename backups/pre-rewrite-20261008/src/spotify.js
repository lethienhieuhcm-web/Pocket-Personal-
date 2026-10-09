// worker/src/spotify.js — Spotify OAuth + API proxy.
import { getSession } from './auth.js';
import { dbPutUser, dbGetSession } from './db.js';

function jerr(msg, code){ return new Response(JSON.stringify({error: msg}), {status: code||400, headers:{"Content-Type":"application/json"}}); }
function jok(d){ return new Response(JSON.stringify(d), {headers:{"Content-Type":"application/json"}}); }

function getCfg(env){
  return {
    client_id: env.SPOTIFY_CLIENT_ID || "",
    client_secret: env.SPOTIFY_CLIENT_SECRET || "",
    redirect_uri: "https://lethanhdong.one/api/spotify/callback",
  };
}

// GET /api/spotify/auth-url
export async function handleSpotifyAuthUrl(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const cfg = getCfg(env);
  if(!cfg.client_id) return jerr("Spotify not configured", 500);
  const params = new URLSearchParams({
    client_id: cfg.client_id,
    response_type: "code",
    redirect_uri: cfg.redirect_uri,
    scope: "user-read-private user-read-email playlist-read-private user-read-playback-state user-modify-playback-state streaming",
    state: s.token,
  });
  return jok({url: "https://accounts.spotify.com/authorize?"+params.toString()});
}

// GET /api/spotify/callback
export async function handleSpotifyCallback(request, env){
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if(!code || !state) return new Response("Missing code/state", {status:400});
  const cfg = getCfg(env);
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded",
              "Authorization":"Basic "+btoa(cfg.client_id+":"+cfg.client_secret)},
    body: new URLSearchParams({code, redirect_uri: cfg.redirect_uri, grant_type: "authorization_code"}).toString(),
  });
  if(!r.ok) return new Response("Token exchange failed", {status:500});
  const t = await r.json();
  const sess = await dbGetSession(env, state);
  if(!sess) return new Response("Invalid session", {status:401});
  await env.DB.prepare(`INSERT INTO spotify_tokens (email, access_token, refresh_token, expires_at, created_at)
    VALUES (?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET access_token=?, refresh_token=?, expires_at=?`)
    .bind(sess.email, t.access_token, t.refresh_token||"", Date.now()+t.expires_in*1000, Date.now(),
          t.access_token, t.refresh_token||"", Date.now()+t.expires_in*1000).run();
  return Response.redirect("https://lethanhdong.one/music/#spotify", 302);
}

// GET /api/spotify/status
export async function handleSpotifyStatus(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const row = await env.DB.prepare("SELECT email FROM spotify_tokens WHERE email=?").bind(s.email).first();
  return jok({connected: !!row});
}

// Get valid token (refresh if needed)
async function getToken(env, email){
  const row = await env.DB.prepare("SELECT * FROM spotify_tokens WHERE email=?").bind(email).first();
  if(!row) return null;
  if(Date.now() < row.expires_at - 60000) return row.access_token;
  const cfg = getCfg(env);
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded",
              "Authorization":"Basic "+btoa(cfg.client_id+":"+cfg.client_secret)},
    body: new URLSearchParams({grant_type:"refresh_token", refresh_token:row.refresh_token}).toString(),
  });
  if(!r.ok) return null;
  const t = await r.json();
  await env.DB.prepare("UPDATE spotify_tokens SET access_token=?, expires_at=? WHERE email=?")
    .bind(t.access_token, Date.now()+t.expires_in*1000, email).run();
  return t.access_token;
}

// GET /api/spotify/search?q=...
export async function handleSpotifySearch(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const token = await getToken(env, s.email);
  if(!token) return jerr("Spotify not connected", 400);
  const q = new URL(request.url).searchParams.get("q")||"";
  const r = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=20`, {
    headers: {"Authorization":"Bearer "+token},
  });
  if(!r.ok) return jerr("Spotify search failed", 500);
  return jok(await r.json());
}

// POST /api/spotify/disconnect
