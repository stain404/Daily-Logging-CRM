const express = require('express');
const router  = express.Router();
const Department = require('../models/Department');
const User       = require('../models/User');
const Team       = require('../models/Team');
const Audit      = require('../models/Audit');
const { protect, authorize } = require('../middleware/auth');
const {
  canPropose, canActDirectly, denyAddRemove, submitRequest, pendingResponse, pendingTargetRequest,
} = require('../services/changeRequests');

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
    const direct = canActDirectly(req.user.role);
    if (!direct && !canPropose(req.user.role)) return denyAddRemove(req, res, 'departments');

    if (!req.body.name) {
      return res.status(400).json({ success: false, message: 'A department name is required.' });
    }
    // Checked now as well as at approval, so HR sees the clash on the form.
    if (await Department.findOne({ name: req.body.name })) {
      return res.status(400).json({ success: false, message: 'A department with that name already exists.' });
    }

    if (direct) {
      const dept = await Department.create(req.body);
      await Audit.create({
        user: req.user._id, userName: req.user.name,
        action: 'Department Created', detail: `Created department: ${dept.name}`, ip: req.ip,
      });
      return res.status(201).json({ success: true, department: dept });
    }

    const request = await submitRequest(req, {
      entity: 'department', action: 'create', payload: req.body,
      summary: `Add department "${req.body.name}"`,
    });

    return pendingResponse(res, request, 'The department will be created');
  } catch (err) {
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
router.delete('/:id', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const direct = canActDirectly(req.user.role);
    if (!direct && !canPropose(req.user.role)) return denyAddRemove(req, res, 'departments');

    const dept = await Department.findById(req.params.id);
    if (!dept) {
      return res.status(404).json({ success: false, message: 'Department not found.' });
    }

    if (direct) {
      await Department.findByIdAndDelete(dept._id);
      await Audit.create({
        user: req.user._id, userName: req.user.name,
        action: 'Department Deleted', detail: `Deleted department: ${dept.name}`, ip: req.ip,
      });
      return res.json({ success: true, message: `${dept.name} has been deleted.` });
    }

    if (await pendingTargetRequest('department', dept._id)) {
      return res.status(400).json({ success: false, message: 'This department already has a change waiting for the CEO.' });
    }

    // Counted for the summary, not to block: the CEO deciding whether to
    // delete a department needs to know 14 people are sitting in it.
    const [staff, teams] = await Promise.all([
      User.countDocuments({ department: dept._id }),
      Team.countDocuments({ department: dept._id }),
    ]);
    const scope = [staff && `${staff} staff`, teams && `${teams} teams`].filter(Boolean).join(', ');

    const request = await submitRequest(req, {
      entity: 'department', action: 'delete', target: dept._id,
      targetLabel: dept.name,
      summary: `Delete department "${dept.name}"${scope ? ` (${scope})` : ''}`,
    });

    return pendingResponse(res, request, 'The department will be deleted');
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
