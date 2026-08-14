# Al Quba Daily Logging — Test Checklist

Written against the current code (`server/routes/*`, `server/models/*`, `client/index.html`).

**How to use this file**
- Fill the **Result** column with `PASS`, `FAIL`, or `N/A`.
- Put bug details in the **Bug / Notes** column. If the write-up is long, put `→ F1`, `→ F2` …
  in the column and write it up in the **Findings log** at the bottom.
- Every row has a stable ID (`1.1`, `10.2c`) — use it when referring to a test elsewhere.
- **Commit after each session** (`git add TESTING-CHECKLIST.md && git commit -m "test notes"`).
  This file is now git-tracked, so a commit is what makes your notes recoverable.

Suggested order: §0 setup → §10 known suspects → everything else.

---

## 0. Test setup

| ID | Task | Result | Bug / Notes |
|---|---|---|---|
| 0.1 | Testing against a **copy** of the DB, not live — real staff records are in prod | | |
| 0.2 | `SEED_DB` is **not** `true` in the test environment (it seeds fake "Alex Johnson / admin123" users if the user collection is empty) | | |
| 0.3 | One throwaway account created per role: superadmin, admin, hr, manager, employee | | |
| 0.4 | A **second** manager with a **second** team exists — most scoping bugs only show when manager A reaches for manager B's team | | |
| 0.5 | API client (Postman / curl) ready — half of this checklist can't be tested through the UI | | |
| 0.6 | Server timezone noted (`GET /api/health` returns server time) vs local Gulf time — see §10.1 | | |

---

## 1. Login & session

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 1.1 | Login with username + correct password | | |
| 1.2 | Login with **empId** instead of username (e.g. `EMP001`) — both accepted | | |
| 1.3 | Username case-insensitive, empId upper-cased: try `EMP001`, `emp001`, `Emp001` | | |
| 1.4 | Wrong password → generic "Invalid username or password", doesn't reveal which was wrong | | |
| 1.5 | Non-existent user → same generic message | | |
| 1.6 | Empty username or password → 400, not a crash | | |
| 1.7 | Deactivated user (`active: false`) cannot log in | | |
| 1.8 | Deactivate a user **while logged in** → next API call 401s and the UI returns them to login | PASS | **Bug found & fixed** → **F1** |
| 1.9 | `lastLogin` timestamp updates on each login | | |
| 1.10 | Login writes an audit entry | | |
| 1.11 | Token survives a page refresh; log out clears it | | |
| 1.12 | Expired / garbage token → JSON 401 with a clean message, no stack trace | PASS | Full matrix tested → **F2** |
| 1.13 | Change password: wrong current password rejected; new password < 6 chars rejected | | |
| 1.14 | After a password change the **old password** fails (note: the old token stays valid until expiry — decide if acceptable) | | |
| 1.15 | Set own email via profile; an email another user already has → clean 400, not 500 | | |
| 1.16 | Set email to empty string → clears it (model maps `''` to unset) rather than colliding with other blank-email users | | |
| 1.17 | Brute force: 100 wrong logins in a row — rate limit is 500/15min across all of `/api/`, with nothing tighter on login | | |

---

## 2. Role permission matrix

Test each cell **through the API with a real token**, not by looking at the UI.
For every "must be denied" case, confirm **403/401 and no data returned**.

