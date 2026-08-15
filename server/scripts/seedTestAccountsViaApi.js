#!/usr/bin/env node
//
// Creates the QA roster (see qaRoster.js) through a RUNNING server's API,
// instead of writing to a database directly like seedTestAccounts.js does.
//
// Use this when you have a superadmin login but not the database credentials —
// which is the situation on live, where the app's own MONGODB_URI works but the
// copy in .env.atlas no longer authenticates.
//
// Usage (from the server/ folder):
//   $env:API_URL="https://daily-logging-crm.onrender.com"
//   $env:ADMIN_USER="<superadmin username>"
//   $env:ADMIN_PASS="<superadmin password>"
//   node scripts/seedTestAccountsViaApi.js --password=test123
//
// Add --apply to actually write; without it the script logs in, reports what it
// would create, and changes nothing. Everything it makes is prefixed QA, so
// removal is: delete the QA users, then QA Team A/B, then QA Department — in
// that order, since teams reference the department and users reference teams.
//
// Creating an account through the API rather than the database means it goes
// through the same validation and audit trail as a real one: each user shows up
// in the audit log as "User Created" by whoever you logged in as.

require('dotenv').config();
const { PEOPLE, DEPARTMENT, TEAM_NAME, NOTE, passwordFromArgv } = require('./qaRoster');

const APPLY    = process.argv.includes('--apply');
const API_URL  = (process.env.API_URL || '').replace(/\/+$/, '');
const USER     = process.env.ADMIN_USER;
const PASS     = process.env.ADMIN_PASS;

let TOKEN = null;

async function api(method, path, body) {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    // A non-JSON body means we reached something that isn't the API — a proxy
    // error page, or API_URL pointing at the static client.
    throw new Error(`${method} ${path} returned ${res.status} and a non-JSON body. Is API_URL right?`);
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.message || 'no message'}`);
  return data;
}

// Departments and teams have no upsert over the API, so re-running means
// finding what a previous run made rather than blindly creating a duplicate.
async function findOrCreate(kind, listPath, name, payload) {
  const list  = await api('GET', listPath);
  const items = list[kind] || list.data || [];
  const found = items.find(i => i.name === name);
  if (found) {
    console.log(`  exists  ${name}`);
    return found;
  }
  if (!APPLY) {
    console.log(`  create  ${name}  (dry run)`);
    return { _id: `<new ${name}>` };
  }
  const created = await api('POST', listPath, payload);
  console.log(`  created ${name}`);
  return created[kind.replace(/s$/, '')] || created.department || created.team;
}

async function run() {
  const PASSWORD = passwordFromArgv(process.argv);

  const missing = [
    !API_URL && 'API_URL',
    !USER    && 'ADMIN_USER',
    !PASS    && 'ADMIN_PASS',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`❌  Not set: ${missing.join(', ')}`);
    console.error('    See the usage comment at the top of this file.');
    process.exit(1);
  }

  console.log(APPLY ? '\n\x1b[1mAPPLYING\x1b[0m' : '\n\x1b[1mDRY RUN — nothing will be written\x1b[0m');
  console.log(`target: ${API_URL}\n`);

  const login = await api('POST', '/auth/login', { username: USER, password: PASS });
  TOKEN = login.token;
  const me = login.user || {};
  console.log(`✅  Logged in as ${me.username || USER} (${me.role || 'role unknown'})`);
  if (me.role && me.role !== 'superadmin') {
    // hr is blocked from creating admin/superadmin rows, and QA001/QA002 are
    // exactly that — better to say so now than to fail on the third account.
    console.warn(`⚠️   ${me.role} cannot create every role in the roster; QA001/QA002 will likely 403.`);
  }

  console.log('\nDEPARTMENT & TEAMS');
  const dept = await findOrCreate('departments', '/departments', DEPARTMENT,
    { name: DEPARTMENT, description: NOTE });

  const teams = {};
  for (const key of ['A', 'B']) {
    teams[key] = await findOrCreate('teams', '/teams', TEAM_NAME(key),
      { name: TEAM_NAME(key), department: dept._id, description: NOTE });
  }

  console.log('\nACCOUNTS');
  const existing = (await api('GET', '/users')).users || [];
  const created  = [];

  for (const p of PEOPLE) {
    const already = existing.find(u => u.empId === p.empId);
    if (already) {
      // Left alone rather than reset: the password of an account someone may
      // already be using is not this script's to change silently.
      console.log(`  exists  ${p.empId}  ${p.username}  (left as is)`);
      created.push({ ...p, id: already._id });
      continue;
    }
    if (!APPLY) {
      console.log(`  create  ${p.empId}  ${p.username.padEnd(16)} ${p.role}  (dry run)`);
      continue;
    }
    const res = await api('POST', '/users', {
      empId:       p.empId,
      username:    p.username,
      name:        p.name,
      role:        p.role,
      designation: p.designation,
      department:  dept._id,
      team:        p.team ? teams[p.team]._id : undefined,
      password:    PASSWORD,
      // Email left unset on purpose: §8 wants a no-email user, and unset means
      // a test run can never send mail to a real address.
    });
    console.log(`  created ${p.empId}  ${p.username.padEnd(16)} ${p.role}`);
    created.push({ ...p, id: res.user._id });
  }

  if (APPLY) {
    // Team membership is a separate endpoint — the user rows above only carry
    // their own team pointer, which leaves Team.members empty otherwise.
    console.log('\nTEAM MEMBERSHIP');
    for (const key of ['A', 'B']) {
      const members = created.filter(p => p.team === key).map(p => p.id);
      const manager = created.find(p => p.role === 'manager' && p.team === key);
      if (!members.length) continue;
      await api('PUT', `/teams/${teams[key]._id}/members`, { members });
      if (manager) await api('PUT', `/teams/${teams[key]._id}`, { manager: manager.id });
      console.log(`  ${TEAM_NAME(key)} → ${members.length} members, manager ${manager ? manager.username : 'none'}`);
    }
    console.log(`\n📋  Roster ready on ${API_URL} — password for all: ${PASSWORD}`);
  } else {
    console.log('\n   Re-run with --apply to write.');
  }
}

run().catch(err => {
  console.error('❌ ', err.message);
  process.exit(1);
});
