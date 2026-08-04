const mongoose = require('mongoose');

// A computed scorecard for one employee in one period. This doubles as the
// historical KPI record — the engine recomputes and upserts it while a period
// is open, and freezes it once a manager approves, so trend charts read from
// one collection instead of replaying task history for every request.
const MetricScoreSchema = new mongoose.Schema({
  key:    { type: String, required: true },
  label:  { type: String, required: true },
  weight: { type: Number, required: true },
  source: { type: String, enum: ['auto', 'manual'], required: true },

  // Which provider produced it, copied from the template. Lets rollups find
  // "the attendance metric" across departments that each label it differently.
  provider: { type: String, default: null },

  // null = no data available for this metric this period. Distinct from 0,
  // which means "measured, and the result was zero". The engine excludes nulls
  // from the weighted total rather than scoring them as 0 — see engine.js.
  score: { type: Number, default: null },

  // Human-readable provenance, e.g. "18 of 20 tasks completed". Shown verbatim
  // in the employee's breakdown so the score is never an unexplained number.
  detail: { type: String, default: '' },

  // Operands behind the score, when there are any.
  numerator:   { type: Number, default: null },
  denominator: { type: Number, default: null },
}, { _id: false });

const KpiScoreSchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  team:       { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },

  period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },

  template:        { type: mongoose.Schema.Types.ObjectId, ref: 'KpiTemplate' },
  templateVersion: { type: Number },

  metrics: { type: [MetricScoreSchema], default: [] },

  // Weighted 0–100, renormalised over metrics that actually had data.
  overall: { type: Number, default: null },

  // Share of template weight that resolved to a real number. An 88 at 60%
  // coverage is a different claim from an 88 at 100%, and the dashboards say
  // so — this is what stops a half-filled scorecard reading as fact.
  coverage: { type: Number, default: 0 },

  band: { type: String, enum: ['excellent', 'good', 'fair', 'poor', 'none'], default: 'none' },

  status: {
    type: String,
    enum: ['draft', 'pending-review', 'approved'],
    default: 'draft',
  },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },

  computedAt: { type: Date, default: Date.now },
}, { timestamps: true });

KpiScoreSchema.index({ user: 1, period: 1 }, { unique: true });
KpiScoreSchema.index({ period: 1, overall: -1 });
KpiScoreSchema.index({ department: 1, period: 1 });
KpiScoreSchema.index({ team: 1, period: 1 });

// Shared band thresholds — the UI colour-codes from this, so green/blue/orange/red
// is defined once here rather than duplicated in the client.
KpiScoreSchema.statics.bandFor = function (score) {
  if (score === null || score === undefined) return 'none';
  if (score >= 95) return 'excellent';
  if (score >= 80) return 'good';
  if (score >= 70) return 'fair';
  return 'poor';
};

module.exports = mongoose.model('KpiScore', KpiScoreSchema);
