// Who does a given user oversee?
//
// Three different places used to answer this three different ways — the task
// list read Team.members, the reports read Team.members, and the file picker
// read User.manager — so a manager could see somebody's tasks but not their
// name, or the reverse. Worse, Team.members goes stale: a team built before
// the org was restructured still lists people who have since moved, which is
// how a manager's team page came to show members who report to somebody else.
//
// One answer, read from every link that exists:
//   - Team.members, for the teams they manage
//   - User.team, for anyone whose own record points at one of those teams
//   - User.manager, for a direct reporting line set without a team
//
// User.team is the authoritative one; Team.members is included so a row that
// has not been reconciled yet still resolves. routes/teams.js does the reverse
// (drops stale Team.members entries) when it is *displaying* a roster — here
// the union is right, because being over-inclusive by one stale row is better
// than a manager losing sight of someone mid-restructure.

const User = require('../models/User');
const Team = require('../models/Team');

async function managedUserIds(user) {
  const teams = await Team.find({ manager: user._id }).select('_id members');
  const teamIds = teams.map(t => t._id);

  const [claimed, reports] = await Promise.all([
    teamIds.length ? User.find({ team: { $in: teamIds } }).select('_id') : [],
    User.find({ manager: user._id }).select('_id'),
  ]);

  const ids = new Set();
  teams.forEach(t => (t.members || []).forEach(m => ids.add(String(m))));
  claimed.forEach(u => ids.add(String(u._id)));
  reports.forEach(u => ids.add(String(u._id)));

  return [...ids];
}

// The same question for the screens that list people rather than their work:
// a manager appears in their own directory, because they are one of the people
// on it. Returns null when the caller sees everyone.
async function visibleUserIds(user) {
  if (['hr', 'admin', 'superadmin'].includes(user.role)) return null;
  return [...new Set([String(user._id), ...(await managedUserIds(user))])];
}

module.exports = { managedUserIds, visibleUserIds };
