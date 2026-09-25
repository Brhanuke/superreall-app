'use strict';
// worker.js — background job processor. Runs inside the Node process: every 2s
// it atomically claims one 'pending' job (UPDATE ... RETURNING, so concurrent
// workers could never double-claim), marks it 'processing', calls the video
// provider, then marks it 'done' (or 'failed' with the error message).

const path = require('path');

function startWorker(db, provider, { mediaDir, uploadsDir }) {
  let busy = false;

  // Jobs left 'processing' by a previous run (restart/redeploy/timeout-kill)
  // would otherwise sit stuck forever — send them back to the queue.
  db.run("UPDATE jobs SET status = 'pending' WHERE status = 'processing'")
    .then(({ changes }) => {
      if (changes) console.log(`[worker] requeued ${changes} stale processing job(s)`);
    })
    .catch((err) => console.error('[worker] failed to requeue stale jobs:', err.message));

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const job = await db.get(
        `UPDATE jobs
           SET status = 'processing', updated_at = datetime('now')
         WHERE id = (SELECT id FROM jobs WHERE status = 'pending'
                     ORDER BY created_at ASC LIMIT 1)
         RETURNING *`
      );
      if (!job) return;

      // Resolve the reference image to an absolute path for the provider.
      job.refImagePath = job.ref_image_path
        ? path.join(uploadsDir, path.basename(job.ref_image_path))
        : null;

      console.log(`[worker] job ${job.id} → processing (${job.format})`);
      try {
        const videoPath = await provider.generate(job, { mediaDir });
        await db.run(
          `UPDATE jobs SET status = 'done', video_filename = ?, error = NULL,
                           fal_request_id = NULL, fal_status_url = NULL,
                           fal_response_url = NULL, updated_at = datetime('now')
           WHERE id = ?`,
          [path.basename(videoPath), job.id]
        );
        console.log(`[worker] job ${job.id} → done`);
      } catch (err) {
        if (err.falResume) {
          // Timed out, but fal.ai is still rendering — park the request IDs on
          // the job and requeue it. The next pass resumes polling the SAME
          // fal.ai request instead of paying for a new generation.
          const r = err.falResume;
          await db.run(
            `UPDATE jobs SET status = 'pending', error = ?,
                             fal_request_id = ?, fal_status_url = ?, fal_response_url = ?,
                             updated_at = datetime('now')
             WHERE id = ?`,
            ['Still rendering on fal.ai — resuming automatically', r.requestId, r.statusUrl, r.responseUrl || null, job.id]
          );
          console.log(`[worker] job ${job.id} → timed out, will resume fal.ai request ${r.requestId}`);
          return;
        }
        const msg = String((err && err.message) || err).slice(0, 500);
        await db.run(
          `UPDATE jobs SET status = 'failed', error = ?, updated_at = datetime('now')
           WHERE id = ?`,
          [msg, job.id]
        );
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
