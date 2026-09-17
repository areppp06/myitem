# 📦 MyItem

**Personal item organizer** – find your stuff in seconds.  
IKEA yellow + blue theme. Built for Cloudflare Pages + Workers + D1 + R2.

Mobile-first, desktop friendly, client-side image compression for thumbnails.

## Features

- Sticky search bar
- Category chips (All by default)
- Responsive grid (2 / 3 / 4 columns)
- Thumbnail + name + place on cards
- Expand card → tags + last updated + Update button
- Pagination (10 items per page)
- Floating + button → modal form
- Client-side image compression before upload to R2
- Add places & tags on the fly
- Simple Manage page for places & tags

## Tech Stack

- **Frontend**: Vanilla HTML / CSS / JS (no build step)
- **Backend**: Cloudflare Pages Functions
- **Database**: Cloudflare D1
- **Images**: Cloudflare R2 (thumbnails only)

## Quick Deploy (you do this part)

I pushed the full code to your GitHub. Now connect it to your Cloudflare account:

### 1. Create D1 database
1. Go to Cloudflare Dashboard → **Workers & Pages** → **D1**
2. Create database named `myitem-db`
3. Copy the **Database ID**
4. Run the schema:
   ```bash
   npx wrangler d1 execute myitem-db --file=./schema.sql
   ```
   (or use the dashboard SQL editor and paste `schema.sql`)

### 2. Create R2 bucket
1. Cloudflare Dashboard → **R2**
2. Create bucket named `myitem-images`
3. (Optional) Enable public access if you want direct URLs later – currently we serve via the Function)

### 3. Deploy to Cloudflare Pages
1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Select the `myitem` repo
3. Build settings:
   - Framework preset: **None**
   - Build command: (leave empty)
   - Build output directory: `public`
4. Add environment variables / bindings:
   - **D1**: binding name `DB` → select `myitem-db`
   - **R2**: binding name `IMAGES` → select `myitem-images`
5. Deploy!

### 4. Update wrangler.toml (optional, for local)
Replace `REPLACE_WITH_YOUR_D1_ID` with your real D1 ID.

## Local Development

```bash
npm install -g wrangler
wrangler pages dev public --d1=DB=myitem-db --r2=IMAGES=myitem-images
```

## Project Structure

```
myitem/
├── public/
│   ├── index.html      # Main app (search + grid + modal)
│   └── manage.html     # Places & Tags manager
├── functions/
│   └── api/
│       └── [[path]].js # All API routes
├── schema.sql          # D1 tables + seed data
├── wrangler.toml
└── README.md
```

## API Endpoints

| Method | Path              | Description                  |
|--------|-------------------|------------------------------|
| GET    | /api/items        | List items (search, page, category) |
| POST   | /api/items        | Create item                  |
| PUT    | /api/items/:id    | Update item                  |
| DELETE | /api/items/:id    | Delete item (+ R2 image)     |
| GET    | /api/places       | List places                  |
| POST   | /api/places       | Create place                 |
| GET    | /api/tags         | List tags                    |
| POST   | /api/tags         | Create tag                   |
| GET    | /api/categories   | Distinct categories          |
| POST   | /api/upload       | Upload thumbnail to R2       |
| GET    | /api/images/:key  | Serve image from R2          |

---

Made for you. Keep it simple, keep it fast.  
If anything breaks after deploy, just tell me the error and we’ll fix it in 30 seconds.
