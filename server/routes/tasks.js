const express = require('express');
const router  = express.Router();
const Task    = require('../models/Task');
const Team    = require('../models/Team');
const Audit   = require('../models/Audit');
const { protect, authorize } = require('../middleware/auth');
const { taskAssigned, taskSubmitted, taskReviewed } = require('../services/notify');

// ── Helper: is this task past its deadline right now? ────────────────
// Falls back to date + endTime for rows created before dueDate existed.
function isLate(task, at = new Date()) {
  const deadline = task.dueDate
    ? new Date(task.dueDate)
    : new Date(`${task.date}T${task.endTime || '17:00'}`);
  return !isNaN(deadline) && at > deadline;
}

// ── Helper: build the correct MongoDB query based on role ────────────
async function getTaskQuery(user) {
  if (user.role === 'superadmin' || user.role === 'admin') {
    return {};
  }
  if (user.role === 'manager') {
    const teams     = await Team.find({ manager: user._id });
    const memberIds = teams.flatMap(t => t.members);
    return { userId: { $in: memberIds } };
  }
  // employee — own tasks only
  return { userId: user._id };
}

// ── GET /api/tasks ────────────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    const {
      status, priority, date, userId,
      from, to,
      page  = 1,
      limit = 50,
    } = req.query;

    const query = await getTaskQuery(req.user);

    if (status)   query.status   = status;
    if (priority) query.priority = priority;

    // Date filtering — exact date OR range
    if (date) {
      query.date = date;
    } else if (from || to) {
      query.date = {};
      if (from) query.date.$gte = from;
      if (to)   query.date.$lte = to;
    }

    // Allow filtering by specific userId (admins / managers only)
    if (userId && ['admin', 'superadmin', 'manager'].includes(req.user.role)) {
      query.userId = userId;
    }

    const total = await Task.countDocuments(query);
    const tasks = await Task.find(query)
      .populate('userId',     'name empId email color initials designation')
      .populate('reviewedBy', 'name')
      .populate('assignedBy', 'name')
      .sort({ date: -1, createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    res.json({ success: true, count: tasks.length, total, page: Number(page), tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/tasks/stats/summary ─────────────────────────────────────
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const query   = await getTaskQuery(req.user);
    const todayStr = new Date().toISOString().split('T')[0];
    const weekAgo  = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

    const [total, todayCount, weekCount, byStatus] = await Promise.all([
      Task.countDocuments(query),
      Task.countDocuments({ ...query, date: todayStr }),
      Task.countDocuments({ ...query, date: { $gte: weekAgo } }),
      Task.aggregate([
        { $match: query },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    const statusMap = {};
    byStatus.forEach(s => { statusMap[s._id] = s.count; });

    res.json({
      success: true,
      stats: {
        total,
        todayCount,
        weekCount,
        completed:      statusMap['completed']    || 0,
        inProgress:     statusMap['in-progress']  || 0,
        notStarted:     statusMap['not-started']  || 0,
        delayed:        statusMap['delayed']       || 0,
        onHold:         statusMap['on-hold']       || 0,
        completionRate: total
          ? Math.round(((statusMap['completed'] || 0) / total) * 100)
          : 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/tasks ───────────────────────────────────────────────────
router.post('/', protect, async (req, res) => {
  try {
    const todayStr = new Date().toISOString().split('T')[0];

    // One submission per employee per day
    const existing = await Task.findOne({ userId: req.user._id, date: todayStr });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: "You have already submitted a daily update today. Use the edit option to update it.",
      });
    }

    // Self-submitted updates always start unreviewed — approval/rating fields
    // can only be set later by a manager/admin via the review endpoint.
    const {
      approved, rejected, mgComment, mgRating, reviewedBy, reviewedAt, assignedBy,
      ...safeBody
    } = req.body;

    const task = await Task.create({
      ...safeBody,
      userId:      req.user._id,
      date:        todayStr,
      submittedAt: new Date(),
    });

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'Task Created',
      detail:   `Submitted daily update: "${task.title}"`,
      ip:       req.ip,
    });

    // Notify supervisors + CEO. Not awaited on the critical path — notify()
    // swallows its own errors, so this can never fail the submission.
    taskSubmitted(task, req.user._id, req.user.name, { late: isLate(task) });

    const populated = await Task.findById(task._id)
      .populate('userId', 'name empId color initials designation');

    res.status(201).json({ success: true, task: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/tasks/assign ────────────────────────────────────────────
// A manager (or admin/superadmin) assigns a task to a specific team member.
router.post('/assign', protect, authorize('manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { userId, date, title, description, project, priority, hours, dueDate } = req.body;

    if (!userId || !title || !project) {
      return res.status(400).json({ success: false, message: 'userId, title, and project are required.' });
    }

    // Managers may only assign tasks to members of a team they manage.
    if (req.user.role === 'manager') {
      const teams     = await Team.find({ manager: req.user._id });
      const memberIds = teams.flatMap(t => t.members.map(m => m.toString()));
      if (!memberIds.includes(userId)) {
        return res.status(403).json({ success: false, message: 'You can only assign tasks to members of your own team.' });
      }
    }

    const targetDate = date || new Date().toISOString().split('T')[0];

    const existing = await Task.findOne({ userId, date: targetDate });
    if (existing) {
      return res.status(400).json({ success: false, message: 'This employee already has a task entry for that date.' });
    }

    const task = await Task.create({
      userId, date: targetDate, title, project,
      description: description || '',
      priority:    priority    || 'medium',
      hours:       hours       || 0,
      // Default the deadline to end of the working day the task covers, so
      // every assigned task has a real dueDate even if the form omits one.
      dueDate:     dueDate ? new Date(dueDate) : new Date(`${targetDate}T17:00`),
      status:      'not-started',
      completion:  0,
      assignedBy:  req.user._id,
    });

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'Task Assigned',
      detail:   `Assigned "${task.title}" to a team member`,
      ip:       req.ip,
    });

    taskAssigned(task, req.user._id, req.user.name);

    const populated = await Task.findById(task._id)
      .populate('userId',     'name empId color initials designation')
      .populate('assignedBy', 'name');

    res.status(201).json({ success: true, task: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/tasks/:id ────────────────────────────────────────────────
router.put('/:id', protect, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    const isOwner   = task.userId.toString() === req.user._id.toString();
    const isPriv    = ['admin', 'superadmin'].includes(req.user.role);

    if (!isOwner && !isPriv) {
      return res.status(403).json({ success: false, message: 'You are not authorised to edit this task.' });
    }

    // Employees (and HR, who submit updates the same way) cannot alter approval
    // status, nor move their own deadline.
    if (['employee', 'hr'].includes(req.user.role)) {
      delete req.body.approved;
      delete req.body.rejected;
      delete req.body.mgComment;
      delete req.body.mgRating;
      delete req.body.reviewedBy;
      delete req.body.reviewedAt;
      delete req.body.assignedBy;
      delete req.body.dueDate;
      delete req.body.submittedAt;
    }

    // First real submission against an assigned task: the owner has moved it
    // off not-started or logged progress. Stamped once so repeat edits don't
    // re-notify, and so lateness is measured from the original submission.
    const isFirstSubmission = isOwner
      && !task.submittedAt
      && (
        (req.body.completion !== undefined && Number(req.body.completion) > 0) ||
        (req.body.status !== undefined && req.body.status !== 'not-started')
      );

    if (isFirstSubmission) req.body.submittedAt = new Date();

    const updated = await Task.findByIdAndUpdate(req.params.id, req.body, {
      new: true, runValidators: true,
    }).populate('userId', 'name empId color initials');

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'Task Updated',
      detail:   `Updated task: "${updated.title}"`,
      ip:       req.ip,
    });

    if (isFirstSubmission) {
      taskSubmitted(updated, req.user._id, req.user.name, {
        late: isLate(updated, updated.submittedAt),
      });
    }

    res.json({ success: true, task: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/tasks/:id/review ─────────────────────────────────────────
router.put('/:id/review', protect, authorize('manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { action, comment, rating } = req.body;

    if (!['approve', 'reject', 'clarify'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid review action. Must be approve, reject, or clarify.' });
    }

    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    if (action === 'approve') {
      task.approved   = true;
      task.rejected   = false;
    } else if (action === 'reject') {
      task.rejected   = true;
      task.approved   = false;
    }
    // 'clarify' only sets a comment — does not change approval state

    task.mgComment  = comment  || (action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : '');
    task.mgRating   = rating   || null;
    task.reviewedBy = req.user._id;
    task.reviewedAt = new Date();
    await task.save();

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   `Task ${action.charAt(0).toUpperCase() + action.slice(1)}d`,
      detail:   `"${task.title}" was ${action}d`,
      ip:       req.ip,
    });

    taskReviewed(task, req.user._id, req.user.name, action);

    const populated = await Task.findById(task._id)
      .populate('userId',     'name empId color initials')
      .populate('reviewedBy', 'name');

    res.json({ success: true, task: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/tasks/:id/clear-review ──────────────────────────────────
// Wipes manager feedback fields and resets approval state back to pending.
// Only the manager/admin/superadmin who left the review (or any admin) can clear it.
router.put('/:id/clear-review', protect, authorize('manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    task.approved   = false;
    task.rejected   = false;
    task.mgComment  = '';
    task.mgRating   = undefined;
    task.reviewedBy = undefined;
    task.reviewedAt = undefined;
    await task.save();

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'Review Cleared',
      detail:   `Cleared review/feedback for task: "${task.title}"`,
      ip:       req.ip,
    });

    const populated = await Task.findById(task._id)
      .populate('userId',     'name empId color initials')
      .populate('reviewedBy', 'name');

    res.json({ success: true, task: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/tasks/:id ─────────────────────────────────────────────
router.delete('/:id', protect, authorize('manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'Task Deleted',
      detail:   `Deleted task: "${task.title}"`,
      ip:       req.ip,
    });

    res.json({ success: true, message: 'Task deleted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
