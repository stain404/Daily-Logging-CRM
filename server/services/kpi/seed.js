// Idempotent seeding of the default scorecards. Safe to call on every boot:
// it only creates templates that are missing, and never overwrites one that
// someone has since edited.

const Department  = require('../../models/Department');
const KpiTemplate = require('../../models/KpiTemplate');
const { DEFAULT_TEMPLATES, GENERAL_TEMPLATE, templateForDepartmentName } = require('./defaultTemplates');

async function seedKpiTemplates({ log = console.log } = {}) {
  const created = [];

  // Org-wide fallback first, so any department without a match is scoreable
  // the moment the module comes up.
  const hasFallback = await KpiTemplate.findOne({ department: null, active: true });
  if (!hasFallback) {
    await KpiTemplate.create({ ...GENERAL_TEMPLATE, department: null });
    created.push(GENERAL_TEMPLATE.name);
  }

  const departments = await Department.find({ active: true });

  for (const dept of departments) {
    const existing = await KpiTemplate.findOne({ department: dept._id, active: true });
    if (existing) continue;

    const spec = templateForDepartmentName(dept.name);
    // No alias match (Admin, Logistics, Shipping…) — deliberately left to the
    // GENERAL fallback rather than guessing a scorecard for them.
    if (!spec) continue;

    await KpiTemplate.create({
      name: spec.name,
      description: spec.description,
      department: dept._id,
      metrics: spec.metrics,
    });
    created.push(`${spec.name} → ${dept.name}`);
  }

  if (created.length) log(`🌱  KPI templates seeded: ${created.join(', ')}`);
  else log('📦  KPI templates already present — skipping.');

  return created;
}

module.exports = { seedKpiTemplates };
