'use strict';
// session-store.js — minimal express-session store backed by better-sqlite3.
// Implements the Store interface: get / set / destroy / touch. Sessions table
// lives in the same app.sqlite database as users and jobs.

const { Store } = require('express-session');

class SQLiteSessionStore extends Store {
  constructor(db) {
    super();
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid    TEXT PRIMARY KEY,
        sess   TEXT NOT NULL,
        expire INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
    `);
    this.getStmt = db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare(
      `INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`
    );
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?');
    this.sweepStmt = db.prepare('DELETE FROM sessions WHERE expire <= ?');

    // Periodically purge expired sessions.
    this.sweepTimer = setInterval(() => {
      try { this.sweepStmt.run(Date.now()); } catch { /* ignore */ }
    }, 60 * 60 * 1000);
    this.sweepTimer.unref();
  }

  static cookieExpiry(sess, fallbackMs) {
    if (sess && sess.cookie && sess.cookie.expires) {
      return new Date(sess.cookie.expires).getTime();
    }
    return Date.now() + fallbackMs;
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
      if (!row) return cb(null, null);
      if (row.expire <= Date.now()) {
        this.destroyStmt.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const expire = SQLiteSessionStore.cookieExpiry(sess, 7 * 24 * 60 * 60 * 1000);
      this.setStmt.run(sid, JSON.stringify(sess), expire);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      const expire = SQLiteSessionStore.cookieExpiry(sess, 7 * 24 * 60 * 60 * 1000);
      this.touchStmt.run(expire, sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }
}

module.exports = { SQLiteSessionStore };
