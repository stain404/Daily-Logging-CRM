// ═══════════════════════════════════════════════════════════════════════
//  KPI ANALYTICS
//
//  Read-side rollups over the KpiScore collection. Every function takes an
//  optional `userFilter` (from services/kpi/scope) so the same aggregation
//  serves the CEO view unfiltered and the manager view scoped to their teams —
//  there is no separate "manager version" of any of these queries.
//
//  All of these read persisted scores rather than recomputing, which is what
//  keeps a company-wide dashboard at 1000 employees a handful of indexed
//  aggregations instead of a thousand task scans.
// ═══════════════════════════════════════════════════════════════════════

const KpiScore          = require('../../models/KpiScore');
const PerformanceReview = require('../../models/PerformanceReview');
const Task              = require('../../models/Task');
const User              = require('../../models/User');
const Team              = require('../../models/Team');

const { periodRange, periodSeries } = require('./period');

const round1 = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

// Averages weight every employee equally and ignore employees with no score at
// all, so a department of 3 scored people isn't diluted by 20 unscored ones.
const SCORED = { overall: { $ne: null } };

/** Company-level headline numbers for one period. */
async function companyOverview(period, userFilter = {}) {
  const match = { period, ...SCORED, ...userFilter };

  const [agg] = await KpiScore.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        avg: { $avg: '$overall' },
        coverage: { $avg: '$coverage' },
        employees: { $sum: 1 },
        excellent: { $sum: { $cond: [{ $eq: ['$band', 'excellent'] }, 1, 0] } },
        good:      { $sum: { $cond: [{ $eq: ['$band', 'good'] }, 1, 0] } },
        fair:      { $sum: { $cond: [{ $eq: ['$band', 'fair'] }, 1, 0] } },
        poor:      { $sum: { $cond: [{ $eq: ['$band', 'poor'] }, 1, 0] } },
        approved:  { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
      },
    },
  ]);

  return {
    period,
    companyKpi: round1(agg?.avg ?? null),
    coverage: round1(agg?.coverage ?? 0),
    employees: agg?.employees || 0,
    distribution: {
      excellent: agg?.excellent || 0,
      good: agg?.good || 0,
      fair: agg?.fair || 0,
      poor: agg?.poor || 0,
    },
    approved: agg?.approved || 0,
    pendingApproval: (agg?.employees || 0) - (agg?.approved || 0),
  };
}

/** Per-department averages for one period, ranked best first. */
async function departmentRanking(period, userFilter = {}) {
  const rows = await KpiScore.aggregate([
    { $match: { period, ...SCORED, ...userFilter } },
    {
      $group: {
        _id: '$department',
        avg: { $avg: '$overall' },
        coverage: { $avg: '$coverage' },
        employees: { $sum: 1 },
        best: { $max: '$overall' },
        worst: { $min: '$overall' },
      },
    },
    { $lookup: { from: 'departments', localField: '_id', foreignField: '_id', as: 'dept' } },
    { $unwind: { path: '$dept', preserveNullAndEmptyArrays: true } },
    { $sort: { avg: -1 } },
  ]);

  return rows.map((r, i) => ({
    rank: i + 1,
    departmentId: r._id,
    name: r.dept?.name || 'Unassigned',
    color: r.dept?.color || '#7c8994',
    kpi: round1(r.avg),
    coverage: round1(r.coverage),
    employees: r.employees,
    best: round1(r.best),
    worst: round1(r.worst),
    band: KpiScore.bandFor(r.avg),
  }));
}

/** Per-team averages — the manager-facing equivalent of departmentRanking. */
async function teamRanking(period, userFilter = {}) {
  const rows = await KpiScore.aggregate([
    { $match: { period, team: { $ne: null }, ...SCORED, ...userFilter } },
    {
      $group: {
        _id: '$team',
        avg: { $avg: '$overall' },
        employees: { $sum: 1 },
      },
    },
    { $lookup: { from: 'teams', localField: '_id', foreignField: '_id', as: 'team' } },
    { $unwind: { path: '$team', preserveNullAndEmptyArrays: true } },
    { $sort: { avg: -1 } },
  ]);

  return rows.map((r, i) => ({
    rank: i + 1,
    teamId: r._id,
    name: r.team?.name || 'Unassigned',
    kpi: round1(r.avg),
    employees: r.employees,
    band: KpiScore.bandFor(r.avg),
  }));
}

