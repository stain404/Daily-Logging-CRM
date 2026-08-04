// ═══════════════════════════════════════════════════════════════════════
//  DEFAULT DEPARTMENT SCORECARDS
//
//  Seeded once, then owned by HR/leadership through the template editor —
//  this file is a starting point, not a source of truth.
//
//  Weights are exactly as specified. Where a metric has no data source in the
//  CRM today (uptime, revenue, invoices, hiring, supplier performance) it is
//  seeded as `manual` rather than quietly dropped or faked: the weight still
//  counts, a manager types the operands, and `coverage` on the scorecard shows
//  how much of the score is currently evidenced. When a CRM module later
//  produces one of these figures, flip the metric to source:'auto' with a new
//  provider — no other change.
//
//  Departments are matched by name alias because the live org uses "IT/Tech"
//  while the spec says "IT / Technology". Anything unmatched (Admin, Logistics,
//  Shipping) falls through to the GENERAL template.
// ═══════════════════════════════════════════════════════════════════════

const auto = (key, label, weight, provider, description) =>
  ({ key, label, weight, source: 'auto', provider, description });

const manual = (key, label, weight, unit, description, inputMode = 'ratio') =>
  ({ key, label, weight, source: 'manual', inputMode, unit, description });

const DEFAULT_TEMPLATES = [
  {
    match: ['it', 'it/tech', 'it / technology', 'technology', 'tech', 'information technology'],
    name: 'IT / Technology Scorecard',
    description: 'Delivery, reliability and security for the technology department.',
    metrics: [
      auto('taskCompletion', 'Task Completion', 40, 'taskCompletion',
        'Completed tasks ÷ assigned tasks.'),
      auto('sla', 'SLA / On-Time Delivery', 20, 'onTimeCompletion',
        'Tasks completed on or before their deadline — the CRM deadline is the SLA clock.'),
      manual('uptime', 'System Uptime', 15, '%',
        'Monitored uptime for owned systems. Enter achieved % against the target %.'),
      manual('security', 'Security', 15, '',
        'Security posture: incidents resolved, patches applied, or audit findings closed.'),
      auto('managerReview', 'Manager Review', 10, 'managerReview',
        'Monthly competency review.'),
    ],
  },
  {
    match: ['hr', 'human resources', 'people'],
    name: 'HR Scorecard',
    description: 'Hiring, retention and people development.',
    metrics: [
      manual('hiring', 'Hiring', 25, 'roles', 'Roles filled against the hiring plan.'),
      manual('retention', 'Employee Retention', 25, '%', 'Retained headcount against target retention.'),
      auto('attendance', 'Attendance', 15, 'loggingCompliance',
        'Days with a submitted daily update ÷ working days.'),
      manual('training', 'Training', 15, 'sessions', 'Training delivered against plan.'),
      auto('managerReview', 'Manager Review', 20, 'managerReview', 'Monthly competency review.'),
    ],
  },
  {
    match: ['finance', 'accounts', 'accounting'],
    name: 'Finance Scorecard',
    description: 'Processing accuracy, collections and audit readiness.',
    metrics: [
      manual('invoiceProcessing', 'Invoice Processing', 20, 'invoices',
        'Invoices processed on time ÷ total invoices.'),
      manual('budgetAccuracy', 'Budget Accuracy', 25, '%',
        'Actuals against budget — enter accuracy achieved vs target.'),
      manual('collections', 'Collections', 20, '',
        'Amount collected against amount due.'),
      manual('reporting', 'Reporting', 15, 'reports',
        'Reports delivered on schedule against the reporting calendar.'),
      manual('audit', 'Audit', 20, '',
        'Audit findings closed against findings raised.'),
    ],
  },
  {
    match: ['sales', 'business development'],
    name: 'Sales Scorecard',
    description: 'Revenue attainment, conversion and account retention.',
    metrics: [
      manual('revenue', 'Revenue', 35, '', 'Revenue achieved against revenue target.'),
      manual('leadConversion', 'Lead Conversion', 20, 'leads', 'Leads converted ÷ leads worked.'),
      manual('retention', 'Retention', 15, 'accounts', 'Accounts retained ÷ accounts held.'),
      manual('followUp', 'Follow-up', 15, '', 'Follow-ups completed against follow-ups due.'),
      auto('managerReview', 'Manager Review', 15, 'managerReview', 'Monthly competency review.'),
    ],
  },
  {
    match: ['procurement', 'purchasing', 'supply chain'],
    name: 'Procurement Scorecard',
    description: 'Cost control, order accuracy and supplier management.',
    metrics: [
      manual('costSaving', 'Cost Saving', 25, '', 'Savings realised against savings target.'),
      manual('purchaseAccuracy', 'Purchase Accuracy', 20, 'orders',
        'Correct purchase orders ÷ total orders.'),
      manual('supplierPerformance', 'Supplier Performance', 20, '%',
        'Supplier scorecard average against target.'),
      manual('purchaseCycle', 'Purchase Cycle', 15, 'days',
        'Orders closed within cycle-time target ÷ total orders.'),
      auto('managerReview', 'Manager Review', 20, 'managerReview', 'Monthly competency review.'),
    ],
  },
];

// Fallback for any department without its own scorecard. Fully automatic, so a
// brand-new department produces real numbers on day one with nothing to fill in.
const GENERAL_TEMPLATE = {
  name: 'General Scorecard',
  description: 'Org-wide default for departments without a specific scorecard. Fully automatic.',
  metrics: [
    auto('taskCompletion', 'Task Completion', 40, 'taskCompletion', 'Completed tasks ÷ assigned tasks.'),
    auto('onTime', 'On-Time Completion', 25, 'onTimeCompletion', 'Completed before deadline ÷ completed.'),
    auto('attendance', 'Attendance', 15, 'loggingCompliance', 'Logged days ÷ working days.'),
    auto('managerReview', 'Manager Review', 20, 'managerReview', 'Monthly competency review.'),
  ],
};

function templateForDepartmentName(name) {
  const n = String(name || '').trim().toLowerCase();
  return DEFAULT_TEMPLATES.find(t => t.match.some(alias => n === alias || n.includes(alias))) || null;
}

module.exports = { DEFAULT_TEMPLATES, GENERAL_TEMPLATE, templateForDepartmentName };
