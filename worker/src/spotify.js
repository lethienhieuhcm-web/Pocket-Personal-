// worker/src/spotify.js — Spotify OAuth + API proxy.
import { getSession } from './auth.js';
import { dbPutUser, dbGetSession } from './db.js';
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { spotifyTokens } from "./schema.js";

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
  const db = drizzle(env.DB);
  await db.insert(spotifyTokens).values({
    email: sess.email,
    accessToken: t.access_token,
    refreshToken: t.refresh_token||"",
    expiresAt: Date.now()+t.expires_in*1000,
    createdAt: Date.now(),
  }).onConflictDoUpdate({
    target: spotifyTokens.email,
    set: {
      accessToken: t.access_token,
      refreshToken: t.refresh_token||"",
      expiresAt: Date.now()+t.expires_in*1000,
    },
  });
  return Response.redirect("https://lethanhdong.one/music/#spotify", 302);
}

// GET /api/spotify/status
export async function handleSpotifyStatus(request, env){
  const s = await getSession(request, env);
  if(!s) return jerr("Not logged in", 401);
  const db = drizzle(env.DB);
  const rows = await db.select({ email: spotifyTokens.email }).from(spotifyTokens).where(eq(spotifyTokens.email, s.email)).limit(1);
  return jok({connected: rows.length > 0});
}

// Get valid token (refresh if needed)
async function getToken(env, email){
  const db = drizzle(env.DB);
  const rows = await db.select().from(spotifyTokens).where(eq(spotifyTokens.email, email)).limit(1);
  const row = rows[0];
  if(!row) return null;
  if(Date.now() < row.expiresAt - 60000) return row.accessToken;
  const cfg = getCfg(env);
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded",
              "Authorization":"Basic "+btoa(cfg.client_id+":"+cfg.client_secret)},
    body: new URLSearchParams({grant_type:"refresh_token", refresh_token:row.refreshToken}).toString(),
  });
  if(!r.ok) return null;
  const t = await r.json();
  await db.update(spotifyTokens)
    .set({ accessToken: t.access_token, expiresAt: Date.now()+t.expires_in*1000 })
    .where(eq(spotifyTokens.email, email));
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
