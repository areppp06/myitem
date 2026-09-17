export async function onRequest(context) {
  const { request, env } = context;
  
  // Basic security, only allow POST and maybe a secret key
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const stmts = [
      "ALTER TABLE items ADD COLUMN user_id TEXT",
      "CREATE TABLE new_places (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, name))",
      "INSERT INTO new_places (id, name, created_at) SELECT id, name, created_at FROM places",
      "DROP TABLE places",
      "ALTER TABLE new_places RENAME TO places",
      "CREATE TABLE new_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, name))",
      "INSERT INTO new_tags (id, name, created_at) SELECT id, name, created_at FROM tags",
      "DROP TABLE tags",
      "ALTER TABLE new_tags RENAME TO tags"
    ];

    for (const sql of stmts) {
      await env.DB.prepare(sql).run();
    }

    return new Response("Migration successful!", { status: 200 });
  } catch (err) {
    return new Response("Migration failed: " + err.message, { status: 500 });
  }
}
