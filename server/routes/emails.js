const express  = require('express');
const router   = express.Router();
const EmailLog = require('../models/EmailLog');
const mailer   = require('../services/mailer');
const templates = require('../services/emailTemplates');
const { protect, authorize } = require('../middleware/auth');

// ── GET /api/emails/log ───────────────────────────────────────────────
// The troubleshooting view. Admin-only: the rows contain other people's email
// addresses, so this is not a self-serve endpoint.
router.get('/log', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const { status, type, user, limit } = req.query;
    const query = {};

    if (status) query.status = { $in: status.split(',') };
    if (type)   query.type   = { $in: type.split(',') };
    if (user)   query.user   = user;

    // Capped: this table grows with every task event and an uncapped find()
    // here would eventually be the slowest request in the app.
    const cap = Math.min(Number(limit) || 100, 500);

    const [logs, counts] = await Promise.all([
      EmailLog.find(query)
        .populate('user', 'name empId')
        .populate('task', 'title')
        .sort({ createdAt: -1 })
        .limit(cap),
      EmailLog.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);

    res.json({
      success: true,
      count: logs.length,
      // Totals across the whole table, not just this page — the point of the
      // view is spotting that e.g. 40 sends were skipped for want of an address.
      totals: Object.fromEntries(counts.map(c => [c._id, c.n])),
      logs,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/emails/config ────────────────────────────────────────────
// "Why is nothing sending?" answered without shell access to the host. Reports
// only the flags and the from-address — never credentials.
router.get('/config', protect, authorize('admin', 'superadmin'), async (req, res) => {
  const from   = process.env.MAIL_FROM || '';
  const appUrl = process.env.APP_URL   || '';

  res.json({
    success: true,
    config: {
      enabled:     mailer.ENABLED,
      fromAddress: from || null,
      region:      process.env.AWS_REGION || 'us-east-1',
      appUrl:      appUrl || null,
      // Credentials are resolved by the AWS SDK's own provider chain, so all
      // we can honestly report is whether the obvious env vars are present.
      hasCredentials: Boolean(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ROLE_ARN),
    },
    // Ordered worst-first: each of these makes email a no-op on its own.
    warnings: [
      !mailer.ENABLED && 'EMAIL_ENABLED is not "true" — every send is logged as dry-run and nothing leaves the server.',
      !from           && 'MAIL_FROM is unset — sends are forced to dry-run even if EMAIL_ENABLED is true.',
      !appUrl         && 'APP_URL is unset — emails render without a link back to the task.',
    ].filter(Boolean),
  });
});

// ── POST /api/emails/test ─────────────────────────────────────────────
// Sends a real (or dry-run) email to the caller's own address using the live
// template path, so a verified SES setup can be proven end to end without
// having to fabricate a task assignment. Deliberately cannot target anyone
// else — that would make this a spam relay.
router.post('/test', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    if (!req.user.email) {
      return res.status(400).json({
        success: false,
        message: 'Your account has no email address on file, so there is nowhere to send the test.',
      });
    }

    const fakeTask = {
      _id:         null,
      title:       'Test notification',
      description: 'This is a test email sent from the TaskFlow admin settings. No task was created.',
      project:     'System check',
      priority:    'low',
      dueDate:     null,
    };

    await mailer.sendToUser(req.user._id, {
      type:  'assigned',
      task:  null,
      render: ({ recipientName, url }) => templates.taskAssigned({
        task: fakeTask,
        assignedByName: 'TaskFlow',
        recipientName,
        url,
      }),
    });

    // The send is logged either way; read the outcome back rather than
    // asserting success, since a dry-run and a real send look identical here.
    const latest = await EmailLog.findOne({ user: req.user._id, type: 'assigned' })
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      status:  latest?.status || 'unknown',
      to:      latest?.to || req.user.email,
      message: latest?.status === 'sent'
        ? `Sent to ${latest.to}. Check your inbox, and the spam folder if it does not arrive.`
        : latest?.status === 'dry-run'
          ? 'Composed and logged as dry-run — nothing was sent. Set EMAIL_ENABLED=true and MAIL_FROM to send for real.'
          : `Not sent: ${latest?.status || 'unknown'}. ${latest?.error || ''}`.trim(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
