// Copy a whole database (documents + indexes) from one MongoDB to another,
// so you can run the test checklist against a throwaway copy instead of the
// live staff records.
//
// mongodump/mongorestore are not installed on this machine, so this does the
// same job with the driver that is already in node_modules.
//
// Usage (from the server/ folder):
//   node scripts/cloneDb.js --from "<source uri>" --to "<target uri>"
//
//   # live Atlas  ->  local scratch copy
//   node scripts/cloneDb.js --from "mongodb+srv://user:pass@cluster/taskflow" \
//                           --to   "mongodb://localhost:27017/taskflow_test"
//
//   # local live  ->  local scratch copy
//   node scripts/cloneDb.js --from "mongodb://localhost:27017/taskflow" \
//                           --to   "mongodb://localhost:27017/taskflow_test"
//
// Both URIs must name a database. The target is dropped first, so it always
// ends up an exact copy rather than a merge of two runs.
//
// Guards, because the whole point is not to touch production:
//   * refuses to write to a database whose name is not clearly a test copy
//     (must contain "test", "copy", "scratch", "staging" or "_clone").
//     Override deliberately with --i-know-what-im-doing.
//   * refuses if source and target are the same database.
//   * never writes to the source.

const { MongoClient } = require('mongodb');
const { repairDnsIfLoopback } = require('../utils/dnsRepair');
repairDnsIfLoopback();

const SAFE_TARGET = /(test|copy|scratch|staging|_clone)/i;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function dbNameOf(uri) {
  // Everything after the last '/' and before any '?' — the driver's own rule.
  const withoutQuery = uri.split('?')[0];
  const name = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  return name || null;
}

async function run() {
  const from = arg('from');
  const to   = arg('to');
  const force = process.argv.includes('--i-know-what-im-doing');

  if (!from || !to) {
    console.error('Usage: node scripts/cloneDb.js --from "<uri>/<db>" --to "<uri>/<db>"');
    process.exit(1);
  }

  const fromDb = dbNameOf(from);
  const toDb   = dbNameOf(to);

  if (!fromDb || !toDb) {
    console.error('❌  Both URIs must end in a database name, e.g. .../taskflow_test');
    process.exit(1);
  }
  if (from === to) {
    console.error('❌  Source and target are the same database.');
    process.exit(1);
  }
  if (!SAFE_TARGET.test(toDb) && !force) {
    console.error(`❌  Target db "${toDb}" does not look like a test copy.`);
    console.error('    Name it something like taskflow_test, or pass --i-know-what-im-doing.');
    process.exit(1);
  }

  const src = await MongoClient.connect(from);
  const dst = await MongoClient.connect(to);
  console.log(`📖  source: ${fromDb}`);
  console.log(`📝  target: ${toDb}`);

  try {
    const source = src.db(fromDb);
    const target = dst.db(toDb);

    await target.dropDatabase();
    console.log(`🗑️   dropped existing ${toDb}`);

    const collections = (await source.listCollections().toArray())
      .filter(c => c.type !== 'view' && !c.name.startsWith('system.'));

    for (const { name } of collections) {
      const docs = await source.collection(name).find({}).toArray();
      if (docs.length) {
        // ordered:false so one bad doc doesn't abort the rest of the collection.
        await target.collection(name).insertMany(docs, { ordered: false });
      } else {
        await target.createCollection(name);
      }

      // Indexes matter here: the checklist tests duplicate-key behaviour
      // (§7 duplicate empId/username/email), which only reproduces with them.
      const indexes = await source.collection(name).indexes();
      let copiedIdx = 0;
      for (const idx of indexes) {
        if (idx.name === '_id_') continue;
        const { key, name: idxName, v, ns, ...opts } = idx;
        try {
          await target.collection(name).createIndex(key, { name: idxName, ...opts });
          copiedIdx++;
        } catch (err) {
          console.warn(`   ⚠️  index ${idxName} on ${name}: ${err.message}`);
        }
      }
      console.log(`   ✔ ${name}: ${docs.length} docs, ${copiedIdx} indexes`);
    }

    console.log(`\n✅  ${collections.length} collections copied into ${toDb}`);
    console.log('    Point the server at it with MONGODB_URI before starting it.');
  } finally {
    await src.close();
    await dst.close();
  }
}

run().catch(err => {
  console.error('❌ ', err.message);
  process.exit(1);
});