Intended matrix (the spec you're testing against):

| Action | superadmin | admin | hr | manager | employee |
|---|---|---|---|---|---|
| See all tasks | ✅ | ✅ | own only | own team only | own only |
| See any user's task by ID | ✅ | ✅ | ❌ | team only | ❌ |
| Create user | ✅ | ✅ | employee/manager only | ❌ | ❌ |
| Edit user | ✅ | ✅ | employee/manager only | ❌ | ❌ |
| Delete user | ✅ | ❌ | ❌ | ❌ | ❌ |
| Create/edit dept & team | ✅ | ✅ | ✅ | ❌ | ❌ |
| Delete dept & team | ✅ | ❌ | ❌ | ❌ | ❌ |
| Edit team membership | ✅ | ✅ | ✅ | own team only | ❌ |
| Assign task | ✅ | ✅ | ❌ | own team only | ❌ |
| Review (approve/reject/rate) | ✅ | ✅ | ❌ | own team only | ❌ |
| Delete task | ✅ | ✅ | ❌ | own team only | ❌ |
| Company-wide reports | ✅ | ✅ | ✅ | ❌ | ❌ |
| Audit log | ✅ | ✅ | ❌ | ❌ | ❌ |
| Email log / test email | ✅ | ✅ | ❌ | ❌ | ❌ |

Probes:

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 2.1 | HR `POST /api/users` with `role: "admin"` → 403 | | |
| 2.2 | HR edits an existing admin/superadmin/HR account → 403 | | |
| 2.3 | HR promotes an employee to `admin` via `PUT /api/users/:id` → 403 | | |
| 2.4 | Admin sets own `role` to `superadmin` via `PUT /api/users/:id` → **currently succeeds**, see §10.3 | | |
| 2.5 | Admin edits or deactivates the superadmin's account → decide the intended rule | | |
| 2.6 | Superadmin deletes own account → blocked | | |
| 2.7 | Employee `GET /api/users` → 403 | | |
| 2.8 | Employee `POST /api/tasks/assign` → 403 | | |
| 2.9 | Employee `PUT /api/tasks/:id/review` on own task → 403 (self-approval) | | |
| 2.10 | Manager `GET /api/reports/department` → 403 | | |
| 2.11 | Manager A `GET /api/tasks?userId=<manager B's employee>` → see §10.2 | | |
| 2.12 | Manager A reviews manager B's team's task → see §10.2 | | |
| 2.13 | Every endpoint with **no** `Authorization` header → 401 | | |

---

## 3. Daily entry — one per person per day

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 3.1 | Employee submits a daily update → appears immediately in their own list | | |
| 3.2 | Second update the same day → clean 400 with the "use edit instead" message | | |
| 3.3 | Employee edits today's entry → persists, no duplicate row | | |
| 3.4 | Submit today, submit again next calendar day → allowed (new row) | | |
| 3.5 | Employee edits **yesterday's** entry — PRODUCT.md says same-day only, API allows it, see §10.5 | | |
| 3.6 | Employee edits **another** employee's entry by ID → 403 | | |
| 3.7 | Employee sets `approved: true` / `mgRating: 5` on own entry (create **and** edit) → stripped | | |
| 3.8 | Employee moves own `dueDate` → stripped | | |
| 3.9 | Submit with no `title` → 400; no `project` → 400 | | |
| 3.10 | `hours` outside 0–24 rejected; negative rejected; `"abc"` → clean error | | |
| 3.11 | `completion` outside 0–100 rejected | | |
| 3.12 | `status` outside the enum rejected | | |
| 3.13 | `priority` garbage rejected | | |
| 3.14 | Very long title/description (5000+ chars) → stored or rejected cleanly | | |
| 3.15 | Special characters and Arabic text stored and displayed correctly, not mangled | | |
| 3.16 | XSS: title `<img src=x onerror=alert(1)>` → escaped on the manager's review screen (CSP is off, see §10.8) | | |
| 3.17 | **Race:** two simultaneous submissions (two tabs / two curl calls) → see §10.4 | | |

---

## 4. Task assignment (manager → employee)

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 4.1 | Manager assigns to own team member → member sees it, status `not-started` | | |
| 4.2 | Manager assigns **outside** their team → 403 | PASS | QA Manager A → QA Employee B refused: "You can only assign tasks to members of your own team." |
| 4.3 | Manager assigns to a **deactivated** user → currently allowed, decide if it should be | | |
| 4.4 | Assign without `userId` / `title` / `project` → 400 | | |
| 4.5 | Assign to a member who already has an entry that day → 400 with a message the manager can act on | | |
| 4.6 | Assign with an explicit future `dueDate` → stored as given | | |
| 4.7 | Assign with **no** `dueDate` → defaults to 17:00 that day. Verify that's 17:00 **Gulf**, not UTC — §10.1 | | |
| 4.8 | Assign for a **past** date → currently allowed, decide if it should be | | |
| 4.9 | Employee sees "assigned by <manager name>" | | |
| 4.10 | Employee moves an assigned task off `not-started` → `submittedAt` stamped once, fixed on later edits | | |
| 4.11 | Second edit of the same task → no duplicate notification / email | | |
| 4.12 | Assign with a past due date, then employee submits → notification flags it as late | | |

---

## 5. Review workflow

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 5.1 | Manager approves a team member's entry → `approved`, reviewer name + timestamp shown | | |
| 5.2 | Manager rejects → `rejected: true`, `approved: false`; flipping back is clean (never both true) | | |
| 5.3 | "Clarify" → adds a comment, leaves approval state untouched | | |
| 5.4 | Approve with rating 5, then clarify with no rating → **does the rating get wiped?** §10.6 | | |
| 5.5 | Rating outside 1–5 (0, 6, -1, `"five"`) → rejected | | |
| 5.6 | Review action other than approve/reject/clarify → 400 | | |
| 5.7 | Review a non-existent task ID → 404, not 500 | | |
| 5.8 | Review with a malformed ID (`abc`) → clean error, not a CastError 500 | | |
| 5.9 | Clear review → all feedback wiped, task back to pending, audit entry written | | |
| 5.10 | Can a manager clear an **admin's** review? Decide the rule, then test | | |
| 5.11 | Employee sees the manager's comment and rating on their own entry | | |
| 5.12 | Reviewing does **not** change the employee's `status` / `completion` | | |

---

## 6. Reports & metric accuracy

Build a known dataset first — e.g. one employee with exactly 4 tasks: 2 completed, 1 delayed,
1 in-progress, hours 8/6/0/4 — and verify by hand.

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 6.1 | Employee report `total` / `completed` / `delayed` / `pending` / `totalHours` match a manual count | | |
| 6.2 | `completionRate` = completed ÷ total rounded — check a non-round case (1/3 → 33) | | |
| 6.3 | Employee with **zero** tasks in range is excluded — confirm that's wanted (someone who logged nothing disappears rather than showing 0%) | | |
| 6.4 | `pending` = neither approved nor rejected; a clarify-only entry still counts as pending | | |
| 6.5 | `from`/`to` filtering drops the right tasks; a task dated exactly `from` **is** included | | |
| 6.6 | `from` later than `to` → empty result, not an error | | |
| 6.7 | Manager's employee report contains **only** their team | | |
| 6.8 | Manager requests `?userId=` outside their team → 403 | | |
| 6.9 | Team report `memberCount` matches reality; a 0-member team shows 0, not NaN | | |
| 6.10 | Department report counts match; a department with no users doesn't crash | | |
| 6.11 | A user with **no department** doesn't break or double-count the department report (this caused a 500 before — commit `f2577c1`) | | |
| 6.12 | Employee-of-month counts only the current month, needs ≥3 tasks to qualify | | |
| 6.13 | Employee-of-month tie-break: 100% vs 100% → higher avg rating wins; still tied → more completed | | |
| 6.14 | Nobody qualifies → `winner: null` and the UI shows an empty state, not a blank card | | |
| 6.15 | Employee-of-month on the **1st of the month** → date range can invert, §10.7 | PASS | Cause fixed → **F3**; re-test on 1 Sep |
| 6.16 | Dashboard `/stats/summary` today/week counts and status breakdown match the task list for the same user | | |
| 6.17 | Dashboard `completionRate` is over **all** tasks ever, not the current filter — confirm intended (it only drifts downward over time) | | |
| 6.18 | Same period reconciles across employee → team → department views | | |

---

## 7. Users, teams, departments

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 7.1 | Duplicate `empId` → clean 400, not 500 | | |
| 7.2 | Duplicate `username` → clean 400; duplicate `email` → clean 400 | | |
| 7.3 | Create user with no `designation` → 400 (required) | | |
| 7.4 | Password < 6 chars on creation → rejected | | |
| 7.5 | New user can log in immediately with the password set | | |
| 7.6 | Initials auto-generate from name; a single-word name doesn't crash | | |
| 7.7 | Rename a user → initials update | | |
| 7.8 | Deactivate a user → gone from active lists, historical tasks and reports intact | | |
| 7.9 | Delete a user (superadmin) → their tasks are orphaned (no cascade). Task list and reports still load | | |
| 7.10 | Move a user's department → old dept count drops, new one rises | | |
| 7.11 | Move a user's team → tasks enter the new manager's scope and **leave** the old manager's | | |
| 7.12 | Remove a member from a team → `team` unset, old manager loses visibility of new entries | | |
| 7.13 | A user in **no team** — is their work visible to anyone, or invisible to every manager? | | |
| 7.14 | A user in **two** teams → no duplicate rows in reports | | |
| 7.15 | Create a team with no department → clean 400 | | |
| 7.16 | Duplicate department name → clean 400 | | |
| 7.17 | Delete a department that still has users/teams → what happens to them; reports still work | | |
| 7.18 | Change a team's manager → new manager gains scope, old one loses it | | |

---

## 8. Notifications, email, attachments

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 8.1 | Assigning a task notifies the employee (in-app + email) | | |
| 8.2 | Submitting notifies the manager / review chain | | |
| 8.3 | Reviewing notifies the employee | | |
| 8.4 | Unread count accurate; mark-one-read and mark-all-read both work | | |
| 8.5 | A user can only see and delete **their own** notifications — try another user's ID directly | | |
| 8.6 | Switching a preference off actually stops that email | | |
| 8.7 | Reviewer switching "task submitted" off → saved but server overrides; UI shows the toggle locked with a reason | | |
| 8.8 | User with **no email** → in-app still works, no crash, prefs screen flags that email has no effect | | |
| 8.9 | Bounced address (`emailBounced: true`) → no further sends | | |
| 8.10 | Break SMTP creds → task submission still succeeds (email must never fail the user's action) | | |
| 8.11 | Email log records sends; admin/superadmin only | | |
| 8.12 | "Also emailed" indicator matches reality (commit `f56b442`) | | |
| 8.13 | Attachment upload → appears on the task, `attachmentCount` increments | | |
| 8.14 | Delete an attachment → count decrements, never goes negative | | |
| 8.15 | Download an attachment on a task you may not see → denied | | |
| 8.16 | Oversized file / unwanted type → rejected with the real reason (commit `da56b0a`) | | |
| 8.17 | Storage misconfigured → clean message, not a 500 | | |

---

## 9. Audit log

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 9.1 | Entry written for: login, password change, task create/update/assign, approve/reject/clarify, review cleared, task delete | | |
| 9.2 | Entry written for: user create/update/delete, team create/update/delete, dept create/update/delete | | |
| 9.3 | Entries record who, what, when, and IP | | |
| 9.4 | IP is the **real** user IP in production, not the proxy's (`trust proxy` only set when `NODE_ENV=production` — verify it is) | | |
| 9.5 | Only admin/superadmin can read the audit log | | |
| 9.6 | Audit entries can't be edited or deleted through any endpoint | | |
| 9.7 | A **failed** action leaves no misleading audit entry | | |

---

## 10. Known suspects — found while reading the code

Test these first. Each is concrete behaviour in the current code, not hypothetical.

### 10.1 Dates were computed in UTC, but the office isn't — **FIXED**
`routes/tasks.js:80,120,185` used `new Date().toISOString().split('T')[0]` — the **UTC** date.
Server in UTC (Render) + staff at UTC+4 meant that between midnight and 04:00 local, the
server still thought it was yesterday. Fixed via `utils/orgTime.js` → **F3**.

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 10.1a | Submit at 01:00 local → filed under today or yesterday? | PASS | Was yesterday, now today → **F3** |
| 10.1b | Is it **blocked as a duplicate** because yesterday's entry exists? | PASS | Cause removed by F3; re-test at a real 01:00 |
| 10.1c | Date shown in the UI (browser-local) matches the date stored on the server | | Still untested — needs a browser at 01:00 UAE |
| 10.1d | Assign default deadline had no timezone suffix → parsed as **server** local. Was "5pm" actually 9pm Gulf? | PASS | Yes, was 21:00 Dubai. Now 13:00Z = 17:00 Dubai → **F3** |
| 10.1e | Same off-by-a-day in the "7 days ago" window in `/stats/summary` | PASS | Now `orgDaysAgo(7)` → **F3** |

**Fix applied:** one org timezone in config (`ORG_TZ`, default `Asia/Dubai`); "today" and default
deadlines derive from it everywhere.

### 10.2 A manager can reach outside their own team
Scoping is enforced on some endpoints and not others.

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 10.2a | `GET /api/tasks?userId=<any id>` — `tasks.js:57` overwrites the team-scoped query, so a manager reads **any** employee's entries company-wide | | |
| 10.2b | `PUT /api/tasks/:id/review` (`tasks.js:291`) has **no** team check — manager A can approve/reject/rate manager B's team | | |
| 10.2c | `PUT /api/tasks/:id/clear-review` — same, no team check | | |
| 10.2d | `DELETE /api/tasks/:id` — any manager can delete any task in the company | | |
| 10.2e | `GET /api/users/:id/stats` — any manager pulls any employee's stats | | |
| 10.2f | `GET /api/users` — managers get the full company roster | | |

PRODUCT.md principle 3 says a manager's world is their own team. Right now that only holds for
the list view and reports.

### 10.3 An admin can promote themselves to superadmin
`PUT /api/users/:id` (`users.js:185`) guards **HR** against role changes; `admin` passes unchecked.

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 10.3a | As admin, `PUT /api/users/<own id>` with `{"role":"superadmin"}` → succeeds? | | |
| 10.3b | As admin, change the superadmin's role down or deactivate them → succeeds? | | |

### 10.4 Nothing at the DB level enforces one entry per day
`tasks.js:123` is `findOne` then `create` — two operations, no unique index on `{userId, date}`.

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 10.4a | Two simultaneous submissions → two rows for one day? | | |
| 10.4b | If so, what do reports show (inflated denominator, skewed completion rate)? | | |

**Fix direction:** `TaskSchema.index({ userId: 1, date: 1 }, { unique: true })`, then surface the
duplicate-key error as the friendly message.

### 10.5 Employees can edit any past entry
`PUT /api/tasks/:id` checks ownership, never the date. PRODUCT.md says amendments are same-day.

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 10.5a | Employee edits an entry from two weeks ago → allowed? | | |
| 10.5b | Employee edits an entry a manager already **approved** → allowed, approval still attached to rewritten content? | | |

10.5b is the one that matters: an approval can end up attached to work changed after the fact,
and the audit trail won't make that obvious.

### 10.6 "Clarify" wipes an existing rating
`tasks.js:314`: `task.mgRating = rating || null` runs on **every** action including `clarify`;
`mgComment` is overwritten too.

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 10.6a | Approve with rating 5, then clarify with a comment and no rating → is the 5 gone? | | |
| 10.6b | Does the lost rating change that person's employee-of-month average? | | |

### 10.7 Employee-of-month mixes local and UTC dates
`reports.js:152-153`: `monthStart` uses local `getFullYear()/getMonth()`, `todayStr` uses UTC.

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 10.7a | On the 1st, early local hours → range becomes `gte: 2026-09-01, lte: 2026-08-31` → empty. Does the card degrade gracefully? | PASS | Both ends now from one clock → **F3** |

### 10.8 Other things worth a look

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 10.8a | `cors({ origin: '*' })` (`server.js:34`) — any website can call this API; no origin restriction on an internal-only tool | | |
| 10.8b | Rate limit 500/15min across all `/api/`, nothing tighter on login — see 1.17 | | |
| 10.8c | `helmet({ contentSecurityPolicy: false })` — CSP off; combined with any unescaped task text that's an XSS path — see 3.16 | | |
| 10.8d | `app.get('*')` serves `index.html` for any unmatched path → a typo'd API path returns HTML, not JSON 404. Does the client handle that without a confusing parse error? | | |
| 10.8e | Deleting a user orphans their tasks (no cascade) — delete a test user with tasks, then load the list and reports as admin | | |
| 10.8f | `attachmentCount` is denormalised — force a mismatch (delete an Attachment row directly) and confirm the UI degrades sensibly | | |

---

## 11. Client / UI pass

| ID | Test | Result | Bug / Notes |
|---|---|---|---|
| 11.1 | Every role's dashboard loads with no console errors | | |
| 11.2 | Buttons a role can't use are hidden **and** the API rejects them (§2) | | |
| 11.3 | Empty states: new employee, team with no members, dept with no data, no notifications, no search results — message, not a blank panel | | |
| 11.4 | Loading states: no flash of "0 tasks" before data arrives | | |
| 11.5 | Error states: stop the server mid-session → real error, not a frozen spinner | | |
| 11.6 | Deadline dot colour (green → amber → red) tracks the real `dueDate` | | |
| 11.7 | The "late" tint is driven by submission vs deadline — a separate mechanism from 11.6, verify independently | | |
| 11.8 | A task with **no** `dueDate` (legacy row) falls back to date + endTime without breaking | | |
| 11.9 | Pagination: page 2 works, `total` correct, filters survive paging | | |
| 11.10 | Filters (status, priority, date, employee) combine correctly and clear properly | | |
| 11.11 | Refresh mid-flow doesn't lose the session or duplicate a submission | | |
| 11.12 | Back button behaves | | |
| 11.13 | Mobile / tablet layout — managers reviewing from a phone is a real scenario | | |
| 11.14 | Long names, long project names, and Arabic text don't break the layout | | |

---

## 12. Sign-off

| ID | Task | Result | Bug / Notes |
|---|---|---|---|
| 12.1 | Every `FAIL` above is fixed, or consciously accepted and written down | | |
| 12.2 | §2, §10.2 and §10.3 re-run after **any** fix — scoping bugs regress easily | | |
| 12.3 | One real month of production numbers spot-checked against a manual count | | |
| 12.4 | No test data leaked into the real database | | |

---

## Findings log

Long write-ups live here. Reference them from the tables as `→ F1`, `→ F2`, …

### F1 — UI did not handle 401 at all *(test 1.8 — fixed)*

The string `401` appears nowhere in `client/index.html`. `apiFetch` (line 1732) collapses every
failure into a generic thrown error, so the screen showed "failed to load dashboard" and the user
was stuck with no hint that their session had ended.

**Repro:** log in, run `localStorage.setItem('tf_token','x')` in the console, then **refresh** —
the in-memory `TOKEN` at line 1678 is only re-read on load, so a refresh is required — then click
anything.

**Impact:** fired on its own every 7 days when `JWT_EXPIRE` lapsed, and immediately whenever an
admin deactivated a logged-in user.

**Fix:** `apiFetch` now calls `handleSessionExpired()` on a 401 for any request that carried a
token, clearing storage and returning to the login screen with the server's reason shown.
Guards: only for signed requests (a failed login is also a 401 and still reads "Invalid username
or password"), and once per session (parallel panel loads produce a burst of 401s).
Verified in Edge end-to-end, including re-login afterwards.

### F2 — Token rejection matrix *(test 1.12 — pass)*

Tested via API: missing header, no `Bearer` prefix, empty bearer, garbage string, expired token,
wrong secret, forged `alg:none`, valid signature for a non-existent user, and valid signature
with a malformed ObjectId — **all** return a JSON 401, none a 500 or stack trace
(`middleware/auth.js:31` catches the Mongo CastError too).

UI handling of a 401 was a separate concern — see F1.

### F3 — Server computed dates in UTC, office is UTC+4 *(§10.1, 6.15, 10.7 — fixed)*

**Two separate symptoms, one cause.** Every "what day is it" and "when is 5pm" decision used the
server's UTC clock instead of the organisation's.

1. **Wrong day for late-night entries.** `routes/tasks.js:80,120,185` used
   `new Date().toISOString().split('T')[0]`. At 01:00 in Dubai on 14 Aug the instant is
   `2026-08-13T21:00Z`, so the server derived `2026-08-13`. A daily update filed any time
   between midnight and 04:00 local was stamped with the previous day — and if the employee had
   already logged that previous day, the one-per-day check rejected it as a duplicate.
2. **Deadlines four hours late.** `tasks.js:199` built the default deadline as
   `new Date(\`${targetDate}T17:00\`)` with no timezone suffix, so it parsed in *server* local
   time. On a UTC host, a "5pm" deadline was stored as `17:00Z` = **21:00 Dubai**. Every
   assigned task's deadline, and therefore every late/on-time judgement and the proximity dot,
   was off by four hours.
3. `reports.js:152` mixed the two clocks in one query — local `getFullYear()/getMonth()` for
   `monthStart`, UTC for `todayStr`. In the early local hours of the 1st, the range inverted
   (`gte: 2026-09-01, lte: 2026-08-31`) and employee-of-month silently returned no winner.

**Fix:** new `server/utils/orgTime.js` owns all of it — `orgToday()`, `orgDaysAgo()`,
`orgMonthStart()`, `orgTimeToDate(dateStr, 'HH:MM')`. Zone comes from `ORG_TZ`
(default `Asia/Dubai`) so it's config, not a hardcoded `+4`; the offset is read from the zone
via `Intl` `longOffset`, so a zone *with* DST stays correct. Six call sites migrated across
`routes/tasks.js` (including the `isLate` fallback, which reads `endTime` — a wall clock the
employee typed, not a UTC instant) and `routes/reports.js`.

**Verified** against the running server on `taskflow_test`:
- `orgDateStr(2026-08-13T21:00Z)` → `2026-08-14` (old code: `2026-08-13`).
- Assigned a task with no `dueDate` → stored `2026-08-20T13:00Z`, reads **17:00 Dubai**
  (old code: 21:00 Dubai).
- Submitted a daily update → dated `2026-08-14`, matching local UAE date.
- Edge cases: unparseable date → `Invalid Date` (callers' existing `isNaN` guard still works);
  missing time → defaults to 17:00; `00:00` → previous day 20:00Z, correct.

**Not covered by this fix:** the client also computes dates in browser-local time. That agrees
with the server for anyone physically in the UAE, but a user travelling or with a misconfigured
machine clock will still disagree with the server. See 10.1c.

---

## Backups

- **Primary:** git. This file is tracked — `git add TESTING-CHECKLIST.md && git commit -m "test notes"`
  after each session, and any accidental overwrite is recoverable with `git checkout -- TESTING-CHECKLIST.md`.
- **Off-machine:** a copy is synced at `%OneDrive%\taskflow-backups\TESTING-CHECKLIST.md`,
  which also gives you OneDrive's own version history.
- Refresh the OneDrive copy with:
  `cp TESTING-CHECKLIST.md "$env:OneDrive\taskflow-backups\"`
