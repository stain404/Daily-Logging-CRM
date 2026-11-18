const mongoose = require('mongoose');

const FollowUpSchema = new mongoose.Schema({
  lead:        { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
  assignedTo:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  scheduledFor:{ type: Date, required: true },
  note:        { type: String, trim: true, default: '' },
  status:      { type: String, enum: ['pending', 'done', 'rescheduled', 'cancelled'], default: 'pending' },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Set once the "due soon" / overdue email+in-app reminder has gone out, so
  // the periodic job in services/leadReminders.js never sends either twice.
  remindedAt:        { type: Date },
  overdueNotifiedAt: { type: Date },
}, { timestamps: true });

FollowUpSchema.index({ assignedTo: 1, status: 1, scheduledFor: 1 });
FollowUpSchema.index({ lead: 1, createdAt: -1 });

module.exports = mongoose.model('FollowUp', FollowUpSchema);
