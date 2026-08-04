const mongoose = require('mongoose');

// Raw operand storage for manual metrics — Revenue vs Target, Invoices On Time
// vs Total, Correct POs vs Total, and so on.
//
// Deliberately stores the *operands*, not the finished percentage: keeping
// "1.8M of 2.0M" rather than "90" means the number can be audited, re-derived
// if a formula changes, and shown to the employee as evidence. When a CRM
// module later starts producing one of these figures for real, the metric flips
// from source:'manual' to source:'auto' in the template and this collection
// simply stops being written for it — no data migration.
const KpiMetricInputSchema = new mongoose.Schema({
  user:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },

  // Matches KpiTemplate.metrics[].key
  metricKey: { type: String, required: true, trim: true },

  // inputMode 'ratio' → achieved / target × 100 (capped by the engine).
  achieved: { type: Number, default: null },
  target:   { type: Number, default: null },

  // inputMode 'score' → straight 0–100.
  score: { type: Number, default: null, min: 0, max: 100 },

  note:      { type: String, default: '', trim: true, maxlength: 1000 },
  enteredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

// One value per employee, per period, per metric — upserted on re-entry.
KpiMetricInputSchema.index({ user: 1, period: 1, metricKey: 1 }, { unique: true });
KpiMetricInputSchema.index({ period: 1 });

module.exports = mongoose.model('KpiMetricInput', KpiMetricInputSchema);
