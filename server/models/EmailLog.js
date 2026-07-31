const mongoose = require('mongoose');

// One row per attempted email — including the ones we deliberately did not
// send. "Why did this person not get an email" is the question this table
// exists to answer, and the usual answer is a skip, not a failure, so skips
// get their own statuses rather than being folded into 'failed'.
const EmailLogSchema = new mongoose.Schema({
  // The address as it stood at send time. Denormalised on purpose: it has to
  // survive the user later changing their email, or being deleted outright.
  to: { type: String, default: '', lowercase: true, trim: true },

  // Nullable — the recipient may since have been deleted.
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Mirrors Notification.type so an in-app notification and its email
  // counterpart can be lined up when tracing an event.
  type: {
    type: String,
    enum: ['assigned', 'submitted', 'reviewed', 'overdue'],
    required: true,
  },
  subject: { type: String, default: '', trim: true },
  task:    { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },

  status: {
    type: String,
    enum: [
      'sent',                 // provider accepted it
      'failed',               // provider rejected it, or the call threw
      'dry-run',              // EMAIL_ENABLED is off — composed but not sent
      'skipped-no-address',   // User.email is optional; this is common
      'skipped-opted-out',    // user turned this notification type off
      'skipped-bounced',      // address previously hard-bounced
    ],
    required: true,
  },

  // SES message id. The only handle AWS support (or a bounce webhook) can
  // correlate against, so it is worth keeping even on success.
  providerId: { type: String, default: '' },
  error:      { type: String, default: '' },
  sentAt:     { type: Date },
}, { timestamps: true });

// "What did we try to send this person, newest first" — the support lookup.
EmailLogSchema.index({ user: 1, createdAt: -1 });
// The troubleshooting view: everything broken, newest first.
EmailLogSchema.index({ status: 1, createdAt: -1 });
// Correlating a bounce webhook back to the original send.
EmailLogSchema.index({ providerId: 1 });

module.exports = mongoose.model('EmailLog', EmailLogSchema);
