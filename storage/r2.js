'use strict';
// storage/r2.js — permanent media storage on Cloudflare R2 (S3-compatible).
// Active only when all four env vars are set; otherwise createR2() returns
// null and the app keeps using the local disk (dev mode / not configured).
//
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function createR2() {
  const bucket = (process.env.R2_BUCKET_NAME || '').trim();
  const accountId = (process.env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || '').trim();

  if (!bucket || !accountId || !accessKeyId || !secretAccessKey) {
    console.log('[r2] not configured — media stays on local disk');
    return null;
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  console.log(`[r2] permanent storage enabled (bucket "${bucket}")`);

  return {
    // Upload a Buffer/Stream. Returns the key.
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })
      );
      return key;
    },
    // Time-limited HTTPS URL for private objects (video playback, fal.ai fetches).
    async getUrl(key, { downloadName = null, expiresIn = 3600 } = {}) {
      const cmd = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(downloadName
          ? { ResponseContentDisposition: `attachment; filename="${downloadName}"` }
          : {}),
      });
      return getSignedUrl(client, cmd, { expiresIn });
    },
    async del(key) {
      if (!key) return;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

module.exports = { createR2 };
