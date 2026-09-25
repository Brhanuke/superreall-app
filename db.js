'use strict';
// db.js — SQLite storage layer built on better-sqlite3 (synchronous, embedded).
// One database file holds users and video jobs. Session cookies are stored in a
// separate sessions file managed by connect-sqlite3 (see server.js).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function initDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'app.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompt          TEXT NOT NULL,
      format          TEXT NOT NULL CHECK (format IN ('9:16', '1:1', '16:9')),
      ref_image_path  TEXT,                       -- filename inside UPLOADS_DIR (optional)
      ref_image_mime  TEXT,                       -- e.g. image/png (optional)
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'done', 'failed')),
      error           TEXT,                       -- failure reason when status = 'failed'
      video_filename  TEXT,                       -- filename inside MEDIA_DIR when done
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_user   ON jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  `);

  return db;
}

module.exports = { initDb };
