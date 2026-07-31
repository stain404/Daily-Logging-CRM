#!/usr/bin/env node
//
// Rebuilds the department list and the staff roster to match the agreed org
// chart. Dry-run by default; pass --apply to write.
//
//   node scripts/restructureOrg.js            # show exactly what would change
//   node scripts/restructureOrg.js --apply    # do it
//
// Decisions baked in here, all confirmed rather than assumed:
//   - Employee IDs are numbered sequentially. The supplied list reused EM002
//     for twelve people and empId is a unique index, so it could not be
//     applied verbatim. IDs given explicitly (EM003-EM007) are honoured and
//     the rest fill in around them, in the order the list was written.
//   - "Finance" maps to Accounting; it was not one of the seven departments.
//   - Muhammed is kept as HR. He was absent from the list, but he is the only
//     holder of the role that maintains staff records.
//   - Suhail sits in IT with "IT Operations" as his designation. A user has a
//     single department field, so it cannot hold both.
//   - Rameez appeared twice in the list; he is one person.
//
// Teams are preserved, not deleted: they carry the manager -> employee
// reporting lines that services/notify.js resolves through supervisorsOf().
// Each team is re-pointed at its manager's new department.

require('dotenv').config();
const mongoose = require('mongoose');

const User       = require('../models/User');
const Team       = require('../models/Team');
const Task       = require('../models/Task');
const Department = require('../models/Department');
const Notification = require('../models/Notification');

const APPLY = process.argv.includes('--apply');

// Seven departments, plus the colours they show up with in reports. Kept
// distinct around the colour wheel so a department chart stays readable.
const DEPARTMENTS = [
  { name: 'IT',          color: '#f5006b' },
  { name: 'Procurement', color: '#00a86b' },
  { name: 'Logistics',   color: '#00b8d4' },
  { name: 'Marketing',   color: '#8b2fe0' },
  { name: 'Sales',       color: '#ff8c00' },
  { name: 'Accounting',  color: '#e34a2b' },
  { name: 'Operations',  color: '#0f766e' },
];

// username, name, empId, role, department, designation
// username is how existing records are matched; the three new hires get one
// derived from their first name.
const ROSTER = [
  ['zaeem',     'Zaeem Sheikh',   'EM002', 'employee',   'IT',          'Employee'],
  ['sanah',     'Sanah Sulaiman', 'EM003', 'employee',   'IT',          'Employee'],
  ['zia',       'Zia',            'EM004', 'employee',   'Procurement', 'Employee'],
  ['nycee',     'Nycee',          'EM005', 'employee',   'Procurement', 'Employee'],
  ['jijesh',    'Jijesh',         'EM006', 'employee',   'Accounting',  'Employee'],
  ['sufail',    'Sufail',         'EM007', 'employee',   'Accounting',  'Employee'],
  ['ramees',    'Rameez',         'EM008', 'employee',   'IT',          'Employee'],
  ['rehan',     'Rehan',          'EM009', 'employee',   'IT',          'Employee'],
  ['arjun',     'Arjun',          'EM010', 'employee',   'IT',          'Employee'],
  ['basil',     'Basil',          'EM011', 'employee',   'IT',          'Employee'],
  ['basith',    'Basith',         'EM012', 'employee',   'IT',          'Employee'],
  ['aashikha',  'Aashika',        'EM013', 'employee',   'IT',          'Employee'],
  ['shakir',    'Shakir',         'EM014', 'employee',   'IT',          'Employee'],
  ['ameen',     'Ameen',          'EM015', 'employee',   'IT',          'Employee'],
  ['ashfaq',    'Ashfaq',         'EM016', 'employee',   'IT',          'Employee'],
  ['fathima',   'Fathima',        'EM017', 'employee',   'IT',          'Employee'],

  ['suhail',    'Suhail Ahmed',   'MG001', 'manager',    'IT',          'IT Operations'],
  ['jaisal',    'Jaisal',         'MG002', 'manager',    'Accounting',  'Manager'],
  ['nabil',     'Nabil',          'MG003', 'manager',    'Logistics',   'Manager'],
  ['twalhath',  'Twalhath',       'MG004', 'manager',    'Procurement', 'Manager'],

  ['khasim',    'Khasim',         'SA001', 'superadmin', null,          'CEO'],
  ['syedaseel', 'Aseel',          'SA002', 'admin',      null,          'Managing Director'],

  // Not on the supplied list, kept deliberately: the only HR account.
  ['muhammed',  'Muhammed AK',    'HR001', 'hr',         null,          'HR'],
];

// Password for accounts created by this script. They cannot log in without
// one, and it is printed so it can be handed over and changed.
const TEMP_PASSWORD = 'AlQuba@2026';

