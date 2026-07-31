const crypto = require('crypto');
const path   = require('path');

// ── Config ────────────────────────────────────────────────────────────
// Storage is inert until a bucket is named, in the same spirit as EMAIL_ENABLED:
// the feature reports itself unavailable rather than half-working or throwing
// AWS credential errors at users.
const BUCKET    = process.env.S3_BUCKET   || '';
const REGION    = process.env.AWS_REGION  || 'us-east-1';
const MAX_MB    = Number(process.env.MAX_UPLOAD_MB || 25);
const MAX_BYTES = MAX_MB * 1024 * 1024;
const URL_TTL   = 300;   // seconds a download link stays valid

const ENABLED = Boolean(BUCKET);

// Allowlist, not a blocklist. The extension is checked against the declared
// MIME type too, because a browser will happily report whatever it likes and
// "invoice.pdf.exe" should not be storable as application/pdf.
const ALLOWED = {
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'text/csv': ['.csv'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png':  ['.png'],
};

const ALLOWED_EXT_LIST = [...new Set(Object.values(ALLOWED).flat())].join(', ');

let _client = null;
function s3() {
  if (!_client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    _client = new S3Client({ region: REGION });
  }
  return _client;
}

// ── Validation ────────────────────────────────────────────────────────
// Returns null when acceptable, or a human-readable reason when not.
function validate({ filename, mimeType, size }) {
  if (!filename || !mimeType) return 'A filename and file type are required.';

  const exts = ALLOWED[mimeType];
  if (!exts) {
    return `Files of type "${mimeType}" are not accepted. Allowed: ${ALLOWED_EXT_LIST}.`;
  }

  const ext = path.extname(filename).toLowerCase();
  if (!exts.includes(ext)) {
    return `The extension "${ext || '(none)'}" does not match the file type ${mimeType}.`;
  }

  // Advisory only — the real limit is enforced by S3 against the presigned
  // policy below, because a client can claim any size it wants here.
  if (size !== undefined && Number(size) > MAX_BYTES) {
    return `That file is ${(Number(size) / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_MB} MB.`;
  }
  return null;
}

// ── Keys ──────────────────────────────────────────────────────────────
// Never derived from the filename. Random, namespaced by uploader so a listing
// by prefix is possible, and carrying a sanitised name only as a trailing hint
// for anyone reading the bucket directly.
function buildKey(userId, filename) {
  const ext  = path.extname(filename).toLowerCase().slice(0, 10);
  const safe = path.basename(filename, path.extname(filename))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 60) || 'file';
  return `uploads/${userId}/${Date.now()}-${crypto.randomBytes(12).toString('hex')}-${safe}${ext}`;
}

// ── Upload ────────────────────────────────────────────────────────────
// A presigned POST rather than a presigned PUT, specifically so the size cap
// is enforced by S3 itself via content-length-range. A presigned PUT cannot
// express a maximum, which would leave the limit as a client-side suggestion
// and let anyone with the URL upload a 5 GB file.
//
// Bytes go browser -> S3 directly; they never pass through this server, which
// matters on a 512 MB free-tier dyno.
async function presignUpload({ key, mimeType }) {
  const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
  return createPresignedPost(s3(), {
    Bucket: BUCKET,
    Key: key,
    Conditions: [
      ['content-length-range', 1, MAX_BYTES],
      ['eq', '$Content-Type', mimeType],
    ],
    Fields: { 'Content-Type': mimeType },
    Expires: 300,
  });
}

// ── Verify ────────────────────────────────────────────────────────────
// Called after the client reports success. Confirms the object is really
// there and returns S3's own view of its size and type, which is what gets
// persisted — the client's claims are never trusted.
async function head(key) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  const out = await s3().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  return {
    size:     out.ContentLength || 0,
    mimeType: out.ContentType || '',
    checksum: (out.ETag || '').replace(/"/g, ''),
  };
}

// ── Download ──────────────────────────────────────────────────────────
// Short-lived and issued only after the caller has been authorised. The
// bucket itself stays private; this is the only way anything comes out of it.
async function presignDownload(key, filename) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl }     = require('@aws-sdk/s3-request-presigner');

  const cmd = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    // Forces a download with the original name rather than rendering in-tab.
    // Also neutralises stored HTML/SVG being opened as an active document on
    // the bucket's origin.
    ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
  });
  return getSignedUrl(s3(), cmd, { expiresIn: URL_TTL });
}

async function remove(key) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  return s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = {
  ENABLED, BUCKET, REGION, MAX_MB, MAX_BYTES, URL_TTL,
  ALLOWED, ALLOWED_EXT_LIST,
  validate, buildKey, presignUpload, head, presignDownload, remove,
};
