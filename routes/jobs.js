'use strict';
// routes/jobs.js — video job CRUD. Every query is scoped to req.session.userId
// so users can only ever see and touch their own jobs.

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const FORMATS = ['9:16', '1:1', '16:9'];
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function jobsRoutes(db, { mediaDir, uploadsDir, r2 }) {
  const router = express.Router();

  const upload = multer({
    dest: uploadsDir,
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
    fileFilter: (_req, file, cb) => {
      if (IMAGE_MIMES.has(file.mimetype)) cb(null, true);
      else cb(new Error('Only image files (jpeg, png, webp, gif) are allowed'));
    },
  });

  const getOwnJob = (userId, id) =>
    db.get('SELECT * FROM jobs WHERE id = ? AND user_id = ?', [id, userId]);

  const publicJob = (job) => ({
    id: job.id,
    prompt: job.prompt,
    format: job.format,
    status: job.status,
    error: job.error,
    hasVideo: job.status === 'done' && !!job.video_filename,
    hasRefImage: !!job.ref_image_path,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  });

  // Submit a new generation job → status 'pending' (the worker picks it up).
  router.post('/', upload.single('image'), async (req, res) => {
    const prompt = String(req.body.prompt || '').trim();
    const format = String(req.body.format || '');

    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
    if (prompt.length > 2000) return res.status(400).json({ error: 'Prompt is too long (max 2000 chars)' });
    if (!FORMATS.includes(format)) {
      return res.status(400).json({ error: `Format must be one of: ${FORMATS.join(', ')}` });
    }

    const refImagePath = req.file ? path.basename(req.file.path) : null;
    const refImageMime = req.file ? req.file.mimetype : null;
    let refImageR2Key = null;

    const { lastInsertRowid } = await db.run(
      `INSERT INTO jobs (user_id, prompt, format, ref_image_path, ref_image_mime)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [req.session.userId, prompt, format, refImagePath, refImageMime]
    );

    // Permanent storage for the reference image (local disk is ephemeral).
    if (req.file && r2) {
      refImageR2Key = `refimages/user-${req.session.userId}/job-${lastInsertRowid}-${path.basename(req.file.path)}`;
      await r2.put(refImageR2Key, fs.readFileSync(req.file.path), req.file.mimetype);
      fs.rm(req.file.path, { force: true }, () => {});
      await db.run('UPDATE jobs SET ref_image_path = NULL, ref_image_r2_key = ? WHERE id = ?', [
        refImageR2Key,
        lastInsertRowid,
      ]);
    }

    res.status(201).json(publicJob(await getOwnJob(req.session.userId, lastInsertRowid)));
  });

  // List own jobs, newest first.
  router.get('/', async (req, res) => {
    const jobs = await db.all('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC', [
      req.session.userId,
    ]);
    res.json(jobs.map(publicJob));
  });

  // Single job.
  router.get('/:id', async (req, res) => {
    const job = await getOwnJob(req.session.userId, req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(publicJob(job));
  });

  // Retry a failed job → back to 'pending'.
  router.post('/:id/retry', async (req, res) => {
    const job = await getOwnJob(req.session.userId, req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'failed') {
      return res.status(400).json({ error: 'Only failed jobs can be retried' });
    }
    await db.run(
      `UPDATE jobs SET status = 'pending', error = NULL, updated_at = datetime('now')
       WHERE id = ?`,
      [job.id]
    );
    res.json(publicJob(await getOwnJob(req.session.userId, job.id)));
  });

  // Delete a job and its files.
  router.delete('/:id', async (req, res) => {
    const job = await getOwnJob(req.session.userId, req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    for (const [dir, name] of [[mediaDir, job.video_filename], [uploadsDir, job.ref_image_path]]) {
      if (!name) continue;
      const abs = path.join(dir, path.basename(name)); // basename: no path traversal
      fs.rm(abs, { force: true }, () => {});
    }
    if (r2) {
      // Best-effort: never fail the delete because R2 is unreachable.
      await r2.del(job.video_r2_key).catch((e) => console.error('[r2] delete failed:', e.message));
      await r2.del(job.ref_image_r2_key).catch((e) => console.error('[r2] delete failed:', e.message));
    }
    await db.run('DELETE FROM jobs WHERE id = ?', [job.id]);
    res.status(204).end();
  });

  return router;
}

// Serve a finished video file — only to its owner.
// Prefers permanent R2 storage (presigned URL redirect); falls back to local disk.
function mediaRoutes(db, { mediaDir, uploadsDir, r2 }) {
  const router = express.Router();

  router.get('/media/:id', async (req, res) => {
    const job = await db.get('SELECT * FROM jobs WHERE id = ? AND user_id = ? AND status = ?', [
      req.params.id,
      req.session.userId,
      'done',
    ]);
    if (!job) return res.status(404).json({ error: 'Video not found' });

    if (job.video_r2_key && r2) {
      const url = await r2.getUrl(job.video_r2_key, {
        downloadName: req.query.download ? `superreall-${job.id}.mp4` : null,
      });
      return res.redirect(url);
    }
    if (!job.video_filename) return res.status(404).json({ error: 'Video not found' });

    const abs = path.join(mediaDir, path.basename(job.video_filename));
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Video file missing' });
    res.sendFile(abs, { headers: { 'Content-Type': 'video/mp4' } });
  });

  // Serve the reference image back (used by the fal.ai image-to-video path).
  router.get('/refimage/:id', async (req, res) => {
    const job = await db.get('SELECT * FROM jobs WHERE id = ? AND user_id = ?', [
      req.params.id,
      req.session.userId,
    ]);
    if (!job) return res.status(404).json({ error: 'Image not found' });

    if (job.ref_image_r2_key && r2) {
      return res.redirect(await r2.getUrl(job.ref_image_r2_key));
    }
    if (!job.ref_image_path) return res.status(404).json({ error: 'Image not found' });

    const abs = path.join(uploadsDir, path.basename(job.ref_image_path));
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Image file missing' });
    res.sendFile(abs, { headers: { 'Content-Type': job.ref_image_mime || 'image/jpeg' } });
  });

  return router;
}

module.exports = { jobsRoutes, mediaRoutes, FORMATS };
