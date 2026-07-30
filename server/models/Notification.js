const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  // Recipient. Every notification belongs to exactly one user — a single
  // event (e.g. a submission) fans out into one document per recipient so
  // read state stays independent.
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', required: true,
  },
  type: {
    type: String,
    enum: ['assigned', 'submitted', 'reviewed', 'overdue'],
    required: true,
  },
  title:   { type: String, required: true, trim: true },
  message: { type: String, default: '', trim: true },

  // What it's about, and who caused it
  task:  { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Drives the accent colour on the client
  severity: {
    type: String,
    enum: ['info', 'success', 'warning', 'danger'],
    default: 'info',
  },
  read: { type: Boolean, default: false },
}, { timestamps: true });

// The only read pattern: this user's notifications, newest first.
NotificationSchema.index({ user: 1, createdAt: -1 });
// Unread badge count.
NotificationSchema.index({ user: 1, read: 1 });

module.exports = mongoose.model('Notification', NotificationSchema);