/**
 * Ranked employee list.
 * @param {'desc'|'asc'} order  desc = top performers, asc = needs attention
 */
async function employeeRanking(period, { userFilter = {}, order = 'desc', limit = 10, minCoverage = 0 } = {}) {
  const rows = await KpiScore.find({
    period, ...SCORED, coverage: { $gte: minCoverage }, ...userFilter,
  })
    .sort({ overall: order === 'asc' ? 1 : -1 })
    .limit(limit)
    .populate('user', 'name empId designation color initials')
    .populate('department', 'name color')
    .lean();

  return rows
    // A scorecard whose user was deleted is noise, not a data point.
    .filter(r => r.user)
    .map((r, i) => ({
      rank: i + 1,
      userId: r.user._id,
      name: r.user.name,
      empId: r.user.empId,
      designation: r.user.designation,
      color: r.user.color,
      initials: r.user.initials,
      department: r.department?.name || '—',
      kpi: r.overall,
      coverage: r.coverage,
      band: r.band,
      status: r.status,
    }));
}

/**
 * Average KPI per period over a rolling window — the trend line.
 * `groupByDepartment` splits it into one series per department for the CEO view.
 */
async function trend(endPeriod, months = 6, { userFilter = {}, groupByDepartment = false } = {}) {
  const periods = periodSeries(endPeriod, months);

  const rows = await KpiScore.aggregate([
    { $match: { period: { $in: periods }, ...SCORED, ...userFilter } },
    {
      $group: {
        _id: groupByDepartment ? { period: '$period', dept: '$department' } : { period: '$period' },
        avg: { $avg: '$overall' },
        employees: { $sum: 1 },
      },
    },
  ]);

  if (!groupByDepartment) {
    const byPeriod = new Map(rows.map(r => [r._id.period, r]));
    return periods.map(p => ({
      period: p,
      kpi: round1(byPeriod.get(p)?.avg ?? null),
      employees: byPeriod.get(p)?.employees || 0,
    }));
  }

  const deptIds = [...new Set(rows.map(r => String(r._id.dept)).filter(Boolean))];
  const depts = await require('../../models/Department')
    .find({ _id: { $in: deptIds } }).select('name color').lean();
  const deptMap = new Map(depts.map(d => [String(d._id), d]));

  const series = new Map();
  for (const r of rows) {
    const key = String(r._id.dept);
    if (!series.has(key)) series.set(key, new Map());
    series.get(key).set(r._id.period, r.avg);
  }

  return {
    periods,
    series: [...series.entries()].map(([deptId, byPeriod]) => ({
      departmentId: deptId,
      name: deptMap.get(deptId)?.name || 'Unassigned',
      color: deptMap.get(deptId)?.color || '#7c8994',
      points: periods.map(p => round1(byPeriod.get(p) ?? null)),
    })),
  };
}

/**
 * Employees with no manager review filed for the period — the "Pending Reviews"
 * queue. Scoped by the caller's visible id set.
 */
async function pendingReviews(period, { visibleIds = null, limit = 100 } = {}) {
  const userQuery = { role: { $in: ['employee', 'manager', 'hr'] }, active: true };
  if (visibleIds) userQuery._id = { $in: visibleIds };

  const users = await User.find(userQuery)
    .select('name empId designation color initials department team')
    .populate('department', 'name color')
    .lean();

  const reviewed = await PerformanceReview.find({
    period, user: { $in: users.map(u => u._id) },
  }).select('user').lean();
  const reviewedSet = new Set(reviewed.map(r => String(r.user)));

  const pending = users.filter(u => !reviewedSet.has(String(u._id)));

  return {
    total: pending.length,
    employees: pending.slice(0, limit).map(u => ({
      userId: u._id,
      name: u.name,
      empId: u.empId,
      designation: u.designation,
      color: u.color,
      initials: u.initials,
      department: u.department?.name || '—',
    })),
  };
}

