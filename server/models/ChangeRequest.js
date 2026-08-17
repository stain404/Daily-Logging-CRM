const mongoose = require('mongoose');

// A proposed addition or removal to the org chart, waiting on the CEO.
//
// Adding and removing people, teams and departments is HR's job to propose and
// the CEO's to approve — nothing happens to the real collections until an
// approval lands. Everything needed to carry the change out later lives on the
// request itself, because the world can move between the proposal and the
// decision (the department HR picked can be deleted, the employee can already
// be gone), and the applier has to fail cleanly rather than half-apply.
//
// Ordinary edits are NOT modelled here — renaming someone, fixing an email,
// moving them between teams stays instant for HR. Only add and remove wait.
const ChangeRequestSchema = new mongoose.Schema({
  entity: {
    type: String,
    enum: ['user', 'team', 'department'],
    required: true,
  },
  action: {
    type: String,
    enum: ['create', 'delete', 'deactivate', 'reactivate'],
    required: true,
  },

  // For `create`: the full body the route would have passed to Model.create().
  // For a user, `payload.password` is ALREADY BCRYPT-HASHED — a pending request
  // can sit in the database for days and must never hold a plaintext password.
  // models/User.js honours `$locals.passwordPreHashed` so the applier can save
  // it without hashing the hash. Mixed, because the three entities have
  // genuinely different shapes and validating them twice buys nothing.
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },

  // For `delete` / `deactivate` / `reactivate`: what it points at.
  target: { type: mongoose.Schema.Types.ObjectId },

  // Human-readable snapshot of the target, taken when the request was raised.
  // Kept so the CEO's list still reads correctly after the target is gone —
  // an approved deletion would otherwise show a blank row.
  targetLabel: { type: String, default: '' },

  // One line describing the whole request, also built at request time. Same
  // reason: the list must stay readable without re-resolving anything.
  summary: { type: String, required: true, trim: true },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'failed', 'withdrawn'],
    default: 'pending',
  },

  requestedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requestedByName: { type: String, default: '' },

  decidedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  decidedByName: { type: String, default: '' },
  decidedAt:     { type: Date },
  decisionNote:  { type: String, default: '', trim: true },

  // What the approval actually produced, for creates.
  resultId: { type: mongoose.Schema.Types.ObjectId },

  // Why an approved request could not be carried out — the department was
  // deleted while the request sat pending, the empId got taken, and so on.
  // `status: 'failed'` plus this string is what the CEO and HR both see.
  failureReason: { type: String, default: '' },
}, { timestamps: true });

// The CEO's queue: pending first, newest first.
ChangeRequestSchema.index({ status: 1, createdAt: -1 });
// HR checking on what they raised.
ChangeRequestSchema.index({ requestedBy: 1, createdAt: -1 });

module.exports = mongoose.model('ChangeRequest', ChangeRequestSchema);
