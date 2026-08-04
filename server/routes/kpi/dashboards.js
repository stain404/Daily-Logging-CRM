const express = require('express');
const router  = express.Router();

const KpiScore          = require('../../models/KpiScore');
const User              = require('../../models/User');
const PerformanceReview = require('../../models/PerformanceReview');

const { protect, authorize } = require('../../middleware/auth');
const { recomputePeriod, computeForUser, SCORED_ROLES } = require('../../services/kpi/engine');
const { buildSuggestions } = require('../../services/kpi/suggestions');
const { currentPeriod, isValidPeriod, shiftPeriod, formatPeriod } = require('../../services/kpi/period');
const analytics = require('../../services/kpi/analytics');
const scope     = require('../../services/kpi/scope');

// Above this many employees a cold-start recompute goes to the background and
// the dashboard returns immediately with `computing: true`; below it, the wait
// is short enough that computing inline gives a better first load than an
// empty dashboard the user has to refresh.
const INLINE_COMPUTE_LIMIT = 250;

function readPeriod(req, res) {
  const p = req.query.period || currentPeriod();
  if (!isValidPeriod(p)) {
    res.status(400).json({ success: false, message: `Invalid period "${p}" — expected YYYY-MM.` });
    return null;
  }
  return p;
}

/**
 * Make sure the period has scores before we aggregate over it. Returns
 * { computing } so the client can show "calculating…" rather than "0%", which
 * would otherwise be indistinguishable from genuinely terrible performance.
 */
async function ensurePeriodComputed(period, filter = {}) {
  const existing = await KpiScore.countDocuments({ period });
  if (existing > 0) return { computing: false };

  const pending = await User.countDocuments({ role: { $in: SCORED_ROLES }, active: true });
  if (pending === 0) return { computing: false };

  if (pending <= INLINE_COMPUTE_LIMIT) {
    await recomputePeriod(period, filter);
    return { computing: false };
  }

  recomputePeriod(period, filter).catch(err =>
    console.error('Background KPI compute failed:', err.message)
  );
  return { computing: true };
}

// ── GET /api/kpi/dashboard/ceo ────────────────────────────────────────
// Company-wide. Restricted to the roles that legitimately see everyone.
router.get('/ceo', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const period = readPeriod(req, res); if (!period) return;
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 2), 24);

    const { computing } = await ensurePeriodComputed(period);

    const [
      overview, prevOverview, departments, top, bottom,
      trendLine, deptTrend, attention, pending, ops,
    ] = await Promise.all([
      analytics.companyOverview(period),
      analytics.companyOverview(shiftPeriod(period, -1)),
      analytics.departmentRanking(period),
      analytics.employeeRanking(period, { order: 'desc', limit: 10 }),
      analytics.employeeRanking(period, { order: 'asc',  limit: 10 }),
      analytics.trend(period, months),
      analytics.trend(period, months, { groupByDepartment: true }),
      analytics.needingReview(period),
      analytics.pendingReviews(period, { limit: 12 }),
      analytics.operationalSummary(period),
    ]);

    res.json({
      success: true,
      period, periodLabel: formatPeriod(period), computing,
      overview: {
        ...overview,
        previousKpi: prevOverview.companyKpi,
        delta: overview.companyKpi !== null && prevOverview.companyKpi !== null
          ? Math.round((overview.companyKpi - prevOverview.companyKpi) * 10) / 10
          : null,
      },
      departments,
      topEmployees: top,
      lowestEmployees: bottom,
      trend: trendLine,
      departmentTrend: deptTrend,
      needingReview: attention,
      pendingReviews: pending,
      operations: ops,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/kpi/dashboard/manager ────────────────────────────────────
// Same aggregations, scoped to the manager's teams. HR/admin/superadmin hitting
// this endpoint get the company set, which makes it a usable fallback view.
router.get('/manager', protect, authorize('manager', 'hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const period = readPeriod(req, res); if (!period) return;
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 2), 24);

    const visible = await scope.visibleUserIds(req.user);
    const userFilter = visible.all ? {} : { user: { $in: visible.ids } };
    const visibleIds = visible.all ? null : visible.ids;

    const { computing } = await ensurePeriodComputed(
      period,
      visible.all ? {} : { _id: { $in: visible.ids } }
    );

    const reportIds = (await scope.directReports(req.user))
      .filter(id => String(id) !== String(req.user._id));

    const [
      overview, prevOverview, ranking, teams,
      trendLine, attention, pending, ops, reviewedCount,
    ] = await Promise.all([
      analytics.companyOverview(period, userFilter),
      analytics.companyOverview(shiftPeriod(period, -1), userFilter),
      analytics.employeeRanking(period, { userFilter, order: 'desc', limit: 100 }),
      analytics.teamRanking(period, userFilter),
      analytics.trend(period, months, { userFilter }),
      analytics.needingReview(period, { userFilter }),
      analytics.pendingReviews(period, { visibleIds: reportIds, limit: 50 }),
      analytics.operationalSummary(period, { visibleIds }),
      PerformanceReview.countDocuments({ period, user: { $in: reportIds } }),
    ]);

    res.json({
      success: true,
      period, periodLabel: formatPeriod(period), computing,
      scope: visible.all ? 'company' : 'team',
      overview: {
        ...overview,
        previousKpi: prevOverview.companyKpi,
        delta: overview.companyKpi !== null && prevOverview.companyKpi !== null
          ? Math.round((overview.companyKpi - prevOverview.companyKpi) * 10) / 10
          : null,
      },
      employees: ranking,
      teams,
      trend: trendLine,
      needingReview: attention,
      pendingReviews: pending,
      reviewsCompleted: reviewedCount,
      reviewsExpected: reportIds.length,
      operations: ops,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/kpi/dashboard/employee ───────────────────────────────────
// The signed-in user's own card. Every role has one.
router.get('/employee', protect, async (req, res) => {
  try {
    const period = readPeriod(req, res); if (!period) return;
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 2), 24);

    const me = await User.findById(req.user._id).select('_id department team role').lean();

    let score = await KpiScore.findOne({ user: req.user._id, period }).lean();
    if (!score && SCORED_ROLES.includes(me.role)) {
      await computeForUser(me, period);
      score = await KpiScore.findOne({ user: req.user._id, period }).lean();
    }

    const prevPeriod = shiftPeriod(period, -1);
    const [previous, history, reviews] = await Promise.all([
      KpiScore.findOne({ user: req.user._id, period: prevPeriod }).lean(),
      analytics.trend(period, months, { userFilter: { user: req.user._id } }),
      PerformanceReview.find({ user: req.user._id })
        .sort({ period: -1 }).limit(6)
        .populate('reviewer', 'name designation').lean(),
    ]);

    res.json({
      success: true,
      period, periodLabel: formatPeriod(period),
      score: score || null,
      previous: previous
        ? { period: previous.period, overall: previous.overall, band: previous.band }
        : null,
      delta: score?.overall !== null && score?.overall !== undefined && previous?.overall !== null && previous?.overall !== undefined
        ? Math.round((score.overall - previous.overall) * 10) / 10
        : null,
      history: history,
      reviews,
      suggestions: buildSuggestions(score, previous),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
