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

