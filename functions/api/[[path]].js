/**
 * MyItem API – Cloudflare Pages Function (catch-all /api/*)
 * Bindings: DB (D1), IMAGES (R2)
 */
const GOOGLE_CLIENT_ID = "218112012758-cggt2288it2dre58trcpss52n5sj60vs.apps.googleusercontent.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

async function verifyGoogleToken(token) {
  if (!token) return null;
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.aud !== GOOGLE_CLIENT_ID) return null;
    if (String(data.exp) * 1000 < Date.now()) return null;
    return {
      sub: data.sub,
      email: data.email || "",
      name: data.name || data.email || "User",
    };
  } catch {
    return null;
  }
}

async function getUser(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyGoogleToken(m[1].trim());
}

async function ensureSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      user_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      user_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      place_id INTEGER,
      category TEXT DEFAULT 'Uncategorized',
      image_key TEXT,
      notes TEXT,
      user_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS item_tags (
      item_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (item_id, tag_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      entity_name TEXT,
      summary TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
  ]);
  const alters = [
    "ALTER TABLE places ADD COLUMN user_id TEXT",
    "ALTER TABLE tags ADD COLUMN user_id TEXT",
    "ALTER TABLE items ADD COLUMN user_id TEXT",
    "ALTER TABLE items ADD COLUMN notes TEXT",
    "ALTER TABLE items ADD COLUMN image_key TEXT",
  ];
  for (const sql of alters) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
}

async function ensureUncategorized(db, userId) {
  let row = await db
    .prepare(`SELECT id, user_id FROM tags WHERE lower(name)='uncategorized' AND (user_id = ? OR user_id IS NULL) LIMIT 1`)
    .bind(userId)
    .first();
  if (row) {
    if (!row.user_id) {
      try { await db.prepare(`UPDATE tags SET user_id = ? WHERE id = ?`).bind(userId, row.id).run(); } catch (_) {}
    }
    return row.id;
  }
  const r = await db.prepare(`INSERT INTO tags (name, user_id) VALUES ('Uncategorized', ?)`).bind(userId).run();
  return r.meta.last_row_id;
}

async function audit(db, userId, action, entityType, entityId, entityName, summary, details) {
  try {
    await db.prepare(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, entity_name, summary, details) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId, action, entityType || null, entityId || null, entityName || null, summary, details ? JSON.stringify(details) : null).run();
  } catch (e) { console.error("audit failed", e); }
}

function imageUrl(key) {
  if (!key) return null;
  return `/api/images/${encodeURIComponent(key)}`;
}

async function itemTags(db, itemId) {
  const rows = await db.prepare(
    `SELECT t.name FROM tags t INNER JOIN item_tags it ON it.tag_id = t.id WHERE it.item_id = ?`
  ).bind(itemId).all();
  return (rows.results || []).map((r) => r.name);
}

