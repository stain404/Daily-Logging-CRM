// The organisation runs on one clock, not the server's.
//
// `new Date().toISOString().split('T')[0]` gives the *UTC* date. The server
// runs in UTC (Render) and staff are in the UAE at UTC+4, so between midnight
// and 04:00 local the server thinks it is still yesterday: a daily update filed
// at 01:00 lands on the previous day, and the one-entry-per-day check blocks it
// as a duplicate of the entry the employee already made that previous day.
//
// Everything that decides "what day is it" or "when is 5pm" goes through here.
// Override the zone with ORG_TZ if the organisation ever moves.

const ORG_TZ = process.env.ORG_TZ || 'Asia/Dubai';

// "YYYY-MM-DD" for an instant, in the org's timezone. en-CA because its short
// date format is already YYYY-MM-DD — the exact shape stored in Task.date.
const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ORG_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

function orgDateStr(at = new Date()) {
  return dateFmt.format(at);
}

// Today, and N days before today, as org-timezone date strings.
function orgToday() {
  return orgDateStr(new Date());
}

function orgDaysAgo(days) {
  return orgDateStr(new Date(Date.now() - days * 86400000));
}

// First day of the month that `at` falls in, org time.
function orgMonthStart(at = new Date()) {
  return `${orgDateStr(at).slice(0, 7)}-01`;
}

// The org's UTC offset in minutes at a given instant. Derived from the zone
// rather than hardcoded to +4, so a zone with DST stays correct.
function orgOffsetMinutes(at = new Date()) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: ORG_TZ, timeZoneName: 'longOffset',
  }).formatToParts(at).find(p => p.type === 'timeZoneName')?.value || '';

  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;                                    // "GMT" == UTC
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// A real instant for "HH:MM on dateStr, org time" — e.g. a 17:00 deadline is
// 17:00 in Dubai, which is 13:00Z, not 17:00Z.
//
// Returns an Invalid Date for unparseable input so callers can use the same
// isNaN guard they already use on `new Date(...)`.
function orgTimeToDate(dateStr, timeStr = '17:00') {
  const [h = 0, min = 0] = String(timeStr || '17:00').split(':').map(Number);
  const midnightUtc = Date.parse(`${dateStr}T00:00:00Z`);

  if (Number.isNaN(midnightUtc) || Number.isNaN(h) || Number.isNaN(min)) {
    return new Date(NaN);
  }

  // Read the wall clock as if it were UTC, then subtract the zone's offset to
  // get the true instant. The offset is looked up at approximately the right
  // moment, which is exact for a zone without DST and off by at most an hour
  // during a transition for one that has it.
  const asIfUtc = midnightUtc + (h * 60 + min) * 60000;
  return new Date(asIfUtc - orgOffsetMinutes(new Date(asIfUtc)) * 60000);
}

module.exports = {
  ORG_TZ,
  orgDateStr,
  orgToday,
  orgDaysAgo,
  orgMonthStart,
  orgOffsetMinutes,
  orgTimeToDate,
};
