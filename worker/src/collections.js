// worker/src/collections.js — content library (collections + items).
import { drizzle } from "drizzle-orm/d1";
import { eq, asc, desc, sql } from "drizzle-orm";
import { collections, collectionItems } from "./schema.js";

function jerr(msg, code){ return new Response(JSON.stringify({error: msg}), {status: code||400, headers:{"Content-Type":"application/json"}}); }
function jok(d){ return new Response(JSON.stringify(d), {headers:{"Content-Type":"application/json"}}); }

// GET /api/collections — list all collections
export async function handleCollectionsList(request, env){
  try{
    const db = drizzle(env.DB);
    const rows = await db.select().from(collections).orderBy(desc(collections.createdAt));
    return jok({ collections: rows });
  }catch(e){ return jerr("DB error", 500); }
}

// GET /api/collections/:id — collection detail + items
export async function handleCollectionGet(request, env, id){
  try{
    const db = drizzle(env.DB);
    const cols = await db.select().from(collections).where(eq(collections.id, id)).limit(1);
    if(!cols[0]) return jerr("Not found", 404);
    const items = await db.select().from(collectionItems)
      .where(eq(collectionItems.collectionId, id))
      .orderBy(asc(collectionItems.sortOrder));
    return jok({ collection: cols[0], items });
  }catch(e){ return jerr("DB error", 500); }
}

// POST /api/admin/collections — create collection (admin only)
export async function handleAdminCollectionCreate(request, env){
  let b;
  try{ b = await request.json(); }catch(e){ return jerr("Invalid JSON", 400); }
  const title = String(b.title || "").trim().slice(0, 100);
  if(!title) return jerr("Missing title", 400);
  const now = Date.now();
  const id = "col_" + now.toString(36) + Math.random().toString(36).slice(2, 8);
  try{
    const db = drizzle(env.DB);
    await db.insert(collections).values({
      id, title,
      description: String(b.description || "").slice(0, 500),
      coverUrl: String(b.cover_url || "").slice(0, 500),
      itemCount: 0, createdAt: now, updatedAt: now,
    });
    return jok({ ok: true, id });
  }catch(e){ return jerr("DB error", 500); }
}

// DELETE /api/admin/collections/:id — delete collection + items (admin only)
export async function handleAdminCollectionDelete(request, env, id){
  try{
    const db = drizzle(env.DB);
    await db.delete(collectionItems).where(eq(collectionItems.collectionId, id));
    await db.delete(collections).where(eq(collections.id, id));
    return jok({ ok: true });
  }catch(e){ return jerr("DB error", 500); }
}

// POST /api/admin/collections/:id/items — add item (admin only)
export async function handleAdminItemCreate(request, env, collectionId){
  let b;
  try{ b = await request.json(); }catch(e){ return jerr("Invalid JSON", 400); }
  const title = String(b.title || "").trim().slice(0, 200);
  if(!title) return jerr("Missing title", 400);
  const now = Date.now();
  const id = "itm_" + now.toString(36) + Math.random().toString(36).slice(2, 8);
  try{
    const db = drizzle(env.DB);
    await db.insert(collectionItems).values({
      id, collectionId,
      title,
      contentType: String(b.content_type || "article").slice(0, 20),
      contentUrl: String(b.content_url || "").slice(0, 1000),
      excerpt: String(b.excerpt || "").slice(0, 500),
      durationSec: parseInt(b.duration_sec) || 0,
      sortOrder: parseInt(b.sort_order) || 0,
      createdAt: now,
    });
    await db.update(collections)
      .set({ itemCount: sql`${collections.itemCount} + 1`, updatedAt: now })
      .where(eq(collections.id, collectionId));
    return jok({ ok: true, id });
  }catch(e){ return jerr("DB error", 500); }
}

// DELETE /api/admin/items/:id — delete item (admin only)
export async function handleAdminItemDelete(request, env, id){
  try{
    const db = drizzle(env.DB);
    const rows = await db.select({ collectionId: collectionItems.collectionId })
      .from(collectionItems).where(eq(collectionItems.id, id)).limit(1);
    if(rows[0]){
      await db.delete(collectionItems).where(eq(collectionItems.id, id));
      await db.update(collections)
        .set({ itemCount: sql`MAX(${collections.itemCount} - 1, 0)`, updatedAt: Date.now() })
        .where(eq(collections.id, rows[0].collectionId));
    }
    return jok({ ok: true });
  }catch(e){ return jerr("DB error", 500); }
}
