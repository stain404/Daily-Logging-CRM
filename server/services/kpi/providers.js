// ═══════════════════════════════════════════════════════════════════════
//  AUTOMATIC METRIC PROVIDERS
//
//  The registry that makes the KPI module extensible without touching the
//  engine, the routes, or the client. A template metric with source:'auto'
//  names one of these keys; the engine hands it a pre-aggregated stats bucket
//  for one employee in one period and gets back a 0–100 score plus the
//  evidence behind it.
//
//  To add a new automatic metric: add an entry here, and if it needs a counter
//  that isn't in the bucket yet, add that counter to the single aggregation in
//  engine.js. Nothing else changes.
//
//  A provider returns null when the input simply doesn't exist for that
//  employee that period (no tasks assigned, no review filed). null is *not*
//  zero — the engine drops null metrics out of the weighted total and reports
//  the shortfall as coverage, because scoring "no data" as 0 punishes people
//  for gaps in the data rather than gaps in their work.
// ═══════════════════════════════════════════════════════════════════════

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

// Ratios can exceed 1 (finishing more than assigned, beating a target). We keep
// the raw figure in `detail` but cap the score, so one runaway month can't drag
// a weighted average above 100 and make the band colours meaningless.
const cap = v => (v === null ? null : Math.max(0, Math.min(100, v)));

const PROVIDERS = {
  taskCompletion: {
    label: 'Task Completion',
    description: 'Completed tasks ÷ tasks assigned in the period × 100.',
    compute(s) {
      if (!s.total) return null;
      const v = pct(s.completed, s.total);
      return {
        score: cap(v),
        detail: `${s.completed} of ${s.total} task${s.total === 1 ? '' : 's'} completed`,
        numerator: s.completed, denominator: s.total,
      };
    },
  },

  onTimeCompletion: {
    label: 'On-Time Completion',
    description: 'Tasks completed before their deadline ÷ completed tasks × 100.',
    compute(s) {
      // Denominator is completed tasks that actually carry a deadline — an
      // undated task can be neither early nor late, and counting it as late
      // would penalise employees for legacy rows with no dueDate.
      if (!s.completedWithDue) return null;
      const v = pct(s.onTime, s.completedWithDue);
      return {
        score: cap(v),
        detail: `${s.onTime} of ${s.completedWithDue} completed on or before deadline`,
        numerator: s.onTime, denominator: s.completedWithDue,
      };
    },
  },

  loggingCompliance: {
    label: 'Attendance (Daily Logging)',
    description:
      'Days with a submitted daily update ÷ working days in the period × 100. ' +
      'The CRM has no attendance module, so presence is inferred from daily log activity.',
    compute(s, ctx) {
      const wd = ctx.workingDays;
      if (!wd) return null;
      const days = Math.min(s.loggedDays, wd);
      const v = pct(days, wd);
      return {
        score: cap(v),
        detail: `Logged on ${days} of ${wd} working day${wd === 1 ? '' : 's'}`,
        numerator: days, denominator: wd,
      };
    },
  },

  taskApprovalRate: {
    label: 'Work Quality (Approval Rate)',
    description: 'Manager-approved entries ÷ reviewed entries × 100.',
    compute(s) {
      const reviewed = s.approved + s.rejected;
      if (!reviewed) return null;
      const v = pct(s.approved, reviewed);
      return {
        score: cap(v),
        detail: `${s.approved} of ${reviewed} reviewed entries approved`,
        numerator: s.approved, denominator: reviewed,
      };
    },
  },

  avgTaskRating: {
    label: 'Average Task Rating',
    description: 'Mean manager star rating on reviewed tasks, scaled 1–5 → 20–100.',
    compute(s) {
      if (!s.ratingCount) return null;
      const avg = s.ratingSum / s.ratingCount;
      return {
        score: cap(Math.round(avg * 20)),
        detail: `${avg.toFixed(1)} / 5 average over ${s.ratingCount} rated task${s.ratingCount === 1 ? '' : 's'}`,
        numerator: Math.round(avg * 10) / 10, denominator: 5,
      };
    },
  },

  managerReview: {
    label: 'Manager Review',
    description:
      'Monthly competency review (communication, technical, initiative, teamwork, ' +
      'leadership, problem solving), averaged and scaled 1–5 → 20–100.',
    compute(s, ctx) {
      const review = ctx.review;
      if (!review || typeof review.score !== 'number') return null;
      const r = review.ratings || {};
      const vals = ['communication', 'technical', 'initiative', 'teamwork', 'leadership', 'problemSolving']
        .map(k => r[k]).filter(v => typeof v === 'number');
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      return {
        score: cap(review.score),
        detail: `${avg.toFixed(1)} / 5 across ${vals.length} competencies`,
        numerator: Math.round(avg * 10) / 10, denominator: 5,
      };
    },
  },
};

// Shape the client uses to populate the "automatic metric" dropdown in the
// template editor — derived from the registry so the two can't drift.
function providerCatalogue() {
  return Object.entries(PROVIDERS).map(([key, p]) => ({
    key, label: p.label, description: p.description,
  }));
}

module.exports = { PROVIDERS, providerCatalogue };
