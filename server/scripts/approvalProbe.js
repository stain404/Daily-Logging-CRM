// Runs §12 of TESTING-CHECKLIST.md — the CEO-approval flow — against a running
// server, and prints pass/fail per check.
//
// Companion to permissionProbe.js and the same shape: "call endpoint E as role
// R, expect status S". §11.2 says re-run the permission checks after ANY
// permission change, and this flow IS a permission change, so it has to be one
// command too.
//
// Usage (from the server/ folder, with the app running):
//   node scripts/approvalProbe.js
//   node scripts/approvalProbe.js --url http://localhost:5050
//
// SAFETY: this creates a real employee, department and team, so it refuses to
// run unless the target is localhost AND /api/health reports a non-production
// env. It removes every fixture it makes — through the approval flow itself,
// which is also how 12.10/12.12 get covered.
//
// Requires the QA accounts from scripts/seedTestAccounts.js (password QAtest123).

const BASE = (() => {
  const i = process.argv.indexOf('--url');
  return (i === -1 ? 'http://localhost:5000' : process.argv[i + 1]).replace(/\/$/, '');
})();
const FORCE    = process.argv.includes('--i-know-what-im-doing');
const PASSWORD = 'QAtest123';
const NEW_PW   = 'ProbePass123';

const out = [];
let currentSection = '';
function section(name) {
  currentSection = name;
  console.log(`\n${name}`);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
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

async function login(username, password = PASSWORD) {
  const { status, data } = await call('POST', '/api/auth/login', { body: { username, password } });
  if (status !== 200 || !data?.token) {
    throw new Error(`login failed for ${username} (${status}: ${data?.message || 'no token'})`);
  }
  return { token: data.token, user: data.user };
}

function record(id, desc, expected, actual, note) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  out.push({ id, desc, ok, section: currentSection });
  const exp = Array.isArray(expected) ? expected.join('/') : expected;
  console.log(`  ${ok ? '[x]' : '[o]'} ${id.padEnd(7)} want ${String(exp).padEnd(7)} got ${String(actual).padEnd(5)} ${desc}`);
  if (note) console.log(`          ${note}`);
  return ok;
}

