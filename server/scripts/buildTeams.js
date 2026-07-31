#!/usr/bin/env node
//
// Builds the six teams and the reporting lines that go with them.
// Dry-run by default; pass --apply to write.
//
//   node scripts/buildTeams.js
//   node scripts/buildTeams.js --apply
//
// Confirmed decisions baked in:
//   - A member's department follows their team. rameez/basith/rehan/ashfaq
//     move to Logistics under Nabil, basil moves to Procurement under Ameen,
//     aashikha moves to Sales. Otherwise department reports and team reports
//     would describe different org charts.
//   - Ameen is promoted from employee to Procurement manager, and takes MG005
//     to sit with the other managers rather than keeping an EM id.
//   - adeel is recreated (EM018) — he was removed by the roster migration
//     because he was absent from that list, then named in this one.
//   - Suhail manages two teams in two departments: IT and Sales.
//
// Both User.manager and Team.manager are set. services/notify.js resolves
// supervisors through either link, and setting both means a submission still
// reaches someone if one side is later edited.

require('dotenv').config();
const mongoose = require('mongoose');

const User       = require('../models/User');
const Team       = require('../models/Team');
const Department = require('../models/Department');

const APPLY = process.argv.includes('--apply');

// name, department, manager username, member usernames
const TEAMS = [
  ['IT Team',                 'IT',          'suhail',   ['zaeem', 'sanah']],
  ['Accounts Team',           'Accounting',  'jaisal',   ['jijesh', 'sufail']],
  ['Procurement (Ameen)',     'Procurement', 'ameen',    ['basil']],
  ['Procurement (Twalhath)',  'Procurement', 'twalhath', ['zia', 'nycee']],
  ['Logistics Team',          'Logistics',   'nabil',    ['ramees', 'adeel', 'basith', 'rehan', 'ashfaq']],
  ['Sales Team',              'Sales',       'suhail',   ['aashikha']],
];

// Role and department changes this org chart implies.
const PROMOTE = { username: 'ameen', empId: 'MG005', role: 'manager', department: 'Procurement', designation: 'Procurement Manager' };
const RECREATE = { username: 'adeel', name: 'Adeel', empId: 'EM018', role: 'employee', department: 'Logistics', designation: 'Employee' };
const TEMP_PASSWORD = 'AlQuba@2026';

const pad = (s, n) => String(s ?? '').padEnd(n);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(APPLY ? '\n\x1b[1mAPPLYING\x1b[0m' : '\n\x1b[1mDRY RUN — nothing will be written\x1b[0m');
  console.log(`db: ${mongoose.connection.name}\n`);

  const depts = Object.fromEntries((await Department.find()).map(d => [d.name, d._id]));
  const missingDept = [...new Set(TEAMS.map(t => t[1]))].filter(n => !depts[n]);
  if (missingDept.length) {
    console.error(`Missing departments: ${missingDept.join(', ')} — run restructureOrg.js first.`);
    process.exit(1);
  }

  // ── Roster adjustments ──────────────────────────────────────────────
  console.log('ROSTER CHANGES');

  const existingAdeel = await User.findOne({ username: RECREATE.username });
  if (existingAdeel) {
    console.log(`  keep    ${RECREATE.username} (already exists)`);
  } else {
    console.log(`  \x1b[32mcreate\x1b[0m  ${pad(RECREATE.username, 11)} ${RECREATE.empId} employee  ${RECREATE.department}`);
    if (APPLY) {
      await User.create({
        username: RECREATE.username, name: RECREATE.name, empId: RECREATE.empId,
        role: RECREATE.role, designation: RECREATE.designation,
        department: depts[RECREATE.department], password: TEMP_PASSWORD,
      });
    }
  }

  const ameen = await User.findOne({ username: PROMOTE.username });
  if (!ameen) {
    console.error(`  ! ${PROMOTE.username} not found — cannot promote.`);
  } else {
    console.log(`  promote ${pad(PROMOTE.username, 11)} ${ameen.empId} ${ameen.role} -> ${PROMOTE.empId} ${PROMOTE.role}, ${PROMOTE.department}`);
    if (APPLY) {
      await User.updateOne({ _id: ameen._id }, {
        empId: PROMOTE.empId, role: PROMOTE.role,
        designation: PROMOTE.designation, department: depts[PROMOTE.department],
      });
    }
  }

  // A member's department follows their team.
  console.log('\nDEPARTMENT MOVES (member follows their team)');
  for (const [, deptName, , members] of TEAMS) {
    for (const username of members) {
      const u = await User.findOne({ username }).populate('department', 'name');
      if (!u) { console.error(`  ! ${username} not found`); continue; }
      const from = u.department?.name || '(none)';
      if (from === deptName) continue;
      console.log(`  ${pad(username, 11)} ${pad(from, 12)} -> ${deptName}`);
      if (APPLY) await User.updateOne({ _id: u._id }, { department: depts[deptName] });
    }
  }

  // ── Teams ───────────────────────────────────────────────────────────
  console.log('\nTEAMS');
  for (const [name, deptName, mgrName, memberNames] of TEAMS) {
    const mgr = await User.findOne({ username: mgrName });
    if (!mgr) { console.error(`  ! manager ${mgrName} not found — skipping ${name}`); continue; }

    const members = await User.find({ username: { $in: memberNames } });
    const found = members.map(m => m.username);
    const absent = memberNames.filter(n => !found.includes(n));

    console.log(`  ${pad(name, 24)} ${pad(deptName, 12)} mgr=${pad(mgrName, 10)} members: ${found.join(', ') || '(none)'}${absent.length ? `  \x1b[31mmissing: ${absent.join(', ')}\x1b[0m` : ''}`);

    if (!APPLY) continue;

    const memberIds = members.map(m => m._id);
    // Upsert by name so re-running does not create duplicates.
    const team = await Team.findOneAndUpdate(
      { name },
      { name, department: depts[deptName], manager: mgr._id, members: memberIds },
      { new: true, upsert: true },
    );

    // Both links, per the note at the top of this file.
    await User.updateMany({ _id: { $in: memberIds } }, { team: team._id, manager: mgr._id });
    await User.updateOne({ _id: mgr._id }, { team: team._id });
  }

  console.log(APPLY ? '\n\x1b[1mDone.\x1b[0m' : '\nRe-run with --apply to write these changes.');
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
