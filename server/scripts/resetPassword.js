#!/usr/bin/env node
//
// Sets one account's password directly in the database. This is the way back in
// when the superadmin password is lost — there is no self-serve reset that can
// help, because every in-app path needs someone already logged in.
//
// Unlike resetToRealData.js, this touches ONE user and deletes nothing.
//
// Usage (from the server/ folder):
//   $env:MONGODB_URI="<the live URI>"
//   node scripts/resetPassword.js --user=Khasim --password=NewPass123
//   node scripts/resetPassword.js --user=Khasim --password=NewPass123 --apply
//
// Dry-run by default: it finds the account and reports who it would change,
// so you can confirm you have the right person and the right database before
// anything is written.
//
// --user matches username OR empId, the same two things the login form accepts.
// Pass --list to print the admin-level accounts instead, for when you are not
// sure which username still exists.
//
// Where to get MONGODB_URI: the Render dashboard holds the working one
// (Environment → MONGODB_URI on the daily-logging-crm service). The copy in
// .env.atlas is stale and fails with "bad auth".

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const LIST  = process.argv.includes('--list');

const arg = name => {
  const found = process.argv.find(a => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌  MONGODB_URI is not set.');
    process.exit(1);
  }

  const target   = arg('user');
  const password = arg('password');

  if (!LIST && (!target || !password)) {
    console.error('❌  Both --user= and --password= are required (or pass --list).');
    process.exit(1);
  }
  // Checked before connecting so a too-short password fails instantly.
  if (password && password.length < 6) {
    console.error('❌  Password must be at least 6 characters — the User model rejects less.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const dbName = mongoose.connection.name;
  console.log(`\n✅  Connected to "${dbName}"`);

  const User = require('../models/User');

  if (LIST) {
    const admins = await User.find({ role: { $in: ['superadmin', 'admin', 'hr'] } })
      .select('empId username name role active')
      .sort('role');
    console.log(`\n${admins.length} admin-level account(s):\n`);
    for (const a of admins) {
      console.log(`   ${a.role.padEnd(11)} ${String(a.username).padEnd(18)} ${a.empId}  ${a.active ? '' : '(inactive)'}`);
    }
    console.log('');
    await mongoose.disconnect();
    return;
  }

  // Same lookup the login route does, so "it works here but not at the login
  // form" can't happen: username is stored lowercase, empId uppercase.
  const user = await User.findOne({
    $or: [{ username: target.toLowerCase() }, { empId: target.toUpperCase() }],
  }).select('+password');

  if (!user) {
    console.error(`\n❌  No account with username or empId "${target}" in "${dbName}".`);
    console.error('    Run with --list to see the admin-level accounts that do exist.');
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`\n   ${user.name} — ${user.username} / ${user.empId} — ${user.role}${user.active ? '' : ' (INACTIVE)'}`);

  if (!APPLY) {
    console.log('\n\x1b[1mDRY RUN\x1b[0m — nothing written. Re-run with --apply to set the password.\n');
    await mongoose.disconnect();
    return;
  }

  // save() rather than updateOne(), so the pre-save hook hashes it. An
  // updateOne here would store the password in plain text and the login form
  // would then reject it, since matchPassword compares against a hash.
  user.password = password;
  await user.save();

  if (!user.active) {
    console.warn('\n⚠️   This account is inactive — the password is set, but check whether it can sign in.');
  }
  console.log(`\n🔑  Password updated for ${user.username}. Sign in and change it from the app.\n`);

  await mongoose.disconnect();
}

run().catch(async err => {
  console.error('❌ ', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
