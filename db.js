'use strict';
// db.js — storage layer with two backends:
//   - Postgres (via `pg`) when DATABASE_URL is set. This is the production
//     path: Render's free tier wipes the local filesystem on every restart,
//     so users, jobs and login sessions must live in an external database.
//   - SQLite (via better-sqlite3) otherwise, for local development.
//
// Both backends expose the same tiny async interface. Always use `?`
// placeholders — they are rewritten to $1, $2, … for Postgres:
//   db.get(sql, params) -> Promise<row | undefined>
//   db.all(sql, params) -> Promise<row[]>
//   db.run(sql, params) -> Promise<{ lastInsertRowid, changes }>
//   db.close()          -> Promise<void>

const path = require('path');
const fs = require('fs');

const SQLITE_DDL = `
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
    ref_image_path  TEXT,
    ref_image_mime  TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    error           TEXT,
    video_filename  TEXT,
    fal_request_id  TEXT,                       -- resume polling this fal.ai request after a timeout
    fal_status_url  TEXT,
    fal_response_url TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_user   ON jobs(user_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

  CREATE TABLE IF NOT EXISTS sessions (
    sid    TEXT PRIMARY KEY,
    sess   TEXT NOT NULL,
    expire INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
`;

const PG_DDL = `
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prompt          TEXT NOT NULL,
    format          TEXT NOT NULL CHECK (format IN ('9:16', '1:1', '16:9')),
    ref_image_path  TEXT,
    ref_image_mime  TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    error           TEXT,
    video_filename  TEXT,
    fal_request_id  TEXT,
    fal_status_url  TEXT,
    fal_response_url TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_user   ON jobs(user_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

  CREATE TABLE IF NOT EXISTS sessions (
    sid    TEXT PRIMARY KEY,
    sess   TEXT NOT NULL,
    expire BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
`;

// Rewrite ? placeholders to $1, $2, … — skipping ? inside 'string literals'.
function pgPlaceholders(sql) {
  let out = '';
  let n = 0;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inStr && sql[i + 1] === "'") { out += "''"; i++; continue; } // escaped ''
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (ch === '?' && !inStr) { n += 1; out += '$' + n; continue; }
    out += ch;
  }
  return out;
}

// SQLite-isms used by this codebase → Postgres equivalents.
const pgSql = (sql) => pgPlaceholders(sql).replace(/datetime\('now'\)/g, 'now()');

async function initPostgres() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Neon / Supabase / Render PG all need TLS
    max: 5,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err) => console.error('[db] postgres pool error:', err.message));
  await pool.query('SELECT 1'); // fail fast if unreachable / bad string
  await pool.query(PG_DDL);
  console.log('[db] using Postgres (DATABASE_URL)');
  return {
    kind: 'pg',
    get: async (sql, params = []) => (await pool.query(pgSql(sql), params)).rows[0],
    all: async (sql, params = []) => (await pool.query(pgSql(sql), params)).rows,
    run: async (sql, params = []) => {
      // Callers that need the new row's id add an explicit `RETURNING id`
      // to their INSERT (works on both Postgres and SQLite); read it back here.
      const res = await pool.query(pgSql(sql), params);
      const row = res.rows[0];
      return {
        lastInsertRowid: row && row.id !== undefined ? Number(row.id) : undefined,
        changes: res.rowCount,
      };
    },
    close: () => pool.end(),
  };
}

function initSqlite(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const Database = require('better-sqlite3');
  const sdb = new Database(path.join(dataDir, 'app.sqlite'));
  sdb.pragma('journal_mode = WAL');
  sdb.pragma('foreign_keys = ON');
  sdb.exec(SQLITE_DDL);
  console.log('[db] using local SQLite');
  return {
    kind: 'sqlite',
    get: async (sql, params = []) => sdb.prepare(sql).get(...params),
    all: async (sql, params = []) => sdb.prepare(sql).all(...params),
    run: async (sql, params = []) => {
      const info = sdb.prepare(sql).run(...params);
      return { lastInsertRowid: Number(info.lastInsertRowid), changes: info.changes };
    },
    close: async () => sdb.close(),
  };
}

async function initDb(dataDir) {
  if (process.env.DATABASE_URL) return initPostgres();
  return initSqlite(dataDir);
}

module.exports = { initDb };
