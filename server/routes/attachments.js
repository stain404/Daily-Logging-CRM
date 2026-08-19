const express    = require('express');
const router     = express.Router();
const Attachment = require('../models/Attachment');
const Task       = require('../models/Task');
const User       = require('../models/User');
const Team       = require('../models/Team');
const Audit      = require('../models/Audit');
const storage    = require('../services/storage');
const { fileShared, supervisorsOf } = require('../services/notify');
const { protect, authorize } = require('../middleware/auth');

const PRIV = ['admin', 'superadmin'];

// Every route needs a configured bucket; without one the honest answer is
// "not available", not a stack trace from the AWS SDK.
function requireStorage(req, res, next) {
  if (!storage.ENABLED) {
    return res.status(503).json({
      success: false,
      message: 'File storage is not configured on this server (S3_BUCKET is unset).',
    });
  }
  next();
}

// ── Access control ────────────────────────────────────────────────────
// The one rule the whole feature rests on. Deliberately a single function so
// there is exactly one place to audit and no route can quietly disagree.
//
// A viewer may see an attachment when they are:
//   - the sender, or
//   - a named recipient, or
//   - an admin/superadmin, or
//   - a supervisor of the owner of the task it is attached to.
//
// That last clause is not in the original spec but is required in practice:
// without it a manager cannot open the file on a task they are being asked
// to review, which is the main reason to attach one.
async function canAccess(user, att) {
  if (PRIV.includes(user.role)) return true;

  const me = user._id.toString();
  if (att.uploadedBy && att.uploadedBy.toString() === me) return true;
  if ((att.recipients || []).some(r => r.toString() === me)) return true;

  if (att.task) {
    const task = await Task.findById(att.task).select('userId');
    if (task) {
      if (task.userId.toString() === me) return true;
      const sups = await supervisorsOf(task.userId);
      if (sups.some(s => s.toString() === me)) return true;
    }
  }
  return false;
}

// ── Who may this person send a file to? ──────────────────────────────
// A direct send is addressed to a named human, so the picker is not a
// company-wide directory. An employee's business is with their own manager,
// with HR, and with the CEO — not with the other 200 people on the payroll,
// and a free-text search over all of them is how a payslip ends up with the
// wrong Ahmed.
//
// Seniority widens it rather than removing it: a manager can also reach their
// own reports, and HR/admin/the CEO can reach everyone, because that is
// already true of every other screen they have.
async function allowedRecipients(user) {
  const wide = ['hr', 'admin', 'superadmin'].includes(user.role);

  if (wide) {
    return User.find({ active: true, _id: { $ne: user._id } })
      .select('name empId designation role color initials')
      .sort({ name: 1 });
  }

  const ids = new Set();

  // Their own review chain — the direct manager link and the team one, which
  // are set independently here and are not always both present.
  (await supervisorsOf(user._id)).forEach(id => ids.add(id.toString()));

  // A manager can also send down to the people they oversee.
  if (user.role === 'manager') {
    const teams = await Team.find({ manager: user._id }).select('members');
    teams.forEach(t => (t.members || []).forEach(m => ids.add(m.toString())));
  }

  const reachable = await User.find({
    active: true,
    $or: [
      { _id: { $in: [...ids] } },
      // HR and the CEO/Director are addressable by everyone by role, not by
      // reporting line — that is the whole point of being able to reach them.
      { role: { $in: ['hr', 'superadmin'] } },
    ],
  })
    .select('name empId designation role color initials')
    .sort({ name: 1 });

  return reachable.filter(u => u._id.toString() !== user._id.toString());
}

