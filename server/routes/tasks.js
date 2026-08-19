const express = require('express');
const router  = express.Router();
const Task    = require('../models/Task');
const Team    = require('../models/Team');
const Audit   = require('../models/Audit');
const { protect, authorize } = require('../middleware/auth');
const User    = require('../models/User');
const { taskAssigned, taskSubmitted, taskReviewed, dailyUpdateSubmitted } = require('../services/notify');
const { orgToday, orgDaysAgo, orgTimeToDate } = require('../utils/orgTime');

// ── Helper: is this task past its deadline right now? ────────────────
// Falls back to date + endTime for rows created before dueDate existed. The
// fallback is read in the org's timezone — endTime is a wall clock the employee
// typed, not a UTC instant.
function isLate(task, at = new Date()) {
  const deadline = task.dueDate
    ? new Date(task.dueDate)
    : orgTimeToDate(task.date, task.endTime || '17:00');
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
      team, dept, submitted,
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

    // Team and department are filters over *people*, so they resolve to a set
    // of user ids and then intersect with whatever the role query already
    // allows. Intersecting rather than replacing matters: a manager filtering
    // by department must still only see their own team, not the department.
    if (team || dept) {
      const peopleQuery = {};
      if (dept) peopleQuery.department = dept;
      if (team) peopleQuery.team = team;
      const people = await User.find(peopleQuery).select('_id');
      let ids = people.map(u => u._id.toString());

      // Team membership is also held on the Team document, and the two are
      // set independently in this codebase — so check both or a filter can
      // come back empty for a team that plainly has members.
      if (team) {
        const teamDoc = await Team.findById(team).select('members');
        (teamDoc?.members || []).forEach(m => ids.push(m.toString()));
      }
      ids = [...new Set(ids)];

      if (query.userId && query.userId.$in) {
        const allowed = new Set(query.userId.$in.map(String));
        query.userId = { $in: ids.filter(id => allowed.has(id)) };
      } else if (query.userId) {
        query.userId = ids.includes(query.userId.toString()) ? query.userId : { $in: [] };
      } else {
        query.userId = { $in: ids };
      }
    }

    // Only entries an employee has actually reported work against. This is
    // what the review queue and the daily-work view are made of — an assigned
    // task nobody has touched yet is not an update.
    if (submitted === 'true')  query.submittedAt = { $ne: null };
    if (submitted === 'false') query.submittedAt = null;

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
    const todayStr = orgToday();
    const weekAgo  = orgDaysAgo(7);

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
    const todayStr = orgToday();

    // Deliberately no one-per-day guard. People genuinely work on several
    // things in a day, and forcing them into a single row meant the second
    // task either went unlogged or got appended to the first one's
    // description, where no report could ever count it.

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
    const { userId, date, title, description, project, priority, hours, estimateHours, dueDate } = req.body;

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

    const targetDate = date || orgToday();

    // A manager can hand someone several tasks for the same day — that is the
    // normal shape of a workload, and the previous one-per-day rule made the
    // second assignment fail with an error that read like a bug.

    const task = await Task.create({
      userId, date: targetDate, title, project,
      description: description || '',
      priority:    priority    || 'medium',
      // The estimate is the manager's; hours-worked stays the employee's and
      // starts empty. `hours` is still accepted for older clients.
      estimateHours: Number(estimateHours ?? hours) || 0,
      hours:         0,
      // Default the deadline to end of the working day the task covers, so
      // every assigned task has a real dueDate even if the form omits one.
      // 17:00 means 17:00 in the office, not 17:00 UTC.
      dueDate:     dueDate ? new Date(dueDate) : orgTimeToDate(targetDate, '17:00'),
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

// ── POST /api/tasks/daily-update ──────────────────────────────────────
// The one route by which an employee reports work. It carries a whole day's
// update — several entries at once — because that is how a day actually looks:
// some progress on two assigned tasks, plus something the employee picked up
// themselves that no manager knew to assign.
//
// Each entry is either:
//   • { taskId, ... }  progress against an existing task (assigned, or a
//                      self-initiated one already created earlier today), or
//   • { title, project, ... }  a new self-initiated entry.
//
// Everything is validated before anything is written. A partially-saved update
// is worse than a rejected one — the employee would have no way to tell which
// rows landed, and would re-submit the lot.
router.post('/daily-update', protect, async (req, res) => {
  try {
    const { entries } = req.body;

    if (!Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ success: false, message: 'Add at least one task to your update.' });
    }
    if (entries.length > 20) {
      return res.status(400).json({ success: false, message: 'A single daily update can hold at most 20 tasks.' });
    }

    const dateStr = orgToday();
    const STATUSES = ['completed', 'in-progress', 'not-started', 'delayed', 'on-hold'];
    const PRIORITIES = ['low', 'medium', 'high', 'critical'];

    // ── Pass 1: validate and resolve, writing nothing ──────────────────
    const plan = [];

    for (let i = 0; i < entries.length; i++) {
      const e   = entries[i];
      const pos = 'Task ' + (i + 1);

      if (!STATUSES.includes(e.status)) {
        return res.status(400).json({ success: false, message: pos + ': choose a status.' });
      }

      const hours = Number(e.hours);
      if (!isFinite(hours) || hours < 0 || hours > 24) {
        return res.status(400).json({ success: false, message: pos + ': hours worked must be between 0 and 24.' });
      }

      const completion = Math.max(0, Math.min(100, Number(e.completion) || 0));

      const fields = {
        description: (e.description || '').trim(),
        status:      e.status,
        hours,
        completion,
        challenges:  (e.challenges || '').trim(),
        support:     (e.support || '').trim() || 'No',
      };

      if (e.taskId) {
        const task = await Task.findById(e.taskId);
        if (!task) {
          return res.status(404).json({ success: false, message: pos + ': that task no longer exists.' });
        }
        if (task.userId.toString() !== req.user._id.toString()) {
          return res.status(403).json({ success: false, message: pos + ': that task is not yours to report on.' });
        }
        plan.push({ kind: 'update', task, fields });
      } else {
        const title   = (e.title || '').trim();
        const project = (e.project || '').trim();
        if (!title) {
          return res.status(400).json({ success: false, message: pos + ': give the work a title.' });
        }
        plan.push({
          kind: 'create',
          fields: {
            ...fields,
            title,
            // Self-initiated work often has no project attached to it, and
            // making someone invent one is exactly the friction this option
            // exists to remove.
            project:  project || 'Self-Initiated',
            priority: PRIORITIES.includes(e.priority) ? e.priority : 'medium',
            userId:   req.user._id,
            date:     dateStr,
            selfInitiated: true,
            submittedAt:   new Date(),
          },
        });
      }
    }

    // ── Pass 2: write ──────────────────────────────────────────────────
    const savedTasks = [];
    const firstTime  = [];   // entries that became a submission just now

    for (const item of plan) {
      if (item.kind === 'create') {
        const task = await Task.create(item.fields);
        savedTasks.push(task);
        firstTime.push(task);
        continue;
      }

      const { task, fields } = item;
      const isFirstSubmission = !task.submittedAt;
      Object.assign(task, fields);
      if (isFirstSubmission) task.submittedAt = new Date();
      await task.save();
      savedTasks.push(task);
      if (isFirstSubmission) firstTime.push(task);
    }

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'Daily Update Submitted',
      detail:   'Submitted a daily update covering ' + savedTasks.length +
                ' task' + (savedTasks.length === 1 ? '' : 's'),
      ip:       req.ip,
    });

    // One notification for the whole update rather than one per entry. A
    // manager with six people on a busy day would otherwise get twenty bells
    // for what is really six events. Not awaited — notify() swallows its own
    // errors and must never fail a submission.
    if (firstTime.length) {
      dailyUpdateSubmitted(req.user._id, req.user.name, firstTime, {
        late: firstTime.some(t => isLate(t, t.submittedAt)),
      });
    }

    const order = savedTasks.map(t => t._id.toString());
    const populated = (await Task.find({ _id: { $in: savedTasks.map(t => t._id) } })
      .populate('userId',     'name empId color initials designation')
      .populate('assignedBy', 'name'))
      // Returned in the order the client sent them. It matches each saved task
      // back to the row it came from so it can upload that row's attachments,
      // and $in gives no ordering guarantee at all.
      .sort((a, b) => order.indexOf(a._id.toString()) - order.indexOf(b._id.toString()));

    res.status(201).json({ success: true, count: populated.length, tasks: populated });
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

    // Nothing is reviewable until the employee has reported against it.
    // Approving an untouched assignment used to be one click away in the task
    // list, which quietly marked work done that nobody had started.
    if (!task.submittedAt) {
      return res.status(400).json({
        success: false,
        message: 'This task has not been submitted yet. It can be reviewed once the employee sends their daily update.',
      });
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
