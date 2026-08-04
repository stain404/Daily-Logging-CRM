const mongoose = require('mongoose');

// A metric is one weighted line on a department's scorecard.
//
// `source` is the whole extensibility story: 'auto' metrics name a provider in
// services/kpi/providers.js and are computed from CRM data with no human input;
// 'manual' metrics are typed in by a manager/HR each period. Adding a department
// means writing a template — never touching the engine — and adding a *new kind
// of automatic metric* means registering one provider, not editing any route.
const MetricSchema = new mongoose.Schema({
  key:    { type: String, required: true, trim: true },
  label:  { type: String, required: true, trim: true },
  weight: { type: Number, required: true, min: 0, max: 100 },

  source: { type: String, enum: ['auto', 'manual'], required: true },

  // Required when source === 'auto'. Must match a key in the provider registry;
  // validated on save so a typo fails at template-edit time rather than silently
  // scoring every employee in the department as "no data" months later.
  provider: { type: String, trim: true },

  // Manual metrics only. 'score' = the reviewer types 0–100 directly.
  // 'ratio' = they type achieved + target, and the engine derives the score,
  // which is what keeps Revenue/Invoices/Purchase-Orders auditable rather than
  // a number someone eyeballed.
  inputMode: { type: String, enum: ['score', 'ratio'], default: 'ratio' },

  unit:        { type: String, default: '', trim: true },
  description: { type: String, default: '', trim: true },
}, { _id: false });

const KpiTemplateSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },

  // One active template per department. Null department = the org-wide fallback
  // used for anyone whose department has no template yet, so a new hire in a new
  // department still gets a score instead of an error.
  department: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department', default: null,
  },

  metrics:     { type: [MetricSchema], required: true },
  description: { type: String, default: '' },
  active:      { type: Boolean, default: true },

  // Bumped on every metric change. Stored on each KpiScore so a historical
  // score always says which scorecard produced it — without this, re-weighting
  // a template silently rewrites the meaning of last quarter's numbers.
  version:   { type: Number, default: 1 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// Only one active template per department (partial index so archived versions
// and multiple null-department drafts don't collide).
KpiTemplateSchema.index(
  { department: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);

// ── Validation ────────────────────────────────────────────────────────
// The spec's hard rule: weights must total exactly 100. Enforced in the model
// rather than the route so scripts, seeds and future callers can't bypass it.
KpiTemplateSchema.path('metrics').validate(function (metrics) {
  return Array.isArray(metrics) && metrics.length > 0;
}, 'A template needs at least one metric.');

KpiTemplateSchema.pre('validate', function (next) {
  const metrics = this.metrics || [];

  const keys = metrics.map(m => m.key);
  const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dupe) return next(new Error(`Duplicate metric key "${dupe}" in this template.`));

  const total = metrics.reduce((s, m) => s + (m.weight || 0), 0);
  // Rounded because weights arrive from a number input and 40+20+15+15+10 can
  // land on 99.99999999999999 in float arithmetic.
  if (Math.round(total * 100) / 100 !== 100) {
    return next(new Error(`Metric weights must total exactly 100% — this template totals ${total}%.`));
  }

  const { PROVIDERS } = require('../services/kpi/providers');
  for (const m of metrics) {
    if (m.source === 'auto') {
      if (!m.provider) {
        return next(new Error(`Metric "${m.label}" is automatic but names no provider.`));
      }
      if (!PROVIDERS[m.provider]) {
        return next(new Error(
          `Unknown KPI provider "${m.provider}" on metric "${m.label}". ` +
          `Available: ${Object.keys(PROVIDERS).join(', ')}.`
        ));
      }
    }
  }

  next();
});

module.exports = mongoose.model('KpiTemplate', KpiTemplateSchema);
