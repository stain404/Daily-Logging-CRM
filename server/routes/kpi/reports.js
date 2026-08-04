const express = require('express');
const router  = express.Router();

const KpiScore = require('../../models/KpiScore');

const { protect } = require('../../middleware/auth');
const { toCsv, sendCsv } = require('../../services/kpi/csv');
const {
  currentPeriod, isValidPeriod, quarterPeriods, yearPeriods,
  formatPeriod, periodSeries,
} = require('../../services/kpi/period');
const analytics = require('../../services/kpi/analytics');
const scope     = require('../../services/kpi/scope');

// Every report is one shape — rows + columns — so JSON and CSV come off the
// same query and can never disagree. `format=csv` swaps the responder; nothing
// else changes. A future XLSX/PDF writer plugs in at the same seam.
function respond(req, res, { filename, columns, rows, meta }) {
  if (req.query.format === 'csv') {
    return sendCsv(res, filename, toCsv(rows, columns));
  }
  res.json({ success: true, ...meta, columns: columns.map(c => ({ key: c.key, label: c.label })), rows });
}

function readPeriod(req, res) {
  const p = req.query.period || currentPeriod();
  if (!isValidPeriod(p)) {
    res.status(400).json({ success: false, message: `Invalid period "${p}" — expected YYYY-MM.` });
    return null;
  }
  return p;
}

const num = v => (v === null || v === undefined ? '' : v);

