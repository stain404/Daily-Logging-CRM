const mongoose = require('mongoose');

const OUTCOMES = ['Answered', 'No Answer', 'Busy', 'Voicemail', 'Wrong Number'];

const CallSchema = new mongoose.Schema({
  lead:     { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
  loggedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  calledAt: { type: Date, required: true, default: Date.now },
  duration: { type: Number, default: 0, min: 0 },  // minutes
  outcome:  { type: String, enum: OUTCOMES, required: true },
  notes:    { type: String, trim: true, default: '' },

  // No telephony provider is wired up yet (feasibility/cost still to be
  // decided) — this just leaves a slot for a recording link once one is.
  recordingUrl: { type: String, trim: true, default: '' },
}, { timestamps: true });

CallSchema.index({ lead: 1, calledAt: -1 });

const Call = mongoose.model('Call', CallSchema);
Call.OUTCOMES = OUTCOMES;
module.exports = Call;
