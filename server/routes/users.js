const express = require('express');
const router  = express.Router();
const User    = require('../models/User');
const Task    = require('../models/Task');
const Audit   = require('../models/Audit');
const { protect, authorize } = require('../middleware/auth');
const { visibleUserIds } = require('../utils/scope');
const { REVIEW_ROLES } = require('../services/mailer');
const {
  canPropose, canActDirectly, denyAddRemove, submitRequest, pendingResponse, hashPassword,
  describeUserCreate, describeUserRemoval, pendingUserCreateClash, pendingTargetRequest,
} = require('../services/changeRequests');

// ── GET /api/users ────────────────────────────────────────────────────
// HR, admin and the CEO read the whole directory — that is already true of
// every other screen they have. A manager does not: their remit is the people
// they manage, and handing them the full roster is what made the Employees
// export, the report filters and the recipient pickers all list the entire
// company. Scoped in utils/scope.js, once, so no route can quietly disagree.
router.get('/', protect, authorize('hr', 'manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { role, dept, active, search } = req.query;
    const query = {};

    const scope = await visibleUserIds(req.user);
    if (scope) query._id = { $in: scope };

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
    const scope = await visibleUserIds(req.user);
    if (scope && !scope.includes(String(req.params.id))) {
      return res.status(403).json({ success: false, message: 'You can only view people you manage.' });
    }

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
    const scope = await visibleUserIds(req.user);
    if (scope && !scope.includes(String(req.params.id))) {
      return res.status(403).json({ success: false, message: 'You can only view people you manage.' });
    }

    const tasks      = await Task.find({ userId: req.params.id });
    const total      = tasks.length;
    const completed  = tasks.filter(t => t.status === 'completed').length;
    const delayed    = tasks.filter(t => t.status === 'delayed').length;
    const reviewed   = tasks.filter(t => t.reviewedAt).length;
    const totalHours = tasks.reduce((s, t) => s + (t.hours || 0), 0);
    const rate       = total ? Math.round((completed / total) * 100) : 0;

    res.json({
      success: true,
      stats: { total, completed, reviewed, delayed, totalHours, completionRate: rate },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/users ────────────────────────────────────────────────────
// When HR raises this, adding a person creates nothing: the CEO approves it,
// and only then does the account exist — so the new hire cannot log in until
// that happens. The CEO himself is the approver, so his own add lands straight
// away. See services/changeRequests.js.
router.post('/', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const direct = canActDirectly(req.user.role);
    if (!direct && !canPropose(req.user.role)) return denyAddRemove(req, res, 'people');

    // HR can only create employee/manager accounts — not admin, superadmin, or hr.
    // The CEO is not held to that: granting a privileged role is his call alone
    // and PUT /:id already says so.
    if (!direct && !['employee', 'manager'].includes(req.body.role || 'employee')) {
      return res.status(403).json({ success: false, message: 'HR can only create employee or manager accounts.' });
    }

    const { empId, username, name, designation, password } = req.body;
    if (!empId || !username || !name || !designation) {
      return res.status(400).json({
        success: false,
        message: 'Employee ID, username, name and designation are all required.',
      });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    // The schema's setters normalise these on save; match them here so the
    // duplicate check compares like with like.
    const normEmpId = empId.toUpperCase().trim();
    const normUser  = username.toLowerCase().trim();

    // Validated now as well as at approval time. HR should learn about a clash
    // while they are still on the form, not days later through the CEO.
    const clash = await User.findOne({ $or: [{ empId: normEmpId }, { username: normUser }] });
    if (clash) {
      return res.status(400).json({
        success: false,
        message: `A user with that ${clash.empId === normEmpId ? 'employee ID' : 'username'} already exists.`,
      });
    }
    const queued = await pendingUserCreateClash(normEmpId, normUser);
    if (queued) {
      return res.status(400).json({
        success: false,
        message: 'That employee ID or username is already waiting for the CEO to approve.',
      });
    }

    // Nothing to approve — he is the approver.
    if (direct) {
      const created = await User.create({ ...req.body, empId: normEmpId, username: normUser });
      await Audit.create({
        user:     req.user._id,
        userName: req.user.name,
        action:   'User Created',
        detail:   `Created user: ${created.name} (${created.empId})`,
        ip:       req.ip,
      });
      const user = await User.findById(created._id)
        .populate('department', 'name color')
        .populate('team',       'name');
      return res.status(201).json({ success: true, user });
    }

    const request = await submitRequest(req, {
      entity: 'user',
      action: 'create',
      // Hashed here so a request sitting in the queue never holds plaintext.
      payload: { ...req.body, empId: normEmpId, username: normUser, password: await hashPassword(password) },
      summary: describeUserCreate(req.body),
    });

    return pendingResponse(res, request, `${name}'s account will be created`);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/users/:id ────────────────────────────────────────────────
router.put('/:id', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    // Never update the password through this route
    const { password, ...updateData } = req.body;

    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (req.user.role === 'hr') {
      // HR can only manage employee/manager accounts, and can't grant any other role.
      if (!['employee', 'manager'].includes(target.role)) {
        return res.status(403).json({ success: false, message: 'HR cannot modify admin, superadmin, or HR accounts.' });
      }
      if (updateData.role && !['employee', 'manager'].includes(updateData.role)) {
        return res.status(403).json({ success: false, message: 'HR can only assign the employee or manager role.' });
      }
    }

    // Only the CEO may grant or alter a privileged role. Without this an admin
    // can promote themselves to superadmin and then approve their own change
    // requests, which would make this whole flow decorative — and it is the
    // escalation TESTING-CHECKLIST F5 (9.3a/b) already reports.
    if (updateData.role) {
      const privileged = ['admin', 'superadmin'];
      if ((privileged.includes(updateData.role) || privileged.includes(target.role))
          && req.user.role !== 'superadmin') {
        return res.status(403).json({
          success: false,
          message: 'Only the CEO can grant or change an admin or superadmin role.',
        });
      }
    }

    // Switching an account off (or back on) is a removal, not an edit, so it
    // waits for the CEO. Every other field — name, email, designation,
    // department, team — still applies immediately.
    let pendingRequest = null;
    if (updateData.active !== undefined) {
      const wanted = Boolean(updateData.active);
      delete updateData.active;

      if (wanted !== target.active) {
        const direct = canActDirectly(req.user.role);
        if (!direct && !canPropose(req.user.role)) return denyAddRemove(req, res, 'people');
        if (target.role === 'superadmin') {
          return res.status(403).json({ success: false, message: 'The CEO account cannot be deactivated.' });
        }
        if (direct) {
          // Put it straight back on the update — the CEO's decision is the
          // decision, and there is nobody above him to wait for.
          updateData.active = wanted;
        } else {
          if (await pendingTargetRequest('user', target._id)) {
            return res.status(400).json({ success: false, message: 'This account already has a change waiting for the CEO.' });
          }

          const action = wanted ? 'reactivate' : 'deactivate';
          pendingRequest = await submitRequest(req, {
            entity: 'user', action, target: target._id,
            targetLabel: `${target.name} (${target.empId})`,
            summary: describeUserRemoval(target, action),
          });
        }
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

    // Some of this edit landed and some of it is waiting, so say so rather
    // than reporting a plain success the CEO hasn't granted yet.
    if (pendingRequest) {
      return res.status(202).json({
        success: true, pending: true, user, request: pendingRequest,
        message: `Other changes saved. ${target.name} will be ${pendingRequest.action}d once the CEO approves.`,
      });
    }

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/users/:id/reset-password ────────────────────────────────
// The way back in for someone who has forgotten their password. PUT /:id
// strips `password` on purpose, and /auth/change-password needs the current
// one, so without this route a forgotten password has no in-app remedy at all.
//
// Deliberately not an email link: EMAIL_ENABLED is false until the sending
// domain is verified, so a mailed reset token would silently go nowhere. An
// admin setting the password and passing it on is what works today.
router.post('/:id/reset-password', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    }

    const target = await User.findById(req.params.id).select('+password');
    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Resetting someone's password is taking over their account, so the rules
    // are tighter than for editing one. Only a superadmin can reset another
    // superadmin — otherwise an admin could seize the top account, which is
    // the same escalation §9.3a already reports through the role field.
    if (target.role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ success: false, message: 'Only a superadmin can reset a superadmin password.' });
    }
    if (req.user.role === 'hr' && !['employee', 'manager'].includes(target.role)) {
      return res.status(403).json({ success: false, message: 'HR can only reset employee or manager passwords.' });
    }

    // save() so the pre-save hook hashes it — findByIdAndUpdate would store
    // the password in plain text and login would then never match it.
    target.password = newPassword;
    await target.save();

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'Password Reset',
      detail:   `Reset password for ${target.name} (${target.empId})`,
      ip:       req.ip,
    });

    res.json({ success: true, message: `Password reset for ${target.name}.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/users/:id ─────────────────────────────────────────────
// Deleting is now a request too, and it is the one that matters most: this
// removes the record outright and orphans that person's task history, so it
// should never be one click by one person.
router.delete('/:id', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const direct = canActDirectly(req.user.role);
    if (!direct && !canPropose(req.user.role)) return denyAddRemove(req, res, 'people');

    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
    }

    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    if (!direct && !['employee', 'manager'].includes(target.role)) {
      return res.status(403).json({ success: false, message: 'HR can only remove employee or manager accounts.' });
    }

    if (direct) {
      await User.findByIdAndDelete(target._id);
      await Audit.create({
        user:     req.user._id,
        userName: req.user.name,
        action:   'User Deleted',
        detail:   `Deleted user: ${target.name} (${target.empId})`,
        ip:       req.ip,
      });
      return res.json({ success: true, message: `${target.name} has been deleted.` });
    }

    if (await pendingTargetRequest('user', target._id)) {
      return res.status(400).json({ success: false, message: 'This account already has a change waiting for the CEO.' });
    }

    const request = await submitRequest(req, {
      entity: 'user', action: 'delete', target: target._id,
      targetLabel: `${target.name} (${target.empId})`,
      summary: describeUserRemoval(target, 'delete'),
    });

    return pendingResponse(res, request, `${target.name}'s record will be deleted`);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
