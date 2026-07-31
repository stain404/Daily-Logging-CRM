const mongoose = require('mongoose');

// Metadata only — the bytes live in S3 under `storageKey`. Nothing in this
// collection is ever served directly; downloads go out as short-lived
// presigned URLs after an authorisation check (see routes/attachments.js).
const AttachmentSchema = new mongoose.Schema({
  // What the user called it. Display only, and never used to build the S3 key:
  // a filename is attacker-controlled and would let one user write over
  // another's object.
  filename: { type: String, required: true, trim: true },

  // Server-generated, unguessable, immutable. The real identity of the object.
  storageKey: { type: String, required: true, unique: true },

  mimeType: { type: String, required: true },
  // Authoritative size, read back from S3 with HeadObject on completion —
  // not the number the client claimed at upload time.
  size:     { type: Number, default: 0, min: 0 },
  checksum: { type: String, default: '' },   // S3 ETag

  // ── Provenance and routing ──────────────────────────────────────────
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', required: true,
  },

  // An array rather than a single recipient because the two cases differ: a
  // direct send names one or more people, while a task attachment has no
  // single recipient at all — the whole review chain can see it. One field
  // covers both without a second collection.
  recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },
  note: { type: String, default: '', trim: true, maxlength: 500 },

  kind: {
    type: String,
    enum: ['task-attachment', 'direct-message'],
    required: true,
  },

  // ── Lifecycle ───────────────────────────────────────────────────────
  // 'uploading' rows are created before the client has actually PUT anything.
  // Only 'ready' rows are ever listed or downloadable, so an abandoned upload
  // is invisible rather than appearing as a broken file.
  status: {
    type: String,
    enum: ['uploading', 'ready', 'quarantined', 'deleted'],
    default: 'uploading',
  },

  // Malware scanning is not wired up (see PRODUCT/deploy notes) — the states
  // exist now so scanning can be added later without a migration or a change
  // to any read path. 'skipped' is the honest value for "we did not look".
  scanStatus: {
    type: String,
    enum: ['pending', 'clean', 'infected', 'skipped', 'error'],
    default: 'skipped',
  },
  scanReport: { type: String, default: '' },
  scannedAt:  { type: Date },
}, { timestamps: true });

// The Files tab on a task.
AttachmentSchema.index({ task: 1, createdAt: -1 });
// "Sent" in a user's inbox.
AttachmentSchema.index({ uploadedBy: 1, createdAt: -1 });
// "Received" in a user's inbox.
AttachmentSchema.index({ recipients: 1, createdAt: -1 });
// Sweeping abandoned 'uploading' rows.
AttachmentSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('Attachment', AttachmentSchema);
