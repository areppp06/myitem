
async function verifyGoogleToken(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.split(" ")[1];
  
  const cache = await caches.open("google-auth");
  let cached = await cache.match(new Request("https://auth/" + token));
  if (cached) return await cached.json();
  
  const verifyRes = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + token);
  if (!verifyRes.ok) return null;
  const payload = await verifyRes.json();
  if (!payload.sub) return null;
  
  const userData = { user_id: payload.sub, email: payload.email, picture: payload.picture };
  await cache.put(new Request("https://auth/" + token), new Response(JSON.stringify(userData), {
    headers: { "Cache-Control": "max-age=3600" }
  }));
  return userData;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace("/api", "");
  const method = request.method;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Public endpoints
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

  // Require Auth for all other endpoints
  const user = await verifyGoogleToken(request, env);
  if (!user) {
    return error("Unauthorized. Please sign in with Google.", 401, corsHeaders);
  }
  const uid = user.user_id;

  try {
    if (path === "/places" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM places WHERE user_id = ? ORDER BY name ASC").bind(uid).all();
      return json(results, corsHeaders);
    }
    if (path === "/places" && method === "POST") {
      const { name } = await request.json();
      if (!name) return error("Name required", 400, corsHeaders);
      const res = await env.DB.prepare("INSERT INTO places (name, user_id) VALUES (?, ?) RETURNING *").bind(name.trim(), uid).first();
      return json(res, corsHeaders, 201);
    }

    if (path === "/tags" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM tags WHERE user_id = ? ORDER BY name ASC").bind(uid).all();
      return json(results, corsHeaders);
    }
    if (path === "/tags" && method === "POST") {
      const { name } = await request.json();
      if (!name) return error("Name required", 400, corsHeaders);
      const res = await env.DB.prepare("INSERT INTO tags (name, user_id) VALUES (?, ?) RETURNING *").bind(name.trim(), uid).first();
      return json(res, corsHeaders, 201);
    }
    if (path.startsWith("/places/") && method === "PUT") {
      const id = path.split("/")[2];
      const { name } = await request.json();
      if (!name) return error("Name required", 400, corsHeaders);
      await env.DB.prepare("UPDATE places SET name = ? WHERE id = ? AND user_id = ?").bind(name.trim(), id, uid).run();
      return json({ success: true }, corsHeaders);
    }
    if (path.startsWith("/places/") && method === "DELETE") {
      const id = path.split("/")[2];
      await env.DB.prepare("UPDATE items SET place_id = NULL, updated_at = datetime('now') WHERE place_id = ? AND user_id = ?").bind(id, uid).run();
      await env.DB.prepare("DELETE FROM places WHERE id = ? AND user_id = ?").bind(id, uid).run();
      return json({ success: true }, corsHeaders);
    }

    if (path.startsWith("/tags/") && method === "PUT") {
      const id = path.split("/")[2];
      const { name } = await request.json();
      if (!name) return error("Name required", 400, corsHeaders);
      const oldTag = await env.DB.prepare("SELECT name FROM tags WHERE id = ? AND user_id = ?").bind(id, uid).first();
      await env.DB.prepare("UPDATE tags SET name = ? WHERE id = ? AND user_id = ?").bind(name.trim(), id, uid).run();
      if (oldTag) {
        await env.DB.prepare("UPDATE items SET category = ?, updated_at = datetime('now') WHERE category = ? AND user_id = ?").bind(name.trim(), oldTag.name, uid).run();
      }
      return json({ success: true }, corsHeaders);
    }
    if (path.startsWith("/tags/") && method === "DELETE") {
      const id = path.split("/")[2];
      
      const uncat = await env.DB.prepare("SELECT id FROM tags WHERE LOWER(name) = 'uncategorized' AND user_id = ?").bind(uid).first();
      let uncatId = uncat?.id;
      if (!uncatId) {
         const res = await env.DB.prepare("INSERT INTO tags (name, user_id) VALUES ('Uncategorized', ?) RETURNING id").bind(uid).first();
         uncatId = res.id;
      }
      
      const { results: linked } = await env.DB.prepare("SELECT item_id FROM item_tags WHERE tag_id = ? AND item_id IN (SELECT id FROM items WHERE user_id = ?)").bind(id, uid).all();
      for (const row of linked) {
        const itemId = row.item_id;
        const cnt = await env.DB.prepare("SELECT COUNT(*) as c FROM item_tags WHERE item_id = ?").bind(itemId).first();
        await env.DB.prepare("DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?").bind(itemId, id).run();
        if (cnt.c <= 1) {
          await env.DB.prepare("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)").bind(itemId, uncatId).run();
          await env.DB.prepare("UPDATE items SET category = 'Uncategorized', updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(itemId, uid).run();
        }
      }
      await env.DB.prepare("DELETE FROM tags WHERE id = ? AND user_id = ?").bind(id, uid).run();
      return json({ success: true }, corsHeaders);
    }

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
        WHERE i.user_id = ?
      `;
      const params = [uid];

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
      if (!tags || tags.length === 0) return error("At least one tag is required", 400, corsHeaders);

      const firstTag = await env.DB.prepare("SELECT name FROM tags WHERE id = ? AND user_id = ?").bind(tags[0], uid).first();
      const categoryName = firstTag?.name || "Uncategorized";

      const result = await env.DB.prepare(
        `INSERT INTO items (name, place_id, category, image_key, notes, updated_at, user_id)
         VALUES (?, ?, ?, ?, ?, datetime('now'), ?) RETURNING *`
      ).bind(name.trim(), place_id || null, categoryName, image_key || null, notes || null, uid).first();

      for (const tagId of tags) {
        await env.DB.prepare("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)").bind(result.id, tagId).run();
      }
      return json(result, corsHeaders, 201);
    }

    if (path.startsWith("/items/") && method === "PUT") {
      const id = path.split("/")[2];
      const body = await request.json();
      const { name, place_id, tags = [], image_key, notes } = body;
      if (!tags || tags.length === 0) return error("At least one tag is required", 400, corsHeaders);

      const firstTag = await env.DB.prepare("SELECT name FROM tags WHERE id = ? AND user_id = ?").bind(tags[0], uid).first();
      const categoryName = firstTag?.name || "Uncategorized";

      await env.DB.prepare(
        `UPDATE items SET
          name = ?, place_id = ?, category = ?,
          image_key = COALESCE(?, image_key), notes = ?,
          updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
      ).bind(name?.trim(), place_id || null, categoryName, image_key || null, notes || null, id, uid).run();

      await env.DB.prepare("DELETE FROM item_tags WHERE item_id = ?").bind(id).run();
      for (const tagId of tags) {
        await env.DB.prepare("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)").bind(id, tagId).run();
      }
      const updated = await env.DB.prepare(
        `SELECT i.*, p.name as place_name FROM items i
         LEFT JOIN places p ON p.id = i.place_id WHERE i.id = ? AND i.user_id = ?`
      ).bind(id, uid).first();
      return json(updated, corsHeaders);
    }

    if (path.startsWith("/items/") && method === "DELETE") {
      const id = path.split("/")[2];
      const item = await env.DB.prepare("SELECT image_key FROM items WHERE id = ? AND user_id = ?").bind(id, uid).first();
      if (!item) return error("Not found", 404, corsHeaders);
      if (item.image_key) {
        await env.IMAGES.delete(item.image_key);
      }
      await env.DB.prepare("DELETE FROM items WHERE id = ? AND user_id = ?").bind(id, uid).run();
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

    if (path === "/categories" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT name FROM tags WHERE user_id = ? ORDER BY name ASC").bind(uid).all();
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
