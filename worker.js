'use strict';
// worker.js — background job processor. Runs inside the Node process: every 2s
// it atomically claims one 'pending' job (UPDATE ... RETURNING, so concurrent
// workers could never double-claim), marks it 'processing', calls the video
// provider, then marks it 'done' (or 'failed' with the error message).

const path = require('path');

function startWorker(db, provider, { mediaDir, uploadsDir }) {
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const job = db
        .prepare(
          `UPDATE jobs
             SET status = 'processing', updated_at = datetime('now')
           WHERE id = (SELECT id FROM jobs WHERE status = 'pending'
                       ORDER BY created_at ASC LIMIT 1)
           RETURNING *`
        )
        .get();
      if (!job) return;

      // Resolve the reference image to an absolute path for the provider.
      job.refImagePath = job.ref_image_path
        ? path.join(uploadsDir, path.basename(job.ref_image_path))
        : null;

      console.log(`[worker] job ${job.id} → processing (${job.format})`);
      try {
        const videoPath = await provider.generate(job, { mediaDir });
        db.prepare(
          `UPDATE jobs SET status = 'done', video_filename = ?, error = NULL,
                           updated_at = datetime('now') WHERE id = ?`
        ).run(path.basename(videoPath), job.id);
        console.log(`[worker] job ${job.id} → done`);
      } catch (err) {
        const msg = String((err && err.message) || err).slice(0, 500);
        db.prepare(
          `UPDATE jobs SET status = 'failed', error = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(msg, job.id);
        console.error(`[worker] job ${job.id} → failed: ${msg}`);
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, 2000);
  tick(); // pick up anything pending from a previous run
  return { stop: () => clearInterval(timer) };
}

module.exports = { startWorker };
