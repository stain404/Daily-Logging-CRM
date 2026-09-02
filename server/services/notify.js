const Notification = require('../models/Notification');
const User = require('../models/User');
const Team = require('../models/Team');
const mailer    = require('./mailer');
const templates = require('./emailTemplates');

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
async function notify(recipientIds, { type, title, message, task, attachment, actor, severity }) {
  try {
    const actorStr = actor ? actor.toString() : null;

    const unique = [...new Set(
      recipientIds.filter(Boolean).map(id => id.toString())
    )].filter(id => id !== actorStr);

    if (!unique.length) return [];

    // Returned so the caller can flip `emailed` on the right rows once the
    // send resolves — see markEmailed below.
    return await Notification.insertMany(unique.map(user => ({
      user, type, title,
      message:  message  || '',
      task:       task       || undefined,
      attachment: attachment || undefined,
      actor:      actor      || undefined,
      severity: severity || 'info',
    })));
  } catch (err) {
    console.error('[notify] failed to write notifications:', err.message);
    return [];
  }
}

// Flip `emailed` on the notifications belonging to people the email actually
// reached. Done as a second write rather than by awaiting the send first, so
// the bell never waits on SES — a slow provider would otherwise delay the
// in-app alert, which is the one that has to be instant.
async function markEmailed(docs, emailedIds) {
  try {
    if (!docs?.length || !emailedIds?.length) return;
    const reached = new Set(emailedIds.map(String));
    const ids = docs.filter(d => reached.has(d.user.toString())).map(d => d._id);
    if (ids.length) await Notification.updateMany({ _id: { $in: ids } }, { emailed: true });
  } catch (err) {
    console.error('[notify] failed to mark notifications as emailed:', err.message);
  }
}

// ── Event helpers ─────────────────────────────────────────────────────
// Each returns a promise the caller can await (or not) — they self-contain
// their own error handling via notify().
//
// These are also the single hook point for transactional email. Email is
// dispatched here rather than from the route handlers so that the recipient
// logic — supervisorsOf() in particular, which has to check two independent
// links — exists once and cannot drift between the in-app and email paths.
// mailer.sendToUser* swallow their own errors on the same contract as notify().

// A manager assigned a task. Only the assignee cares; per the agreed scope
// the CEO is not notified about routine hand-outs.
async function taskAssigned(task, actor, actorName) {
  const inApp = notify([task.userId], {
    type: 'assigned',
    title: 'New task assigned',
    message: `${actorName} assigned you "${task.title}"${
      task.dueDate ? ` — due ${new Date(task.dueDate).toDateString()}` : ''
    }.`,
    task: task._id,
    actor,
    severity: 'info',
  });

  const email = mailer.sendToUsers([task.userId], actor, {
    type: 'assigned',
    task,
    render: ({ recipientName, url }) => templates.taskAssigned({
      task, assignedByName: actorName, recipientName, url,
    }),
  });

  const [docs, emailedIds] = await Promise.all([inApp, email]);
  return markEmailed(docs, emailedIds);
}

// An employee submitted work. Goes to their supervisors — and to the CEO only
// when it is late.
//
// Routine submissions deliberately stop at the review chain. The CEO was on
// every one of these, which meant his bell was a running transcript of the
// whole company's day and the two things he actually had to act on — a missed
// deadline, a rejection — were indistinguishable from the noise. Escalation,
// not subscription: see also taskReviewed and dailyUpdateSubmitted.
async function taskSubmitted(task, actor, actorName, { late = false } = {}) {
  const sups   = await supervisorsOf(task.userId);
  const chiefs = late ? await ceos() : [];
  const recipients = [...sups, ...chiefs];

  const inApp = notify(recipients, {
    type: 'submitted',
    title: late ? 'Late submission' : 'Task submitted',
    message: `${actorName} submitted "${task.title}"${late ? ' after its deadline' : ''}.`,
    task: task._id,
    actor,
    severity: late ? 'warning' : 'info',
  });

  const email = mailer.sendToUsers(recipients, actor, {
    type: 'submitted',
    task,
    render: ({ url }) => templates.taskSubmitted({
      task, submittedByName: actorName, submittedAt: task.submittedAt, url, late,
    }),
  });

  const [docs, emailedIds] = await Promise.all([inApp, email]);
  return markEmailed(docs, emailedIds);
}

