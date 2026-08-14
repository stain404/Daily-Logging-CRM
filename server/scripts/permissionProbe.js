// Runs the §2 permission matrix and the §9.2 / §9.3 scoping probes from
// TESTING-CHECKLIST.md against a running server, and prints pass/fail per check.
//
// Why a script and not Burp: every probe here is "call endpoint E as role R,
// expect status S". Burp is for tampering with requests the UI already made;
// this is a fixed matrix, so it should be repeatable and diffable instead.
// §11.2 says re-run these after ANY permission fix — that only happens if it's
// one command.
//
// Usage (from the server/ folder, with the app running):
//   node scripts/permissionProbe.js
//   node scripts/permissionProbe.js --url http://localhost:5000
//
// SAFETY: some probes mutate (they try to escalate a role, and to delete
// another team's task) — that is the whole point, since a silent success IS the
// bug. So it refuses to run unless the target is localhost AND /api/health
// reports a non-production env. Every mutation it makes, it reverts.
//
// Requires the QA accounts from scripts/seedTestAccounts.js (password QAtest123).

const BASE = (() => {
  const i = process.argv.indexOf('--url');
  return (i === -1 ? 'http://localhost:5000' : process.argv[i + 1]).replace(/\/$/, '');
})();
const FORCE    = process.argv.includes('--i-know-what-im-doing');
const PASSWORD = 'QAtest123';

const results = [];
let currentSection = '';

function section(name) { currentSection = name; }

function record(id, desc, expected, actual, note) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  results.push({ id, desc, expected, actual, ok, note, section: currentSection });
  const mark = ok ? '  [x]' : '  [o]';
  const exp  = Array.isArray(expected) ? expected.join('/') : expected;
  console.log(`${mark} ${id.padEnd(7)} want ${String(exp).padEnd(7)} got ${String(actual).padEnd(5)} ${desc}`);
  if (note) console.log(`          ${note}`);
  return ok;
}

