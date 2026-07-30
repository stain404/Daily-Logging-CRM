# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Employees** across departments (Procurement, Shipping, Sales, IT/Tech, Finance, Admin, HR) — log a daily work update, either freely written or picked from a task their manager assigned them.
- **Managers** — review, approve, reject, or rate their own team's daily updates; assign tasks to members of teams they manage; see reports scoped to their team only.
- **HR** — onboard/maintain employee records (create/edit employee & manager accounts, but not admin/superadmin/HR accounts), manage teams and departments, view company-wide reports, and log their own daily updates like an employee.
- **Admin** (includes the Managing Director) — broader operational oversight of users, teams, departments, tasks, and reports.
- **Superadmin** (the company owner) — full system control, including account deletion and role assignment without restriction.

## Product Purpose

A daily task/work reporting and review system for internal operations: employees log what they worked on each day, managers review and rate it, and leadership gets rollup visibility (reports by employee/team/department, an audit trail, and a monthly top-performer highlight). It replaces informal/ad-hoc status reporting with one lightweight daily record per person.

## Positioning

Purpose-built for this organization's actual role hierarchy and team/department structure, not a generic off-the-shelf status-reporting tool. Internal use only — there is no external customer, competitor, or market position to defend.

## Operating Context

Built for a real, currently-operating organization: **Al Quba** (Al Quba Investment / Containerkart — one organization operating under two brand names). Departments in active use: Admin, Finance, HR, IT/Tech, Procurement, Sales, Logistics, Shipping.

Daily workflow: an employee submits exactly one task/work entry per day — either a custom entry or one selected from a task their manager assigned — and can amend it the same day. Managers review their own team's entries (approve/reject/rate/comment) and can assign new tasks to their team members. HR and admins maintain the org chart (departments, teams, employee records). Reports roll up completion rate, hours, and volume by employee, team, or department, scoped to what each role is allowed to see. An audit log records account and security-relevant actions.

## Capabilities and Constraints

- One task/work entry per employee per day (not a general project-management or multi-task-per-day system).
- Five distinct roles — superadmin, admin, hr, manager, employee — each scoped to a deliberately different permission set; access should always match what that role actually needs, not a generic two-tier admin/user split.
- Manager oversight and reporting are scoped to a manager's own team, not company-wide, by design.
- No payroll, attendance, or compliance integration — this system is for work/task visibility only, confirmed as out of scope.
- Internal tool only — no multi-tenancy or external customer accounts are planned.

## Brand Commitments

- Product name: **Al Quba**, with the tagline **"Daily Logging"** shown on the login screen and dashboard.
- The organization itself operates under two names — Al Quba Investment and Containerkart — both represented among real user accounts in this system.

## Evidence on Hand

- Real, currently-operating production data: real employees, managers, HR, and admin accounts across the departments listed above, running against a live database. No demo/seed data should be treated as representative — the dummy seed dataset was deliberately wiped in favor of real accounts.
- No marketing copy, testimonials, case studies, or press exist for this product and none should be invented — it is not marketed externally.

## Product Principles

1. One report per person per day — daily logging stays lightweight, not a full project-tracking system.
2. Permissions mirror the real org hierarchy exactly (superadmin / admin / HR / manager / employee) rather than a generic RBAC template.
3. Manager visibility and authority follow actual reporting lines — a manager's world is their own team, never the whole company by default.
4. Reporting and recognition (e.g. a monthly top-performer highlight) exist to surface genuine performance signal, not vanity metrics.
5. Every product decision optimizes for this specific internal organization's staff — there is no hypothetical external customer to design for.
