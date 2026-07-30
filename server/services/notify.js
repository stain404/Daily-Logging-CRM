const Notification = require('../models/Notification');
const User = require('../models/User');
const Team = require('../models/Team');

// ── Who oversees a given employee ────────────────────────────────────
// Their directly-assigned manager, plus the manager of any team they are
// a member of. Both are checked because the two are set independently in
// this codebase and either one can be the only link that exists.
async function supervisorsOf(userId) {
  const ids = [];

  const [employee, teams] = await Promise.all([
    User.findById(userId).select('manager'),
    Team.find({ members: userId }).select('manager'),
  ]);

  if (employee && employee.manager) ids.push(employee.manager);
  teams.forEach(t => { if (t.manager) ids.push(t.manager); });

  return ids;
}

// ── The CEO ───────────────────────────────────────────────────────────
// Modelled as the superadmin role. Returns every active holder, so the
// org can have more than one without this needing to change.
async function ceos() {
  const admins = await User.find({ role: 'superadmin', active: true }).select('_id');
  return admins.map(u => u._id);
}

// ── Fan a single event out to a set of recipients ─────────────────────
// One document per recipient so read state is independent. Deduplicates,
// and never notifies the person who caused the event.
//
// Failures are swallowed deliberately: a notification is never important
// enough to fail the task write that triggered it. Same contract as the
// audit logger in middleware/auth.js.
async function notify(recipientIds, { type, title, message, task, actor, severity }) {
  try {
    const actorStr = actor ? actor.toString() : null;

    const unique = [...new Set(
      recipientIds.filter(Boolean).map(id => id.toString())
    )].filter(id => id !== actorStr);

    if (!unique.length) return;

    await Notification.insertMany(unique.map(user => ({
      user, type, title,
      message:  message  || '',
      task:     task     || undefined,
      actor:    actor    || undefined,
      severity: severity || 'info',
    })));
  } catch (err) {
    console.error('[notify] failed to write notifications:', err.message);
  }
}

// ── Event helpers ─────────────────────────────────────────────────────
// Each returns a promise the caller can await (or not) — they self-contain
// their own error handling via notify().

// A manager assigned a task. Only the assignee cares; per the agreed scope
// the CEO is not notified about routine hand-outs.
async function taskAssigned(task, actor, actorName) {
  return notify([task.userId], {
    type: 'assigned',
    title: 'New task assigned',
    message: `${actorName} assigned you "${task.title}"${
      task.dueDate ? ` — due ${new Date(task.dueDate).toDateString()}` : ''
    }.`,
    task: task._id,
    actor,
    severity: 'info',
  });
}

// An employee submitted work. Goes to their supervisors and to the CEO.
async function taskSubmitted(task, actor, actorName, { late = false } = {}) {
  const [sups, chiefs] = await Promise.all([supervisorsOf(task.userId), ceos()]);
  return notify([...sups, ...chiefs], {
    type: 'submitted',
    title: late ? 'Late submission' : 'Task submitted',
    message: `${actorName} submitted "${task.title}"${late ? ' after its deadline' : ''}.`,
    task: task._id,
    actor,
    severity: late ? 'warning' : 'info',
  });
}

// A manager reviewed a submission. Goes to the task owner and to the CEO.
async function taskReviewed(task, actor, actorName, action) {
  const chiefs = await ceos();
  const severity = action === 'approve' ? 'success'
                 : action === 'reject'  ? 'danger'
                 : 'info';
  const verb = action === 'approve' ? 'approved'
             : action === 'reject'  ? 'rejected'
             : 'requested clarification on';

  return notify([task.userId, ...chiefs], {
    type: 'reviewed',
    title: action === 'approve' ? 'Task approved'
         : action === 'reject'  ? 'Task rejected'
         : 'Clarification requested',
    message: `${actorName} ${verb} "${task.title}".`,
    task: task._id,
    actor,
    severity,
  });
}

module.exports = { notify, supervisorsOf, ceos, taskAssigned, taskSubmitted, taskReviewed };
