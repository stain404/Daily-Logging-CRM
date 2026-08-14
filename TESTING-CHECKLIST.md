# Al Quba — Daily Logging · Test Checklist

> **Marks** — `[x]` pass · `[o]` fail · `[-]` skipped / not applicable · `[ ]` not tested yet
>
> **Found a bug?** Mark it `[o]` and write it on the indented line under the item.
> If it needs more than a line, put `→ F6` there and write it up in the
> **[Findings log](#findings-log)** at the bottom.
>
> **Save your work:** `git add TESTING-CHECKLIST.md && git commit -m "test notes"`
> This file is git-tracked, so a commit is what makes your notes recoverable.

**Environment**

- App: `http://localhost:5000` · database `taskflow_test` · `ORG_TZ=Asia/Dubai`
- QA accounts: `qa.superadmin` `qa.admin` `qa.hr` `qa.manager.a` `qa.manager.b`
  `qa.employee.a` `qa.employee.b` `qa.orphan` — password **`QAtest123`** for all
- Login accepts username **or** empId (QA001–QA008)

**Suggested order:** §0 setup → §9 known suspects → then §1 through §8 → §10 UI → §11 sign-off

---

## 0 · Setup

- [x] `0.1` Testing against a **copy**, not live — server is on `taskflow_test`
- [x] `0.2` `SEED_DB=false` confirmed — no risk of fake seed users overwriting real ones
- [x] `0.3` One throwaway account per role exists (QA001–QA008)
- [x] `0.4` **Two** managers with **separate** teams exist — QA Manager A / B
- [ ] `0.5` API client ready (Postman / curl) — half of this can't be tested through the UI
- [x] `0.6` Server clock vs office clock understood — server is UTC, office is UTC+4 → **F3**

---

## 1 · Login & session

- [x] `1.1` Login with username + correct password
- [x] `1.2` Login with **empId** instead of username — both accepted
- [x] `1.3` Username case-insensitive, empId upper-cased — try `QA006`, `qa006`, `Qa006`
- [x] `1.4` Wrong password → generic "Invalid username or password", doesn't say which was wrong
- [x] `1.5` Non-existent user → same generic message
- [x] `1.6` Empty username or password → 400, not a crash
- [x] `1.7` Deactivated user cannot log in
- [x] `1.8` Deactivate a user **while logged in** → next call 401s, UI returns them to login
- [x] `1.9` `lastLogin` updates on each login
- [x] `1.10` Login writes an audit entry
- [x] `1.11` Token survives a page refresh; logout clears it
- [x] `1.12` Expired / garbage token → clean JSON 401, no stack trace
- [x] `1.13` Change password: wrong current rejected; new password under 6 chars rejected
- [x] `1.14` After a password change the **old password** fails
- [x] `1.15` Set own email; an email another user already has → clean 400, not 500
- [x] `1.16` Set email to empty → clears it, doesn't collide with other blank-email users
- [x] `1.17` 100 wrong logins in a row — limit is 500/15min across all of `/api/`, nothing tighter on login
- [x] `1.18` Email must be a real address — `hello`, `a@`, `@b.com` all rejected


---

## 2 · Permissions

**Intended matrix** — the spec you're testing against:

| Action                    | superadmin | admin |  hr           |  manager  | employee |
|---------------------------|:----------:|:-----:|:-------------:|:---------:|:--------:|
| See all tasks             | all        | all   | own           | own team  |   own    |
| Create / edit user        | ✅         | ✅   | emp+mgr only  | ❌        | ❌      |
| Delete user               | ✅         | ❌   | ❌            | ❌        | ❌      |
| Create / edit dept & team | ✅         | ✅   | ✅            | ❌        | ❌      |
| Delete dept & team        | ✅         | ❌   | ❌            | ❌        | ❌      |
| Edit team membership      | ✅         | ✅   | ✅            | own team  | ❌      |
| Assign task               | ✅         | ✅   | ❌            | own team  | ❌      |
| Review / rate             | ✅         | ✅   | ❌            | own team  | ❌      |
| Delete task               | ✅         | ✅   | ❌            | own team  | ❌      |
| Company-wide reports      | ✅         | ✅   | ✅            | ❌        | ❌      |
| Audit log                 | ✅         | ✅   | ❌            | ❌        | ❌      |
| Email log / test email    | ✅         | ✅   | ❌            | ❌        | ❌      |

Test through the **API with a real token**, not by looking at the UI. Every denial must be
403/401 **and** return no data.

> **Run these with one command:** `node scripts/permissionProbe.js` (app must be running).
> It logs in as all 7 QA roles, asserts a status per endpoint, reverts every mutation it makes,
> and prints the failures with their IDs. Re-run it after any permission change — that's `11.2`.
> Marks below came from that run; **8 of 28 failed** → **F5**.

- [x] `2.1` HR creates a user with `role: "admin"` → 403
- [x] `2.2` HR edits an existing admin / superadmin / HR account → 403
- [x] `2.3` HR promotes an employee to `admin` → 403
- [o] `2.4` Admin sets their **own** role to `superadmin` → 403
  - Returned **200** and the role actually changed → **F5**, same as `9.3a`
- [o] `2.5` Admin edits or deactivates the superadmin → 403
  - Returned **200**, superadmin was deactivated → **F5**, same as `9.3b`
- [ ] `2.6` Superadmin deletes own account → blocked
- [x] `2.7` Employee lists users → 403
- [x] `2.8` Employee assigns a task → 403
- [x] `2.9` Employee reviews their **own** task → 403 (no self-approval)
- [x] `2.10` Manager opens the department report → 403
- [o] `2.11` Manager A reads Manager B's employee's tasks via `?userId=` → 403
  - Returned **200 with 2 of another team's tasks** → **F5**, same as `9.2a`
- [o] `2.12` Manager A reviews Manager B's employee's task → 403
  - Returned **200**, review applied → **F5**, same as `9.2b`
- [x] `2.13` Every endpoint with **no** auth header → 401
  - Checked on tasks, users, employee report, audit log, notifications

---

## 3 · Daily entry — one per person per day

- [ ] `3.1` Employee submits a daily update → appears in their list immediately
- [ ] `3.2` Second update the same day → clean 400, "use edit instead"
- [ ] `3.3` Employee edits today's entry → persists, no duplicate row
- [ ] `3.4` Submit today, submit again tomorrow → allowed, new row
- [ ] `3.5` Employee edits **yesterday's** entry → spec says same-day only, API allows it, see `9.5`
- [ ] `3.6` Employee edits **someone else's** entry by ID → 403
- [ ] `3.7` Employee sets `approved` / `mgRating` on their own entry (create **and** edit) → stripped
- [ ] `3.8` Employee moves their own `dueDate` → stripped
- [ ] `3.9` No `title` → 400 · no `project` → 400
- [ ] `3.10` `hours` over 24, negative, or `"abc"` → rejected cleanly
- [ ] `3.11` `completion` outside 0–100 → rejected
- [ ] `3.12` `status` outside the allowed list → rejected
- [ ] `3.13` `priority` garbage → rejected
- [ ] `3.14` Title / description of 5000+ chars → stored or rejected cleanly, no truncation surprise
- [ ] `3.15` Arabic text and special characters → stored and displayed correctly
- [ ] `3.16` **XSS:** title `<img src=x onerror=alert(1)>` → escaped on the manager's review screen
  - CSP is disabled server-side, so the client is the only defence here — see `9.8c`
- [ ] `3.17` **Race:** two submissions at the same instant → see `9.4`

---

## 4 · Assignment

- [ ] `4.1` Manager assigns to own team member → member sees it, status `not-started`
- [x] `4.2` Manager assigns **outside** their team → 403
  - QA Manager A → QA Employee B correctly refused
- [ ] `4.3` Assign to a **deactivated** user → allowed today; decide if it should be
- [ ] `4.4` Assign with no `userId` / `title` / `project` → 400
- [ ] `4.5` Assign to someone who already has an entry that day → 400 with a message that explains why
- [ ] `4.6` Assign with an explicit future `dueDate` → stored as given
- [x] `4.7` Assign with **no** `dueDate` → defaults to 17:00 **Dubai** (not 17:00 UTC)
  - Was 21:00 Dubai; fixed → **F3**
- [ ] `4.8` Assign for a **past** date → allowed today; decide if it should be
- [ ] `4.9` Employee sees "assigned by <manager>"
- [ ] `4.10` Employee moves an assigned task off `not-started` → `submittedAt` stamped once, then fixed
- [ ] `4.11` Editing the same task again → no duplicate notification or email
- [ ] `4.12` Past-due assignment, then employee submits → notification flags it late

---

## 5 · Review

- [ ] `5.1` Approve → `approved`, reviewer name + timestamp shown
- [ ] `5.2` Reject → `rejected`; flipping approve/reject is clean, never both true
- [ ] `5.3` Clarify → adds a comment, leaves approval state alone
- [ ] `5.4` Approve with rating 5, then clarify with no rating → **is the rating wiped?** see `9.6`
- [ ] `5.5` Rating 0, 6, -1, `"five"` → rejected
- [ ] `5.6` Review action other than approve/reject/clarify → 400
- [ ] `5.7` Review a non-existent task ID → 404, not 500
- [ ] `5.8` Review a malformed ID (`abc`) → clean error, not a CastError 500
- [ ] `5.9` Clear review → feedback wiped, back to pending, audit entry written
- [ ] `5.10` Can a manager clear an **admin's** review? Decide the rule, then test it
- [ ] `5.11` Employee sees the comment and rating on their own entry
- [ ] `5.12` Reviewing does **not** change the employee's `status` / `completion`

---

## 6 · Reports & numbers

Build a known dataset first — e.g. one employee with exactly 4 tasks: 2 completed, 1 delayed,
1 in-progress, hours 8 / 6 / 0 / 4 — then check the maths by hand.

- [ ] `6.1` Employee report totals, completed, delayed, pending, hours all match a manual count
- [ ] `6.2` Completion rate = completed ÷ total, rounded — verify a messy case (1/3 → 33)
- [ ] `6.3` Employee with **zero** tasks in range is excluded
  - Confirm that's wanted — someone who logged nothing vanishes rather than showing 0%
- [ ] `6.4` `pending` = neither approved nor rejected; a clarify-only entry still counts pending
- [ ] `6.5` Date range filters correctly; a task dated exactly `from` **is** included
- [ ] `6.6` `from` later than `to` → empty result, not an error
- [ ] `6.7` Manager's employee report shows **only** their own team
- [x] `6.8` Manager requests a report for someone outside their team → 403
  - Correctly blocked — `reports.js` checks team membership, unlike `tasks.js` (`9.2a`)
- [ ] `6.9` Team report member count is right; a 0-member team shows 0, not NaN
- [ ] `6.10` Department report counts are right; an empty department doesn't crash
- [ ] `6.11` A user with **no department** doesn't break or double-count the department report
  - This exact case caused a 500 before (commit `f2577c1`)
- [ ] `6.12` Employee-of-month counts only this month, needs 3+ tasks to qualify
- [ ] `6.13` Tie-break order: completion rate → average rating → total completed
- [ ] `6.14` Nobody qualifies → empty state on the card, not a blank box or an error
- [x] `6.15` Employee-of-month on the **1st** → range no longer inverts
  - Cause fixed → **F3**; worth re-checking on 1 Sep
- [ ] `6.16` Dashboard today / week counts and status breakdown match the task list
- [ ] `6.17` Dashboard completion rate is over **all** tasks ever, not the current filter
  - Confirm intended — it can only drift downward over time
- [ ] `6.18` Same period reconciles across employee → team → department views

---

## 7 · Users, teams, departments

- [ ] `7.1` Duplicate `empId` → clean 400, not 500
- [ ] `7.2` Duplicate `username` → clean 400 · duplicate `email` → clean 400
- [o] `7.2b` HR / admin cannot save a malformed email on someone else's record
  - Same missing validation as `1.18`, and the **edit-user** field has no `type="email"`
    either, so the browser doesn't catch it → **F4**
- [ ] `7.3` Create user with no `designation` → 400
- [ ] `7.4` Password under 6 chars → rejected
- [ ] `7.5` New user can log in immediately with the password set
- [ ] `7.6` Initials auto-generate; a single-word name doesn't crash
- [ ] `7.7` Rename a user → initials update
- [ ] `7.8` Deactivate a user → gone from active lists, history and reports intact
- [ ] `7.9` Delete a user → their tasks are orphaned (no cascade); list and reports still load
- [ ] `7.10` Move a user's department → old count drops, new one rises
- [ ] `7.11` Move a user's team → tasks enter the new manager's scope and **leave** the old one's
- [ ] `7.12` Remove a member from a team → old manager loses visibility of their new entries
- [ ] `7.13` `qa.orphan` is in no team — is their work visible to anyone at all?
- [ ] `7.14` A user in **two** teams → no duplicate rows in reports
- [ ] `7.15` Create a team with no department → clean 400
- [ ] `7.16` Duplicate department name → clean 400
- [ ] `7.17` Delete a department that still has users and teams → what happens to them?
- [ ] `7.18` Change a team's manager → new manager gains scope, old one loses it

---

## 8 · Notifications, email, attachments

- [ ] `8.1` Assigning notifies the employee (in-app + email)
- [ ] `8.2` Submitting notifies the manager / review chain
- [ ] `8.3` Reviewing notifies the employee
- [ ] `8.4` Unread count accurate; mark-one and mark-all both work
- [ ] `8.5` A user can only see and delete **their own** notifications — try another user's ID
- [ ] `8.6` Switching a preference off actually stops that email
- [ ] `8.7` Reviewer turning "task submitted" off → saved, server overrides, UI shows it locked with a reason
- [ ] `8.8` `qa.orphan` has no email → in-app still works, no crash, prefs screen says email won't apply
- [ ] `8.9` Bounced address → no further sends attempted
- [o] `8.9b` A malformed address is never handed to SES
  - The mailer checks only *presence* and `emailBounced`, never format → **F4**
- [ ] `8.10` Break SMTP creds → task submission **still succeeds**
  - Email must never fail the user's action
- [ ] `8.11` Email log records sends; admin / superadmin only
- [ ] `8.12` "Also emailed" indicator matches reality (commit `f56b442`)
- [ ] `8.13` Upload an attachment → appears on the task, count increments
- [ ] `8.14` Delete an attachment → count decrements, never negative
- [ ] `8.15` Download an attachment on a task you may not see → denied
- [ ] `8.16` Oversized file / unwanted type → rejected with the real reason (commit `da56b0a`)
- [ ] `8.17` Storage misconfigured → clean message, not a 500

**Audit log**

- [ ] `8.18` Entry written for login, password change, task create/update/assign/review/delete
- [ ] `8.19` Entry written for user, team and department create/update/delete
- [ ] `8.20` Entries record who, what, when, IP
- [ ] `8.21` IP is the **real** user IP in production, not the proxy's
  - `trust proxy` is only set when `NODE_ENV=production` — confirm it is, in prod
- [ ] `8.22` Only admin / superadmin can read the audit log
- [ ] `8.23` Audit entries can't be edited or deleted through any endpoint
- [ ] `8.24` A **failed** action leaves no misleading audit entry

---

## 9 · Known suspects

Found by reading the code. Test these first — each is real current behaviour.

### 9.1 · Dates computed in UTC — **FIXED** → F3

Server ran in UTC, office is UTC+4, so between midnight and 04:00 local the server thought it
was still yesterday.

- [x] `9.1a` Entry at 01:00 local → filed under **today**, not yesterday
- [x] `9.1b` No longer wrongly blocked as a duplicate of yesterday's entry
- [ ] `9.1c` UI date (browser-local) matches the server's date
  - Still open — needs a browser at 01:00 UAE. Client still uses browser-local time
- [x] `9.1d` Default deadline is 17:00 Dubai, was 21:00
- [x] `9.1e` The "7 days ago" window uses the org clock

### 9.2 · A manager can reach outside their own team

Scoping is enforced on some endpoints and missing on others.

Scoping is enforced on some endpoints and missing on others. **All six confirmed** by
`node scripts/permissionProbe.js` → **F5**.

- [o] `9.2a` `GET /api/tasks?userId=<anyone>` — `tasks.js:57` overwrites the team scope, so a
      manager reads **any** employee's entries company-wide
  - 200, returned 2 of Manager B's team's tasks to Manager A
- [o] `9.2b` `PUT /api/tasks/:id/review` — **no team check at all**; Manager A can rate
      Manager B's team
  - 200, the review was applied
- [o] `9.2c` `PUT /api/tasks/:id/clear-review` — same, no team check
  - 200, another team's review wiped
- [o] `9.2d` `DELETE /api/tasks/:id` — any manager can delete any task in the company
  - 200, **the task was actually deleted**
- [o] `9.2e` `GET /api/users/:id/stats` — any manager pulls any employee's stats
  - 200, full stats body returned
- [o] `9.2f` `GET /api/users` — managers get the whole company roster
  - 200, **32 users** returned to a manager

> Your own spec says a manager's world is their own team. Right now that only holds for the
> list view and the reports.

### 9.3 · An admin can promote themselves to superadmin

`PUT /api/users/:id` guards **HR** against role changes; `admin` passes straight through.
**Both confirmed** → **F5**.

- [o] `9.3a` As admin, set own role to `superadmin`
  - 200, and the role **actually changed**. Full system control by editing your own record
- [o] `9.3b` As admin, demote or deactivate the superadmin
  - 200, the owner's account was deactivated and locked out until restored

### 9.4 · Nothing at the database level enforces one entry per day

`tasks.js:123` is a `findOne` then a `create` — two operations, no unique index.

- [ ] `9.4a` Two simultaneous submissions → two rows for one day?
- [ ] `9.4b` If so, what do the reports show — inflated denominator, skewed rate?

> Fix: `TaskSchema.index({ userId: 1, date: 1 }, { unique: true })`, then surface the
> duplicate-key error as the friendly message.

### 9.5 · Employees can edit any past entry

`PUT /api/tasks/:id` checks ownership but never the date, though the spec says same-day only.

- [ ] `9.5a` Employee edits an entry from two weeks ago → allowed?
- [ ] `9.5b` Employee edits an entry a manager already **approved** → approval stays attached to
      rewritten content?

> `9.5b` is the one that matters: an approval can end up attached to work changed afterwards,
> and the audit trail won't make that obvious.

### 9.6 · "Clarify" wipes an existing rating

`tasks.js:314` runs `mgRating = rating || null` on **every** action, clarify included.

- [ ] `9.6a` Approve with rating 5, then clarify with no rating → is the 5 gone?
- [ ] `9.6b` Does the lost rating shift that person's employee-of-month average?

### 9.7 · Employee-of-month mixed two clocks — **FIXED** → F3

- [x] `9.7a` Both ends of the range now come from the same clock

### 9.8 · Also worth a look

- [ ] `9.8a` `cors({ origin: '*' })` — any website can call this API; no origin restriction at
      all on an internal-only tool
- [ ] `9.8b` Rate limit is 500/15min across all of `/api/`, nothing tighter on login — see `1.17`
- [ ] `9.8c` `contentSecurityPolicy: false` — CSP is off, so any unescaped task text is an XSS
      path — see `3.16`
- [ ] `9.8d` `app.get('*')` returns `index.html` for any unmatched path, so a typo'd API path
      returns HTML not a JSON 404 — does the client handle that cleanly?
- [ ] `9.8e` Deleting a user orphans their tasks — delete a test user with tasks, then load the
      list and reports as admin
- [ ] `9.8f` `attachmentCount` is denormalised — force a mismatch and confirm the UI copes

---

## 10 · UI pass

- [ ] `10.1` Every role's dashboard loads with no console errors
- [ ] `10.2` Buttons a role can't use are hidden **and** the API rejects them (§2)
- [ ] `10.3` Empty states: new employee, empty team, empty department, no notifications, no
      search results — all show a message, not a blank panel
- [ ] `10.4` No flash of "0 tasks" before data arrives
- [ ] `10.5` Stop the server mid-session → real error, not a frozen spinner
- [ ] `10.6` Deadline dot colour (green → amber → red) tracks the real `dueDate`
- [ ] `10.7` The "late" tint is driven by submission vs deadline — a **separate** mechanism from
      `10.6`, so verify it on its own
- [ ] `10.8` A task with **no** `dueDate` falls back to date + endTime without breaking
- [ ] `10.9` Pagination: page 2 works, total is right, filters survive paging
- [ ] `10.10` Filters combine correctly and clear properly
- [ ] `10.11` Refresh mid-flow doesn't lose the session or duplicate a submission
- [ ] `10.12` Back button behaves
- [ ] `10.13` Mobile / tablet layout — managers reviewing from a phone is a real scenario
- [ ] `10.14` Long names, long project names and Arabic text don't break the layout

---

## 11 · Sign-off

- [ ] `11.1` Every `[o]` above is fixed, or consciously accepted and written down
- [ ] `11.2` §2, `9.2` and `9.3` re-run after **any** fix — scoping bugs regress easily
- [ ] `11.3` One real month of production numbers spot-checked against a manual count
- [ ] `11.4` No test data leaked into the real database
- [ ] `11.5` `ORG_TZ` set correctly in the production environment

---

## Findings log

Long write-ups live here. Reference them from the checklist as `→ F1`, `→ F2`, …

### F1 · UI did not handle 401 at all
`1.8` — **fixed**

The string `401` appeared nowhere in `client/index.html`. `apiFetch` (line 1732) collapsed every
failure into a generic thrown error, so the screen showed "failed to load dashboard" and the user
was stuck with no hint their session had ended.

**Repro** — log in, run `localStorage.setItem('tf_token','x')` in the console, then **refresh**
(the in-memory `TOKEN` at line 1678 is only re-read on load, so a refresh is required), then
click anything.

**Impact** — fired on its own every 7 days when `JWT_EXPIRE` lapsed, and immediately whenever an
admin deactivated a logged-in user.

**Fix** — `apiFetch` now calls `handleSessionExpired()` on a 401 for any request that carried a
token, clearing storage and returning to the login screen with the server's reason shown.
Guards: only for signed requests (a failed login is also a 401 and must still read "Invalid
username or password"), and once per session (parallel panel loads produce a burst of 401s).
Verified in Edge end to end, including re-login afterwards.

### F2 · Token rejection matrix
`1.12` — **pass**

Tested via API: missing header, no `Bearer` prefix, empty bearer, garbage string, expired token,
wrong secret, forged `alg:none`, valid signature for a non-existent user, and valid signature
with a malformed ObjectId. All returned a JSON 401 — none a 500 or a stack trace
(`middleware/auth.js:31` catches the Mongo CastError too).

UI handling of a 401 was a separate concern — see F1.

### F3 · Server computed dates in UTC, office is UTC+4
`9.1`, `9.7`, `4.7`, `6.15` — **fixed**

Three symptoms, one cause: every "what day is it" and "when is 5pm" decision used the server's
UTC clock instead of the organisation's.

1. **Wrong day for late-night entries.** `tasks.js:80,120,185` used
   `new Date().toISOString().split('T')[0]`. At 01:00 in Dubai on 14 Aug the instant is
   `2026-08-13T21:00Z`, so the server derived `2026-08-13`. Any update filed between midnight
   and 04:00 local was stamped with the previous day — and if the employee had already logged
   that day, the one-per-day check rejected it as a duplicate.
2. **Deadlines four hours late.** `tasks.js:199` built the default deadline as
   `new Date(\`${targetDate}T17:00\`)` with no timezone suffix, so it parsed in *server* local
   time. On a UTC host a "5pm" deadline was stored as `17:00Z` = **21:00 Dubai**. Every assigned
   task's deadline, and so every late/on-time judgement and the proximity dot, was four hours out.
3. **Inverted range.** `reports.js:152` mixed clocks in one query — local
   `getFullYear()/getMonth()` for `monthStart`, UTC for `todayStr`. In the early local hours of
   the 1st the range inverted (`gte: 2026-09-01, lte: 2026-08-31`) and employee-of-month
   silently returned no winner.

**Fix** — new `server/utils/orgTime.js` owns all of it: `orgToday()`, `orgDaysAgo()`,
`orgMonthStart()`, `orgTimeToDate(dateStr, 'HH:MM')`. The zone comes from `ORG_TZ`
(default `Asia/Dubai`) so it's configuration rather than a hardcoded `+4`, and the offset is read
from the zone via `Intl` `longOffset`, so a zone *with* DST stays correct. Six call sites migrated
across `routes/tasks.js` — including the `isLate` fallback, which reads `endTime`, a wall clock
the employee typed rather than a UTC instant — and `routes/reports.js`.

**Verified** against the running server on `taskflow_test`:

| | Before | After |
|---|---|---|
| Entry at 01:00 UAE (`21:00Z` prev day) | dated 13 Aug | dated **14 Aug** |
| Assigned task, no due date | `17:00Z` = 21:00 Dubai | `13:00Z` = **17:00 Dubai** |
| Real submission just now | — | dated `2026-08-14` |

Edge cases: unparseable date → `Invalid Date`, so callers' existing `isNaN` guard still works;
missing time → defaults to 17:00; `00:00` → previous day 20:00Z, correct.

**Not covered** — the client still computes dates in browser-local time. That agrees with the
server for anyone physically in the UAE, but a travelling user or a wrong machine clock will
still disagree. Tracked as `9.1c`.

### F4 · Email addresses are never validated
`1.18`, `7.2b`, `8.9b` — **open**

**Found by:** entering a plain word with no `@domain.com` in the email field and having it saved.

Confirmed: there is **no email format validation anywhere in the stack**.

**Server** — `models/User.js:14` declares `email` as `type: String` with `unique`, `sparse`,
`lowercase` and `trim`, but **no `match` validator**. So `runValidators: true` on the update
routes has nothing to run. Every route that writes an email is affected:
`PUT /api/auth/profile` (self-service), `POST /api/users` and `PUT /api/users/:id` (HR / admin
setting someone else's).

Tested against `PUT /api/auth/profile` — all eight accepted and stored verbatim:

| Sent | Stored |
|---|---|
| `hello` | `hello` |
| `notanemail` | `notanemail` |
| `a@` | `a@` |
| `@b.com` | `@b.com` |
| `x y z` | `x y z` |
| `javascript:alert(1)` | `javascript:alert(1)` |
| `admin@` | `admin@` |
| `....` | `....` |

**Client** — inconsistent, and not a real defence anyway:
- `client/index.html:3284` (new user) — has `type="email"`
- `client/index.html:4586` (own profile) — has `type="email"`
- `client/index.html:3342` (**edit user**) — plain `<input>`, **no `type="email"` at all**

Even on the two that have it, `type="email"` only blocks a native form submit; if the handler
reads `.value` directly without calling `.checkValidity()`, the browser never intervenes. So the
edit-user field has neither client nor server validation.

**Why it matters — three consequences, worst first:**

1. **SES sending reputation.** `services/mailer.js:93,98` checks only that an address *exists*
   and that `emailBounced` isn't set — never that it's well-formed. A value like `hello` goes
   straight into `Destination: { ToAddresses: ['hello'] }`. Every notification to that user is a
   guaranteed hard bounce, and `models/User.js:51` already records why that's bad: bounces are
   what damage a sending domain's reputation and can put SES back in its sandbox.
2. **Silent non-delivery.** `GET /api/users/me/notification-prefs` reports
   `hasEmail: Boolean(req.user.email)`, so `hello` reads as `true`. The UI tells the user their
   email notifications are active while nothing can ever be delivered — the exact case `8.8` was
   written to catch, but inverted.
3. **The unique index becomes meaningless.** `email` is `unique + sparse`, so junk values occupy
   the index and a typo like `admin@` permanently blocks the real `admin@…` from being saved by
   anyone else.

**Fix direction** — validate in the model so every route inherits it, rather than patching each
route:

```js
email: {
  type: String, unique: true, sparse: true,
  lowercase: true, trim: true,
  set: v => (v === '' ? undefined : v),
  match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please provide a valid email address.'],
},
```

Then: add `type="email"` to the edit-user input at `3342`, and have the mailer skip and log
`skipped-invalid-address` rather than handing a bad value to SES. Note the routes must surface the
`ValidationError` as a clean 400 — `PUT /api/auth/profile` currently only special-cases the
duplicate-key `11000`, so a validation failure would fall through to a 500.

**Existing data — already checked.** Scanned both databases before recommending the validator, so
adding it won't make any current user unsaveable:

- `taskflow` (real records): 5 users have an email, **0 malformed** — safe to add the validator.
- `taskflow_test`: 2 malformed, both from testing (`QA001` → `test`, `QA006` → `....`).
  `QA006` cleaned up; `QA001` left in place as a fixture for re-testing.

Re-run the scan any time before deploying the validator:
`db.users.find({ email: { $exists: true, $not: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/ } }, { empId: 1, email: 1 })`

### F5 · Role boundaries not enforced: 8 of 28 permission probes failed
`2.4`, `2.5`, `2.11`, `2.12`, `9.2a–f`, `9.3a–b` — **open**

Run with `node scripts/permissionProbe.js` (from `server/`, app running). It logs in as all 7 QA
roles, asserts an expected status per endpoint, reverts every mutation, and cleans up its fixtures.
Result: **20/28 passed, 8 failed.**

**Two independent holes.**

**1 · An admin is effectively a superadmin.** `PUT /api/users/:id` (`users.js:185`) guards HR
against role changes but lets `admin` through unchecked.

| Probe | Expected | Actual |
|---|---|---|
| `9.3a` admin sets own role to `superadmin` | 403 | **200 — role changed** |
| `9.3b` admin deactivates the superadmin | 403 | **200 — owner locked out** |

`9.3a` means the admin/superadmin distinction doesn't exist in practice: any admin can grant
themselves full control, including user deletion, by editing their own record. `9.3b` means an
admin can lock the company owner out of their own system.

**2 · Manager scoping is enforced on four endpoints and missing on six.** All six confirmed
against live fixture data:

| Probe | Endpoint | Actual |
|---|---|---|
| `9.2a` | `GET /api/tasks?userId=` | 200 — **2 of another team's tasks** |
| `9.2b` | `PUT /tasks/:id/review` | 200 — review applied to another team |
| `9.2c` | `PUT /tasks/:id/clear-review` | 200 — another team's review wiped |
| `9.2d` | `DELETE /tasks/:id` | 200 — **task actually deleted** |
| `9.2e` | `GET /users/:id/stats` | 200 — full stats body |
| `9.2f` | `GET /api/users` | 200 — **32 users company-wide** |

`9.2d` is the worst of these: any manager can permanently destroy any employee's record anywhere
in the company, and the audit entry will name them as the deleter of a task they had no business
seeing. `9.2a` is the read equivalent — the team scope is built correctly and then thrown away by
`tasks.js:57`, which assigns `query.userId = userId` over the top of `{ $in: memberIds }`.

**What passed** — worth stating, since it shows the pattern is inconsistent rather than absent:
HR's limits all hold (`2.1`–`2.3`), employees are correctly blocked from listing users, assigning,
and self-approving (`2.7`–`2.9`), managers can't reach the department report (`2.10`), all
endpoints 401 without a token (`2.13`), and `reports.js` **does** check team membership
(`6.8` passed) — which is exactly the check `tasks.js` is missing.

**Fix direction** — the manager-scope check already exists in `tasks.js:177` for assignment and in
`reports.js:21`. Extract it into one helper (`assertManagesTaskOwner(user, task)`) and apply it in
`review`, `clear-review`, `delete`, and to the `?userId=` filter; scope `GET /api/users` and
`/users/:id/stats` for managers. Separately, guard role and `active` changes in `users.js` so only
a superadmin can grant `superadmin`/`admin` or deactivate one.

**Note for whoever fixes this:** the probe's own revert step has to undo a deactivation using a
*different* account's token — the deactivated account's token 401s immediately, so an undo signed
by it silently fails and strands the fixture. The script now reverts with the admin token and
confirms by logging back in.

---

## Backups

- **Primary — git.** This file is tracked. Commit after each session; recover a clobbered file
  with `git checkout -- TESTING-CHECKLIST.md`.
- **Off-machine — OneDrive.** Copy synced at `%OneDrive%\taskflow-backups\`, which also gives you
  OneDrive's own version history.
  Refresh with `cp TESTING-CHECKLIST.md "$env:OneDrive\taskflow-backups\"`

## Test data

- Database `taskflow_test`, cloned from `taskflow` with `server/scripts/cloneDb.js`
- QA accounts created by `server/scripts/seedTestAccounts.js` — everything it makes is prefixed
  `QA`, so `db.users.deleteMany({ empId: /^QA/ })` cleans up
- Re-clone from live at any time:
  `node scripts/cloneDb.js --from "mongodb://localhost:27017/taskflow" --to "mongodb://localhost:27017/taskflow_test"`

### F6 · *(next finding — replace this heading)*
