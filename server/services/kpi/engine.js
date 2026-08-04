// ═══════════════════════════════════════════════════════════════════════
//  KPI ENGINE
//
//  Turns CRM data into scorecards. The whole module has exactly one code path
//  for producing a number — everything else (dashboards, reports, exports)
//  reads what this file wrote.
//
//  Designed around bulk: computing one employee and computing a thousand run
//  the same code, because the per-employee route just calls the batch function
//  with a single-element array. At 500–1000 employees a full monthly recompute
//  is four queries total, not four per person.
// ═══════════════════════════════════════════════════════════════════════

const Task              = require('../../models/Task');
const User              = require('../../models/User');
const KpiTemplate       = require('../../models/KpiTemplate');
const KpiScore          = require('../../models/KpiScore');
const KpiMetricInput    = require('../../models/KpiMetricInput');
const PerformanceReview = require('../../models/PerformanceReview');

const { PROVIDERS } = require('./providers');
const { periodRange, workingDays, isValidPeriod } = require('./period');

// Roles that get a scorecard. Admins and superadmin run the company rather
// than carry a departmental scorecard, so they're measured through their
// departments' numbers instead of their own.
const SCORED_ROLES = ['employee', 'manager', 'hr'];

// ── Stats ─────────────────────────────────────────────────────────────
// One aggregation produces every counter the providers need, for every
// requested employee, in one round-trip. New automatic metrics add a counter
// here; they never add a query.
async function buildTaskStats(userIds, period) {
  const { start, end } = periodRange(period);

  const rows = await Task.aggregate([
    { $match: { userId: { $in: userIds }, date: { $gte: start, $lte: end } } },
    {
      $addFields: {
        // Real deadline, falling back to the working day's end time for the
        // legacy rows that predate dueDate — mirrors what the task UI shows.
        _due: {
          $ifNull: ['$dueDate', {
            $dateFromString: {
              dateString: { $concat: ['$date', 'T', { $ifNull: ['$endTime', '17:00'] }, ':00Z'] },
              onError: null, onNull: null,
            },
          }],
        },
        // Lateness is measured against the submission, not the last edit, so a
        // typo fix next week doesn't retroactively make the work late.
        _sub: { $ifNull: ['$submittedAt', '$updatedAt'] },
        _done: { $eq: ['$status', 'completed'] },
      },
    },
    {
      $group: {
        _id: '$userId',
        total:     { $sum: 1 },
        completed: { $sum: { $cond: ['$_done', 1, 0] } },
        completedWithDue: {
          $sum: { $cond: [{ $and: ['$_done', { $ne: ['$_due', null] }] }, 1, 0] },
        },
        onTime: {
          $sum: {
            $cond: [
              { $and: ['$_done', { $ne: ['$_due', null] }, { $ne: ['$_sub', null] }, { $lte: ['$_sub', '$_due'] }] },
              1, 0,
            ],
          },
        },
        approved: { $sum: { $cond: ['$approved', 1, 0] } },
        rejected: { $sum: { $cond: ['$rejected', 1, 0] } },
        ratingSum:   { $sum: { $ifNull: ['$mgRating', 0] } },
        ratingCount: { $sum: { $cond: [{ $gt: ['$mgRating', 0] }, 1, 0] } },
        logDates: { $addToSet: '$date' },
      },
    },
  ]);

  const map = new Map();
  for (const r of rows) {
    map.set(String(r._id), {
      total: r.total,
      completed: r.completed,
      completedWithDue: r.completedWithDue,
      onTime: r.onTime,
      approved: r.approved,
      rejected: r.rejected,
      ratingSum: r.ratingSum,
      ratingCount: r.ratingCount,
      loggedDays: (r.logDates || []).length,
    });
  }
  return map;
}

const EMPTY_STATS = {
  total: 0, completed: 0, completedWithDue: 0, onTime: 0,
  approved: 0, rejected: 0, ratingSum: 0, ratingCount: 0, loggedDays: 0,
};

// ── Template resolution ───────────────────────────────────────────────
// Every employee resolves to a template: their department's, or the org-wide
// fallback (department: null). Nobody is left unscoreable because their
// department is new — that's what keeps "add a department" a template-only
// operation.
async function resolveTemplates() {
  const templates = await KpiTemplate.find({ active: true }).lean();
  const byDept = new Map();
  let fallback = null;
  for (const t of templates) {
    if (t.department) byDept.set(String(t.department), t);
    else fallback = t;
  }
  return {
    for(deptId) {
      return (deptId && byDept.get(String(deptId))) || fallback || null;
    },
    all: templates,
  };
}