// ── GET /api/attachments/recipients ───────────────────────────────────
// The picker's source of truth. Deliberately its own endpoint rather than the
// client filtering GET /api/users: employees are not authorised to call that
// at all, so the old picker silently fell back to an empty list for exactly
// the people this feature is for.
router.get('/recipients', protect, async (req, res) => {
  try {
    const users = await allowedRecipients(req.user);
    res.json({ success: true, count: users.length, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/attachments/config ───────────────────────────────────────
// Lets the client render limits and the accept="" filter from the server's
// actual configuration instead of hardcoding a second copy of the rules.
router.get('/config', protect, (req, res) => {
  res.json({
    success: true,
    config: {
      enabled:      storage.ENABLED,
      maxMb:        storage.MAX_MB,
      allowedTypes: Object.keys(storage.ALLOWED),
      allowedExts:  storage.ALLOWED_EXT_LIST,
      // Surfaced so the UI can be honest about it rather than implying files
      // have been checked for malware when they have not.
      virusScanning: false,
    },
  });
});

// ── POST /api/attachments/upload-url ──────────────────────────────────
// Step 1 of 2. Validates, reserves a row in 'uploading', and hands back a
// presigned POST the browser submits directly to S3. Bytes never touch this
// server.
router.post('/upload-url', protect, requireStorage, async (req, res) => {
  try {
    const { filename, mimeType, size, kind, taskId, recipients, note } = req.body;

    if (!['task-attachment', 'direct-message'].includes(kind)) {
      return res.status(400).json({ success: false, message: 'kind must be task-attachment or direct-message.' });
    }

    const bad = storage.validate({ filename, mimeType, size });
    if (bad) return res.status(400).json({ success: false, message: bad });

    let recipientIds = [];

    if (kind === 'task-attachment') {
      if (!taskId) {
        return res.status(400).json({ success: false, message: 'taskId is required for a task attachment.' });
      }
      const task = await Task.findById(taskId).select('userId');
      if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

      // Only people who can already see the task may attach to it — reuse the
      // same predicate the read path uses rather than inventing a second one.
      const allowed = await canAccess(req.user, { task: task._id, recipients: [], uploadedBy: null });
      if (!allowed) {
        return res.status(403).json({ success: false, message: 'You do not have access to that task.' });
      }
    } else {
      recipientIds = Array.isArray(recipients) ? recipients.filter(Boolean) : [];
      if (!recipientIds.length) {
        return res.status(400).json({ success: false, message: 'Select at least one recipient.' });
      }
      // Recipients must be real, active, and someone this sender is actually
      // allowed to reach. Checked here and not only in the picker — the picker
      // is a convenience, this is the rule.
      const allowed = new Set((await allowedRecipients(req.user)).map(u => u._id.toString()));
      const outside = recipientIds.filter(id => !allowed.has(String(id)));
      if (outside.length) {
        return res.status(403).json({
          success: false,
          message: 'You can only send files to your manager, HR, or the CEO/Director.',
        });
      }
    }

    const key = storage.buildKey(req.user._id, filename);

    const att = await Attachment.create({
      filename, mimeType, storageKey: key,
      size: Number(size) || 0,
      uploadedBy: req.user._id,
      recipients: recipientIds,
      task: kind === 'task-attachment' ? taskId : undefined,
      note: (note || '').slice(0, 500),
      kind,
      status: 'uploading',
    });

    const post = await storage.presignUpload({ key, mimeType });

    res.status(201).json({
      success: true,
      attachmentId: att._id,
      upload: { url: post.url, fields: post.fields },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/attachments/:id/complete ────────────────────────────────
// Step 2 of 2. Confirms with S3 that the object exists and records S3's own
// size/type, then makes the row visible. Until this runs the attachment is
// 'uploading' and appears nowhere.
router.post('/:id/complete', protect, requireStorage, async (req, res) => {
  try {
    const att = await Attachment.findById(req.params.id);
    if (!att) return res.status(404).json({ success: false, message: 'Attachment not found.' });

    if (att.uploadedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You did not start this upload.' });
    }
    if (att.status === 'ready') {
      return res.json({ success: true, attachment: att });   // idempotent retry
    }

    let meta;
    try {
      meta = await storage.head(att.storageKey);
    } catch (e) {
      // The object is not there — the browser's POST to S3 failed, or was
      // rejected by the size policy. Drop the reservation so it cannot linger.
      await Attachment.findByIdAndDelete(att._id);
      return res.status(400).json({
        success: false,
        message: 'The upload did not complete. The file may exceed the size limit.',
      });
    }

    att.size     = meta.size;
    att.checksum = meta.checksum;
    if (meta.mimeType) att.mimeType = meta.mimeType;
    att.status   = 'ready';
    await att.save();

    if (att.task) {
      await Task.findByIdAndUpdate(att.task, { $inc: { attachmentCount: 1 } });
    }

    await Audit.create({
      user: req.user._id, userName: req.user.name,
      action: 'File Uploaded',
      detail: `Uploaded "${att.filename}" (${(att.size / 1024).toFixed(0)} KB)`,
      ip: req.ip,
    });

    fileShared(att, req.user._id, req.user.name);

    const populated = await Attachment.findById(att._id)
      .populate('uploadedBy', 'name empId color initials')
      .populate('recipients', 'name empId');

    res.json({ success: true, attachment: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/attachments/task/:taskId ─────────────────────────────────
router.get('/task/:taskId', protect, async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId).select('userId');
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

    const allowed = await canAccess(req.user, { task: task._id, recipients: [], uploadedBy: null });
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You do not have access to that task.' });
    }

    const files = await Attachment.find({ task: task._id, status: 'ready' })
      .populate('uploadedBy', 'name empId color initials')
      .sort({ createdAt: -1 });

    res.json({ success: true, count: files.length, files });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/attachments/inbox ────────────────────────────────────────
// Everything this user sent or was sent. Task attachments they can see by
// virtue of supervising someone are intentionally excluded — those belong on
// the task, and folding them in here would make the inbox unreadable.
router.get('/inbox', protect, async (req, res) => {
  try {
    const me = req.user._id;

    const [received, sent] = await Promise.all([
      Attachment.find({ recipients: me, status: 'ready' })
        .populate('uploadedBy', 'name empId color initials')
        .populate('task', 'title')
        .sort({ createdAt: -1 }).limit(200),
      Attachment.find({ uploadedBy: me, status: 'ready' })
        .populate('recipients', 'name empId')
        .populate('task', 'title')
        .sort({ createdAt: -1 }).limit(200),
    ]);

    res.json({ success: true, received, sent });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/attachments/:id/download ─────────────────────────────────
// Returns a short-lived presigned URL rather than the bytes. The bucket stays
// private and this server never proxies file traffic.
// Note the ordering: authorisation runs before the storage-configured check,
// so an unauthorised caller gets 403 either way and never learns whether the
// server has storage set up. requireStorage is applied inline below rather
// than as middleware for exactly that reason.
router.get('/:id/download', protect, async (req, res) => {
  try {
    const att = await Attachment.findById(req.params.id);
    if (!att || att.status !== 'ready') {
      return res.status(404).json({ success: false, message: 'File not found.' });
    }

    if (!(await canAccess(req.user, att))) {
      return res.status(403).json({ success: false, message: 'You do not have access to this file.' });
    }

    if (!storage.ENABLED) {
      return res.status(503).json({ success: false, message: 'File storage is not configured on this server.' });
    }

    const url = await storage.presignDownload(att.storageKey, att.filename);

    await Audit.create({
      user: req.user._id, userName: req.user.name,
      action: 'File Downloaded',
      detail: `Downloaded "${att.filename}"`,
      ip: req.ip,
    });

    res.json({ success: true, url, filename: att.filename, expiresIn: storage.URL_TTL });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/attachments/:id ───────────────────────────────────────
// Sender or admin only. Recipients cannot delete something sent to them.
router.delete('/:id', protect, async (req, res) => {
  try {
    const att = await Attachment.findById(req.params.id);
    if (!att) return res.status(404).json({ success: false, message: 'File not found.' });

    const isOwner = att.uploadedBy.toString() === req.user._id.toString();
    if (!isOwner && !PRIV.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the sender or an admin can delete this file.' });
    }

    // After the permission check, as above. Deleting the row while storage is
    // unreachable would orphan the object in the bucket with nothing pointing
    // at it, so this refuses rather than half-deleting.
    if (!storage.ENABLED) {
      return res.status(503).json({ success: false, message: 'File storage is not configured on this server.' });
    }

    // Object first, row second. The reverse order can orphan bytes in S3 with
    // nothing left pointing at them.
    try {
      await storage.remove(att.storageKey);
    } catch (e) {
      console.error('[attachments] S3 delete failed:', e.message);
    }

    if (att.task) {
      await Task.findByIdAndUpdate(att.task, { $inc: { attachmentCount: -1 } });
    }
    await Attachment.findByIdAndDelete(att._id);

    await Audit.create({
      user: req.user._id, userName: req.user.name,
      action: 'File Deleted',
      detail: `Deleted "${att.filename}"`,
      ip: req.ip,
    });

    res.json({ success: true, message: 'File deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
