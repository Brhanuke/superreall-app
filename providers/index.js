'use strict';
// providers/index.js — selects the video provider from the PROVIDER env var.
//
// Provider interface (both providers implement it):
//   provider.name                        — string identifier
//   provider.generate(job, { mediaDir }) — async; resolves with the ABSOLUTE path
//                                          of the finished .mp4 inside mediaDir,
//                                          or rejects with an Error.
//   job = { id, prompt, format ('9:16'|'1:1'|'16:9'),
//           refImagePath (absolute path or null), refImageMime }

function loadProvider() {
  const name = (process.env.PROVIDER || 'mock').trim().toLowerCase();
  if (name === 'mock') return require('./mock');
  if (name === 'fal') return require('./fal');
  throw new Error(`Unknown PROVIDER "${process.env.PROVIDER}". Use "mock" or "fal".`);
}

module.exports = { loadProvider };
