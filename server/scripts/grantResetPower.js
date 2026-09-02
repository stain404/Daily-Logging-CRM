#!/usr/bin/env node
//
// Grants (or revokes) the canResetPasswords capability on one account.
//
// This is the ONLY way the flag gets set — it is deliberately absent from the
// role/edit UI so it cannot be handed out by a mis-click. The capability lets
// its holder reset employee and manager passwords without being made an admin;
// the reset routes in routes/users.js enforce it.
//
// Usage (from the server/ folder):
//   node scripts/grantResetPower.js --user=EM002              # dry run, shows who
//   node scripts/grantResetPower.js --user=EM002 --apply      # grant it
//   node scripts/grantResetPower.js --user=EM002 --revoke --apply
//   node scripts/grantResetPower.js --list                    # who currently holds it
//
// --user matches empId OR username, the two things the login form accepts.
//
// Dry run by default: it finds the account and reports what it would change,
// so you can confirm the right person and the right database before writing.
// Reports the host and database name up front — read that line before --apply.
//
// Where to get the live MONGODB_URI: the Render dashboard (Environment →
// MONGODB_URI on the daily-logging-crm service).

require('dotenv').config();
const mongoose = require('mongoose');
const { repairDnsIfLoopback } = require('../utils/dnsRepair');

const arg = name => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const APPLY  = process.argv.includes('--apply');
const REVOKE = process.argv.includes('--revoke');
const LIST   = process.argv.includes('--list');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('✖  No MONGODB_URI. Set it in server/.env or in the environment.');
    process.exit(1);
  }

  repairDnsIfLoopback();
  await mongoose.connect(uri);
  const User = require('../models/User');

  console.log(`\n  host      ${mongoose.connection.host}`);
  console.log(`  database  ${mongoose.connection.db.databaseName}\n`);

  if (LIST) {
    const holders = await User.find({ canResetPasswords: true }).select('name empId username role');
    if (!holders.length) console.log('  Nobody currently holds canResetPasswords.\n');
    else {
      console.log('  canResetPasswords holders:');
      holders.forEach(u => console.log(`    ${String(u.empId || '—').padEnd(6)} ${String(u.username).padEnd(12)} ${u.role.padEnd(10)} ${u.name}`));
      console.log('');
    }
    await mongoose.disconnect();
    return;
  }

  const who = arg('user');
  if (!who) {
    console.error('✖  Pass --user=<empId or username>, or --list.');
    await mongoose.disconnect();
    process.exit(1);
  }

  const user = await User.findOne({ $or: [{ empId: who }, { username: who }] });
  if (!user) {
    console.error(`✖  No account with empId or username "${who}".`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const want = !REVOKE;   // --revoke turns it off, otherwise on
  const verb = want ? 'GRANT' : 'REVOKE';

  console.log(`  account   ${user.name} (${user.empId || user.username}), role '${user.role}'`);
  console.log(`  currently canResetPasswords = ${user.canResetPasswords === true}`);
  console.log(`  action    ${verb} → canResetPasswords = ${want}`);
  console.log(`  mode      ${APPLY ? 'APPLY' : 'dry run — nothing will be written'}\n`);

  if (user.canResetPasswords === want) {
    console.log('  Already in the requested state. Nothing to do.\n');
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log('  Dry run — nothing written. Re-run with --apply to make the change.\n');
    await mongoose.disconnect();
    return;
  }

  // updateOne, not save(), so the password pre-save hook does not fire and
  // re-hash the already-hashed password.
  await User.updateOne({ _id: user._id }, { $set: { canResetPasswords: want } });
  console.log(`  ✅  ${verb === 'GRANT' ? 'Granted' : 'Revoked'}. ${user.name} canResetPasswords = ${want}.\n`);

  await mongoose.disconnect();
})().catch(err => {
  console.error('✖ ', err.message);
  process.exit(1);
});
