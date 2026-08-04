const express = require('express');
const router  = express.Router();

const KpiScore = require('../../models/KpiScore');
const User     = require('../../models/User');

const { protect, authorize, auditLog } = require('../../middleware/auth');
const { computeForUser, recomputePeriod, SCORED_ROLES } = require('../../services/kpi/engine');
const { buildSuggestions } = require('../../services/kpi/suggestions');
const { currentPeriod, isValidPeriod, periodSeries, shiftPeriod } = require('../../services/kpi/period');
const scope = require('../../services/kpi/scope');

// Resolve ?period=, defaulting to the open month. Rejects garbage rather than
// letting it reach an aggregation as an unmatched string.
function readPeriod(req, res) {
  const p = req.query.period || currentPeriod();
  if (!isValidPeriod(p)) {
    res.status(400).json({ success: false, message: `Invalid period "${p}" — expected YYYY-MM.` });
    return null;
  }
  return p;
}

// A score is computed on demand the first time it's asked for, so a fresh
// month doesn't show empty cards until a nightly job runs.
async function ensureScore(userId, period) {
  let score = await KpiScore.findOne({ user: userId, period })
    .populate('user', 'name empId designation color initials role')
    .populate('department', 'name color')
    .populate('team', 'name')
    .populate('approvedBy', 'name')
    .lean();

  if (score) return score;

  const user = await User.findById(userId).select('_id department team role').lean();
  if (!user || !SCORED_ROLES.includes(user.role)) return null;

  await computeForUser(user, period);

  return KpiScore.findOne({ user: userId, period })
    .populate('user', 'name empId designation color initials role')
    .populate('department', 'name color')
    .populate('team', 'name')
    .lean();
}

// ── GET /api/kpi/scores/me ────────────────────────────────────────────
router.get('/me', protect, async (req, res) => {
  try {
    const period = readPeriod(req, res); if (!period) return;

    const score = await ensureScore(req.user._id, period);
    if (!score) {
      return res.json({ success: true, score: null, suggestions: [], message: 'No scorecard applies to this account.' });
    }

    const previous = await KpiScore.findOne({ user: req.user._id, period: shiftPeriod(period, -1) }).lean();

    res.json({
      success: true,
      score,
      previous: previous ? { period: previous.period, overall: previous.overall, band: previous.band } : null,
      suggestions: buildSuggestions(score, previous),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/kpi/scores/history/:userId ───────────────────────────────
// Monthly trend for one employee. `months` bounded so a crafted query can't
// ask for a thousand periods.
router.get('/history/:userId', protect, async (req, res) => {
  try {
    if (!(await scope.canView(req.user, req.params.userId))) {
      return res.status(403).json({ success: false, message: 'You do not have access to this employee\'s KPI.' });
    }

    const end    = readPeriod(req, res); if (!end) return;
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 36);
    const periods = periodSeries(end, months);

    const scores = await KpiScore.find({ user: req.params.userId, period: { $in: periods } })
      .select('period overall coverage band status metrics')
      .lean();

    const byPeriod = new Map(scores.map(s => [s.period, s]));

    res.json({
      success: true,
      history: periods.map(p => {
        const s = byPeriod.get(p);
        return {
          period: p,
          overall: s?.overall ?? null,
          coverage: s?.coverage ?? 0,
          band: s?.band ?? 'none',
          status: s?.status ?? null,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/kpi/scores/user/:userId ──────────────────────────────────
router.get('/user/:userId', protect, async (req, res) => {
  try {
    if (!(await scope.canView(req.user, req.params.userId))) {
      return res.status(403).json({ success: false, message: 'You do not have access to this employee\'s KPI.' });
    }

    const period = readPeriod(req, res); if (!period) return;
    const score  = await ensureScore(req.params.userId, period);
    if (!score) return res.status(404).json({ success: false, message: 'No scorecard for this employee.' });

    const previous = await KpiScore.findOne({ user: req.params.userId, period: shiftPeriod(period, -1) }).lean();

    res.json({
      success: true,
      score,
      previous: previous ? { period: previous.period, overall: previous.overall, band: previous.band } : null,
      suggestions: buildSuggestions(score, previous),
      canReview: await scope.canReview(req.user, req.params.userId),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/kpi/scores ───────────────────────────────────────────────
// Scoped list — the backing query for every ranking table.
router.get('/', protect, async (req, res) => {
  try {
    const period = readPeriod(req, res); if (!period) return;
    const filter = { period, ...(await scope.scopeFilter(req.user)) };

    if (req.query.department) filter.department = req.query.department;
    if (req.query.team)       filter.team = req.query.team;
    if (req.query.band)       filter.band = req.query.band;
    if (req.query.status)     filter.status = req.query.status;

    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const sort  = req.query.sort === 'asc' ? { overall: 1 } : { overall: -1 };

    const scores = await KpiScore.find(filter)
      .sort(sort)
      .limit(limit)
      .populate('user', 'name empId designation color initials')
      .populate('department', 'name color')
      .populate('team', 'name')
      .lean();

    res.json({ success: true, count: scores.length, period, scores: scores.filter(s => s.user) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/kpi/scores/recompute ────────────────────────────────────
// Manual refresh. Managers may refresh their own team; leadership may refresh
// any department or the whole company.
router.post('/recompute', protect, authorize('manager', 'hr', 'admin', 'superadmin'),
  auditLog('KPI Recomputed', req => `Recomputed KPI for ${req.body.period || 'current period'}`),
  async (req, res) => {
    try {
      const period = req.body.period || currentPeriod();
      if (!isValidPeriod(period)) {
        return res.status(400).json({ success: false, message: `Invalid period "${period}".` });
      }

      let filter = {};
      if (req.user.role === 'manager') {
        const visible = await scope.visibleUserIds(req.user);
        filter = { _id: { $in: visible.ids } };
      } else if (req.body.department) {
        filter = { department: req.body.department };
      }

      const result = await recomputePeriod(period, filter);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ── POST /api/kpi/scores/:userId/approve ──────────────────────────────
// Sign-off. Freezes nothing structurally — recompute still refreshes the
// numbers — but records who accepted the card and when, which is what the
// pending-approval queues count against.
router.post('/:userId/approve', protect, authorize('manager', 'hr', 'admin', 'superadmin'),
  auditLog('KPI Approved', req => `Approved KPI for user ${req.params.userId}`),
  async (req, res) => {
    try {
      if (!(await scope.canReview(req.user, req.params.userId))) {
        return res.status(403).json({ success: false, message: 'You can only approve KPI for your own team.' });
      }

      const period = req.body.period || currentPeriod();
      if (!isValidPeriod(period)) {
        return res.status(400).json({ success: false, message: `Invalid period "${period}".` });
      }

      const score = await KpiScore.findOne({ user: req.params.userId, period });
      if (!score) return res.status(404).json({ success: false, message: 'No scorecard to approve for that period.' });

      if (score.overall === null) {
        return res.status(400).json({
          success: false,
          message: 'This scorecard has no data yet — nothing to approve.',
        });
      }

      score.status     = 'approved';
      score.approvedBy = req.user._id;
      score.approvedAt = new Date();
      await score.save();

      res.json({ success: true, score });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