/**
 * Employees flagged for attention: below the threshold, or dropped sharply
 * against last period. Falling fast matters as much as being low — a 90 that
 * was 99 last month is a signal a "bottom 10" list would never surface.
 */
async function needingReview(period, { userFilter = {}, threshold = 70, dropBy = 10, limit = 20 } = {}) {
  const prev = periodSeries(period, 2)[0];

  const [current, previous] = await Promise.all([
    KpiScore.find({ period, ...SCORED, ...userFilter })
      .populate('user', 'name empId designation color initials')
      .populate('department', 'name')
      .lean(),
    KpiScore.find({ period: prev, ...SCORED, ...userFilter }).select('user overall').lean(),
  ]);

  const prevMap = new Map(previous.map(p => [String(p.user), p.overall]));

  const flagged = [];
  for (const s of current) {
    if (!s.user) continue;
    const before = prevMap.get(String(s.user._id));
    const delta = typeof before === 'number' ? round1(s.overall - before) : null;

    const reasons = [];
    if (s.overall < threshold) reasons.push(`Below ${threshold}`);
    if (delta !== null && delta <= -dropBy) reasons.push(`Down ${Math.abs(delta)} pts`);
    if (!reasons.length) continue;

    flagged.push({
      userId: s.user._id,
      name: s.user.name,
      empId: s.user.empId,
      designation: s.user.designation,
      color: s.user.color,
      initials: s.user.initials,
      department: s.department?.name || '—',
      kpi: s.overall,
      previous: before ?? null,
      delta,
      band: s.band,
      reasons,
    });
  }

  flagged.sort((a, b) => a.kpi - b.kpi || (a.delta ?? 0) - (b.delta ?? 0));
  return { total: flagged.length, employees: flagged.slice(0, limit) };
}

/**
 * Operational counters the dashboards show alongside KPI: overdue tasks and
 * the attendance/logging summary. These read Task directly because they are
 * live operational state, not period-scored history.
 */
async function operationalSummary(period, { visibleIds = null } = {}) {
  const { start, end } = periodRange(period);
  const taskMatch = { date: { $gte: start, $lte: end } };
  if (visibleIds) taskMatch.userId = { $in: visibleIds };

  const now = new Date();

  const [overdue, totals, loggingAgg] = await Promise.all([
    Task.countDocuments({
      ...taskMatch,
      status: { $ne: 'completed' },
      dueDate: { $ne: null, $lt: now },
    }),
    Task.aggregate([
      { $match: taskMatch },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          pendingReview: { $sum: { $cond: [{ $and: [{ $eq: ['$approved', false] }, { $eq: ['$rejected', false] }] }, 1, 0] } },
        },
      },
    ]),
    KpiScore.aggregate([
      { $match: { period, ...(visibleIds ? { user: { $in: visibleIds } } : {}) } },
      { $unwind: '$metrics' },
      // Attendance is whichever metric the department's template drives from
      // the logging-compliance provider, so this stays correct even if a
      // template renames the metric.
      { $match: { 'metrics.provider': 'loggingCompliance', 'metrics.score': { $ne: null } } },
      { $group: { _id: null, avg: { $avg: '$metrics.score' }, n: { $sum: 1 } } },
    ]),
  ]);

  const t = totals[0] || { total: 0, completed: 0, pendingReview: 0 };

  return {
    overdueTasks: overdue,
    totalTasks: t.total,
    completedTasks: t.completed,
    completionRate: t.total ? round1((t.completed / t.total) * 100) : null,
    pendingTaskReviews: t.pendingReview,
    attendanceAvg: round1(loggingAgg[0]?.avg ?? null),
    attendanceCounted: loggingAgg[0]?.n || 0,
  };
}

module.exports = {
  companyOverview, departmentRanking, teamRanking, employeeRanking,
  trend, pendingReviews, needingReview, operationalSummary,
};