// ── Scoring one employee ──────────────────────────────────────────────
function scoreEmployee(template, stats, ctx) {
  const metrics = [];

  for (const m of template.metrics) {
    let result = null;

    if (m.source === 'auto') {
      const provider = PROVIDERS[m.provider];
      // A template can outlive the provider it names (renamed, removed). Score
      // it as no-data rather than throwing — one stale metric must not take
      // down the whole department's dashboard.
      result = provider ? provider.compute(stats, ctx) : null;
    } else {
      const input = ctx.inputs.get(m.key);
      if (input) {
        if (m.inputMode === 'score' && typeof input.score === 'number') {
          result = {
            score: Math.max(0, Math.min(100, input.score)),
            detail: input.note || 'Entered manually',
            numerator: null, denominator: null,
          };
        } else if (typeof input.achieved === 'number' && input.target > 0) {
          const raw = (input.achieved / input.target) * 100;
          const unit = m.unit ? ` ${m.unit}` : '';
          result = {
            score: Math.max(0, Math.min(100, Math.round(raw * 10) / 10)),
            detail: `${input.achieved.toLocaleString()}${unit} of ${input.target.toLocaleString()}${unit} target (${Math.round(raw)}%)`,
            numerator: input.achieved, denominator: input.target,
          };
        }
      }
    }

    metrics.push({
      key: m.key,
      label: m.label,
      weight: m.weight,
      source: m.source,
      provider: m.provider || null,
      score: result ? result.score : null,
      detail: result ? result.detail : 'No data for this period',
      numerator: result ? result.numerator ?? null : null,
      denominator: result ? result.denominator ?? null : null,
    });
  }

  // Weighted average over metrics that produced a number, renormalised to the
  // weight that was actually measurable. See KpiScore.coverage for why.
  let weightWithData = 0;
  let weightedSum = 0;
  let weightTotal = 0;

  for (const m of metrics) {
    weightTotal += m.weight;
    if (m.score !== null) {
      weightWithData += m.weight;
      weightedSum += m.score * m.weight;
    }
  }

  const overall = weightWithData > 0
    ? Math.round((weightedSum / weightWithData) * 10) / 10
    : null;

  return {
    metrics,
    overall,
    coverage: weightTotal > 0 ? Math.round((weightWithData / weightTotal) * 100) : 0,
    band: KpiScore.bandFor(overall),
  };
}

// ── Batch computation ─────────────────────────────────────────────────
/**
 * Compute (and optionally persist) scorecards for a set of users.
 *
 * @param {Array}  users   Populated User docs — need _id, department, team.
 * @param {String} period  "YYYY-MM"
 * @param {Object} opts    { persist = true }
 * @returns {Array} plain scorecard objects, one per user
 */
async function computeForUsers(users, period, opts = {}) {
  const { persist = true } = opts;
  if (!isValidPeriod(period)) throw new Error(`Invalid period "${period}".`);
  if (!users.length) return [];

  const ids = users.map(u => u._id);

  const [templates, stats, reviews, inputs] = await Promise.all([
    resolveTemplates(),
    buildTaskStats(ids, period),
    PerformanceReview.find({ user: { $in: ids }, period }).lean(),
    KpiMetricInput.find({ user: { $in: ids }, period }).lean(),
  ]);

  const reviewByUser = new Map(reviews.map(r => [String(r.user), r]));
  const inputsByUser = new Map();
  for (const i of inputs) {
    const k = String(i.user);
    if (!inputsByUser.has(k)) inputsByUser.set(k, new Map());
    inputsByUser.get(k).set(i.metricKey, i);
  }

  const wd = workingDays(period).length;
  const results = [];
  const ops = [];

  for (const u of users) {
    const uid = String(u._id);
    const deptId = u.department?._id || u.department;
    const template = templates.for(deptId);
    if (!template) continue; // No templates configured at all yet.

    const ctx = {
      workingDays: wd,
      review: reviewByUser.get(uid) || null,
      inputs: inputsByUser.get(uid) || new Map(),
      period,
      user: u,
    };

    const scored = scoreEmployee(template, stats.get(uid) || EMPTY_STATS, ctx);

    const doc = {
      user: u._id,
      department: deptId || null,
      team: u.team?._id || u.team || null,
      period,
      template: template._id,
      templateVersion: template.version,
      ...scored,
      computedAt: new Date(),
    };

    results.push(doc);

    if (persist) {
      ops.push({
        updateOne: {
          filter: { user: u._id, period },
          // An approved scorecard is a signed-off record. Recomputing must not
          // silently rewrite it, so status/approvedBy/approvedAt are set only
          // on insert and left alone on every later recompute.
          update: {
            $set: {
              department: doc.department, team: doc.team,
              template: doc.template, templateVersion: doc.templateVersion,
              metrics: doc.metrics, overall: doc.overall,
              coverage: doc.coverage, band: doc.band,
              computedAt: doc.computedAt,
            },
            $setOnInsert: { user: u._id, period, status: 'draft' },
          },
          upsert: true,
        },
      });
    }
  }

  if (ops.length) await KpiScore.bulkWrite(ops, { ordered: false });

  return results;
}

// Convenience wrapper — same path, one user.
async function computeForUser(user, period, opts) {
  const [res] = await computeForUsers([user], period, opts);
  return res || null;
}

/**
 * Recompute an entire period. `filter` narrows the user set (e.g. by
 * department) for a targeted refresh after a template edit.
 */
async function recomputePeriod(period, filter = {}) {
  const users = await User.find({
    role: { $in: SCORED_ROLES }, active: true, ...filter,
  }).select('_id department team').lean();

  // Chunked so a 1000-employee recompute doesn't build one enormous $in or one
  // enormous bulkWrite. 200 keeps each aggregation comfortably small.
  const CHUNK = 200;
  let count = 0;
  for (let i = 0; i < users.length; i += CHUNK) {
    const batch = users.slice(i, i + CHUNK);
    const res = await computeForUsers(batch, period);
    count += res.length;
  }
  return { period, employees: count };
}

module.exports = {
  computeForUsers, computeForUser, recomputePeriod,
  resolveTemplates, buildTaskStats, scoreEmployee,
  SCORED_ROLES,
};
