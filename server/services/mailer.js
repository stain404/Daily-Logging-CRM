const EmailLog = require('../models/EmailLog');
const User     = require('../models/User');

// ── Config ────────────────────────────────────────────────────────────
// EMAIL_ENABLED defaults to OFF, and that default is load-bearing. The seed
// data in server.js creates a dozen users on fake @company.com addresses; a
// single task assignment against seeded data with live sending on would hard-
// bounce them all and drop the SES account straight back into the sandbox.
// Turning this on is a deliberate act performed once the domain is verified
// and the fake addresses are gone.
const ENABLED   = process.env.EMAIL_ENABLED === 'true';
const FROM_ADDR = process.env.MAIL_FROM      || '';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'TaskFlow';
const REGION    = process.env.AWS_REGION     || 'us-east-1';
const APP_URL   = (process.env.APP_URL || '').replace(/\/+$/, '');

// Which preference field governs which event.
const PREF_KEY = {
  assigned:  'emailTaskAssigned',
  submitted: 'emailTaskSubmitted',
  reviewed:  'emailTaskReviewed',
};

// Roles that cannot opt out of submission alerts. Enforced here rather than in
// the UI because the client is a static file any user can edit — the toggle in
// Settings is a courtesy, this is the rule.
const REVIEW_ROLES = ['manager', 'admin', 'superadmin'];

function isMandatory(user, type) {
  return type === 'submitted' && REVIEW_ROLES.includes(user.role);
}

// ── SES client ────────────────────────────────────────────────────────
// Constructed lazily so the module can be required (and dry-run sends logged)
// on a machine with no AWS credentials configured at all.
let _client = null;
function sesClient() {
  if (!_client) {
    const { SESv2Client } = require('@aws-sdk/client-sesv2');
    _client = new SESv2Client({ region: REGION });
  }
  return _client;
}

// ── Deep links ────────────────────────────────────────────────────────
// The client is a single index.html with no router, so a task link is a query
// param the page reads on load (see the openDeepLink() handler in
// client/index.html). Returns '' when APP_URL is unset, and the templates
// then omit the button rather than rendering a dead one.
function taskUrl(taskId) {
  if (!APP_URL || !taskId) return '';
  return `${APP_URL}/?task=${encodeURIComponent(taskId.toString())}`;
}

// Mongoose gives us ObjectIds, populated documents, or plain strings depending
// on the call site — routes/tasks.js does all three. Normalise before use.
function idOf(v) {
  if (!v) return null;
  return v._id ? v._id : v;
}

async function log(entry) {
  try {
    await EmailLog.create(entry);
  } catch (err) {
    console.error('[mailer] failed to write EmailLog:', err.message);
  }
}

// ── Send one email to one user ────────────────────────────────────────
// Resolves the recipient, applies the skip rules in order, and records exactly
// one EmailLog row per call whatever the outcome.
//
// Never throws and never rejects. Callers sit on the task-write path, and the
// contract there is the same one services/notify.js documents: a notification
// is never important enough to fail the write that triggered it.
async function sendToUser(userRef, { type, task, render }) {
  try {
    const userId = idOf(userRef);
    if (!userId) return;

    const user = await User.findById(userId)
      .select('name email role notificationPrefs emailBounced');
    if (!user) return;

    const base = { user: user._id, type, task: idOf(task) || undefined };

    // 1. No address. Common by design — User.email is sparse and optional.
    if (!user.email) {
      return log({ ...base, to: '', status: 'skipped-no-address' });
    }

    // 2. Address is known bad.
    if (user.emailBounced) {
      return log({ ...base, to: user.email, status: 'skipped-bounced' });
    }

    // 3. Opted out, unless this type is mandatory for their role.
    const prefKey = PREF_KEY[type];
    const optedIn = !prefKey || user.notificationPrefs?.[prefKey] !== false;
    if (!optedIn && !isMandatory(user, type)) {
      return log({ ...base, to: user.email, status: 'skipped-opted-out' });
    }

    // Render only once we know we have a live recipient.
    const { subject, html, text } = render({
      recipientName: user.name,
      url: taskUrl(idOf(task)),
    });

    // 4. Dry run — compose and log, send nothing.
    if (!ENABLED || !FROM_ADDR) {
      return log({ ...base, to: user.email, subject, status: 'dry-run' });
    }

    // 5. Actually send.
    const { SendEmailCommand } = require('@aws-sdk/client-sesv2');
    const out = await sesClient().send(new SendEmailCommand({
      FromEmailAddress: `${FROM_NAME} <${FROM_ADDR}>`,
      Destination: { ToAddresses: [user.email] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: html, Charset: 'UTF-8' },
            Text: { Data: text, Charset: 'UTF-8' },
          },
        },
      },
    }));

    return log({
      ...base, to: user.email, subject,
      status: 'sent', providerId: out.MessageId || '', sentAt: new Date(),
    });
  } catch (err) {
    console.error('[mailer] send failed:', err.message);
    return log({
      user: idOf(userRef) || undefined,
      task: idOf(task) || undefined,
      type,
      to: '',
      status: 'failed',
      error: err.message.slice(0, 500),
    });
  }
}

// Fan one event out to many recipients. Deduplicated, and the actor is never
// emailed about their own action — same rule notify() applies in-app.
async function sendToUsers(userRefs, actorRef, opts) {
  const actorId = idOf(actorRef)?.toString();
  const unique = [...new Set(
    userRefs.map(idOf).filter(Boolean).map(id => id.toString())
  )].filter(id => id !== actorId);

  return Promise.all(unique.map(id => sendToUser(id, opts)));
}

module.exports = { sendToUser, sendToUsers, taskUrl, isMandatory, ENABLED, PREF_KEY, REVIEW_ROLES };
