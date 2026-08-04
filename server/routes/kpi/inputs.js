const express = require('express');
const router  = express.Router();

const KpiMetricInput = require('../../models/KpiMetricInput');
const KpiTemplate    = require('../../models/KpiTemplate');
const User           = require('../../models/User');

const { protect, authorize, auditLog } = require('../../middleware/auth');
const { computeForUser, resolveTemplates } = require('../../services/kpi/engine');
const { currentPeriod, isValidPeriod } = require('../../services/kpi/period');
const scope = require('../../services/kpi/scope');

// Values for the manual metrics — revenue, invoices, uptime, purchase accuracy.
// Written by managers/HR only. Employees can read their own (the figures back
// their score, so hiding them would make the score unexplainable) but can never
// write them, which is the "employees never enter their own KPI" rule.

// ── GET /api/kpi/inputs ───────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    const period = req.query.period || currentPeriod();
    if (!isValidPeriod(period)) {
      return res.status(400).json({ success: false, message: `Invalid period "${period}".` });
    }

    const userId = req.query.userId || String(req.user._id);
    if (!(await scope.canView(req.user, userId))) {
      return res.status(403).json({ success: false, message: 'You do not have access to those figures.' });
    }

    const [inputs, user] = await Promise.all([
      KpiMetricInput.find({ user: userId, period })
        .populate('enteredBy', 'name')
        .lean(),
      User.findById(userId).select('department').lean(),
    ]);

    // Returned alongside the values so the entry form knows which metrics exist
    // for this employee's department, what unit they're in, and which are
    // automatic (and therefore not enterable).
    const templates = await resolveTemplates();
    const template  = templates.for(user?.department);

    res.json({
      success: true,
      period,
      inputs,
      metrics: (template?.metrics || []).filter(m => m.source === 'manual'),
      templateName: template?.name || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/kpi/inputs ──────────────────────────────────────────────
router.post('/', protect, authorize('manager', 'hr', 'admin', 'superadmin'),
  auditLog('KPI Metric Entered', req => `Entered "${req.body.metricKey}" for user ${req.body.userId} (${req.body.period})`),
  async (req, res) => {
    try {
      const { userId, metricKey, achieved, target, score, note } = req.body;
      const period = req.body.period || currentPeriod();

      if (!userId || !metricKey) {
        return res.status(400).json({ success: false, message: 'userId and metricKey are required.' });
      }
      if (!isValidPeriod(period)) {
        return res.status(400).json({ success: false, message: `Invalid period "${period}".` });
      }
      if (!(await scope.canReview(req.user, userId))) {
        return res.status(403).json({
          success: false,
          message: 'You can only enter KPI figures for employees on the teams you manage.',
        });
      }

      const user = await User.findById(userId).select('_id department team').lean();
      if (!user) return res.status(404).json({ success: false, message: 'Employee not found.' });

      // The metric must exist on the employee's own scorecard and must be
      // manual — otherwise a stray key would sit in the collection forever,
      // read by nothing, and an automatic metric could be overridden by hand.
      const templates = await resolveTemplates();
      const template  = templates.for(user.department);
      const metric    = template?.metrics.find(m => m.key === metricKey);

      if (!metric) {
        return res.status(400).json({
          success: false,
          message: `"${metricKey}" is not a metric on this employee's scorecard (${template?.name || 'none assigned'}).`,
        });
      }
      if (metric.source !== 'manual') {
        return res.status(400).json({
          success: false,
          message: `"${metric.label}" is calculated automatically from CRM data and cannot be entered by hand.`,
        });
      }

      const update = { enteredBy: req.user._id, note: note || '' };

      if (metric.inputMode === 'score') {
        const v = Number(score);
        if (!Number.isFinite(v) || v < 0 || v > 100) {
          return res.status(400).json({ success: false, message: 'Score must be between 0 and 100.' });
        }
        update.score = v; update.achieved = null; update.target = null;
      } else {
        const a = Number(achieved);
        const t = Number(target);
        if (!Number.isFinite(a) || a < 0) {
          return res.status(400).json({ success: false, message: 'Achieved must be a number of 0 or more.' });
        }
        if (!Number.isFinite(t) || t <= 0) {
          return res.status(400).json({ success: false, message: 'Target must be greater than 0.' });
        }
        update.achieved = a; update.target = t; update.score = null;
      }

      const input = await KpiMetricInput.findOneAndUpdate(
        { user: userId, period, metricKey },
        { $set: update, $setOnInsert: { user: userId, period, metricKey } },
        { upsert: true, new: true, runValidators: true }
      );

      await computeForUser(user, period);

      res.json({ success: true, input });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }
);

// ── DELETE /api/kpi/inputs/:id ────────────────────────────────────────
router.delete('/:id', protect, authorize('manager', 'hr', 'admin', 'superadmin'),
  auditLog('KPI Metric Cleared', req => `Cleared KPI input ${req.params.id}`),
  async (req, res) => {
    try {
      const input = await KpiMetricInput.findById(req.params.id);
      if (!input) return res.status(404).json({ success: false, message: 'Entry not found.' });

      if (!(await scope.canReview(req.user, input.user))) {
        return res.status(403).json({ success: false, message: 'Not your team.' });
      }

      await input.deleteOne();

      const user = await User.findById(input.user).select('_id department team').lean();
      if (user) await computeForUser(user, input.period);

      res.json({ success: true, message: 'Entry cleared.' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
