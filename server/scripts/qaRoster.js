// The QA roster §0 of TESTING-CHECKLIST.md documents, in one place so the two
// seeders can't drift apart: seedTestAccounts.js writes it straight to a
// database, seedTestAccountsViaApi.js creates it through a running server.
//
// The checklist refers to these usernames and empIds by name, so changing one
// here means changing it there too.

// One account per role, plus TWO managers each owning their own team, because
// most scoping bugs (§10.2) only show up when manager A reaches for manager B's
// team.
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

const DEFAULT_PASSWORD = 'QAtest123';
const DEPARTMENT = 'QA Department';
const TEAM_NAME  = key => `QA Team ${key}`;
const NOTE       = 'Throwaway record for checklist testing';

// Both seeders accept --password=; the User model enforces a 6-character
// minimum, checked here so a typo fails before anything is written.
function passwordFromArgv(argv) {
  const arg = argv.find(a => a.startsWith('--password='));
  const pw  = arg ? arg.slice('--password='.length) : DEFAULT_PASSWORD;
  if (pw.length < 6) {
    throw new Error(`Password "${pw}" is under the 6-character minimum the User model enforces.`);
  }
  return pw;
}

module.exports = { PEOPLE, DEFAULT_PASSWORD, DEPARTMENT, TEAM_NAME, NOTE, passwordFromArgv };