// ── HTTP ──────────────────────────────────────────────────────────────
async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body  ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` }   : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON (e.g. the SPA fallback) */ }
  return { status: res.status, data };
}

async function login(username) {
  const { status, data } = await call('POST', '/api/auth/login', {
    body: { username, password: PASSWORD },
  });
  if (status !== 200 || !data?.token) {
    throw new Error(`login failed for ${username} (${status}: ${data?.message || 'no token'})`);
  }
  return { token: data.token, user: data.user };
}

// A denial must return no payload, not just a non-200. Catches an endpoint that
// 403s in the status line while still leaking the body.
function leaked(data, key) {
  const v = data?.[key];
  return Array.isArray(v) ? v.length > 0 : Boolean(v);
}

// ── Preflight ─────────────────────────────────────────────────────────
async function preflight() {
  const { status, data } = await call('GET', '/api/health');
  if (status !== 200) throw new Error(`server not reachable at ${BASE} (status ${status})`);

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(BASE);
  const isProd  = data?.env === 'production';

  if ((!isLocal || isProd) && !FORCE) {
    console.error(`\n❌  Refusing to run: target="${BASE}" env="${data?.env}".`);
    console.error('    These probes mutate data (role escalation, task deletion).');
    console.error('    Point at a local server on a cloned database, or pass --i-know-what-im-doing.\n');
    process.exit(1);
  }
  console.log(`server: ${BASE}  env=${data?.env}\n`);
}

async function run() {
  await preflight();

  const su  = await login('qa.superadmin');
  const ad  = await login('qa.admin');
  const hr  = await login('qa.hr');
  const mA  = await login('qa.manager.a');
  const mB  = await login('qa.manager.b');
  const eA  = await login('qa.employee.a');
  const eB  = await login('qa.employee.b');
  console.log('logged in as all 7 QA roles\n');

  // Directory of QA users, via a role allowed to read it.
  const { data: dir } = await call('GET', '/api/users?search=QA', { token: su.token });
  const byEmp = Object.fromEntries((dir?.users || []).map(u => [u.empId, u]));
  const empB  = byEmp['QA007'];
  const empA  = byEmp['QA006'];

  // ── §2 · unauthenticated ───────────────────────────────────────────
  section('§2 · no token');
  for (const [path, label] of [
    ['/api/tasks',              'tasks'],
    ['/api/users',              'users'],
    ['/api/reports/employee',   'employee report'],
    ['/api/audit',              'audit log'],
    ['/api/notifications',      'notifications'],
  ]) {
    const { status } = await call('GET', path);
    record('2.13', `no auth header → ${label}`, 401, status);
  }

  // ── §2 · HR limits ─────────────────────────────────────────────────
  section('§2 · HR limits');
  {
    const r = await call('POST', '/api/users', { token: hr.token, body: {
      empId: 'QAPROBE1', username: 'qa.probe.admin', name: 'QA Probe Admin',
      designation: 'Probe', role: 'admin', password: PASSWORD,
    }});
    record('2.1', 'HR creates an admin account', 403, r.status);
    if (r.status === 201) {
      await call('DELETE', `/api/users/${r.data.user._id}`, { token: su.token });
      console.log('          (reverted: probe admin deleted)');
    }
  }
  {
    const r = await call('PUT', `/api/users/${ad.user._id}`, {
      token: hr.token, body: { designation: 'HR touched this' },
    });
    record('2.2', "HR edits an admin's account", 403, r.status);
  }
  {
    const r = await call('PUT', `/api/users/${empA._id}`, {
      token: hr.token, body: { role: 'admin' },
    });
    record('2.3', 'HR promotes an employee to admin', 403, r.status);
    if (r.status === 200) {
      await call('PUT', `/api/users/${empA._id}`, { token: su.token, body: { role: 'employee' } });
      console.log('          (reverted: QA006 back to employee)');
    }
  }

  // ── §9.3 · admin self-escalation ───────────────────────────────────
  section('§9.3 · admin escalation');
  {
    const r = await call('PUT', `/api/users/${ad.user._id}`, {
      token: ad.token, body: { role: 'superadmin' },
    });
    record('9.3a', 'admin promotes SELF to superadmin', 403, r.status,
      r.data?.user?.role === 'superadmin' ? '⚠  role actually changed to superadmin' : undefined);
    if (r.data?.user?.role === 'superadmin') {
      await call('PUT', `/api/users/${ad.user._id}`, { token: su.token, body: { role: 'admin' } });
      console.log('          (reverted: QA002 back to admin)');
    }
  }
  {
    const r = await call('PUT', `/api/users/${su.user._id}`, {
      token: ad.token, body: { active: false },
    });
    record('9.3b', 'admin deactivates the superadmin', 403, r.status);

    if (r.status === 200) {
      // Deliberately NOT su.token: the account was just deactivated, so its own
      // token now 401s and the revert would silently fail, locking the fixture
      // out for every later probe. Undo it with the account that broke it.
      const undo = await call('PUT', `/api/users/${su.user._id}`, {
        token: ad.token, body: { active: true },
      });
      const back = await call('POST', '/api/auth/login', {
        body: { username: 'qa.superadmin', password: PASSWORD },
      });
      if (undo.status === 200 && back.status === 200) {
        console.log('          (reverted: superadmin reactivated, login confirmed)');
      } else {
        console.error(`\n❌  COULD NOT REACTIVATE qa.superadmin (undo=${undo.status} login=${back.status}).`);
        console.error('    Fix before re-running:');
        console.error("    db.users.updateOne({ empId: 'QA001' }, { $set: { active: true } })\n");
        process.exit(1);
      }
    }
  }

  // ── §2 · employee limits ───────────────────────────────────────────
  section('§2 · employee limits');
  {
    const r = await call('GET', '/api/users', { token: eA.token });
    record('2.7', 'employee lists all users', 403, r.status,
      leaked(r.data, 'users') ? `⚠  leaked ${r.data.users.length} users in the body` : undefined);
  }
  {
    const r = await call('POST', '/api/tasks/assign', { token: eA.token, body: {
      userId: empB._id, title: 'probe', project: 'probe',
    }});
    record('2.8', 'employee assigns a task', 403, r.status);
  }
  {
    // Employee A's own entry, so this isolates self-review from cross-team access.
    const own = await call('GET', '/api/tasks', { token: eA.token });
    const mine = own.data?.tasks?.[0];
    if (mine) {
      const r = await call('PUT', `/api/tasks/${mine._id}/review`, {
        token: eA.token, body: { action: 'approve', rating: 5 },
      });
      record('2.9', 'employee approves their OWN task', 403, r.status);
    } else {
      console.log('  [-] 2.9     skipped — employee A has no task to review');
    }
  }
  {
    const r = await call('GET', '/api/reports/department', { token: mA.token });
    record('2.10', 'manager opens the department report', 403, r.status,
      leaked(r.data, 'report') ? '⚠  leaked the department report body' : undefined);
  }

  // ── §9.2 · manager reaching outside their team ──────────────────────
  // A scoping probe against an employee with no tasks proves nothing — the
  // endpoint returns 200 with an empty list either way. So plant a row in
  // manager B's team first, and clean it up at the end.
  section('§9.2 · manager scoping');

  const planted = [];
  for (const date of ['2026-12-29', '2026-12-30']) {
    const made = await call('POST', '/api/tasks/assign', { token: mB.token, body: {
      userId: empB._id, title: `probe fixture ${date}`, project: 'probe', date,
    }});
    if (made.status === 201) planted.push(made.data.task._id);
  }
  console.log(`          (planted ${planted.length} fixture task(s) in manager B's team)`);

  {
    const r = await call('GET', `/api/tasks?userId=${empB._id}`, { token: mA.token });
    const n = r.data?.tasks?.length || 0;
    record('9.2a', "manager A reads manager B's employee tasks via ?userId=", 403, r.status,
      n > 0 ? `⚠  returned ${n} of another team's tasks` : 'returned 0 rows — fixture missing, result inconclusive');
  }
  {
    const bTasks = await call('GET', '/api/tasks', { token: mB.token });
    const target = bTasks.data?.tasks?.[0];
    if (target) {
      const r = await call('PUT', `/api/tasks/${target._id}/review`, {
        token: mA.token, body: { action: 'approve', comment: 'probe', rating: 4 },
      });
      record('9.2b', "manager A reviews manager B's team task", 403, r.status);
      if (r.status === 200) {
        await call('PUT', `/api/tasks/${target._id}/clear-review`, { token: mB.token });
        console.log('          (reverted: review cleared)');
      }

      const c = await call('PUT', `/api/tasks/${target._id}/clear-review`, { token: mA.token });
      record('9.2c', "manager A clears review on manager B's team task", 403, c.status);
    } else {
      console.log('  [-] 9.2b/c  skipped — manager B\'s team has no tasks');
    }
  }
  {
    // Destructive, so it uses a task created for the purpose rather than real data.
    const made = await call('POST', '/api/tasks/assign', { token: mB.token, body: {
      userId: empB._id, title: 'probe — delete me', project: 'probe', date: '2026-12-31',
    }});
    if (made.status === 201) {
      const id = made.data.task._id;
      const r  = await call('DELETE', `/api/tasks/${id}`, { token: mA.token });
      record('9.2d', "manager A deletes manager B's team task", 403, r.status,
        r.status === 200 ? '⚠  task was actually deleted' : undefined);
      if (r.status !== 200) planted.push(id);
    } else {
      console.log(`  [-] 9.2d    skipped — could not create probe task (${made.status})`);
    }
  }
  {
    const r = await call('GET', `/api/users/${empB._id}/stats`, { token: mA.token });
    record('9.2e', "manager A pulls stats for manager B's employee", 403, r.status,
      leaked(r.data, 'stats') ? '⚠  leaked the stats body' : undefined);
  }
  {
    const r = await call('GET', '/api/users', { token: mA.token });
    const n = r.data?.users?.length || 0;
    record('9.2f', 'manager reads the full company roster', 403, r.status,
      n > 0 ? `⚠  returned ${n} users company-wide` : undefined);
  }
  {
    const r = await call('GET', `/api/reports/employee?userId=${empB._id}`, { token: mA.token });
    record('6.8', "manager A reports on manager B's employee", 403, r.status);
  }

  // ── §2 · reads that should be allowed ──────────────────────────────
  // A permission test that only checks denials can be "passed" by an app that
  // denies everything, so confirm the legitimate paths still work.
  section('§2 · allowed paths still work');
  record('2.a', 'superadmin lists users',        200, (await call('GET', '/api/users', { token: su.token })).status);
  record('2.b', 'admin reads the audit log',     200, (await call('GET', '/api/audit', { token: ad.token })).status);
  record('2.c', 'HR lists users',                200, (await call('GET', '/api/users', { token: hr.token })).status);
  record('2.d', 'HR reads the department report',200, (await call('GET', '/api/reports/department', { token: hr.token })).status);
  record('2.e', 'manager reads their team report',200,(await call('GET', '/api/reports/team', { token: mA.token })).status);
  record('2.f', 'employee reads their own tasks',200, (await call('GET', '/api/tasks', { token: eA.token })).status);
  record('2.g', 'employee reads own notifications',200,(await call('GET', '/api/notifications', { token: eB.token })).status);

  // ── Clean up planted fixtures ──────────────────────────────────────
  // Manager B owns them, so manager B removes them. Anything left behind would
  // skew §6 report counts on the next run.
  if (planted.length) {
    let removed = 0;
    for (const id of planted) {
      const r = await call('DELETE', `/api/tasks/${id}`, { token: mB.token });
      if (r.status === 200) removed++;
    }
    console.log(`\ncleanup: ${removed}/${planted.length} fixture task(s) removed`);
    if (removed !== planted.length) {
      console.log('  ⚠  some fixtures remain — find them with { project: "probe" }');
    }
  }

  // ── Summary ────────────────────────────────────────────────────────
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok);

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`${pass}/${results.length} passed`);

  if (fail.length) {
    console.log(`\n${fail.length} FAILED — mark these [o] in TESTING-CHECKLIST.md:\n`);
    for (const f of fail) {
      const exp = Array.isArray(f.expected) ? f.expected.join('/') : f.expected;
      console.log(`  ${f.id.padEnd(7)} ${f.desc}`);
      console.log(`          expected ${exp}, got ${f.actual}${f.note ? ' — ' + f.note : ''}`);
    }
    process.exitCode = 1;
  } else {
    console.log('\nno permission gaps found.');
  }
}

run().catch(err => {
  console.error('\n❌ ', err.message);
  process.exit(1);
});
