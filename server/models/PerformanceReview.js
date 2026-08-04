const mongoose = require('mongoose');

// The manual half of the scorecard: a manager's monthly read on an employee
// across six competencies, each 1–5. The engine turns the average into the
// 0–100 "Manager Review" metric, so this document is both an HR record and a
// KPI input — which is why it is versioned by period and not editable in place
// once the period's score has been approved.
const RATING = { type: Number, min: 1, max: 5 };

const PerformanceReviewSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // "YYYY-MM"
  period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },

  ratings: {
    communication:  { ...RATING, required: true },
    technical:      { ...RATING, required: true },
    initiative:     { ...RATING, required: true },
    teamwork:       { ...RATING, required: true },
    leadership:     { ...RATING, required: true },
    problemSolving: { ...RATING, required: true },
  },

  comments: { type: String, default: '', trim: true, maxlength: 4000 },

  // Denormalised 0–100 projection of `ratings`, written by the pre-save hook.
  // Kept on the document so ranking queries and CSV exports don't have to
  // recompute the same average across thousands of rows.
  score: { type: Number, min: 0, max: 100 },

  status:       { type: String, enum: ['draft', 'submitted'], default: 'submitted' },
  submittedAt:  { type: Date, default: Date.now },
}, { timestamps: true });

// One review per employee per period. Re-reviewing updates the existing row.
PerformanceReviewSchema.index({ user: 1, period: 1 }, { unique: true });
PerformanceReviewSchema.index({ reviewer: 1, period: 1 });

PerformanceReviewSchema.methods.computeScore = function () {
  const r = this.ratings || {};
  const vals = [
    r.communication, r.technical, r.initiative,
    r.teamwork, r.leadership, r.problemSolving,
  ].filter(v => typeof v === 'number');

  if (!vals.length) return null;
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  // 1–5 → 0–100. A 5 is 100, a 1 is 20 (not 0) — a 1 means "needs work",
  // not "contributed nothing", and zeroing it distorts the weighted total.
  return Math.round(avg * 20);
};

PerformanceReviewSchema.pre('save', function (next) {
  this.score = this.computeScore();
  next();
});

module.exports = mongoose.model('PerformanceReview', PerformanceReviewSchema);
