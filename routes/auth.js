'use strict';
// routes/auth.js — sign up / log in / log out / current user.
// Passwords are hashed with bcryptjs; sessions live in httpOnly cookies.

const express = require('express');
const bcrypt = require('bcryptjs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function authRoutes(db) {
  const router = express.Router();

  const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');

  router.post('/signup', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email address' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (findByEmail.get(email)) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 10);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
      .run(email, passwordHash);

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.userId = lastInsertRowid;
      res.status(201).json({ id: lastInsertRowid, email });
    });
  });

  router.post('/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const user = findByEmail.get(email);
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.userId = user.id;
      res.json({ id: user.id, email: user.email });
    });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('ptv.sid');
      res.json({ ok: true });
    });
  });

  router.get('/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
    const user = db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    res.json(user);
  });

  return router;
}

// Middleware: reject unauthenticated API calls with 401.
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Authentication required' });
  next();
}

module.exports = { authRoutes, requireAuth };
