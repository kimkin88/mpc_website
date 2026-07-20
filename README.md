# MPC — Media Photography Company site

A redesigned one-page site with a built-in admin panel. No npm installs — just Node.js, Wasabi for media, and Supabase for content.

## Run it

```
node server.js
```

- **Site:** http://localhost:3000
- **Admin:** http://localhost:3000/admin — default password `mpc2026`

Change the password:

```
ADMIN_KEY=your-secret node server.js
```

## Updating content

Everything editable is stored in Supabase (`site_content` table): hero headline and video, about copy, process steps, portfolio projects, featured case, stats, brand rows, testimonials, contact details, footer links, and the accent colour.

Edit through the **admin panel**. Each save writes a backup row to `site_content_backups`, then updates the live payload. The public site reads from Supabase at startup and after each save.

### One-time Supabase setup

1. Open your Supabase project → **SQL Editor**
2. Run `supabase/schema.sql`
3. In **Project Settings → API**, copy:
   - Project URL → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`
4. Add those to `.env` and restart the server

On first boot with an empty table, the server seeds Supabase from the repo’s `content.json`.

## Wasabi media storage

All images and video are served from Wasabi — there is no local `media/` folder in the repo. The site keeps existing `/media/...` URLs; the server proxies those requests to your Wasabi bucket.

Add these to `.env`:

```env
REGION=eu-west-1
BUCKET_NAME=your-bucket-name
ACCESS_KEY=your-wasabi-access-key
SECRET_ACCESS_KEY=your-wasabi-secret-access-key
# Optional override:
# WASABI_ENDPOINT=https://s3.eu-west-1.wasabisys.com
```

The bucket should contain the same `media/` tree that used to live locally (including `media/_opt/manifest.json` for responsive WebP delivery).

## Media optimization

To regenerate optimized assets before uploading to Wasabi, use a temporary local `media/` folder and run:

```
npm run optimize-media
```

Requires ImageMagick (`magick`), `gif2webp`, and optionally `ffmpeg` for video. Upload the resulting `media/` tree to your Wasabi bucket when done.

## Files

| File | Purpose |
|---|---|
| `server.js` | Zero-dependency Node server + content API |
| `content.json` | Seed payload used only if Supabase is empty |
| `supabase/schema.sql` | Tables for live content + backups |
| `site/index.html` | The site (content injected at request time) |
| `site/admin.html` | Admin panel |

## Deploy

Works on any Node 18+ host. The repo includes configs for common platforms.

### 1. Set environment variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_KEY` | **Yes in production** | Admin panel password |
| `PORT` | No | Set automatically by most hosts |
| `NODE_ENV` | Recommended | Set to `production` |
| `SUPABASE_URL` | **Yes** | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Supabase service-role key (server only) |
| `REGION` | **Yes** | Wasabi region, for example `eu-west-1` |
| `BUCKET_NAME` | **Yes** | Wasabi bucket containing the `media/` tree |
| `ACCESS_KEY` | **Yes** | Wasabi access key |
| `SECRET_ACCESS_KEY` | **Yes** | Wasabi secret access key |
| `WASABI_ENDPOINT` | Optional | Override the default Wasabi S3 endpoint |
| `MEDIA_MODE` | Optional | Set to `redirect` to send `/media/*` to Wasabi with a signed URL (Vercel does this automatically) |

Copy `.env.example` to `.env` for local overrides (`.env` is gitignored).

### 2. Pick a host

**Render** (easiest — `render.yaml` included):

1. Push this repo to GitHub
2. [Render Dashboard](https://dashboard.render.com) → New → Blueprint → connect repo
3. Set `ADMIN_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` when prompted
4. Deploy

**Vercel** (`vercel.json` included):

1. Install the CLI: `npm i -g vercel` (or use the Vercel GitHub integration)
2. From this folder: `vercel` (preview) or `vercel --prod`
3. In the Vercel project → **Settings → Environment Variables**, add the same vars as above (`ADMIN_KEY`, `SUPABASE_*`, Wasabi keys, etc.)
4. Redeploy

On Vercel, `/media/*` is redirected to short-lived Wasabi presigned URLs (serverless cannot proxy large images/video). Local/`node server.js` still proxies by default unless you set `MEDIA_MODE=redirect`.

**Railway / Fly / VPS:**

```bash
npm start
# or: node server.js
```

Railway and Fly auto-detect `package.json`. A `Procfile` is included for Heroku-style hosts.

**VPS with PM2:**

```bash
ADMIN_KEY=your-secret pm2 start server.js --name mpc-website
```

Put nginx or Caddy in front for HTTPS and your domain.

### Health check

`GET /health` returns `{"ok":true}` — used by Render and useful for uptime monitors.

## Notes

- Media is served from Wasabi via `/media/...` URLs (proxy locally; redirect on Vercel).
- The site respects `prefers-reduced-motion` and falls back to a vertical gallery + native scrolling on touch devices.
