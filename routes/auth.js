'use strict';
// routes/auth.js — sign up / log in / log out / current user.
// Passwords are hashed with bcryptjs; sessions live in httpOnly cookies.

const express = require('express');
const bcrypt = require('bcryptjs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENDERS = ['female', 'male', 'nonbinary', 'prefer-not-to-say'];

function authRoutes(db) {
  const router = express.Router();

  const findByEmail = (email) => db.get('SELECT * FROM users WHERE email = ?', [email]);

  router.post('/signup', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const firstName = String(req.body.firstName || '').trim().slice(0, 50);
    const lastName = String(req.body.lastName || '').trim().slice(0, 50);
    const gender = String(req.body.gender || '').trim().toLowerCase();

    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email address' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!firstName) return res.status(400).json({ error: 'First name is required' });
    if (gender && !GENDERS.includes(gender)) return res.status(400).json({ error: 'Invalid gender selection' });
    if (await findByEmail(email)) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 10);
    const { lastInsertRowid } = await db.run(
      'INSERT INTO users (email, password_hash, first_name, last_name, gender) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [email, passwordHash, firstName, lastName || null, gender || null]
    );

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.userId = lastInsertRowid;
      res.status(201).json({ id: lastInsertRowid, email, first_name: firstName, last_name: lastName || null, gender: gender || null });
    });
  });

  router.post('/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const user = await findByEmail(email);
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.userId = user.id;
      res.json({ id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, gender: user.gender });
    });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('ptv.sid');
      res.json({ ok: true });
    });
  });

  router.get('/me', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
    const user = await db.get('SELECT id, email, first_name, last_name, gender, created_at FROM users WHERE id = ?', [
      req.session.userId,
    ]);
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