async function hydrateItem(db, row) {
  if (!row) return null;
  const tags = await itemTags(db, row.id);
  let place_name = null;
  if (row.place_id) {
    const p = await db.prepare(`SELECT name FROM places WHERE id = ?`).bind(row.place_id).first();
    place_name = p ? p.name : null;
  }
  return { ...row, tags, place_name, image_url: imageUrl(row.image_key) };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  const url = new URL(request.url);
  let path = url.pathname.replace(/^\/api\/?/, "");
  if (path.endsWith("/")) path = path.slice(0, -1);
  const parts = path ? path.split("/") : [];
  const method = request.method.toUpperCase();
  const db = env.DB;
  const images = env.IMAGES;
  if (!db) return err("Database binding missing", 500);
  await ensureSchema(db);

  if (parts[0] === "images" && parts[1] && method === "GET") {
    const key = decodeURIComponent(parts.slice(1).join("/"));
    if (!images) return err("Images binding missing", 500);
    const obj = await images.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers: cors });
    const headers = new Headers(cors);
    headers.set("Content-Type", obj.httpMetadata?.contentType || "image/jpeg");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(obj.body, { headers });
  }

  const user = await getUser(request);
  if (!user) return err("Unauthorized", 401);
  const userId = user.sub;

  try {
    if (parts[0] === "places" && parts.length === 1 && method === "GET") {
      const rows = await db.prepare(`SELECT id, name, created_at FROM places WHERE user_id = ? OR user_id IS NULL ORDER BY name COLLATE NOCASE`).bind(userId).all();
      return json(rows.results || []);
    }
    if (parts[0] === "places" && parts.length === 1 && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = (body.name || "").trim();
      if (!name) return err("Name is required");
      const exists = await db.prepare(`SELECT id FROM places WHERE lower(name)=lower(?) AND (user_id = ? OR user_id IS NULL)`).bind(name, userId).first();
      if (exists) return err("Place already exists");
      const r = await db.prepare(`INSERT INTO places (name, user_id) VALUES (?, ?)`).bind(name, userId).run();
      const id = r.meta.last_row_id;
      await audit(db, userId, "place.create", "place", id, name, `Added place **${name}**`);
      return json({ id, name });
    }
    if (parts[0] === "places" && parts[1] && method === "PUT") {
      const id = parseInt(parts[1], 10);
      const body = await request.json().catch(() => ({}));
      const name = (body.name || "").trim();
      if (!name) return err("Name is required");
      const old = await db.prepare(`SELECT * FROM places WHERE id = ?`).bind(id).first();
      if (!old) return err("Not found", 404);
      const clash = await db.prepare(`SELECT id FROM places WHERE lower(name)=lower(?) AND id != ? AND (user_id = ? OR user_id IS NULL)`).bind(name, id, userId).first();
      if (clash) return err("Place already exists");
      await db.prepare(`UPDATE places SET name = ?, user_id = ? WHERE id = ?`).bind(name, userId, id).run();
      await audit(db, userId, "place.rename", "place", id, name, `Renamed place **${old.name}** → **${name}**`, { from: old.name, to: name });
      return json({ id, name });
    }
    if (parts[0] === "places" && parts[1] && method === "DELETE") {
      const id = parseInt(parts[1], 10);
      const old = await db.prepare(`SELECT * FROM places WHERE id = ?`).bind(id).first();
      if (!old) return err("Not found", 404);
      await db.prepare(`UPDATE items SET place_id = NULL WHERE place_id = ?`).bind(id).run();
      await db.prepare(`DELETE FROM places WHERE id = ?`).bind(id).run();
      await audit(db, userId, "place.delete", "place", id, old.name, `Deleted place **${old.name}**. Items using it marked as Place deleted.`);
      return json({ ok: true });
    }

    if (parts[0] === "tags" && parts.length === 1 && method === "GET") {
      await ensureUncategorized(db, userId);
      const rows = await db.prepare(`SELECT id, name, created_at FROM tags WHERE user_id = ? OR user_id IS NULL ORDER BY CASE WHEN lower(name)='uncategorized' THEN 1 ELSE 0 END, name COLLATE NOCASE`).bind(userId).all();
      return json(rows.results || []);
    }
    if (parts[0] === "tags" && parts.length === 1 && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = (body.name || "").trim();
      if (!name) return err("Name is required");
      if (name.toLowerCase() === "uncategorized") return err("Reserved tag name");
      const exists = await db.prepare(`SELECT id FROM tags WHERE lower(name)=lower(?) AND (user_id = ? OR user_id IS NULL)`).bind(name, userId).first();
      if (exists) return err("Tag already exists");
      const r = await db.prepare(`INSERT INTO tags (name, user_id) VALUES (?, ?)`).bind(name, userId).run();
      const id = r.meta.last_row_id;
      await audit(db, userId, "tag.create", "tag", id, name, `Created tag **${name}**`);
      return json({ id, name });
    }
    if (parts[0] === "tags" && parts[1] && method === "PUT") {
      const id = parseInt(parts[1], 10);
      const body = await request.json().catch(() => ({}));
      const name = (body.name || "").trim();
      if (!name) return err("Name is required");
      const old = await db.prepare(`SELECT * FROM tags WHERE id = ?`).bind(id).first();
      if (!old) return err("Not found", 404);
      if ((old.name || "").toLowerCase() === "uncategorized") return err("Cannot rename Uncategorized");
      const clash = await db.prepare(`SELECT id FROM tags WHERE lower(name)=lower(?) AND id != ? AND (user_id = ? OR user_id IS NULL)`).bind(name, id, userId).first();
      if (clash) return err("Tag already exists");
      await db.prepare(`UPDATE tags SET name = ?, user_id = ? WHERE id = ?`).bind(name, userId, id).run();
      await audit(db, userId, "tag.rename", "tag", id, name, `Renamed tag **${old.name}** → **${name}**`, { from: old.name, to: name });
      return json({ id, name });
    }
    if (parts[0] === "tags" && parts[1] && method === "DELETE") {
      const id = parseInt(parts[1], 10);
      const old = await db.prepare(`SELECT * FROM tags WHERE id = ?`).bind(id).first();
      if (!old) return err("Not found", 404);
      if ((old.name || "").toLowerCase() === "uncategorized") return err("Cannot delete Uncategorized");
      const uncId = await ensureUncategorized(db, userId);
      const affected = await db.prepare(`SELECT item_id FROM item_tags WHERE tag_id = ? AND item_id NOT IN (SELECT item_id FROM item_tags WHERE tag_id != ?)`).bind(id, id).all();
      for (const row of affected.results || []) {
        await db.prepare(`INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)`).bind(row.item_id, uncId).run();
        await db.prepare(`UPDATE items SET category = 'Uncategorized', updated_at = datetime('now') WHERE id = ?`).bind(row.item_id).run();
      }
      await db.prepare(`DELETE FROM item_tags WHERE tag_id = ?`).bind(id).run();
      await db.prepare(`DELETE FROM tags WHERE id = ?`).bind(id).run();
      await audit(db, userId, "tag.delete", "tag", id, old.name, `Deleted tag **${old.name}**`);
      return json({ ok: true });
    }

    if (parts[0] === "categories" && method === "GET") {
      await ensureUncategorized(db, userId);
      const rows = await db.prepare(
        `SELECT t.name, COUNT(it.item_id) AS cnt FROM tags t
         LEFT JOIN item_tags it ON it.tag_id = t.id
         LEFT JOIN items i ON i.id = it.item_id AND (i.user_id = ? OR i.user_id IS NULL)
         WHERE (t.user_id = ? OR t.user_id IS NULL)
         GROUP BY t.id
         ORDER BY CASE WHEN lower(t.name)='uncategorized' THEN 1 ELSE 0 END, t.name COLLATE NOCASE`
      ).bind(userId, userId).all();
      const names = ["All"];
      for (const r of rows.results || []) {
        const isUnc = (r.name || "").toLowerCase() === "uncategorized";
        if (isUnc && (!r.cnt || r.cnt === 0)) continue;
        names.push(r.name);
      }
      return json(names);
    }

    if (parts[0] === "items" && parts.length === 1 && method === "GET") {
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10)));
      const search = (url.searchParams.get("search") || "").trim();
      const tag = (url.searchParams.get("tag") || "").trim();
      const offset = (page - 1) * limit;
      let where = `(i.user_id = ? OR i.user_id IS NULL)`;
      const binds = [userId];
      if (search) {
        where += ` AND (i.name LIKE ? OR ifnull(i.notes,'') LIKE ? OR ifnull(p.name,'') LIKE ?)`;
        const q = `%${search}%`;
        binds.push(q, q, q);
      }
      if (tag && tag.toLowerCase() !== "all") {
        where += ` AND EXISTS (SELECT 1 FROM item_tags it2 INNER JOIN tags t2 ON t2.id = it2.tag_id WHERE it2.item_id = i.id AND t2.name = ?)`;
        binds.push(tag);
      }
      const countRow = await db.prepare(`SELECT COUNT(DISTINCT i.id) AS c FROM items i LEFT JOIN places p ON p.id = i.place_id WHERE ${where}`).bind(...binds).first();
      const total = countRow?.c || 0;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const list = await db.prepare(`SELECT i.* FROM items i LEFT JOIN places p ON p.id = i.place_id WHERE ${where} ORDER BY i.updated_at DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all();
      const items = [];
      for (const row of list.results || []) items.push(await hydrateItem(db, row));
      return json({ items, pagination: { page, limit, total, totalPages } });
    }

    if (parts[0] === "items" && parts.length === 1 && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = (body.name || "").trim();
      if (!name) return err("Name is required");
      let tagIds = Array.isArray(body.tags) ? body.tags.map((x) => parseInt(x, 10)).filter(Boolean) : [];
      if (!tagIds.length) return err("At least one tag is required");
      tagIds = tagIds.slice(0, 3);
      const placeId = body.place_id ? parseInt(body.place_id, 10) : null;
      const imageKey = body.image_key || null;
      const notes = body.notes ? String(body.notes).slice(0, 300) : null;
      const firstTag = await db.prepare(`SELECT name FROM tags WHERE id = ?`).bind(tagIds[0]).first();
      const category = firstTag?.name || "Uncategorized";
      const r = await db.prepare(`INSERT INTO items (name, place_id, category, image_key, notes, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).bind(name, placeId, category, imageKey, notes, userId).run();
      const id = r.meta.last_row_id;
      for (const tid of tagIds) await db.prepare(`INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)`).bind(id, tid).run();
      const tags = await itemTags(db, id);
      let placeName = null;
      if (placeId) { const p = await db.prepare(`SELECT name FROM places WHERE id = ?`).bind(placeId).first(); placeName = p?.name; }
      await audit(db, userId, "item.create", "item", id, name, `Added item **${name}**`, { tags, place: placeName, notes });
      return json(await hydrateItem(db, await db.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first()));
    }

    if (parts[0] === "items" && parts[1] && method === "PUT") {
      const id = parseInt(parts[1], 10);
      const old = await db.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first();
      if (!old) return err("Not found", 404);
      const body = await request.json().catch(() => ({}));
      const name = (body.name || "").trim();
      if (!name) return err("Name is required");
      let tagIds = Array.isArray(body.tags) ? body.tags.map((x) => parseInt(x, 10)).filter(Boolean) : [];
      if (!tagIds.length) return err("At least one tag is required");
      tagIds = tagIds.slice(0, 3);
      const placeId = body.place_id != null && body.place_id !== "" ? parseInt(body.place_id, 10) : null;
      const notes = body.notes != null ? String(body.notes).slice(0, 300) : old.notes;
      let imageKey = old.image_key;
      if (Object.prototype.hasOwnProperty.call(body, "image_key")) imageKey = body.image_key || null;
      const oldTags = await itemTags(db, id);
      let oldPlaceName = null;
      if (old.place_id) { const p = await db.prepare(`SELECT name FROM places WHERE id = ?`).bind(old.place_id).first(); oldPlaceName = p?.name || null; }
      const firstTag = await db.prepare(`SELECT name FROM tags WHERE id = ?`).bind(tagIds[0]).first();
      const category = firstTag?.name || "Uncategorized";
      await db.prepare(`UPDATE items SET name=?, place_id=?, category=?, image_key=?, notes=?, user_id=?, updated_at=datetime('now') WHERE id=?`).bind(name, placeId, category, imageKey, notes, userId, id).run();
      await db.prepare(`DELETE FROM item_tags WHERE item_id = ?`).bind(id).run();
      for (const tid of tagIds) await db.prepare(`INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)`).bind(id, tid).run();
      const uncId = await ensureUncategorized(db, userId);
      const newTags = await itemTags(db, id);
      const hasReal = newTags.some((t) => (t || "").toLowerCase() !== "uncategorized");
      if (hasReal) await db.prepare(`DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?`).bind(id, uncId).run();
      let newPlaceName = null;
      if (placeId) { const p = await db.prepare(`SELECT name FROM places WHERE id = ?`).bind(placeId).first(); newPlaceName = p?.name || null; }
      const changes = [];
      if (old.name !== name) changes.push(`name **${old.name}** → **${name}**`);
      if ((old.notes || "") !== (notes || "")) changes.push(`note updated`);
      if ((oldPlaceName || "") !== (newPlaceName || "")) changes.push(`place **${oldPlaceName || "none"}** → **${newPlaceName || "none"}**`);
      const oldTagStr = oldTags.filter((t) => t.toLowerCase() !== "uncategorized").sort().join(", ");
      const newTagStr = newTags.filter((t) => t.toLowerCase() !== "uncategorized").sort().join(", ");
      if (oldTagStr !== newTagStr) changes.push(`tags **${oldTagStr || "none"}** → **${newTagStr || "none"}**`);
      if ((old.image_key || "") !== (imageKey || "")) changes.push(`photo updated`);
      const summary = changes.length ? `Updated **${name}**: ${changes.join("; ")}` : `Updated **${name}**`;
      await audit(db, userId, "item.update", "item", id, name, summary, { from: { name: old.name, place: oldPlaceName, tags: oldTags, notes: old.notes }, to: { name, place: newPlaceName, tags: newTags, notes } });
      return json(await hydrateItem(db, await db.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first()));
    }

    if (parts[0] === "items" && parts[1] && method === "DELETE") {
      const id = parseInt(parts[1], 10);
      const old = await db.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first();
      if (!old) return err("Not found", 404);
      if (old.image_key && images) { try { await images.delete(old.image_key); } catch (_) {} }
      await db.prepare(`DELETE FROM item_tags WHERE item_id = ?`).bind(id).run();
      await db.prepare(`DELETE FROM items WHERE id = ?`).bind(id).run();
      await audit(db, userId, "item.delete", "item", id, old.name, `Deleted item **${old.name}**`);
      return json({ ok: true });
    }

    if (parts[0] === "upload" && method === "POST") {
      if (!images) return err("Images binding missing", 500);
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return err("file required");
      const key = `${userId}/${crypto.randomUUID()}.jpg`;
      await images.put(key, file.stream(), { httpMetadata: { contentType: file.type || "image/jpeg" } });
      return json({ key, url: imageUrl(key) });
    }

    if (parts[0] === "audit" && method === "GET") {
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
      const offset = (page - 1) * limit;
      const countRow = await db.prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE user_id = ?`).bind(userId).first();
      const total = countRow?.c || 0;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const rows = await db.prepare(`SELECT * FROM audit_logs WHERE user_id = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?`).bind(userId, limit, offset).all();
      return json({ logs: rows.results || [], pagination: { page, limit, total, totalPages } });
    }

    return err("Not found", 404);
  } catch (e) {
    console.error(e);
    return err(e.message || "Server error", 500);
  }
}