const pad = (s, n) => String(s ?? '').padEnd(n);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(APPLY ? '\n\x1b[1mAPPLYING\x1b[0m\n' : '\n\x1b[1mDRY RUN — nothing will be written\x1b[0m\n');

  // ── Departments ─────────────────────────────────────────────────────
  const existingDepts = await Department.find();
  const keepNames = DEPARTMENTS.map(d => d.name);
  const deptDrop  = existingDepts.filter(d => !keepNames.includes(d.name));

  console.log('DEPARTMENTS');
  const deptMap = {};
  for (const spec of DEPARTMENTS) {
    const found = existingDepts.find(d => d.name === spec.name);
    console.log(`  ${found ? 'keep  ' : 'create'} ${spec.name}`);
    if (APPLY) {
      const doc = found
        ? await Department.findByIdAndUpdate(found._id, { color: spec.color }, { new: true })
        : await Department.create(spec);
      deptMap[spec.name] = doc._id;
    } else if (found) {
      deptMap[spec.name] = found._id;
    }
  }
  deptDrop.forEach(d => console.log(`  \x1b[31mdelete\x1b[0m ${d.name}`));

  // ── Users ───────────────────────────────────────────────────────────
  const allUsers   = await User.find();
  const rosterKeys = ROSTER.map(r => r[0]);
  const userDrop   = allUsers.filter(u => !rosterKeys.includes(u.username));

  console.log('\nUSERS');

  // empId is a unique index and this migration shuffles IDs between people:
  // muhammed holds EM002 which goes to zaeem, and adeel holds EM012 which goes
  // to basith. Assigning in any single pass hits a duplicate key partway
  // through and leaves the roster half-migrated.
  //
  // So: drop the departing users first, then park every remaining empId on a
  // temporary unique value, then assign the real ones. Order stops mattering.
  // Counted before anything is removed, so the report is accurate in both modes.
  const dropInfo = [];
  for (const u of userDrop) {
    const [t, n] = await Promise.all([
      Task.countDocuments({ userId: u._id }),
      Notification.countDocuments({ user: u._id }),
    ]);
    dropInfo.push({ u, t, n });
  }

  if (APPLY) {
    for (const u of userDrop) {
      await Promise.all([
        Task.deleteMany({ userId: u._id }),
        Notification.deleteMany({ user: u._id }),
        Team.updateMany({ members: u._id }, { $pull: { members: u._id } }),
      ]);
      await User.deleteOne({ _id: u._id });
    }
    for (const u of allUsers.filter(x => rosterKeys.includes(x.username))) {
      await User.updateOne({ _id: u._id }, { empId: `TMP-${u._id}` });
    }
  }

  for (const [username, name, empId, role, dept, desig] of ROSTER) {
    const existing = allUsers.find(u => u.username === username);
    const verb = existing ? 'update' : '\x1b[32mcreate\x1b[0m';
    console.log(`  ${verb} ${pad(username, 11)} ${pad(empId, 7)} ${pad(role, 11)} ${pad(dept || '(none)', 12)} ${desig}`);

    if (!APPLY) continue;

    const fields = {
      name, empId, role, designation: desig,
      department: dept ? deptMap[dept] : undefined,
    };

    if (existing) {
      // $unset rather than set-undefined so the field is actually removed
      // when a person has no department.
      const update = { $set: {} , $unset: {} };
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) update.$unset[k] = 1; else update.$set[k] = v;
      }
      if (!Object.keys(update.$unset).length) delete update.$unset;
      await User.updateOne({ _id: existing._id }, update);
    } else {
      await User.create({ ...fields, username, password: TEMP_PASSWORD });
    }
  }

  // Already removed above, before the empId shuffle — this only reports it.
  for (const { u, t, n } of dropInfo) {
    console.log(`  \x1b[31mdelete\x1b[0m ${pad(u.username, 11)} ${pad(u.empId, 7)} ${pad(u.role, 11)} (${t} tasks, ${n} notifications)`);
  }

  // ── Teams ───────────────────────────────────────────────────────────
  // Re-pointed at the manager's new department rather than deleted, so the
  // reporting lines notify.js walks stay intact.
  console.log('\nTEAMS (preserved, re-pointed to their manager\'s department)');
  const teams = await Team.find().populate('manager', 'username');
  for (const t of teams) {
    const mgrRow = t.manager && ROSTER.find(r => r[0] === t.manager.username);
    const target = mgrRow ? mgrRow[4] : null;
    console.log(`  ${pad(t.name, 14)} -> ${target || '(manager not in roster — left as is)'}`);
    if (APPLY && target && deptMap[target]) {
      await Team.updateOne({ _id: t._id }, { department: deptMap[target] });
    }
  }

  if (APPLY) {
    for (const d of deptDrop) await Department.deleteOne({ _id: d._id });
    console.log(`\n\x1b[1mDone.\x1b[0m New accounts use the password: ${TEMP_PASSWORD}`);
  } else {
    console.log('\nRe-run with --apply to write these changes.');
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
