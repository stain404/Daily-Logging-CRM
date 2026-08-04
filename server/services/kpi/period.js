// Period helpers. A KPI period is a calendar month, "YYYY-MM".
//
// Everything here works in plain date strings rather than Date objects, because
// Task.date is stored as "YYYY-MM-DD" — going through Date would drag the
// server's timezone into a comparison that has nothing to do with clock time.

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function isValidPeriod(p) {
  return typeof p === 'string' && PERIOD_RE.test(p);
}

function currentPeriod(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function parsePeriod(period) {
  if (!isValidPeriod(period)) throw new Error(`Invalid period "${period}" — expected YYYY-MM.`);
  const [y, m] = period.split('-').map(Number);
  return { year: y, month: m };
}

// Inclusive "YYYY-MM-DD" bounds for the month.
function periodRange(period) {
  const { year, month } = parsePeriod(period);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { start: `${period}-01`, end: `${period}-${String(last).padStart(2, '0')}`, days: last, mm };
}

// Previous n periods, oldest first, ending at (and including) `period`.
function periodSeries(period, n = 6) {
  const { year, month } = parsePeriod(period);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function shiftPeriod(period, delta) {
  const { year, month } = parsePeriod(period);
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The three periods of the quarter containing `period`, and the twelve of its year.
function quarterPeriods(period) {
  const { year, month } = parsePeriod(period);
  const qStart = Math.floor((month - 1) / 3) * 3 + 1;
  return [0, 1, 2].map(i => `${year}-${String(qStart + i).padStart(2, '0')}`);
}

function yearPeriods(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

// ── Working calendar ──────────────────────────────────────────────────
// Non-working days come from KPI_HOLIDAYS (comma-separated YYYY-MM-DD) and the
// weekend definition from KPI_WEEKEND (comma-separated day numbers, 0=Sunday).
// Defaults to a Sat/Sun weekend. Kept in env for now because the org has no
// holiday calendar in the database; moving it to a collection later only means
// replacing the two readers below.
function weekendDays() {
  const raw = (process.env.KPI_WEEKEND || '0,6').split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  return new Set(raw.length ? raw : [0, 6]);
}

function holidaySet() {
  return new Set(
    (process.env.KPI_HOLIDAYS || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s))
  );
}

// Working days in the period, capped at `upTo` (default today) so a partially
// elapsed month isn't judged against days that haven't happened yet — otherwise
// every employee's attendance reads as failing on the 3rd of the month.
function workingDays(period, upTo = new Date()) {
  const { year, month } = parsePeriod(period);
  const { days, end } = periodRange(period);
  const weekend = weekendDays();
  const holidays = holidaySet();

  const todayStr = `${upTo.getFullYear()}-${String(upTo.getMonth() + 1).padStart(2, '0')}-${String(upTo.getDate()).padStart(2, '0')}`;
  const limit = todayStr < end ? todayStr : end;

  const dates = [];
  for (let d = 1; d <= days; d++) {
    const ds = `${period}-${String(d).padStart(2, '0')}`;
    if (ds > limit) break;
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (weekend.has(dow)) continue;
    if (holidays.has(ds)) continue;
    dates.push(ds);
  }
  return dates;
}

function formatPeriod(period) {
  if (!isValidPeriod(period)) return period;
  const { year, month } = parsePeriod(period);
  return new Date(Date.UTC(year, month - 1, 1))
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

module.exports = {
  isValidPeriod, currentPeriod, parsePeriod, periodRange, periodSeries,
  shiftPeriod, quarterPeriods, yearPeriods, workingDays, formatPeriod,
};