// A manager reviewed a submission. Goes to the task owner — and to the CEO
// only on a rejection, which is the one review outcome that signals something
// went wrong rather than something routine finishing normally.
async function taskReviewed(task, actor, actorName, action) {
  const chiefs = action === 'reject' ? await ceos() : [];
  const severity = action === 'approve' ? 'success'
                 : action === 'reject'  ? 'danger'
                 : 'info';
  const verb = action === 'approve' ? 'approved'
             : action === 'reject'  ? 'rejected'
             : 'requested clarification on';

  const inApp = notify([task.userId, ...chiefs], {
    type: 'reviewed',
    title: action === 'approve' ? 'Task approved'
         : action === 'reject'  ? 'Task rejected'
         : 'Clarification requested',
    message: `${actorName} ${verb} "${task.title}".`,
    task: task._id,
    actor,
    severity,
  });

  // Only the task owner is emailed. Emailing every superadmin on every
  // individual review turns the CEO's inbox into a firehose within a week;
  // he gets the in-app record on rejections and nothing on the rest.
  const email = mailer.sendToUsers([task.userId], actor, {
    type: 'reviewed',
    task,
    render: ({ url }) => templates.taskReviewed({
      task, reviewerName: actorName, action, url,
    }),
  });

  const [docs, emailedIds] = await Promise.all([inApp, email]);
  return markEmailed(docs, emailedIds);
}

// An employee submitted a whole daily update — several tasks at once.
//
// Collapsed into a single notification on purpose. The unit the reviewer cares
// about is "Priya reported today", not each row inside it; fanning one bell
// per task out to a manager with six reports produces twenty alerts for six
// events and trains them to ignore the bell entirely.
//
// The CEO is included only when the update is late, on the same escalation
// rule as taskSubmitted.
async function dailyUpdateSubmitted(userId, userName, tasks, { late = false } = {}) {
  if (!tasks?.length) return;

  const sups   = await supervisorsOf(userId);
  const chiefs = late ? await ceos() : [];
  const recipients = [...sups, ...chiefs];

  const n      = tasks.length;
  const plural = n === 1 ? 'task' : 'tasks';
  const submittedAt = new Date();

  const inApp = notify(recipients, {
    type: 'submitted',
    title: late ? 'Late daily update' : 'Daily update submitted',
    message: `${userName} reported work on ${n} ${plural}${late ? ', after the deadline' : ''}.`,
    // Linked to the first entry so the bell still deep-links somewhere useful.
    // There is no single task the update belongs to, which is the point.
    task: tasks[0]._id,
    actor: userId,
    severity: late ? 'warning' : 'info',
  });

  const email = mailer.sendToUsers(recipients, userId, {
    type: 'submitted',
    task: tasks[0],
    render: ({ url }) => templates.dailyUpdate({
      submittedByName: userName, tasks, submittedAt, url, late,
    }),
  });

  const [docs, emailedIds] = await Promise.all([inApp, email]);
  return markEmailed(docs, emailedIds);
}

// Someone shared a file. In-app only: an email carrying a link to a file the
// recipient must log in to fetch adds little, and file sharing is the one
// event here with no deadline attached to it.
async function fileShared(attachment, actor, actorName) {
  const isTask = attachment.kind === 'task-attachment';

  // A task attachment is addressed to the review chain rather than to named
  // people, so recipients is empty and we resolve them the same way a
  // submission does.
  const recipients = isTask && !attachment.recipients?.length
    ? await supervisorsOf(actor)
    : (attachment.recipients || []);

  return notify(recipients, {
    type: 'file-shared',
    title: isTask ? 'File attached to a task' : 'A file was sent to you',
    message: `${actorName} shared "${attachment.filename}"${
      attachment.note ? ` — ${attachment.note}` : ''
    }.`,
    task:       attachment.task || undefined,
    attachment: attachment._id,
    actor,
    severity:   'info',
  });
}

module.exports = {
  notify, markEmailed, supervisorsOf, ceos,
  taskAssigned, taskSubmitted, taskReviewed, dailyUpdateSubmitted, fileShared,
};
