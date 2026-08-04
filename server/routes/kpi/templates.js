const express = require('express');
const router  = express.Router();

const KpiTemplate = require('../../models/KpiTemplate');
const { protect, authorize, auditLog } = require('../../middleware/auth');
const { providerCatalogue } = require('../../services/kpi/providers');
const { recomputePeriod } = require('../../services/kpi/engine');
const { currentPeriod } = require('../../services/kpi/period');

// Templates define how everyone is measured, so editing them is leadership-only.
// Managers can read them (they need to know what they're reviewing against)
// but never write.
const CAN_EDIT = ['hr', 'admin', 'superadmin'];

// ── GET /api/kpi/templates/providers ──────────────────────────────────
// The catalogue of automatic metrics available to the template editor.
// Served from the registry so the UI can never offer a provider the engine
// doesn't have.
router.get('/providers', protect, (_req, res) => {
  res.json({ success: true, providers: providerCatalogue() });
});

// ── GET /api/kpi/templates ────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    const query = req.query.includeArchived === 'true' ? {} : { active: true };
    const templates = await KpiTemplate.find(query)
      .populate('department', 'name color')
      .populate('createdBy', 'name')
      .sort({ department: 1, name: 1 })
      .lean();

    res.json({ success: true, count: templates.length, templates });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/kpi/templates/:id ────────────────────────────────────────
router.get('/:id', protect, async (req, res) => {
  try {
    const template = await KpiTemplate.findById(req.params.id)
      .populate('department', 'name color')
      .lean();
    if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });
    res.json({ success: true, template });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/kpi/templates ───────────────────────────────────────────
router.post('/', protect, authorize(...CAN_EDIT),
  auditLog('KPI Template Created', req => `Created KPI template "${req.body.name}"`),
  async (req, res) => {
    try {
      const { name, department, metrics, description } = req.body;

      const existing = await KpiTemplate.findOne({
        department: department || null, active: true,
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: department
            ? 'This department already has an active scorecard. Edit it instead of creating a second one.'
            : 'An org-wide default scorecard already exists.',
        });
      }

      const template = await KpiTemplate.create({
        name,
        department: department || null,
        metrics,
        description: description || '',
        createdBy: req.user._id,
      });

      res.status(201).json({ success: true, template });
    } catch (err) {
      // Weight-sum and unknown-provider failures come through here as
      // validation errors — 400, not 500, so the editor can show the message.
      res.status(400).json({ success: false, message: err.message });
    }
  }
);

// ── PUT /api/kpi/templates/:id ────────────────────────────────────────
// Bumps version and recomputes the affected department for the open period, so
// a weight change is reflected immediately rather than at the next month roll.
router.put('/:id', protect, authorize(...CAN_EDIT),
  auditLog('KPI Template Updated', req => `Updated KPI template ${req.params.id}`),
  async (req, res) => {
    try {
      const template = await KpiTemplate.findById(req.params.id);
      if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });

      const { name, metrics, description, active } = req.body;

      if (name !== undefined) template.name = name;
      if (description !== undefined) template.description = description;
      if (active !== undefined) template.active = active;

      if (metrics !== undefined) {
        template.metrics = metrics;
        template.version += 1;
      }

      await template.save();

      const period = currentPeriod();
      const filter = template.department ? { department: template.department } : {};
      // Fire-and-forget: a 1000-employee recompute must not hold the editor's
      // save request open. Scores are read from the collection, so the UI just
      // sees them refresh a moment later.
      recomputePeriod(period, filter).catch(err =>
        console.error('KPI recompute after template update failed:', err.message)
      );

      res.json({ success: true, template, recomputing: { period } });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }
);

// ── DELETE /api/kpi/templates/:id ─────────────────────────────────────
// Archives rather than deletes: historical KpiScore rows reference this
// template, and hard-deleting it would orphan every score it ever produced.
router.delete('/:id', protect, authorize('admin', 'superadmin'),
  auditLog('KPI Template Archived', req => `Archived KPI template ${req.params.id}`),
  async (req, res) => {
    try {
      const template = await KpiTemplate.findByIdAndUpdate(
        req.params.id, { active: false }, { new: true }
      );
      if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });
      res.json({ success: true, message: 'Template archived.' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
