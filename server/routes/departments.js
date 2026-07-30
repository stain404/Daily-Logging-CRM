const express = require('express');
const router  = express.Router();
const Department = require('../models/Department');
const Audit      = require('../models/Audit');
const { protect, authorize } = require('../middleware/auth');

// ── GET /api/departments ──────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    const departments = await Department.find({ active: true }).sort({ name: 1 });
    res.json({ success: true, count: departments.length, departments });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/departments ─────────────────────────────────────────────
router.post('/', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const dept = await Department.create(req.body);

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'Department Created',
      detail:   `Created department: ${dept.name}`,
      ip:       req.ip,
    });

    res.status(201).json({ success: true, department: dept });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'A department with that name already exists.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/departments/:id ──────────────────────────────────────────
router.put('/:id', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const dept = await Department.findByIdAndUpdate(req.params.id, req.body, {
      new: true, runValidators: true,
    });

    if (!dept) {
      return res.status(404).json({ success: false, message: 'Department not found.' });
    }

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'Department Updated',
      detail:   `Updated department: ${dept.name}`,
      ip:       req.ip,
    });

    res.json({ success: true, department: dept });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/departments/:id ───────────────────────────────────────
router.delete('/:id', protect, authorize('superadmin'), async (req, res) => {
  try {
    const dept = await Department.findByIdAndDelete(req.params.id);
    if (!dept) {
      return res.status(404).json({ success: false, message: 'Department not found.' });
    }

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'Department Deleted',
      detail:   `Deleted department: ${dept.name}`,
      ip:       req.ip,
    });

    res.json({ success: true, message: 'Department deleted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
