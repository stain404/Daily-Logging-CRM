#!/usr/bin/env node
//
// Removes the dead `approved` and `rejected` fields from every task.
//
// Daily updates are no longer approved or rejected — a manager leaves feedback
// instead — so the two booleans came out of models/Task.js. Mongoose governs
// what is written and what a hydrated document exposes; it does NOT reach into
// rows already sitting in the database. Those still physically carry the
// fields, and GET /api/tasks reads with .lean(), which hands back raw Mongo
// documents that never pass through the schema. So the dead fields keep
// arriving in the browser until they are deleted at the source.
//
// Nothing depends on them any more: no route reads them, no page renders them.
// This is tidying, not a fix — skipping it breaks nothing.
//
// Usage (from the server/ folder):
//   node scripts/dropApprovalFields.js            # dry run, writes nothing
//   node scripts/dropApprovalFields.js --apply    # actually removes them
//
// Runs against whatever MONGODB_URI resolves to, so it reports the host and
// database name up front — read that line before passing --apply. To point it
// at production instead of your local mongod:
//   $env:MONGODB_URI="<the live URI>"
//   node scripts/dropApprovalFields.js
//
// Where to get MONGODB_URI: the Render dashboard (Environment → MONGODB_URI on
// the daily-logging-crm service), same as resetPassword.js.

require('dotenv').config();
const dns      = require('dns');
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

// Node on this machine resolves DNS through 127.0.0.1, and nothing is
// listening there, so every `mongodb+srv://` URI dies with
// `querySrv ECONNREFUSED` before a packet reaches Atlas. Windows' own resolver
// is healthy — nslookup on the same hostname works — which makes this look
// like an Atlas outage or a firewall when it is neither.
//
// Only override when every configured server is loopback: on a machine with
// working DNS this is a no-op, and on a corporate network the local resolver
// may be the only one that can see internal hosts.
function repairDnsIfLoopback() {
  const servers = dns.getServers();
  const allLoopback = servers.every(s => s === '127.0.0.1' || s === '::1' || s.startsWith('127.'));
  if (!allLoopback) return null;
  dns.setServers(['1.1.1.1', '8.8.8.8']);
  return servers;
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('✖  No MONGODB_URI. Set it in server/.env or in the environment.');
    process.exit(1);
  }

  const repaired = repairDnsIfLoopback();
  if (repaired) {
    console.log(`\n  note      DNS was set to ${repaired.join(', ')}, which refuses connections.`);
    console.log('            Using 1.1.1.1 / 8.8.8.8 for this run only.');
  }

  await mongoose.connect(uri);
  const db    = mongoose.connection.db;
  const tasks = db.collection('tasks');

  // Say which database this is before anything else. The whole risk here is
  // running it against the wrong one, and the connection string is usually
  // the only thing that distinguishes local from live.
  console.log(`\n  host      ${mongoose.connection.host}:${mongoose.connection.port || ''}`);
  console.log(`  database  ${db.databaseName}`);
  console.log(`  mode      ${APPLY ? 'APPLY — fields will be deleted' : 'dry run — nothing will be written'}\n`);

  const filter  = { $or: [{ approved: { $exists: true } }, { rejected: { $exists: true } }] };
  const total   = await tasks.countDocuments();
  const carrying = await tasks.countDocuments(filter);

  console.log(`  ${carrying} of ${total} task${total === 1 ? '' : 's'} still carry approved/rejected.`);

  if (!carrying) {
    console.log('  Nothing to do.\n');
    await mongoose.disconnect();
    return;
  }

  // Worth seeing before deleting: an `approved: true` is a verdict somebody
  // actually left, and this is the last moment it exists anywhere.
  const wasApproved = await tasks.countDocuments({ approved: true });
  const wasRejected = await tasks.countDocuments({ rejected: true });
  console.log(`  Of those, ${wasApproved} were approved and ${wasRejected} rejected.`);
  console.log('  Those verdicts are not shown anywhere in the app any more.\n');

  const sample = await tasks.find(filter).project({ title: 1, date: 1, approved: 1, rejected: 1 }).limit(10).toArray();
  sample.forEach(t => console.log(`    ${t.date}  ${String(t.title).slice(0, 40).padEnd(40)}  approved=${t.approved}  rejected=${t.rejected}`));
  if (carrying > sample.length) console.log(`    … and ${carrying - sample.length} more`);

  if (!APPLY) {
    console.log('\n  Dry run — nothing written. Re-run with --apply to remove them.\n');
    await mongoose.disconnect();
    return;
  }

  const res = await tasks.updateMany({}, { $unset: { approved: '', rejected: '' } });
  console.log(`\n  ✅  Cleaned ${res.modifiedCount} task${res.modifiedCount === 1 ? '' : 's'}.`);

  const left = await tasks.countDocuments(filter);
  console.log(left === 0 ? '  Verified: no task carries the fields any more.\n'
                         : `  ⚠  ${left} still carry them — re-run and investigate.\n`);

  await mongoose.disconnect();
})().catch(err => {
  console.error('✖ ', err.message);
  process.exit(1);
});
