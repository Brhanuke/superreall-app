'use strict';
// server.js — Prompt to Video: private AI video generation for content creators.
// Express + Postgres (DATABASE_URL) or local SQLite fallback. Serves the
// frontend from public/, exposes a JSON API under /api, and runs an in-process
// background worker that turns queued prompts into mp4 files via the
// configured video provider (mock | fal).

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const { initDb } = require('./db');
const { DbSessionStore } = require('./session-store');
const { authRoutes, requireAuth } = require('./routes/auth');
const { jobsRoutes, mediaRoutes } = require('./routes/jobs');
const { startWorker } = require('./worker');
const { loadProvider } = require('./providers');

// ---- config ---------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || './media');
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || './uploads');

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change-me-to-a-long-random-string') {
  console.error('FATAL: set a real SESSION_SECRET in .env (see .env.example).');
  process.exit(1);
}

for (const dir of [DATA_DIR, MEDIA_DIR, UPLOADS_DIR]) fs.mkdirSync(dir, { recursive: true });

async function main() {
  const db = await initDb(DATA_DIR);
  const provider = loadProvider();
  console.log(`[init] video provider: ${provider.name}`);

  // ---- app ----------------------------------------------------------------
  const app = express();
  app.set('trust proxy', 1); // safe behind a reverse proxy; harmless locally

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use(
    session({
      store: new DbSessionStore(db),
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      name: 'ptv.sid',
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE === '1',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    })
  );

  // Brute-force protection on the auth endpoints.
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
  app.use('/api/signup', authLimiter);
  app.use('/api/login', authLimiter);

  app.use('/api', authRoutes(db));                       // signup/login/logout/me (public)
  app.use('/api/jobs', requireAuth, jobsRoutes(db, { mediaDir: MEDIA_DIR, uploadsDir: UPLOADS_DIR }));
  app.use('/api', requireAuth, mediaRoutes(db, { mediaDir: MEDIA_DIR, uploadsDir: UPLOADS_DIR }));

  // Frontend (no build step — plain HTML/CSS/JS).
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  // Multer / validation errors → clean JSON instead of an HTML stack trace.
  app.use((err, _req, res, _next) => {
    console.error('[error]', err.message);
    res.status(400).json({ error: err.message || 'Bad request' });
  });

  // ---- worker + boot ------------------------------------------------------
  const worker = startWorker(db, provider, { mediaDir: MEDIA_DIR, uploadsDir: UPLOADS_DIR });

  const server = app.listen(PORT, () => {
    console.log(`[init] Prompt to Video listening on http://localhost:${PORT}`);
  });

  function shutdown() {
    console.log('\n[init] shutting down…');
    worker.stop();
    server.close(() => db.close().catch(() => {}));
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('FATAL: failed to start:', err.message || err);
  process.exit(1);
});
