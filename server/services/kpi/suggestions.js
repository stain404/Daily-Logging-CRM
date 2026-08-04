// Improvement suggestions for the employee dashboard.
//
// Deliberately rule-based and derived from the employee's own metric
// breakdown — each suggestion points at a specific weak metric and says what
// moving it is worth. Generic advice ("communicate more") would be noise; the
// point is that the employee can see which lever actually shifts their score.

const { PROVIDERS } = require('./providers');

const ADVICE = {
  taskCompletion:
    'Finish the tasks already assigned to you before taking on new ones — unfinished entries carry the largest single weight on your scorecard.',
  onTimeCompletion:
    'Several completed tasks landed after their deadline. Flag blockers to your manager early, or renegotiate the due date before it passes.',
  loggingCompliance:
    'Submit your daily update every working day. Missed days count against attendance even when the work was done.',
  taskApprovalRate:
    'Some entries were rejected on review. Add enough detail — what you did, blockers, and next steps — for your manager to approve first time.',
  avgTaskRating:
    'Your average task rating is below the top band. Ask your manager what a 5-star entry looks like on your current work.',
  managerReview:
    'Your competency review is the lowest-scoring part of your card. Ask your manager which of the six areas to focus on next month.',
};

const MANUAL_ADVICE =
  'This metric is entered by your manager. If it looks wrong, raise it with them — the underlying figures are recorded and can be corrected.';

/**
 * @param {Object} score      A KpiScore document (lean or hydrated).
 * @param {Object} previous   The prior period's score, if any — used to call
 *                            out regressions the raw number alone hides.
 * @returns {Array<{severity:string, metric:string, title:string, body:string, impact:number|null}>}
 */
function buildSuggestions(score, previous = null) {
  if (!score || !Array.isArray(score.metrics)) return [];

  const out = [];
  const prevByKey = new Map((previous?.metrics || []).map(m => [m.key, m.score]));

  const scored = score.metrics.filter(m => m.score !== null);

  for (const m of scored) {
    if (m.score >= 95) continue;

    // Points recoverable on the overall score by taking this metric to 100 —
    // the honest ranking signal. A 60 on a 40%-weight metric matters far more
    // than a 60 on a 5% one, and sorting by raw score would invert that.
    const totalWeight = score.metrics.reduce((s, x) => s + (x.score !== null ? x.weight : 0), 0);
    const impact = totalWeight
      ? Math.round(((100 - m.score) * m.weight / totalWeight) * 10) / 10
      : 0;

    if (impact < 0.5) continue;

    const before = prevByKey.get(m.key);
    const dropped = typeof before === 'number' && m.score < before - 5;

    out.push({
      severity: m.score < 70 ? 'high' : m.score < 85 ? 'medium' : 'low',
      metric: m.key,
      label: m.label,
      score: m.score,
      impact,
      title: dropped
        ? `${m.label} fell from ${before} to ${m.score}`
        : `${m.label} is at ${m.score}`,
      body: (m.source === 'auto' && ADVICE[m.provider]) || (m.source === 'manual' ? MANUAL_ADVICE : ADVICE[m.key]) ||
        `Improving ${m.label} would add up to ${impact} points to your overall KPI.`,
      detail: m.detail,
    });
  }

  // Coverage gaps aren't the employee's fault, but they are the reason a score
  // can look odd — saying so beats leaving them to guess.
  if (score.coverage < 100) {
    const missing = score.metrics.filter(m => m.score === null).map(m => m.label);
    if (missing.length) {
      out.push({
        severity: 'info',
        metric: '_coverage',
        label: 'Incomplete scorecard',
        score: null,
        impact: null,
        title: `${score.coverage}% of your scorecard has data this period`,
        body: `No figures were recorded yet for: ${missing.join(', ')}. Your KPI is averaged over the metrics that do have data, so it may move once these are entered.`,
        detail: '',
      });
    }
  }

  return out.sort((a, b) => (b.impact ?? -1) - (a.impact ?? -1));
}

/** Everything the employee's card needs to explain itself, keyed by provider. */
function metricGlossary() {
  return Object.fromEntries(
    Object.entries(PROVIDERS).map(([k, p]) => [k, p.description])
  );
}

module.exports = { buildSuggestions, metricGlossary };
