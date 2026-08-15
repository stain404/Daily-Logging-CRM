// Creates the throwaway accounts §0 of TESTING-CHECKLIST.md asks for:
// one per role, plus TWO managers each owning their own team, because most
// scoping bugs (§10.2) only show up when manager A reaches for manager B's team.
//
// Run it against a CLONE, never the live database — it refuses to run unless
// the db name looks like a test copy. --i-know-what-im-doing overrides that,
// and should stay reserved for the rare case where the accounts are wanted on
// live on purpose; see the cleanup line at the bottom of this comment.
//
// Usage (from the server/ folder):
//   $env:MONGODB_URI="mongodb://localhost:27017/taskflow_test"
//   node scripts/seedTestAccounts.js
//
// Password defaults to QAtest123 — the one §0 of the checklist documents.
// Override for a one-off run without editing this file:
//   node scripts/seedTestAccounts.js --password=test123
//
// Re-running is safe: existing QA rows are matched by empId and updated.
// Everything it creates is prefixed QA / "QA " so you can find and remove it
// (§12: "confirm no test data leaked into the real database").

require('dotenv').config();
const mongoose = require('mongoose');

const SAFE_TARGET = /(test|copy|scratch|staging|_clone)/i;

const passwordArg = process.argv.find(a => a.startsWith('--password='));
const PASSWORD = passwordArg ? passwordArg.slice('--password='.length) : 'QAtest123';

const PEOPLE = [
  { empId: 'QA001', username: 'qa.superadmin', name: 'QA Superadmin', role: 'superadmin', designation: 'QA Superadmin' },
  { empId: 'QA002', username: 'qa.admin',      name: 'QA Admin',      role: 'admin',      designation: 'QA Admin' },
  { empId: 'QA003', username: 'qa.hr',         name: 'QA HR',         role: 'hr',         designation: 'QA HR Officer' },
  { empId: 'QA004', username: 'qa.manager.a',  name: 'QA Manager A',  role: 'manager',    designation: 'QA Manager A', team: 'A' },
  { empId: 'QA005', username: 'qa.manager.b',  name: 'QA Manager B',  role: 'manager',    designation: 'QA Manager B', team: 'B' },
  { empId: 'QA006', username: 'qa.employee.a', name: 'QA Employee A', role: 'employee',   designation: 'QA Employee A', team: 'A' },
  { empId: 'QA007', username: 'qa.employee.b', name: 'QA Employee B', role: 'employee',   designation: 'QA Employee B', team: 'B' },
  // Deliberately in no team at all — §7 asks whether their work is visible to anyone.
  { empId: 'QA008', username: 'qa.orphan',     name: 'QA Orphan',     role: 'employee',   designation: 'QA Unassigned' },
];

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌  MONGODB_URI is not set.');
    process.exit(1);
  }

  // Checked here rather than letting the model reject it, so a typo'd
  // --password= fails before any account is written instead of halfway through.
  if (PASSWORD.length < 6) {
    console.error(`❌  Password "${PASSWORD}" is under the 6-character minimum the User model enforces.`);
    process.exit(1);
  }

  await mongoose.connect(uri);
  const dbName = mongoose.connection.name;

  if (!SAFE_TARGET.test(dbName)) {
    if (!process.argv.includes('--i-know-what-im-doing')) {
      console.error(`❌  Refusing to seed test accounts into "${dbName}" — that is not a test copy.`);
      console.error('    Clone the database first: node scripts/cloneDb.js --from ... --to ...');
      await mongoose.disconnect();
      process.exit(1);
    }
    console.warn(`\n⚠️   "${dbName}" is not a test copy — seeding into it anyway (--i-know-what-im-doing).`);
    console.warn('    These are real logins on that database until they are removed:');
    console.warn(`    db.users.deleteMany({ empId: /^QA/ }) and drop "QA Department" / "QA Team A" / "QA Team B".\n`);
  }
  console.log(`✅  Connected to ${dbName}`);

  const User       = require('../models/User');
  const Team       = require('../models/Team');
  const Department = require('../models/Department');

  const dept = await Department.findOneAndUpdate(
    { name: 'QA Department' },
    { name: 'QA Department', description: 'Throwaway department for checklist testing' },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const teams = {};
  for (const key of ['A', 'B']) {
    teams[key] = await Team.findOneAndUpdate(
      { name: `QA Team ${key}` },
      { name: `QA Team ${key}`, department: dept._id, description: 'Throwaway team for checklist testing' },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  const created = [];
  for (const p of PEOPLE) {
    // save() rather than updateOne() so the pre-save hook hashes the password
    // and regenerates initials, same path the real app uses.
    let user = await User.findOne({ empId: p.empId }).select('+password');
    if (!user) user = new User({ empId: p.empId });

    user.username    = p.username;
    user.name        = p.name;
    user.role        = p.role;
    user.designation = p.designation;
    user.department  = dept._id;
    user.active      = true;
    user.password    = PASSWORD;                 // re-hashed every run
    user.team        = p.team ? teams[p.team]._id : undefined;
    // Email left unset on purpose: §8 wants a no-email user, and unset avoids
    // real mail ever reaching a real address from a test run.
    await user.save();
    created.push({ ...p, id: user._id });
  }

  // Wire team manager + membership from the roles above.
  for (const key of ['A', 'B']) {
    const manager = created.find(p => p.role === 'manager' && p.team === key);
    const members = created.filter(p => p.team === key).map(p => p.id);
    await Team.updateOne({ _id: teams[key]._id }, { manager: manager.id, members });
    await User.updateMany(
      { _id: { $in: members }, role: 'employee' },
      { manager: manager.id },
    );
  }

  console.log(`\n📋  ${created.length} QA accounts ready in "${dbName}" — password for all: ${PASSWORD}\n`);
  for (const p of created) {
    console.log(`   ${p.role.padEnd(11)} ${p.username.padEnd(16)} ${p.empId}  ${p.team ? 'QA Team ' + p.team : '(no team)'}`);
  }
  console.log('\n   QA Department → QA Team A (Manager A + Employee A), QA Team B (Manager B + Employee B)');
  console.log('   Manager A vs Manager B is the pair to use for the §10.2 scoping probes.');

  await mongoose.disconnect();
}

run().catch(async err => {
  console.error('❌ ', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
