const express      = require('express');
const router       = express.Router();
const Notification = require('../models/Notification');
const { protect }  = require('../middleware/auth');

// ── GET /api/notifications ────────────────────────────────────────────
// Current user's notifications, newest first. Always scoped to req.user —
// there is deliberately no way to read someone else's.
router.get('/', protect, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const [notifications, unread] = await Promise.all([
      Notification.find({ user: req.user._id })
        .populate('actor', 'name initials color designation')
        .populate('task',  'title project date dueDate')
        .sort({ createdAt: -1 })
        .limit(limit),
      Notification.countDocuments({ user: req.user._id, read: false }),
    ]);

    res.json({ success: true, count: notifications.length, unread, notifications });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/notifications/unread-count ───────────────────────────────
// Cheap endpoint for the poll loop — no documents, just the badge number.
router.get('/unread-count', protect, async (req, res) => {
  try {
    const unread = await Notification.countDocuments({ user: req.user._id, read: false });
    res.json({ success: true, unread });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/notifications/read-all ───────────────────────────────────
// Declared before /:id/read so "read-all" is never parsed as an id.
router.put('/read-all', protect, async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { user: req.user._id, read: false },
      { $set: { read: true } },
    );
    res.json({ success: true, updated: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/notifications/:id/read ───────────────────────────────────
router.put('/:id/read', protect, async (req, res) => {
  try {
    // The user filter is the authorisation check: you can only ever mark
    // your own notification read.
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { read: true } },
      { new: true },
    );

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }
    res.json({ success: true, notification });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/notifications/:id ─────────────────────────────────────
router.delete('/:id', protect, async (req, res) => {
  try {
    const deleted = await Notification.findOneAndDelete({
      _id: req.params.id, user: req.user._id,
    });
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }
    res.json({ success: true, message: 'Notification deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
