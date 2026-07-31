const express = require('express');
const router  = express.Router();
const User    = require('../models/User');
const Task    = require('../models/Task');
const Audit   = require('../models/Audit');
const { protect, authorize } = require('../middleware/auth');
const { REVIEW_ROLES } = require('../services/mailer');

// ── GET /api/users ────────────────────────────────────────────────────
router.get('/', protect, authorize('hr', 'manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { role, dept, active, search } = req.query;
    const query = {};

    if (role)   query.role = role;
    if (dept)   query.department = dept;
    if (active !== undefined) query.active = active === 'true';

    if (search) {
      query.$or = [
        { name:  { $regex: search, $options: 'i' } },
        { empId: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const users = await User.find(query)
      .populate('department', 'name color')
      .populate('team',       'name')
      .populate('manager',    'name empId')
      .sort({ name: 1 });

    res.json({ success: true, count: users.length, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/users/me/notification-prefs ──────────────────────────────
// Self-serve, so it is deliberately not behind authorize(): every role needs
// to manage their own email preferences, and PUT /api/users/:id is restricted
// to hr/admin/superadmin.
//
// Registered above GET /:id — two path segments means it could not be captured
// by that route anyway, but keeping literal paths first avoids the trap next
// time someone adds a single-segment /me route.
router.get('/me/notification-prefs', protect, async (req, res) => {
  try {
    const prefs = req.user.notificationPrefs || {};

    res.json({
      success: true,
      prefs: {
        emailTaskAssigned:  prefs.emailTaskAssigned  !== false,
        emailTaskSubmitted: prefs.emailTaskSubmitted !== false,
        emailTaskReviewed:  prefs.emailTaskReviewed  !== false,
      },
      // Types this user may not switch off, so the client can render the
      // toggle disabled with a reason instead of letting it silently fail.
      locked: REVIEW_ROLES.includes(req.user.role) ? ['emailTaskSubmitted'] : [],
      // No address on file means none of this has any effect — worth surfacing.
      hasEmail: Boolean(req.user.email),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/users/me/notification-prefs ──────────────────────────────
router.put('/me/notification-prefs', protect, async (req, res) => {
  try {
    const ALLOWED = ['emailTaskAssigned', 'emailTaskSubmitted', 'emailTaskReviewed'];
    const update  = {};

    for (const key of ALLOWED) {
      if (typeof req.body[key] === 'boolean') {
        update[`notificationPrefs.${key}`] = req.body[key];
      }
    }

    if (!Object.keys(update).length) {
      return res.status(400).json({
        success: false,
        message: `Provide at least one boolean preference: ${ALLOWED.join(', ')}.`,
      });
    }

    // A reviewer switching submission alerts off is stored as asked but has no
    // effect — services/mailer.js overrides it at send time. Accepting the
    // write and reporting the override is clearer than a 403 on a checkbox.
    const overridden = REVIEW_ROLES.includes(req.user.role)
      && update['notificationPrefs.emailTaskSubmitted'] === false;

    const user = await User.findByIdAndUpdate(req.user._id, update, {
      new: true, runValidators: true,
    }).select('notificationPrefs');

    res.json({
      success: true,
      prefs: user.notificationPrefs,
      message: overridden
        ? 'Saved. Task-submitted alerts stay on for reviewers and cannot be disabled.'
        : 'Notification preferences updated.',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/users/:id ────────────────────────────────────────────────
router.get('/:id', protect, authorize('hr', 'manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .populate('department', 'name color')
      .populate('team',       'name')
      .populate('manager',    'name empId designation');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/users/:id/stats ──────────────────────────────────────────
router.get('/:id/stats', protect, authorize('hr', 'manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const tasks      = await Task.find({ userId: req.params.id });
    const total      = tasks.length;
    const completed  = tasks.filter(t => t.status === 'completed').length;
    const approved   = tasks.filter(t => t.approved).length;
    const rejected   = tasks.filter(t => t.rejected).length;
    const delayed    = tasks.filter(t => t.status === 'delayed').length;
    const totalHours = tasks.reduce((s, t) => s + (t.hours || 0), 0);
    const rate       = total ? Math.round((completed / total) * 100) : 0;

    res.json({
      success: true,
      stats: { total, completed, approved, rejected, delayed, totalHours, completionRate: rate },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/users ────────────────────────────────────────────────────
router.post('/', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    // HR can only create employee/manager accounts — not admin, superadmin, or hr.
    if (req.user.role === 'hr' && !['employee', 'manager'].includes(req.body.role || 'employee')) {
      return res.status(403).json({ success: false, message: 'HR can only create employee or manager accounts.' });
    }

    const user = await User.create(req.body);

    const populated = await User.findById(user._id)
      .populate('department', 'name color')
      .populate('team',       'name');

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'User Created',
      detail:   `Created user: ${user.name} (${user.empId})`,
      ip:       req.ip,
    });

    res.status(201).json({ success: true, user: populated });
  } catch (err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({
        success: false,
        message: `A user with that ${field} already exists.`,
      });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/users/:id ────────────────────────────────────────────────
router.put('/:id', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    // Never update the password through this route
    const { password, ...updateData } = req.body;

    if (req.user.role === 'hr') {
      const target = await User.findById(req.params.id);
      if (!target) {
        return res.status(404).json({ success: false, message: 'User not found.' });
      }
      // HR can only manage employee/manager accounts, and can't grant any other role.
      if (!['employee', 'manager'].includes(target.role)) {
        return res.status(403).json({ success: false, message: 'HR cannot modify admin, superadmin, or HR accounts.' });
      }
      if (updateData.role && !['employee', 'manager'].includes(updateData.role)) {
        return res.status(403).json({ success: false, message: 'HR can only assign the employee or manager role.' });
      }
    }

    const user = await User.findByIdAndUpdate(req.params.id, updateData, {
      new: true, runValidators: true,
    })
      .populate('department', 'name color')
      .populate('team',       'name')
      .populate('manager',    'name');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'User Updated',
      detail:   `Updated user: ${user.name}`,
      ip:       req.ip,
    });

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/users/:id ─────────────────────────────────────────────
router.delete('/:id', protect, authorize('superadmin'), async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
    }

    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'User Deleted',
      detail:   `Deleted user: ${user.name} (${user.empId})`,
      ip:       req.ip,
    });

    res.json({ success: true, message: 'User deleted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
