// worker/src/images.js — serve illustration images from R2 (DATA bucket).
// Only keys under images/vocab/ or images/reading/ with an image
// extension are served, so this route can never read user data
// (books/, bank/ and sessions live under other prefixes).
import { jerr } from './utils.js';

const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);

export async function handleImageGet(request, env) {
  const key = new URL(request.url).pathname.replace('/api/images/', '');
  const parts = key.split('/');
  if (parts.length !== 3) return jerr('Invalid key', 400);
  if (parts[0] !== 'images') return jerr('Invalid key', 400);
  if (parts[1] !== 'vocab' && parts[1] !== 'reading') return jerr('Invalid key', 400);
  if (!parts[2] || parts[2].includes('..')) return jerr('Invalid key', 400);
  const ext = parts[2].split('.').pop().toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return jerr('Invalid key', 400);
  const obj = await env.DATA.get(key);
  if (!obj) return jerr('Not found', 404);
  const ct = obj.httpMetadata && obj.httpMetadata.contentType
    ? obj.httpMetadata.contentType
    : 'image/png';
  return new Response(await obj.arrayBuffer(), {
    headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' },
  });
}
