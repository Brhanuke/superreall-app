'use strict';
// providers/fal.js — real AI video generation via the fal.ai queue API.
// Needs FAL_API_KEY in the environment. Honors the requested aspect ratio
// (9:16, 1:1, 16:9) and downloads the finished file into the media directory.
//
// Model choice: FAL_MODEL env var (text-to-video). fal.ai model slugs change
// over time — set it to a current text-to-video model from https://fal.ai/models.
// Optional image-to-video: if a reference image was uploaded AND both
// FAL_IMAGE_MODEL and PUBLIC_BASE_URL are set, the reference image is served
// back to fal.ai through this app's /api/refimage/:id endpoint.

const fs = require('fs');
const path = require('path');

const QUEUE_BASE = 'https://queue.fal.run';
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes per job

const ASPECT_RATIOS = { '9:16': '9:16', '1:1': '1:1', '16:9': '16:9' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function falFetch(url, apiKey, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Key ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const raw = (body && (body.detail || body.message)) || text || `HTTP ${res.status}`;
    // fal.ai validation errors come back as objects/arrays — stringify them
    // so the real reason shows up in the UI instead of "[object Object]".
    const detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
    throw new Error(`fal.ai request failed (${res.status}): ${detail}`);
  }
  return body;
}

async function submitAndWait({ model, apiKey, input }) {
  console.log(`[fal] submit input: ${JSON.stringify(input)}`);
  // 1. Submit → get request_id + status/response URLs.
  const submitted = await falFetch(`${QUEUE_BASE}/${model}`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ input }),
  });
  const { request_id: requestId, status_url: statusUrl, response_url: responseUrl } = submitted;
  if (!requestId || !statusUrl) throw new Error('fal.ai did not return a request_id');

  // 2. Poll until the job completes or fails.
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const status = await falFetch(statusUrl, apiKey);
    if (status.status === 'COMPLETED') break;
    if (status.status === 'FAILED') {
      throw new Error(`fal.ai generation failed: ${JSON.stringify(status.error || status)}`);
    }
    if (Date.now() > deadline) throw new Error('fal.ai generation timed out');
    await sleep(POLL_INTERVAL_MS);
  }

  // 3. Fetch the result payload and extract the video URL.
  const result = await falFetch(responseUrl || `${statusUrl}/response`, apiKey);
  const videoUrl = result && result.video && result.video.url;
  if (!videoUrl) throw new Error('fal.ai response contained no video URL');
  return videoUrl;
}

async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`video download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

module.exports = {
  name: 'fal',

  async generate(job, { mediaDir }) {
    const apiKey = process.env.FAL_API_KEY;
    if (!apiKey) throw new Error('FAL_API_KEY is not set (PROVIDER=fal requires it)');

    const aspectRatio = ASPECT_RATIOS[job.format] || '16:9';
    let model = process.env.FAL_MODEL || 'fal-ai/wan-2.2-a14b/text-to-video';
    let input = { prompt: job.prompt, aspect_ratio: aspectRatio };

    // Image-to-video path (only when the app is publicly reachable so fal.ai
    // can fetch the reference image).
    const imageModel = (process.env.FAL_IMAGE_MODEL || '').trim();
    const publicBase = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
    if (job.refImagePath && imageModel && publicBase) {
      model = imageModel;
      input = {
        prompt: job.prompt,
        image_url: `${publicBase}/api/refimage/${job.id}`,
        aspect_ratio: aspectRatio,
      };
    } else if (job.refImagePath) {
      console.warn(
        '[fal] reference image ignored: set FAL_IMAGE_MODEL and PUBLIC_BASE_URL ' +
        'to enable image-to-video; falling back to text-to-video.'
      );
    }

    console.log(`[fal] submitting job ${job.id} to model ${model} (${aspectRatio})`);
    const videoUrl = await submitAndWait({ model, apiKey, input });

    const filename = `job-${job.id}-${Date.now()}.mp4`;
    const absPath = path.join(mediaDir, filename);
    await downloadTo(videoUrl, absPath);
    return absPath;
  },
};
