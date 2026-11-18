const mongoose = require('mongoose');

// The per-lead activity timeline the spec asks for (calls, notes, status
// changes, reassignments) — kept separate from the company-wide Audit log,
// which still gets an entry for the handful of sensitive actions (reassign,
// delete) that belong in both places.
const LeadActivitySchema = new mongoose.Schema({
  lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
  type: {
    type: String,
    enum: [
      'created', 'updated', 'status_change', 'call', 'reassignment',
      'followup_scheduled', 'followup_done', 'followup_rescheduled', 'followup_cancelled',
    ],
    required: true,
  },
  actor:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  detail: { type: String, default: '' },
}, { timestamps: true });

LeadActivitySchema.index({ lead: 1, createdAt: -1 });

module.exports = mongoose.model('LeadActivity', LeadActivitySchema);
