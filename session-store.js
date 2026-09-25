'use strict';
// session-store.js — express-session store backed by the app's db wrapper
// (Postgres in production, SQLite locally). Because sessions live in the
// external database, logins survive Render restarts and redeploys.

const { Store } = require('express-session');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

class DbSessionStore extends Store {
  constructor(db) {
    super();
    this.db = db;

    // Periodically purge expired sessions.
    this.sweepTimer = setInterval(() => {
      this.db.run('DELETE FROM sessions WHERE expire <= ?', [Date.now()]).catch(() => {});
    }, 60 * 60 * 1000);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  static cookieExpiry(sess) {
    if (sess && sess.cookie && sess.cookie.expires) {
      return new Date(sess.cookie.expires).getTime();
    }
    return Date.now() + WEEK_MS;
  }

  get(sid, cb) {
    this.db.get('SELECT sess, expire FROM sessions WHERE sid = ?', [sid]).then(
      (row) => {
        if (!row || Number(row.expire) <= Date.now()) {
          if (row) this.db.run('DELETE FROM sessions WHERE sid = ?', [sid]).catch(() => {});
          cb(null, null);
          return;
        }
        let sess;
        try {
          sess = JSON.parse(row.sess);
        } catch (e) {
          cb(e);
          return;
        }
        cb(null, sess);
      },
      cb
    );
  }

  set(sid, sess, cb) {
    const expire = DbSessionStore.cookieExpiry(sess);
    this.db
      .run(
        `INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`,
        [sid, JSON.stringify(sess), expire]
      )
      .then(() => cb(null), cb);
  }

  destroy(sid, cb) {
    this.db.run('DELETE FROM sessions WHERE sid = ?', [sid]).then(() => cb(null), cb);
  }

  touch(sid, sess, cb) {
    const expire = DbSessionStore.cookieExpiry(sess);
    this.db
      .run('UPDATE sessions SET expire = ? WHERE sid = ?', [expire, sid])
      .then(() => cb(null), cb);
  }
}

module.exports = { DbSessionStore };