(async () => {
  // ── Safety ──────────────────────────────────────────────────────────
  if (!FORCE) {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
      console.error(`\n❌  Refusing to run against ${BASE} — localhost only.\n`);
      process.exit(1);
    }
    const health = await call('GET', '/api/health');
    if (health.data?.env === 'production') {
      console.error('\n❌  Refusing to run against a production environment.\n');
      process.exit(1);
    }
    console.log(`server: ${BASE}  env=${health.data?.env}\n`);
  }

  const [su, hr, ad, mA] = await Promise.all([
    login('qa.superadmin'), login('qa.hr'), login('qa.admin'), login('qa.manager.a'),
  ]);

  const stamp = Date.now().toString().slice(-6);
  const empId = 'QAP' + stamp;
  const uname = 'qa.pending.' + stamp;
  const dept  = 'QA Probe Dept ' + stamp;
  const team  = 'QA Probe Team ' + stamp;
  const newUser = {
    name: 'Pending Probe', empId, username: uname,
    designation: 'Tester', role: 'employee', password: NEW_PW,
  };

  // ── Who may propose ─────────────────────────────────────────────────
  section('§12 · who may propose');
  record('12.1', 'CEO adds a person directly', 403,
    (await call('POST', '/api/users', { token: su.token, body: newUser })).status);
  record('12.2', 'admin adds a person', 403,
    (await call('POST', '/api/users', { token: ad.token, body: newUser })).status);
  record('12.3', 'manager adds a person', 403,
    (await call('POST', '/api/users', { token: mA.token, body: newUser })).status);

  const raised = await call('POST', '/api/users', { token: hr.token, body: newUser });
  record('12.4', 'HR raises the request', 202, raised.status,
    `pending=${raised.data?.pending} · "${raised.data?.request?.summary}"`);
  const reqId = raised.data?.request?._id;
  if (!reqId) {
    console.error('\n❌  No request id came back — nothing further can be tested.\n');
    process.exit(1);
  }

  record('12.4b', 'the same person queued twice', 400,
    (await call('POST', '/api/users', { token: hr.token, body: newUser })).status);

  // ── Who may decide ──────────────────────────────────────────────────
  section('§12 · who may decide');
  record('12.5', 'HR approves their own request', 403,
    (await call('PUT', `/api/change-requests/${reqId}/approve`, { token: hr.token })).status);
  record('12.6', 'admin approves', 403,
    (await call('PUT', `/api/change-requests/${reqId}/approve`, { token: ad.token })).status);

  const queue = await call('GET', '/api/change-requests?status=pending', { token: su.token });
  record('12.7a', 'the request is in the CEO queue', true,
    (queue.data?.requests || []).some(r => r._id === reqId), `${queue.data?.count} pending`);
  record('12.7b', 'a manager sees no requests at all', 0,
    (await call('GET', '/api/change-requests', { token: mA.token })).data?.requests?.length);

  // ── Nothing happens until approval ──────────────────────────────────
  section('§12 · nothing happens until approval');
  record('12.8', 'the proposed employee cannot log in yet', 401,
    (await call('POST', '/api/auth/login', { body: { username: uname, password: NEW_PW } })).status);

  const approved = await call('PUT', `/api/change-requests/${reqId}/approve`, { token: su.token });
  record('12.8b', 'CEO approves', 200, approved.status, approved.data?.message);
  const userId = approved.data?.request?.resultId;

  record('12.11', 'now they log in with the password HR set', 200,
    (await call('POST', '/api/auth/login', { body: { username: uname, password: NEW_PW } })).status,
    'confirms the stored hash was not hashed a second time');
  record('12.13', 'the same request approved twice', 400,
    (await call('PUT', `/api/change-requests/${reqId}/approve`, { token: su.token })).status);

  // ── Removal ─────────────────────────────────────────────────────────
  section('§12 · removal');
  record('12.1b', 'CEO deletes a person directly', 403,
    (await call('DELETE', `/api/users/${userId}`, { token: su.token })).status);

  const delReq = await call('DELETE', `/api/users/${userId}`, { token: hr.token });
  record('12.4c', 'HR raises the removal', 202, delReq.status, `"${delReq.data?.request?.summary}"`);
  record('12.10', 'they still log in while the removal waits', 200,
    (await call('POST', '/api/auth/login', { body: { username: uname, password: NEW_PW } })).status);

  record('12.12a', 'CEO rejects the removal', 200,
    (await call('PUT', `/api/change-requests/${delReq.data?.request?._id}/reject`,
      { token: su.token, body: { note: 'Probe: not yet' } })).status);
  record('12.12b', 'a rejected removal leaves the account alone', 200,
    (await call('POST', '/api/auth/login', { body: { username: uname, password: NEW_PW } })).status);

  // ── Edits stay instant ──────────────────────────────────────────────
  section('§12 · edits stay instant, removals do not');
  const edit = await call('PUT', `/api/users/${userId}`,
    { token: hr.token, body: { designation: 'Senior Tester' } });
  record('12.14', 'an ordinary edit applies at once', 200, edit.status,
    `designation now "${edit.data?.user?.designation}"`);

  const deact = await call('PUT', `/api/users/${userId}`, { token: hr.token, body: { active: false } });
  record('12.15a', 'deactivating waits for the CEO', 202, deact.status);
  record('12.15b', 'they stay active until it is approved', 200,
    (await call('POST', '/api/auth/login', { body: { username: uname, password: NEW_PW } })).status);
  record('12.16a', 'CEO approves the deactivation', 200,
    (await call('PUT', `/api/change-requests/${deact.data?.request?._id}/approve`, { token: su.token })).status);
  record('12.16b', 'now they cannot log in', 401,
    (await call('POST', '/api/auth/login', { body: { username: uname, password: NEW_PW } })).status);

  // ── The escalation that would make all of this decorative ───────────
  section('§9.3 · role escalation (re-checked here on purpose)');
  record('9.3a', 'admin promotes SELF to superadmin', 403,
    (await call('PUT', `/api/users/${ad.user._id}`, { token: ad.token, body: { role: 'superadmin' } })).status,
    'an admin who can do this could approve his own requests');

  // ── Teams and departments ───────────────────────────────────────────
  section('§12 · teams and departments');
  record('12.1c', 'CEO adds a department directly', 403,
    (await call('POST', '/api/departments', { token: su.token, body: { name: dept } })).status);

  const deptReq = await call('POST', '/api/departments', { token: hr.token, body: { name: dept, color: '#2563eb' } });
  record('12.4d', 'HR raises a department', 202, deptReq.status);
  record('12.9a', 'it is not in the list yet', false,
    ((await call('GET', '/api/departments', { token: hr.token })).data?.departments || [])
      .some(d => d.name === dept));

  const deptOk = await call('PUT', `/api/change-requests/${deptReq.data?.request?._id}/approve`, { token: su.token });
  record('12.9b', 'CEO approves it', 200, deptOk.status);
  record('12.9c', 'now it is in the list', true,
    ((await call('GET', '/api/departments', { token: hr.token })).data?.departments || [])
      .some(d => d.name === dept));
  const deptId = deptOk.data?.request?.resultId;

  const teamReq = await call('POST', '/api/teams', { token: hr.token, body: { name: team, department: deptId } });
  record('12.4e', 'HR raises a team', 202, teamReq.status);
  const teamOk = await call('PUT', `/api/change-requests/${teamReq.data?.request?._id}/approve`, { token: su.token });
  record('12.9d', 'CEO approves the team', 200, teamOk.status);
  const teamId = teamOk.data?.request?.resultId;

  // ── What the CEO keeps ──────────────────────────────────────────────
  // A gate that only removes power can be "passed" by an app that denies the
  // CEO everything, so confirm the two things he explicitly keeps.
  section('§12 · what the CEO still has');
  record('12.28a', 'CEO reads company-wide reports', 200,
    (await call('GET', '/api/reports/department', { token: su.token })).status);

  const roster = await call('GET', '/api/users?role=employee', { token: su.token });
  const victim = (roster.data?.users || []).find(u => u.active && u._id !== userId);
  const assigned = victim
    ? await call('POST', '/api/tasks/assign', { token: su.token, body: {
        userId: victim._id, title: 'Probe assignment', project: 'QA Probe', date: '2026-12-30',
      }})
    : { status: 'no-employee' };
  record('12.28b', 'CEO assigns a task to anyone', [201, 400], assigned.status,
    assigned.data?.message || `assigned to ${victim?.name}`);

  // ── Cleanup, through the flow itself ────────────────────────────────
  section('cleanup');
  if (assigned.data?.task?._id) {
    await call('DELETE', `/api/tasks/${assigned.data.task._id}`, { token: su.token });
  }
  let cleaned = 0;
  for (const [label, raise] of [
    ['user',       () => call('DELETE', `/api/users/${userId}`,       { token: hr.token })],
    ['team',       () => call('DELETE', `/api/teams/${teamId}`,       { token: hr.token })],
    ['department', () => call('DELETE', `/api/departments/${deptId}`, { token: hr.token })],
  ]) {
    const r = await raise();
    const id = r.data?.request?._id;
    if (!id) { console.log(`  ⚠  could not raise removal of the fixture ${label}`); continue; }
    const done = await call('PUT', `/api/change-requests/${id}/approve`, { token: su.token });
    if (done.status === 200) cleaned++;
    else console.log(`  ⚠  fixture ${label} not removed: ${done.data?.message}`);
  }
  console.log(`  ${cleaned}/3 fixtures removed (raised by HR, approved by the CEO — the flow cleans up after itself)`);

  // ── Summary ─────────────────────────────────────────────────────────
  const pass  = out.filter(r => r.ok).length;
  const fails = out.filter(r => !r.ok);
  console.log(`\n${'─'.repeat(72)}\n${pass}/${out.length} passed`);
  if (fails.length) {
    console.log(`\n${fails.length} FAILED — mark these [o] in TESTING-CHECKLIST.md:\n`);
    fails.forEach(f => console.log(`  ${f.id.padEnd(7)} ${f.desc}`));
  }
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('\nERR', e.message); process.exit(1); });
