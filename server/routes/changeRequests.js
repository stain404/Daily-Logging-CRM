const express       = require('express');
const router        = express.Router();
const ChangeRequest = require('../models/ChangeRequest');
const Audit         = require('../models/Audit');
const { protect }   = require('../middleware/auth');
const { notify }    = require('../services/notify');
const { canDecide, applyRequest } = require('../services/changeRequests');

// The CEO's approval queue. HR raises requests through the ordinary
// users/teams/departments routes; this router is only for reading and
// deciding them.

// ── GET /api/change-requests ──────────────────────────────────────────
// The CEO sees everything. Anyone else sees only what they raised — HR needs
// to know whether their request went through, and nobody else has any
// business reading the queue at all.
router.get('/', protect, async (req, res) => {
  try {
    const { status } = req.query;
    const query = canDecide(req.user.role) ? {} : { requestedBy: req.user._id };
    if (status) query.status = status;

    const requests = await ChangeRequest.find(query)
      .populate('requestedBy', 'name empId color initials role')
      .populate('decidedBy',   'name')
      .sort({ status: 1, createdAt: -1 })
      .limit(200);

    res.json({ success: true, count: requests.length, requests });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/change-requests/pending-count ───────────────────────────
// Drives the badge in the sidebar. Same scoping rule as the list.
router.get('/pending-count', protect, async (req, res) => {
  try {
    const query = { status: 'pending' };
    if (!canDecide(req.user.role)) query.requestedBy = req.user._id;
    res.json({ success: true, count: await ChangeRequest.countDocuments(query) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/change-requests/:id/approve ─────────────────────────────
router.put('/:id/approve', protect, async (req, res) => {
  try {
    if (!canDecide(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the CEO can approve org changes.' });
    }

    const doc = await ChangeRequest.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }
    if (doc.status !== 'pending') {
      return res.status(400).json({ success: false, message: `This request was already ${doc.status}.` });
    }

    // Carry the change out. If the world moved while it sat pending, record
    // that as `failed` and tell both parties — the alternative is a request
    // marked approved with nothing actually changed.
    let result;
    try {
      result = await applyRequest(doc);
    } catch (applyErr) {
      doc.status        = 'failed';
      doc.failureReason = applyErr.message;
      doc.decidedBy     = req.user._id;
      doc.decidedByName = req.user.name;
      doc.decidedAt     = new Date();
      await doc.save();

      notify([doc.requestedBy], {
        type: 'change-request', title: 'Approved but could not be applied',
        message: `"${doc.summary}" was approved, but failed: ${applyErr.message}`,
        actor: req.user._id, severity: 'danger',
      });

      return res.status(409).json({
        success: false, request: doc,
        message: `Could not apply this change: ${applyErr.message}`,
      });
    }

    doc.status        = 'approved';
    doc.decidedBy     = req.user._id;
    doc.decidedByName = req.user.name;
    doc.decidedAt     = new Date();
    doc.decisionNote  = req.body?.note || '';
    if (result.resultId) doc.resultId = result.resultId;
    await doc.save();

    // Two entries on purpose: who approved it, and what it actually did. The
    // second matches what the old direct route used to write, so the audit
    // trail reads the same as it did before approvals existed.
    await Audit.create({
      user: req.user._id, userName: req.user.name,
      action: 'Change Approved',
      detail: `Approved ${doc.requestedByName}'s request: ${doc.summary}`,
      ip: req.ip,
    });
    await Audit.create({
      user: req.user._id, userName: req.user.name,
      action: 'Change Applied',
      detail: result.detail,
      ip: req.ip,
    });

    notify([doc.requestedBy], {
      type: 'change-request', title: 'Request approved',
      message: `${req.user.name} approved: ${doc.summary}`,
      actor: req.user._id, severity: 'success',
    });

    res.json({ success: true, request: doc, message: 'Approved and applied.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/change-requests/:id/reject ──────────────────────────────
router.put('/:id/reject', protect, async (req, res) => {
  try {
    if (!canDecide(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the CEO can reject org changes.' });
    }

    const doc = await ChangeRequest.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }
    if (doc.status !== 'pending') {
      return res.status(400).json({ success: false, message: `This request was already ${doc.status}.` });
    }

    doc.status        = 'rejected';
    doc.decidedBy     = req.user._id;
    doc.decidedByName = req.user.name;
    doc.decidedAt     = new Date();
    doc.decisionNote  = req.body?.note || '';
    await doc.save();

    await Audit.create({
      user: req.user._id, userName: req.user.name,
      action: 'Change Rejected',
      detail: `Rejected ${doc.requestedByName}'s request: ${doc.summary}${doc.decisionNote ? ` — ${doc.decisionNote}` : ''}`,
      ip: req.ip,
    });

    // The reason matters more than the rejection: HR has to know whether to
    // fix it and resubmit or drop it.
    notify([doc.requestedBy], {
      type: 'change-request', title: 'Request rejected',
      message: `${req.user.name} rejected: ${doc.summary}${doc.decisionNote ? ` — ${doc.decisionNote}` : ''}`,
      actor: req.user._id, severity: 'danger',
    });

    res.json({ success: true, request: doc, message: 'Request rejected.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/change-requests/:id ──────────────────────────────────
// HR withdrawing their own mistake, so a typo doesn't need the CEO's time.
router.delete('/:id', protect, async (req, res) => {
  try {
    const doc = await ChangeRequest.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }
    if (doc.requestedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only withdraw your own requests.' });
    }
    if (doc.status !== 'pending') {
      return res.status(400).json({ success: false, message: `This request was already ${doc.status}.` });
    }

    doc.status = 'withdrawn';
    await doc.save();

    await Audit.create({
      user: req.user._id, userName: req.user.name,
      action: 'Change Withdrawn',
      detail: `Withdrew request: ${doc.summary}`,
      ip: req.ip,
    });

    res.json({ success: true, message: 'Request withdrawn.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
