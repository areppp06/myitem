// MyItem API - Cloudflare Pages Function
// Handles items, places, tags, image upload to R2 + D1

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = request.method;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ========== PLACES ==========
    if (path === "/places" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM places ORDER BY name ASC").all();
      return json(results, corsHeaders);
    }

    if (path === "/places" && method === "POST") {
      const { name } = await request.json();
      if (!name || !name.trim()) return error("Name required", 400, corsHeaders);
      const clean = name.trim();
      const existing = await env.DB.prepare("SELECT id, name FROM places WHERE LOWER(name) = LOWER(?)").bind(clean).first();
      if (existing) return error(`Place "${existing.name}" already exists`, 409, corsHeaders);
      const result = await env.DB.prepare("INSERT INTO places (name) VALUES (?) RETURNING *").bind(clean).first();
      return json(result, corsHeaders, 201);
    }

    if (path.startsWith("/places/") && method === "PUT") {
      const id = path.split("/")[2];
      const { name } = await request.json();
      if (!name || !name.trim()) return error("Name required", 400, corsHeaders);
      const clean = name.trim();
      const existing = await env.DB.prepare("SELECT id, name FROM places WHERE LOWER(name) = LOWER(?) AND id != ?").bind(clean, id).first();
      if (existing) return error(`Place "${existing.name}" already exists`, 409, corsHeaders);
      await env.DB.prepare("UPDATE places SET name = ? WHERE id = ?").bind(clean, id).run();
      const updated = await env.DB.prepare("SELECT * FROM places WHERE id = ?").bind(id).first();
      return json(updated, corsHeaders);
    }

    if (path.startsWith("/places/") && method === "DELETE") {
      const id = path.split("/")[2];
      await env.DB.prepare("UPDATE items SET place_id = NULL WHERE place_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM places WHERE id = ?").bind(id).run();
      return json({ success: true }, corsHeaders);
    }

    // ========== TAGS ==========
    async function getUncategorizedId() {
      let row = await env.DB.prepare("SELECT id FROM tags WHERE LOWER(name) = 'uncategorized'").first();
      if (!row) {
        row = await env.DB.prepare("INSERT INTO tags (name) VALUES ('Uncategorized') RETURNING id").first();
      }
      return row.id;
    }

    if (path === "/tags" && method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM tags ORDER BY CASE WHEN LOWER(name) = 'uncategorized' THEN 1 ELSE 0 END, name ASC"
      ).all();
      return json(results, corsHeaders);
    }

    if (path === "/tags" && method === "POST") {
      const { name } = await request.json();
      if (!name || !name.trim()) return error("Name required", 400, corsHeaders);
      const clean = name.trim();
      if (clean.toLowerCase() === "uncategorized") {
        return error("Uncategorized is a system tag and cannot be created manually", 400, corsHeaders);
      }
      const existing = await env.DB.prepare("SELECT id, name FROM tags WHERE LOWER(name) = LOWER(?)").bind(clean).first();
      if (existing) return error(`Tag "${existing.name}" already exists`, 409, corsHeaders);
      const result = await env.DB.prepare("INSERT INTO tags (name) VALUES (?) RETURNING *").bind(clean).first();
      return json(result, corsHeaders, 201);
    }

    if (path.startsWith("/tags/") && method === "PUT") {
      const id = path.split("/")[2];
      const tag = await env.DB.prepare("SELECT * FROM tags WHERE id = ?").bind(id).first();
      if (!tag) return error("Tag not found", 404, corsHeaders);
      if (tag.name.toLowerCase() === "uncategorized") {
        return error("Uncategorized cannot be renamed", 400, corsHeaders);
      }
      const { name } = await request.json();
      if (!name || !name.trim()) return error("Name required", 400, corsHeaders);
      const clean = name.trim();
      if (clean.toLowerCase() === "uncategorized") {
        return error("Cannot rename to Uncategorized", 400, corsHeaders);
      }
      const existing = await env.DB.prepare("SELECT id, name FROM tags WHERE LOWER(name) = LOWER(?) AND id != ?").bind(clean, id).first();
      if (existing) return error(`Tag "${existing.name}" already exists`, 409, corsHeaders);
      await env.DB.prepare("UPDATE tags SET name = ? WHERE id = ?").bind(clean, id).run();
      await env.DB.prepare("UPDATE items SET category = ? WHERE category = ?").bind(clean, tag.name).run();
      const updated = await env.DB.prepare("SELECT * FROM tags WHERE id = ?").bind(id).first();
      return json(updated, corsHeaders);
    }

    if (path.startsWith("/tags/") && method === "DELETE") {
      const id = path.split("/")[2];
      const tag = await env.DB.prepare("SELECT * FROM tags WHERE id = ?").bind(id).first();
      if (!tag) return error("Tag not found", 404, corsHeaders);
      if (tag.name.toLowerCase() === "uncategorized") {
        return error("Uncategorized cannot be deleted", 400, corsHeaders);
      }
      const uncatId = await getUncategorizedId();
      const { results: linked } = await env.DB.prepare("SELECT item_id FROM item_tags WHERE tag_id = ?").bind(id).all();
      for (const row of linked) {
        const itemId = row.item_id;
        const cnt = await env.DB.prepare("SELECT COUNT(*) as c FROM item_tags WHERE item_id = ?").bind(itemId).first();
        await env.DB.prepare("DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?").bind(itemId, id).run();
        if (cnt.c <= 1) {
          await env.DB.prepare("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)").bind(itemId, uncatId).run();
          await env.DB.prepare("UPDATE items SET category = 'Uncategorized', updated_at = datetime('now') WHERE id = ?").bind(itemId).run();
        }
      }
      await env.DB.prepare("DELETE FROM tags WHERE id = ?").bind(id).run();
      return json({ success: true }, corsHeaders);
    }

    // ========== ITEMS ==========
    if (path === "/items" && method === "GET") {
      const search = url.searchParams.get("search") || "";
      const tag = url.searchParams.get("tag") || "";
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
      const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "10"));
      const offset = (page - 1) * limit;

      let query = `
        SELECT i.*, p.name as place_name,
          (SELECT GROUP_CONCAT(t.name) FROM item_tags it
           JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id) as tags
        FROM items i
        LEFT JOIN places p ON p.id = i.place_id
        WHERE 1=1
      `;
      const params = [];

      if (search) {
        query += ` AND (i.name LIKE ? OR i.notes LIKE ? OR p.name LIKE ?)`;
        const s = `%${search}%`;
        params.push(s, s, s);
      }
      if (tag && tag !== "All") {
        query += ` AND EXISTS (
          SELECT 1 FROM item_tags it2
          JOIN tags t2 ON t2.id = it2.tag_id
          WHERE it2.item_id = i.id AND t2.name = ?
        )`;
        params.push(tag);
      }

      const countQuery = query.replace(
        /SELECT i\.\*, p\.name as place_name,[\s\S]*?FROM items i/,
        "SELECT COUNT(*) as total FROM items i"
      );
      const countResult = await env.DB.prepare(countQuery).bind(...params).first();
      const total = countResult?.total || 0;

      query += ` ORDER BY i.updated_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const { results } = await env.DB.prepare(query).bind(...params).all();

      const items = results.map((item) => ({
        ...item,
        tags: item.tags ? item.tags.split(",") : [],
        image_url: item.image_key ? `/api/images/${item.image_key}` : null,
      }));

      return json({
        items,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      }, corsHeaders);
    }

    if (path === "/items" && method === "POST") {
      const body = await request.json();
      const { name, place_id, tags = [], image_key, notes } = body;
      if (!name) return error("Name is required", 400, corsHeaders);
      if (!tags || tags.length === 0) {
        return error("At least one tag (category) is required", 400, corsHeaders);
      }

      const uncat = await env.DB.prepare("SELECT id FROM tags WHERE LOWER(name) = 'uncategorized'").first();
      const uncatId = uncat?.id;
      let realTags = tags.filter((id) => String(id) !== String(uncatId));
      if (realTags.length === 0) {
        return error("At least one tag (category) is required", 400, corsHeaders);
      }

      const firstTag = await env.DB.prepare("SELECT name FROM tags WHERE id = ?").bind(realTags[0]).first();
      const categoryName = firstTag?.name || "General";

      const result = await env.DB.prepare(
        `INSERT INTO items (name, place_id, category, image_key, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now')) RETURNING *`
      ).bind(name.trim(), place_id || null, categoryName, image_key || null, notes || null).first();

      for (const tagId of realTags) {
        await env.DB.prepare("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)").bind(result.id, tagId).run();
      }

      return json(result, corsHeaders, 201);
    }

    if (path.startsWith("/items/") && method === "PUT") {
      const id = path.split("/")[2];
      const body = await request.json();
      const { name, place_id, tags = [], image_key, notes } = body;

      if (!tags || tags.length === 0) {
        return error("At least one tag (category) is required", 400, corsHeaders);
      }

      const uncat = await env.DB.prepare("SELECT id FROM tags WHERE LOWER(name) = 'uncategorized'").first();
      const uncatId = uncat?.id;
      let realTags = tags.filter((tid) => String(tid) !== String(uncatId));
      if (realTags.length === 0) {
        return error("At least one tag (category) is required", 400, corsHeaders);
      }

      const firstTag = await env.DB.prepare("SELECT name FROM tags WHERE id = ?").bind(realTags[0]).first();
      const categoryName = firstTag?.name || "General";

      await env.DB.prepare(
        `UPDATE items SET
          name = ?, place_id = ?, category = ?,
          image_key = COALESCE(?, image_key), notes = ?,
          updated_at = datetime('now')
         WHERE id = ?`
      ).bind(name?.trim(), place_id || null, categoryName, image_key || null, notes || null, id).run();

      await env.DB.prepare("DELETE FROM item_tags WHERE item_id = ?").bind(id).run();
      for (const tagId of realTags) {
        await env.DB.prepare("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)").bind(id, tagId).run();
      }

      const updated = await env.DB.prepare(
        `SELECT i.*, p.name as place_name FROM items i
         LEFT JOIN places p ON p.id = i.place_id WHERE i.id = ?`
      ).bind(id).first();

      return json(updated, corsHeaders);
    }

    if (path.startsWith("/items/") && method === "DELETE") {
      const id = path.split("/")[2];
      const item = await env.DB.prepare("SELECT image_key FROM items WHERE id = ?").bind(id).first();
      if (item?.image_key) {
        await env.IMAGES.delete(item.image_key);
      }
      await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id).run();
      return json({ success: true }, corsHeaders);
    }

    if (path === "/upload" && method === "POST") {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file) return error("No file", 400, corsHeaders);
      const key = `${crypto.randomUUID()}.jpg`;
      await env.IMAGES.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || "image/jpeg" },
      });
      return json({ key, url: `/api/images/${key}` }, corsHeaders, 201);
    }

    if (path.startsWith("/images/") && method === "GET") {
      const key = path.replace("/images/", "");
      const object = await env.IMAGES.get(key);
      if (!object) return error("Image not found", 404, corsHeaders);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Cache-Control", "public, max-age=31536000");
      return new Response(object.body, { headers });
    }

    if (path === "/categories" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT name FROM tags ORDER BY name ASC").all();
      const cats = results.map((r) => r.name);
      return json(["All", ...cats], corsHeaders);
    }

    return error("Not found", 404, corsHeaders);
  } catch (err) {
    console.error(err);
    return error(err.message || "Server error", 500, corsHeaders);
  }
}

function json(data, extraHeaders = {}, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function error(message, status = 400, extraHeaders = {}) {
  return json({ error: message }, extraHeaders, status);
}
