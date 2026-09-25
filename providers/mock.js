'use strict';
// providers/mock.js — local development / test provider.
// Simulates a generation run (2–4s delay) and writes a tiny bundled placeholder
// mp4 into the media directory. No network access, no API key needed.
// The placeholder video bytes live in placeholder.mp4.b64 next to this file.

const fs = require('fs');
const path = require('path');

const PLACEHOLDER_B64 = fs
  .readFileSync(path.join(__dirname, 'placeholder.mp4.b64'), 'utf8')
  .trim();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  name: 'mock',

  async generate(job, { mediaDir }) {
    // Simulate queue + GPU time so the pending → processing → done flow is real.
    await delay(2000 + Math.random() * 2000);

    const filename = `job-${job.id}-${Date.now()}.mp4`;
    const absPath = path.join(mediaDir, filename);
    fs.writeFileSync(absPath, Buffer.from(PLACEHOLDER_B64, 'base64'));
    return absPath;
  },
};
