// MyItem API - Cloudflare Pages Function
// Handles items, places, tags, image upload to R2 + D1

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = request.method;

  // CORS for local + production
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
      const { results } = await env.DB.prepare(
        "SELECT * FROM places ORDER BY name ASC"
      ).all();
      return json(results, corsHeaders);
    }

    if (path === "/places" && method === "POST") {
      const { name } = await request.json();
      if (!name || !name.trim()) return error("Name required", 400, corsHeaders);
      const result = await env.DB.prepare(
        "INSERT INTO places (name) VALUES (?) RETURNING *"
      )
        .bind(name.trim())
        .first();
      return json(result, corsHeaders, 201);
    }

    // ========== TAGS ==========
    if (path === "/tags" && method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM tags ORDER BY name ASC"
      ).all();
      return json(results, corsHeaders);
    }

    if (path === "/tags" && method === "POST") {
      const { name } = await request.json();
      if (!name || !name.trim()) return error("Name required", 400, corsHeaders);
      const result = await env.DB.prepare(
        "INSERT INTO tags (name) VALUES (?) RETURNING *"
      )
        .bind(name.trim())
        .first();
      return json(result, corsHeaders, 201);
    }

    // ========== ITEMS ==========
    // GET /api/items?search=&tag=&page=1&limit=10
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
      // Filter by tag name (tags are the categories)
      if (tag && tag !== "All") {
        query += ` AND EXISTS (
          SELECT 1 FROM item_tags it2
          JOIN tags t2 ON t2.id = it2.tag_id
          WHERE it2.item_id = i.id AND t2.name = ?
        )`;
        params.push(tag);
      }

      // Count total
      const countQuery = query.replace(
        /SELECT i\.\*, p\.name as place_name,[\s\S]*?FROM items i/,
        "SELECT COUNT(*) as total FROM items i"
      );
      const countResult = await env.DB.prepare(countQuery)
        .bind(...params)
        .first();
      const total = countResult?.total || 0;

      query += ` ORDER BY i.updated_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const { results } = await env.DB.prepare(query).bind(...params).all();

      // Add image URLs
      const items = results.map((item) => ({
        ...item,
        tags: item.tags ? item.tags.split(",") : [],
        image_url: item.image_key
          ? `/api/images/${item.image_key}`
          : null,
      }));

      return json(
        {
          items,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
        corsHeaders
      );
    }

    // POST /api/items  (create)
    if (path === "/items" && method === "POST") {
      const body = await request.json();
      const { name, place_id, tags = [], image_key, notes } = body;
      if (!name) return error("Name is required", 400, corsHeaders);
      if (!tags || tags.length === 0) {
        return error("At least one tag (category) is required", 400, corsHeaders);
      }

      // Use first tag name as category for simple display fallback
      const firstTag = await env.DB.prepare("SELECT name FROM tags WHERE id = ?")
        .bind(tags[0])
        .first();
      const categoryName = firstTag?.name || "General";

      const result = await env.DB.prepare(
        `INSERT INTO items (name, place_id, category, image_key, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now')) RETURNING *`
      )
        .bind(
          name.trim(),
          place_id || null,
          categoryName,
          image_key || null,
          notes || null
        )
        .first();

      // Attach tags
      for (const tagId of tags) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)"
        )
          .bind(result.id, tagId)
          .run();
      }

      return json(result, corsHeaders, 201);
    }

    // PUT /api/items/:id
    if (path.startsWith("/items/") && method === "PUT") {
      const id = path.split("/")[2];
      const body = await request.json();
      const { name, place_id, tags = [], image_key, notes } = body;

      if (!tags || tags.length === 0) {
        return error("At least one tag (category) is required", 400, corsHeaders);
      }

      const firstTag = await env.DB.prepare("SELECT name FROM tags WHERE id = ?")
        .bind(tags[0])
        .first();
      const categoryName = firstTag?.name || "General";

      await env.DB.prepare(
        `UPDATE items SET 
          name = ?, place_id = ?, category = ?, 
          image_key = COALESCE(?, image_key), notes = ?, 
          updated_at = datetime('now')
         WHERE id = ?`
      )
        .bind(
          name?.trim(),
          place_id || null,
          categoryName,
          image_key || null,
          notes || null,
          id
        )
        .run();

      // Reset tags
      await env.DB.prepare("DELETE FROM item_tags WHERE item_id = ?")
        .bind(id)
        .run();
      for (const tagId of tags) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)"
        )
          .bind(id, tagId)
          .run();
      }

      const updated = await env.DB.prepare(
        `SELECT i.*, p.name as place_name FROM items i 
         LEFT JOIN places p ON p.id = i.place_id WHERE i.id = ?`
      )
        .bind(id)
        .first();

      return json(updated, corsHeaders);
    }

    // DELETE /api/items/:id
    if (path.startsWith("/items/") && method === "DELETE") {
      const id = path.split("/")[2];
      // Optional: delete image from R2 too
      const item = await env.DB.prepare(
        "SELECT image_key FROM items WHERE id = ?"
      )
        .bind(id)
        .first();
      if (item?.image_key) {
        await env.IMAGES.delete(item.image_key);
      }
      await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id).run();
      return json({ success: true }, corsHeaders);
    }

    // ========== IMAGE UPLOAD ==========
    // POST /api/upload  (multipart form with "file")
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

    // GET /api/images/:key  (serve from R2)
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

    // ========== CATEGORIES (now powered by tags) ==========
    if (path === "/categories" && method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT name FROM tags ORDER BY name ASC"
      ).all();
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
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

function error(message, status = 400, extraHeaders = {}) {
  return json({ error: message }, extraHeaders, status);
}
