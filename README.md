# MyItem

Personal item organizer. Find where you put things in seconds.

**Live:** https://myitem-go3.pages.dev  
**Repo:** https://github.com/areppp06/myitem

Theme: IKEA yellow (`#FFDA1A`) + blue (`#0058A3`).  
Mobile-first, responsive (2 / 3 / 4 column grid).

---

## What it does

- Search items by name / place / notes
- Filter by **tags** (tags = categories)
- Store each item with: name, place, one or more tags, optional thumbnail photo
- Update location when you move something
- Manage places and tags from a simple Manage page

**Key rule:** Tags are mandatory. There is no separate Category field and no "Uncategorized" items. At least one tag is required when creating or updating an item.

---

## Tech stack

| Layer        | Technology                          |
|--------------|-------------------------------------|
| Frontend     | Vanilla HTML + CSS + JS (no build)  |
| Hosting      | Cloudflare Pages                    |
| API          | Cloudflare Pages Functions          |
| Database     | Cloudflare D1 (SQLite)              |
| Images       | Cloudflare R2 (thumbnails only)     |
| Image compress | Client-side (Canvas API) before upload |

No framework, no bundler, no Node runtime on the client. Pages Functions handle the API under `/api/*`.

---

## Project structure

```
myitem/
├── public/
│   ├── index.html      # Main app (search, grid, add/edit modal)
│   └── manage.html     # Manage places & tags
├── functions/
│   └── api/
│       └── [[path]].js # All API routes (catch-all)
├── schema.sql          # D1 tables + seed data
├── wrangler.toml       # Local + binding reference
└── README.md
```

---

## Data model (D1)

### Tables

**places**
- `id` INTEGER PK
- `name` TEXT UNIQUE
- `created_at` TEXT

**tags**
- `id` INTEGER PK
- `name` TEXT UNIQUE
- `created_at` TEXT

**items**
- `id` INTEGER PK
- `name` TEXT NOT NULL
- `place_id` INTEGER (FK → places, nullable)
- `category` TEXT  (legacy/fallback – set to first tag name on save)
- `image_key` TEXT (R2 object key)
- `notes` TEXT
- `created_at` TEXT
- `updated_at` TEXT

**item_tags** (many-to-many)
- `item_id` INTEGER
- `tag_id` INTEGER
- PRIMARY KEY (item_id, tag_id)

### Important behaviour

- Tags are the only categories. Filter chips on the main screen come from the `tags` table.
- On create/update the API requires at least one tag. It also writes the first tag name into `items.category` for simple display fallback.
- Images are compressed on the client (max ~500px, JPEG) then uploaded to R2. Only the thumbnail is stored.

---

## API reference

Base path: `/api`

| Method | Path              | Description |
|--------|-------------------|-------------|
| GET    | /items            | List items. Query: `search`, `tag`, `page`, `limit` |
| POST   | /items            | Create item. Body: `{ name, place_id?, tags: number[], image_key?, notes? }` – **tags required** |
| PUT    | /items/:id        | Update item. Same body rules – **tags required** |
| DELETE | /items/:id        | Delete item + its R2 image |
| GET    | /places           | List places |
| POST   | /places           | Create place `{ name }` |
| GET    | /tags             | List tags |
| POST   | /tags             | Create tag `{ name }` |
| GET    | /categories       | Returns `["All", ...tag names]` (used by the filter chips) |
| POST   | /upload           | Upload thumbnail. FormData with field `file` → returns `{ key, url }` |
| GET    | /images/:key      | Serve image from R2 |

Bindings expected by the Function:
- `DB` → D1 database (`myitem-db`)
- `IMAGES` → R2 bucket (`myitem-images`)

---

## Frontend behaviour

### Main screen (`index.html`)
- Sticky header with search
- Horizontal tag chips (default = All)
- Responsive card grid
- Card shows: thumbnail, name, place
- Click card → expands to show tags + last updated + Update button
- Pagination: 10 items per page
- Floating `+` button opens add/edit modal

### Add / Edit modal
- Photo (optional, client-side compressed)
- Name (required)
- Place (dropdown + “Add new place”)
- Tags (multi-select chips, **required**, + “Create new tag”)

### Manage page (`manage.html`)
- Simple lists for Places and Tags
- Add new ones
- Delete is currently a stub (not fully implemented)

---

## Bindings & deploy

Already configured on the live project:

- **D1** binding name: `DB` → database `myitem-db` (UUID: `6d578ae1-ff99-45fb-80b2-d0c486c8356f`)
- **R2** binding name: `IMAGES` → bucket `myitem-images`
- Build output directory: `public`
- Auto-deploy on every push to `main`

Local development:

```bash
npx wrangler pages dev public --d1=DB=myitem-db --r2=IMAGES=myitem-images
```

Update `wrangler.toml` with the real D1 UUID if you run commands locally.

---

## Notes for future AI agents

1. **Tags = categories.** Do not re-introduce a separate Category field unless the user explicitly asks. Filtering and chips use tags.
2. **Tags are mandatory.** Both frontend and API reject saves with zero tags.
3. **No emojis** in the UI. Use SVG icons only (user preference).
4. **Client-side image compression** is intentional for performance and R2 cost.
5. **No offline mode** (intentionally deferred).
6. **Manage delete** for places/tags is incomplete – only items have full delete + R2 cleanup.
7. The live domain is `myitem-go3.pages.dev`. GitHub → Pages connection is already live; any push to `main` triggers a rebuild.
8. Prefer keeping the stack simple: vanilla frontend + Pages Functions + D1 + R2. Avoid adding frameworks unless the user requests it.

---

## Seed data

On first schema run the following places and tags are inserted:

Places: Bedroom, Living Room, Kitchen, Office, Bag, Car, Storage  
Tags: Electronics, Documents, Clothes, Tools, Keys, Charger, Important

---

## License / ownership

Private personal project of the repository owner.
