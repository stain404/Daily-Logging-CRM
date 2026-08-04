// ═══════════════════════════════════════════════════════════════════════
//  VISIBILITY SCOPING
//
//  One place that answers "whose KPI may this person see, and whose may they
//  review?". Every KPI route goes through here rather than re-deriving team
//  membership, so a permission change lands in one file.
//
//  Manager scope is by TEAM, not department — a manager's world is the teams
//  they manage (PRODUCT.md principle 3, and what routes/reports.js already
//  enforces). Department-level numbers stay with HR, admin and superadmin.
// ═══════════════════════════════════════════════════════════════════════

const Team = require('../../models/Team');
const User = require('../../models/User');

const COMPANY_WIDE = ['hr', 'admin', 'superadmin'];

function isCompanyWide(user) {
  return COMPANY_WIDE.includes(user.role);
}

/**
 * The employee ids this user may read KPI data for.
 * @returns {{ all: boolean, ids: ObjectId[]|null, teamIds: ObjectId[] }}
 *          all:true means unrestricted — callers should skip the id filter
 *          entirely rather than loading every id in the company.
 */
async function visibleUserIds(user) {
  if (isCompanyWide(user)) {
    return { all: true, ids: null, teamIds: [] };
  }

  if (user.role === 'manager') {
    const teams = await Team.find({ manager: user._id }).select('_id members').lean();
    const ids = teams.flatMap(t => t.members || []);
    // A manager sees their own scorecard alongside their team's.
    ids.push(user._id);
    return {
      all: false,
      ids: dedupe(ids),
      teamIds: teams.map(t => t._id),
    };
  }

  // employee — self only.
  return { all: false, ids: [user._id], teamIds: [] };
}

/** Employees this manager is responsible for, excluding themselves. */
async function directReports(user) {
  if (user.role === 'manager') {
    const teams = await Team.find({ manager: user._id }).select('members').lean();
    return dedupe(teams.flatMap(t => t.members || []));
  }
  if (isCompanyWide(user)) {
    const users = await User.find({
      role: { $in: ['employee', 'manager', 'hr'] }, active: true,
    }).select('_id').lean();
    return users.map(u => u._id);
  }
  return [];
}

/** Can `user` read `targetId`'s scorecard? */
async function canView(user, targetId) {
  const scope = await visibleUserIds(user);
  if (scope.all) return true;
  return scope.ids.some(id => String(id) === String(targetId));
}

/**
 * Can `user` write a review / manual metric / approval for `targetId`?
 * Stricter than canView: an employee can see their own score but never score
 * themselves, and a manager reviews their reports rather than themselves.
 */
async function canReview(user, targetId) {
  if (String(user._id) === String(targetId)) return false;
  if (isCompanyWide(user)) return true;
  if (user.role !== 'manager') return false;
  const reports = await directReports(user);
  return reports.some(id => String(id) === String(targetId));
}

/**
 * Mongo filter fragment for KpiScore/User queries. Returns {} for company-wide
 * roles so the query stays index-friendly instead of carrying a 1000-element $in.
 */
async function scopeFilter(user, field = 'user') {
  const scope = await visibleUserIds(user);
  if (scope.all) return {};
  return { [field]: { $in: scope.ids } };
}

function dedupe(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const k = String(id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(id);
  }
  return out;
}

module.exports = {
  isCompanyWide, visibleUserIds, directReports,
  canView, canReview, scopeFilter, COMPANY_WIDE,
};
