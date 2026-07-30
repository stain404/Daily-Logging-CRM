const express = require('express');
const router  = express.Router();
const Audit   = require('../models/Audit');
const { protect, authorize } = require('../middleware/auth');

// ── GET /api/audit ────────────────────────────────────────────────────
router.get('/', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const { page = 1, limit = 100, action, userId } = req.query;
    const query = {};

    if (action) query.action = { $regex: action, $options: 'i' };
    if (userId) query.user   = userId;

    const total = await Audit.countDocuments(query);
    const logs  = await Audit.find(query)
      .populate('user', 'name empId')
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    res.json({ success: true, total, count: logs.length, page: Number(page), logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