// ── GET /api/kpi/reports/employee ─────────────────────────────────────
// One row per employee for a single period, with each template metric expanded
// into its own column.
router.get('/employee', protect, async (req, res) => {
  try {
    const period = readPeriod(req, res); if (!period) return;
    const filter = { period, ...(await scope.scopeFilter(req.user)) };
    if (req.query.department) filter.department = req.query.department;

    const scores = await KpiScore.find(filter)
      .sort({ overall: -1 })
      .populate('user', 'name empId designation')
      .populate('department', 'name')
      .populate('team', 'name')
      .populate('approvedBy', 'name')
      .lean();

    const live = scores.filter(s => s.user);

    // Metric columns are unioned across every scorecard in the result, because
    // a company-wide export spans departments with different templates.
    const metricCols = [];
    const seen = new Set();
    for (const s of live) {
      for (const m of s.metrics) {
        if (seen.has(m.key)) continue;
        seen.add(m.key);
        metricCols.push({ key: `m_${m.key}`, label: `${m.label} (${m.weight}%)` });
      }
    }

    const rows = live.map((s, i) => {
      const row = {
        rank: i + 1,
        empId: s.user.empId,
        name: s.user.name,
        designation: s.user.designation,
        department: s.department?.name || '—',
        team: s.team?.name || '—',
        overall: num(s.overall),
        band: s.band,
        coverage: s.coverage,
        status: s.status,
        approvedBy: s.approvedBy?.name || '',
      };
      for (const m of s.metrics) row[`m_${m.key}`] = num(m.score);
      return row;
    });

    respond(req, res, {
      filename: `kpi-employees-${period}.csv`,
      columns: [
        { key: 'rank', label: 'Rank' },
        { key: 'empId', label: 'Employee ID' },
        { key: 'name', label: 'Name' },
        { key: 'designation', label: 'Designation' },
        { key: 'department', label: 'Department' },
        { key: 'team', label: 'Team' },
        { key: 'overall', label: 'Overall KPI' },
        { key: 'band', label: 'Band' },
        { key: 'coverage', label: 'Data Coverage %' },
        { key: 'status', label: 'Status' },
        { key: 'approvedBy', label: 'Approved By' },
        ...metricCols,
      ],
      rows,
      meta: { period, periodLabel: formatPeriod(period), count: rows.length },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/kpi/reports/department ───────────────────────────────────
router.get('/department', protect, async (req, res) => {
  try {
    const period = readPeriod(req, res); if (!period) return;
    const userFilter = await scope.scopeFilter(req.user);

    const rows = (await analytics.departmentRanking(period, userFilter)).map(d => ({
      rank: d.rank,
      department: d.name,
      kpi: num(d.kpi),
      band: d.band,
      employees: d.employees,
      best: num(d.best),
      worst: num(d.worst),
      coverage: num(d.coverage),
    }));

    respond(req, res, {
      filename: `kpi-departments-${period}.csv`,
      columns: [
        { key: 'rank', label: 'Rank' },
        { key: 'department', label: 'Department' },
        { key: 'kpi', label: 'Department KPI' },
        { key: 'band', label: 'Band' },
        { key: 'employees', label: 'Employees Scored' },
        { key: 'best', label: 'Highest' },
        { key: 'worst', label: 'Lowest' },
        { key: 'coverage', label: 'Data Coverage %' },
      ],
      rows,
      meta: { period, periodLabel: formatPeriod(period), count: rows.length },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Multi-period reports ──────────────────────────────────────────────
// monthly (rolling N months), quarterly (the 3 months of the quarter) and
// annual (12 months) are the same report over a different period list — one
// column per period plus an average, one row per employee.
async function periodMatrix(req, res, { periods, filename, title }) {
  const filter = { period: { $in: periods }, ...(await scope.scopeFilter(req.user)) };
  if (req.query.department) filter.department = req.query.department;

  const scores = await KpiScore.find(filter)
    .populate('user', 'name empId designation')
    .populate('department', 'name')
    .lean();

  const byUser = new Map();
  for (const s of scores) {
    if (!s.user) continue;
    const k = String(s.user._id);
    if (!byUser.has(k)) {
      byUser.set(k, {
        empId: s.user.empId,
        name: s.user.name,
        designation: s.user.designation,
        department: s.department?.name || '—',
        _scores: new Map(),
      });
    }
    byUser.get(k)._scores.set(s.period, s.overall);
  }

  const rows = [...byUser.values()].map(u => {
    const row = {
      empId: u.empId, name: u.name,
      designation: u.designation, department: u.department,
    };
    const vals = [];
    for (const p of periods) {
      const v = u._scores.get(p);
      row[`p_${p}`] = num(v ?? null);
      if (typeof v === 'number') vals.push(v);
    }
    row.average = vals.length
      ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
      : '';
    row.periodsScored = vals.length;
    return row;
  }).sort((a, b) => (b.average || 0) - (a.average || 0));

  rows.forEach((r, i) => { r.rank = i + 1; });

  respond(req, res, {
    filename,
    columns: [
      { key: 'rank', label: 'Rank' },
      { key: 'empId', label: 'Employee ID' },
      { key: 'name', label: 'Name' },
      { key: 'designation', label: 'Designation' },
      { key: 'department', label: 'Department' },
      ...periods.map(p => ({ key: `p_${p}`, label: formatPeriod(p) })),
      { key: 'average', label: 'Average KPI' },
      { key: 'periodsScored', label: 'Periods Scored' },
    ],
    rows,
    meta: { title, periods, count: rows.length },
  });
}

// ── GET /api/kpi/reports/monthly?period=&months= ──────────────────────
router.get('/monthly', protect, async (req, res) => {
  try {
    const period = readPeriod(req, res); if (!period) return;
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);
    await periodMatrix(req, res, {
      periods: periodSeries(period, months),
      filename: `kpi-monthly-${period}.csv`,
      title: `Monthly KPI Report — ${months} months to ${formatPeriod(period)}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/kpi/reports/quarterly?period= ────────────────────────────
router.get('/quarterly', protect, async (req, res) => {
  try {
    const period = readPeriod(req, res); if (!period) return;
    const periods = quarterPeriods(period);
    const q = Math.floor((Number(period.split('-')[1]) - 1) / 3) + 1;
    await periodMatrix(req, res, {
      periods,
      filename: `kpi-quarterly-${period.split('-')[0]}-Q${q}.csv`,
      title: `Quarterly KPI Report — Q${q} ${period.split('-')[0]}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/kpi/reports/annual?year= ─────────────────────────────────
router.get('/annual', protect, async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    if (year < 2000 || year > 2100) {
      return res.status(400).json({ success: false, message: 'Invalid year.' });
    }
    await periodMatrix(req, res, {
      periods: yearPeriods(year),
      filename: `kpi-annual-${year}.csv`,
      title: `Annual KPI Report — ${year}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
