# Prompt to Video

A private prompt-to-video web app for content creators. Sign in, type a prompt,
pick a format — **vertical 9:16** (Shorts/Reels/TikTok), **square 1:1**, or
**landscape 16:9** (YouTube) — optionally attach a reference image, and the app
queues the job, generates the video in the background, and keeps a per-user
gallery with playback, retry, and delete.

**Stack:** Node.js 20+, Express, SQLite (`better-sqlite3`), `bcryptjs` password
hashing, `express-session` with a persistent SQLite session store, `multer` for
uploads. Frontend is plain HTML/CSS/JS in `public/` — no build step, no
TypeScript.

## Quickstart

```bash
cd prompt-to-video-source
npm install
cp .env.example .env
# edit .env: set SESSION_SECRET to a long random string
npm start
# open http://localhost:3000
```

Create an account in the browser, submit a prompt, and watch the queue turn it
into a video. The default `mock` provider simulates generation locally (a few
seconds) and writes a small placeholder mp4 — no network or API key needed.

### Switching to real AI video (fal.ai)

1. Get an API key at [fal.ai](https://fal.ai) and add it to `.env`:
   ```bash
   PROVIDER=fal
   FAL_API_KEY=your-key-here
   ```
2. Check [fal.ai/models](https://fal.ai/models) for a current text-to-video
   model slug and set `FAL_MODEL` accordingly (slugs change over time; the
   default in `.env.example` may be outdated).
3. Restart: `npm start`.

Image-to-video with fal.ai additionally needs `FAL_IMAGE_MODEL` (an
image-to-video model slug) and `PUBLIC_BASE_URL` (the public URL of this app,
so fal.ai can download the reference image through `/api/refimage/:id`).

### Docker

```bash
docker build -t prompt-to-video .
docker run -p 3000:3000 --env-file .env \
  -v ptv-data:/app/data -v ptv-media:/app/media -v ptv-uploads:/app/uploads \
  prompt-to-video
```

## Project structure

```
server.js            Express app: sessions, API routes, static frontend, worker boot
db.js                SQLite schema (users, jobs)
worker.js            Background job processor (polls pending jobs every 2s)
routes/auth.js       POST /api/signup, /api/login, /api/logout, GET /api/me
routes/jobs.js       POST/GET /api/jobs, GET /api/jobs/:id,
                     POST /api/jobs/:id/retry, DELETE /api/jobs/:id,
                     GET /api/media/:id (video), GET /api/refimage/:id
providers/
  index.js           Selects provider from PROVIDER env var
  mock.js            Local dev provider: writes a bundled placeholder mp4
  fal.js             Real provider: fal.ai queue API, aspect-ratio aware
public/              Frontend: index.html, styles.css, app.js (no build step)
```

## API reference

| Method | Path                  | Auth | Description                              |
|--------|-----------------------|------|------------------------------------------|
| POST   | `/api/signup`         | no   | `{email, password}` → creates account    |
| POST   | `/api/login`          | no   | `{email, password}` → session cookie     |
| POST   | `/api/logout`         | yes  | destroys session                          |
| GET    | `/api/me`             | yes  | current user                              |
| POST   | `/api/jobs`           | yes  | multipart: `prompt`, `format`, `image?`   |
| GET    | `/api/jobs`           | yes  | own jobs, newest first                    |
| GET    | `/api/jobs/:id`       | yes  | single own job                            |
| POST   | `/api/jobs/:id/retry` | yes  | re-queue a failed job                     |
| DELETE | `/api/jobs/:id`       | yes  | delete job + its files                    |
| GET    | `/api/media/:id`      | yes  | stream the finished mp4 (owner only)      |
| GET    | `/api/refimage/:id`   | yes  | reference image (owner only)              |

All `/api/jobs` and media endpoints return `401` without a session and `404`
for jobs belonging to another user.

## Security notes

- Passwords hashed with bcrypt (cost 10); sessions in `httpOnly`, `SameSite=lax` cookies.
- Every job/media query is scoped by `user_id`; filenames are `basename()`-sanitized.
- Uploads limited to 8 MB images (jpeg/png/webp/gif); auth endpoints rate-limited.
- `SESSION_SECRET` must be set — the server refuses to boot without a real one.
- Set `COOKIE_SECURE=1` when serving over HTTPS.

## Known limitations

- The in-process worker handles one job at a time; for heavy use, run multiple
  instances against separate DBs or replace `worker.js` with an external queue.
- `mock` videos are a static placeholder, not AI output — it's for local dev.
- fal.ai model slugs change; keep `FAL_MODEL` current.
- No email verification / password reset (add before any public launch).

## Troubleshooting

**`npm install` hangs on `better-sqlite3`:** its installer first tries to
download a prebuilt binary, which can stall on networks with an egress proxy.
Workaround — install without scripts, then compile locally (needs
`python3`, `make`, `g++`, and Node headers):

```bash
npm install --ignore-scripts
cd node_modules/better-sqlite3
../.bin/node-gyp rebuild --release   # add --nodedir=<headers> if it can't find node headers
```
