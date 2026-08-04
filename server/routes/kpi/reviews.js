const express = require('express');
const router  = express.Router();

const PerformanceReview = require('../../models/PerformanceReview');
const User              = require('../../models/User');

const { protect, authorize, auditLog } = require('../../middleware/auth');
const { computeForUser } = require('../../services/kpi/engine');
const { currentPeriod, isValidPeriod } = require('../../services/kpi/period');
const analytics = require('../../services/kpi/analytics');
const scope     = require('../../services/kpi/scope');

const COMPETENCIES = ['communication', 'technical', 'initiative', 'teamwork', 'leadership', 'problemSolving'];

// ── GET /api/kpi/reviews/me ───────────────────────────────────────────
// An employee's own reviews — visible to them by design: a review that feeds
// the KPI score but can't be read by the person scored isn't feedback.
router.get('/me', protect, async (req, res) => {
  try {
    const reviews = await PerformanceReview.find({ user: req.user._id })
      .sort({ period: -1 })
      .limit(24)
      .populate('reviewer', 'name designation')
      .lean();
    res.json({ success: true, count: reviews.length, reviews });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/kpi/reviews/pending ──────────────────────────────────────
router.get('/pending', protect, authorize('manager', 'hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const period = req.query.period || currentPeriod();
    if (!isValidPeriod(period)) {
      return res.status(400).json({ success: false, message: `Invalid period "${period}".` });
    }

    // A manager's queue is their reports, not themselves — nobody reviews
    // their own competencies.
    const reports = await scope.directReports(req.user);
    const visibleIds = reports.filter(id => String(id) !== String(req.user._id));

    const result = await analytics.pendingReviews(period, { visibleIds });
    res.json({ success: true, period, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/kpi/reviews ──────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.query.period) {
      if (!isValidPeriod(req.query.period)) {
        return res.status(400).json({ success: false, message: 'Invalid period.' });
      }
      filter.period = req.query.period;
    }

    if (req.query.userId) {
      if (!(await scope.canView(req.user, req.query.userId))) {
        return res.status(403).json({ success: false, message: 'You do not have access to those reviews.' });
      }
      filter.user = req.query.userId;
    } else {
      Object.assign(filter, await scope.scopeFilter(req.user));
    }

    const reviews = await PerformanceReview.find(filter)
      .sort({ period: -1, createdAt: -1 })
      .limit(Math.min(parseInt(req.query.limit, 10) || 200, 500))
      .populate('user', 'name empId designation color initials')
      .populate('reviewer', 'name designation')
      .lean();

    res.json({ success: true, count: reviews.length, reviews: reviews.filter(r => r.user) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/kpi/reviews ─────────────────────────────────────────────
// Create or replace the review for one employee/period, then immediately
// recompute their scorecard so the Manager Review metric lands in the KPI
// without waiting for a scheduled pass.
router.post('/', protect, authorize('manager', 'hr', 'admin', 'superadmin'),
  auditLog('Performance Review Submitted', req => `Reviewed user ${req.body.userId} for ${req.body.period}`),
  async (req, res) => {
    try {
      const { userId, period: rawPeriod, ratings, comments } = req.body;
      const period = rawPeriod || currentPeriod();

      if (!userId) return res.status(400).json({ success: false, message: 'userId is required.' });
      if (!isValidPeriod(period)) {
        return res.status(400).json({ success: false, message: `Invalid period "${period}".` });
      }

      if (!(await scope.canReview(req.user, userId))) {
        return res.status(403).json({
          success: false,
          message: 'You can only review employees on the teams you manage.',
        });
      }

      // Every competency is required — a partial review would quietly change
      // what the 1–5 average means from one employee to the next.
      const clean = {};
      for (const key of COMPETENCIES) {
        const v = Number(ratings?.[key]);
        if (!Number.isFinite(v) || v < 1 || v > 5) {
          return res.status(400).json({
            success: false,
            message: `"${key}" must be rated between 1 and 5.`,
          });
        }
        clean[key] = v;
      }

      const existing = await PerformanceReview.findOne({ user: userId, period });
      let review;

      if (existing) {
        existing.ratings   = clean;
        existing.comments  = comments || '';
        existing.reviewer  = req.user._id;
        existing.submittedAt = new Date();
        review = await existing.save();
      } else {
        review = await PerformanceReview.create({
          user: userId, reviewer: req.user._id, period,
          ratings: clean, comments: comments || '',
        });
      }

      const user = await User.findById(userId).select('_id department team').lean();
      if (user) await computeForUser(user, period);

      res.status(existing ? 200 : 201).json({ success: true, review });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }
);

// ── DELETE /api/kpi/reviews/:id ───────────────────────────────────────
router.delete('/:id', protect, authorize('hr', 'admin', 'superadmin'),
  auditLog('Performance Review Deleted', req => `Deleted review ${req.params.id}`),
  async (req, res) => {
    try {
      const review = await PerformanceReview.findByIdAndDelete(req.params.id);
      if (!review) return res.status(404).json({ success: false, message: 'Review not found.' });

      const user = await User.findById(review.user).select('_id department team').lean();
      if (user) await computeForUser(user, review.period);

      res.json({ success: true, message: 'Review deleted.' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
