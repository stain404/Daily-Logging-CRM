#!/usr/bin/env node
//
// Bulk-set employee email addresses without going through the UI one at a
// time. Dry-run by default — nothing is written unless you pass --apply.
//
//   node scripts/setEmails.js
//       Audit only. Lists who has a valid address and who does not.
//
//   node scripts/setEmails.js arjun=arjun@alqubainvestment.com nabil=nabil@... --apply
//       Set addresses for the named users (by username or empId).
//
//   node scripts/setEmails.js --file emails.csv --apply
//       Same, but read "username,email" (or "username=email") one per line.
//       Blank lines and lines starting with # are ignored.
//
//   node scripts/setEmails.js --clear-invalid --apply
//       Blank out corrupt values such as the literal string "undefined",
//       which would otherwise hard-bounce and damage the sending domain.
//
// Safe to re-run: setting an address to the value it already has is a no-op.

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');

const args  = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CLEAR = args.includes('--clear-invalid');

// A deliberately ordinary check. It is not RFC-complete and does not need to
// be — it only has to catch the values that would bounce.
const isValid = e => typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e.trim());

function parsePairs() {
  const pairs = new Map();

  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1) {
    const p = args[fileIdx + 1];
    if (!p) { console.error('--file needs a path.'); process.exit(1); }
    const full = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
    if (!fs.existsSync(full)) { console.error(`No such file: ${full}`); process.exit(1); }
    fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach(raw => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const [k, v] = line.split(/[,=]/).map(s => (s || '').trim());
      if (k && v) pairs.set(k.toLowerCase(), v);
    });
  }

  args.filter(a => a.includes('=') && !a.startsWith('--')).forEach(a => {
    const [k, v] = a.split('=').map(s => s.trim());
    if (k && v) pairs.set(k.toLowerCase(), v);
  });

  return pairs;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const pairs = parsePairs();
  const users = await User.find().select('empId username name role email').sort({ name: 1 });

  const byKey = new Map();
  users.forEach(u => {
    byKey.set(u.username.toLowerCase(), u);
    byKey.set(u.empId.toLowerCase(), u);
  });

  // ── Audit ───────────────────────────────────────────────────────────
  const missing = users.filter(u => !isValid(u.email));
  const corrupt = users.filter(u => u.email !== undefined && u.email !== null && !isValid(u.email));

  console.log(`\n${users.length} users — ${users.length - missing.length} with a valid address, ${missing.length} without.`);
  if (corrupt.length) {
    console.log(`\n${corrupt.length} corrupt value(s) that would hard-bounce:`);
    corrupt.forEach(u => console.log(`  ${u.username.padEnd(12)} ${JSON.stringify(u.email)}`));
  }

  const changes = [];

  // ── Clear corrupt values ────────────────────────────────────────────
  if (CLEAR) {
    corrupt.forEach(u => {
      if (!pairs.has(u.username.toLowerCase()) && !pairs.has(u.empId.toLowerCase())) {
        changes.push({ user: u, from: u.email, to: null });
      }
    });
  }

  // ── Apply the supplied mapping ──────────────────────────────────────
  const unknown = [];
  for (const [key, email] of pairs) {
    const u = byKey.get(key);
    if (!u) { unknown.push(key); continue; }
    if (!isValid(email)) {
      console.error(`  ! "${email}" for ${key} is not a valid address — skipped.`);
      continue;
    }
    if ((u.email || '').toLowerCase() === email.toLowerCase()) continue;   // no-op
    changes.push({ user: u, from: u.email, to: email.toLowerCase() });
  }

  if (unknown.length) {
    console.error(`\nNo user matched: ${unknown.join(', ')}`);
  }

  if (!changes.length) {
    console.log(`\nNothing to change.${missing.length && !pairs.size ? '\n\nPass username=email pairs, or --file emails.csv, to fill the gaps.' : ''}`);
    if (missing.length && !pairs.size) {
      console.log('\nTemplate for the users still missing an address:\n');
      missing.forEach(u => console.log(`${u.username},   # ${u.name} (${u.role})`));
    }
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${changes.length} change(s)${APPLY ? '' : ' — DRY RUN, nothing written'}:`);
  changes.forEach(c => console.log(
    `  ${c.user.username.padEnd(12)} ${String(c.from ?? '(unset)').padEnd(30)} -> ${c.to ?? '(unset)'}`
  ));

  if (!APPLY) {
    console.log('\nRe-run with --apply to write these.');
    await mongoose.disconnect();
    return;
  }

  let ok = 0;
  for (const c of changes) {
    try {
      // $unset rather than setting '' — the User schema's setter maps '' to
      // undefined anyway, and a sparse unique index treats them differently.
      if (c.to === null) {
        await User.updateOne({ _id: c.user._id }, { $unset: { email: 1 } });
      } else {
        await User.updateOne({ _id: c.user._id }, { $set: { email: c.to } });
      }
      ok++;
    } catch (err) {
      // Almost always a duplicate: email is unique+sparse on the User model.
      console.error(`  ! ${c.user.username}: ${err.code === 11000 ? 'that address is already used by another user' : err.message}`);
    }
  }

  console.log(`\n${ok}/${changes.length} applied.`);
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
