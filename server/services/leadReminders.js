// Periodic check for the Sales CRM's follow-up reminders — the server-side
// half of what the sample-data prototype only ever simulated client-side.
// Nothing else in this codebase runs on a schedule yet (see the PR notes),
// so this is the first use of node-cron here.

const cron = require('node-cron');
const FollowUp = require('../models/FollowUp');
const { leadFollowUpDue, leadFollowUpOverdue } = require('./notify');

const REMINDER_LEAD_MINUTES = 60;  // remind this many minutes before it's due

async function checkFollowUps() {
  const now = new Date();
  const soon = new Date(now.getTime() + REMINDER_LEAD_MINUTES * 60000);

  const dueSoon = await FollowUp.find({
    status: 'pending', remindedAt: null, scheduledFor: { $gte: now, $lte: soon },
  }).populate('lead');
  for (const fu of dueSoon) {
    if (!fu.lead) continue;
    await leadFollowUpDue(fu.lead, fu);
    fu.remindedAt = new Date();
    await fu.save();
  }

  const overdue = await FollowUp.find({
    status: 'pending', overdueNotifiedAt: null, scheduledFor: { $lt: now },
  }).populate('lead');
  for (const fu of overdue) {
    if (!fu.lead) continue;
    await leadFollowUpOverdue(fu.lead, fu);
    fu.overdueNotifiedAt = new Date();
    await fu.save();
  }
}

function start() {
  cron.schedule('*/10 * * * *', () => {
    checkFollowUps().catch(err => console.error('[leadReminders] check failed:', err.message));
  });
  // Run once at boot too, so a reminder that fell due while the server was
  // down isn't left waiting up to 10 minutes after restart.
  checkFollowUps().catch(err => console.error('[leadReminders] initial check failed:', err.message));
}

module.exports = { start, checkFollowUps };
