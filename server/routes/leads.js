const express = require('express');
const router  = express.Router();

const Lead         = require('../models/Lead');
const Call         = require('../models/Call');
const FollowUp     = require('../models/FollowUp');
const LeadActivity = require('../models/LeadActivity');
const User          = require('../models/User');
const Audit          = require('../models/Audit');
const { protect }    = require('../middleware/auth');
const {
  getLeadQuery, leadInScope, requireSalesCrmAccess, assignableUserIds,
} = require('../utils/leadScope');
const { orgToday } = require('../utils/orgTime');

router.use(protect, requireSalesCrmAccess);

function logActivity(leadId, type, actor, detail) {
  LeadActivity.create({ lead: leadId, type, actor: actor?._id, detail }).catch(() => {});
}

// ── GET /api/leads/meta ──────────────────────────────────────────────
// Filter-dropdown data: stages, sources, call outcomes, and the reps the
// caller is allowed to see/assign to.
router.get('/meta', async (req, res) => {
  try {
    const ids = await assignableUserIds(req.user);
    const reps = await User.find({ _id: { $in: ids } }).select('name username role');
    res.json({
      success: true,
      stages: Lead.STAGES,
      sources: Lead.SOURCES,
      outcomes: Call.OUTCOMES,
      reps,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Saved views ───────────────────────────────────────────────────────
router.get('/views', async (req, res) => {
  res.json({ success: true, views: req.user.savedLeadViews || [] });
});

router.post('/views', async (req, res) => {
  try {
    const { name, filters } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Give the view a name.' });
    }
    const user = await User.findById(req.user._id);
    user.savedLeadViews = (user.savedLeadViews || []).filter(v => v.name !== name.trim());
    user.savedLeadViews.push({ name: name.trim(), filters: filters || {} });
    await user.save();
    res.json({ success: true, views: user.savedLeadViews });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/views/:name', async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    user.savedLeadViews = (user.savedLeadViews || []).filter(v => v.name !== req.params.name);
    await user.save();
    res.json({ success: true, views: user.savedLeadViews });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/leads/followups/dashboard ───────────────────────────────
// Today's + overdue + upcoming follow-ups, scoped by role — the data behind
// the Follow-ups page.
router.get('/followups/dashboard', async (req, res) => {
  try {
    const leadQuery = await getLeadQuery(req.user);
    const myLeadIds = (await Lead.find(leadQuery).select('_id')).map(l => l._id);

    const followUps = await FollowUp.find({ lead: { $in: myLeadIds }, status: 'pending' })
      .populate({ path: 'lead', select: 'name company value stage assignedTo' })
      .populate({ path: 'lead', populate: { path: 'assignedTo', select: 'name' } })
      .sort({ scheduledFor: 1 });

    const now = new Date();
    const groups = { overdue: [], today: [], upcoming: [] };
    const todayStr = orgToday();
    followUps.forEach(fu => {
      if (!fu.lead) return;
      const dateStr = new Date(fu.scheduledFor).toISOString().slice(0, 10);
      if (fu.scheduledFor < now) groups.overdue.push(fu);
      else if (dateStr === todayStr) groups.today.push(fu);
      else groups.upcoming.push(fu);
    });

    res.json({ success: true, ...groups });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Reports ───────────────────────────────────────────────────────────
function dateRangeQuery(from, to) {
  const q = {};
  if (from || to) {
    q.createdAt = {};
    if (from) q.createdAt.$gte = new Date(from);
    if (to)   q.createdAt.$lte = new Date(to + 'T23:59:59.999Z');
  }
  return q;
}

async function buildSummary(req, { from, to, assignedTo } = {}) {
  const leadQuery = await getLeadQuery(req.user);
  if (assignedTo) leadQuery.assignedTo = assignedTo;
  Object.assign(leadQuery, dateRangeQuery(from, to));

  const leads = await Lead.find(leadQuery).select('_id value stage assignedTo createdAt');
  const leadIds = leads.map(l => l._id);

  const callDateQuery = { lead: { $in: leadIds } };
  if (from || to) {
    callDateQuery.calledAt = {};
    if (from) callDateQuery.calledAt.$gte = new Date(from);
    if (to)   callDateQuery.calledAt.$lte = new Date(to + 'T23:59:59.999Z');
  }
  const calls = await Call.find(callDateQuery).select('lead');
  const leadsWithCalls = new Set(calls.map(c => String(c.lead)));

  const followUps = await FollowUp.find({ lead: { $in: leadIds } }).select('status scheduledFor');
  const completed = followUps.filter(f => f.status === 'done').length;
  const missed = followUps.filter(f => f.status === 'pending' && f.scheduledFor < new Date()).length;

  const won = leads.filter(l => l.stage === 'won');
  const lost = leads.filter(l => l.stage === 'lost');
  const revenueWon = won.reduce((s, l) => s + (l.value || 0), 0);

  return {
    leads: leads.length,
    callsMade: calls.length,
    leadsContacted: leadsWithCalls.size,
    won: won.length,
    lost: lost.length,
    conversionRate: leads.length ? Math.round(won.length / leads.length * 100) : 0,
    followUpsCompleted: completed,
    followUpsMissed: missed,
    revenueWon,
  };
}

// GET /api/leads/reports/summary?from=&to=&assignedTo=
router.get('/reports/summary', async (req, res) => {
  try {
    const summary = await buildSummary(req, req.query);
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/leads/reports/funnel?by=stage|source&from=&to=
router.get('/reports/funnel', async (req, res) => {
  try {
    const { by = 'stage', from, to } = req.query;
    const leadQuery = await getLeadQuery(req.user);
    Object.assign(leadQuery, dateRangeQuery(from, to));
    const leads = await Lead.find(leadQuery).select('stage source');

    const buckets = by === 'source' ? Lead.SOURCES : Lead.STAGES;
    const funnel = buckets.map(key => ({
      key, count: leads.filter(l => (by === 'source' ? l.source : l.stage) === key).length,
    }));
    res.json({ success: true, by, funnel });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/leads/reports/by-rep?from=&to=  — calls/conversions per rep, for
// "role-based" dashboards where a manager/admin wants the team breakdown.
router.get('/reports/by-rep', async (req, res) => {
  try {
    const { from, to } = req.query;
    const leadQuery = await getLeadQuery(req.user);
    Object.assign(leadQuery, dateRangeQuery(from, to));
    const leads = await Lead.find(leadQuery).populate('assignedTo', 'name');

    const byRep = new Map();
    for (const l of leads) {
      const key = l.assignedTo ? String(l.assignedTo._id) : 'unassigned';
      if (!byRep.has(key)) byRep.set(key, { rep: l.assignedTo?.name || '—', leads: 0, won: 0, lost: 0, value: 0 });
      const row = byRep.get(key);
      row.leads += 1;
      if (l.stage === 'won') row.won += 1;
      if (l.stage === 'lost') row.lost += 1;
      row.value += l.value || 0;
    }
    const leadIds = leads.map(l => l._id);
    const calls = await Call.find({ lead: { $in: leadIds } }).populate('loggedBy', 'name');
    const callsByRep = new Map();
    calls.forEach(c => {
      const key = c.loggedBy ? String(c.loggedBy._id) : 'unknown';
      callsByRep.set(key, (callsByRep.get(key) || 0) + 1);
    });

    const rows = [...byRep.entries()].map(([id, row]) => ({ ...row, calls: callsByRep.get(id) || 0 }));
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/leads/reports/export?format=csv|pdf&from=&to=&assignedTo=
router.get('/reports/export', async (req, res) => {
  try {
    const { format = 'csv', from, to, assignedTo } = req.query;
    const leadQuery = await getLeadQuery(req.user);
    if (assignedTo) leadQuery.assignedTo = assignedTo;
    Object.assign(leadQuery, dateRangeQuery(from, to));
    const leads = await Lead.find(leadQuery).populate('assignedTo', 'name').sort({ createdAt: -1 });
    const summary = await buildSummary(req, req.query);

    if (format === 'pdf') {
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({ margin: 40 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="sales-crm-report.pdf"');
      doc.pipe(res);

      doc.fontSize(18).text('Sales CRM — Performance Report', { align: 'left' });
      doc.moveDown(0.3).fontSize(10).fillColor('#666')
        .text(`Range: ${from || 'all time'} — ${to || 'now'}`);
      doc.moveDown();

      doc.fillColor('#000').fontSize(12).text('Summary');
      doc.fontSize(10).fillColor('#333');
      Object.entries(summary).forEach(([k, v]) => doc.text(`${k}: ${v}`));
      doc.moveDown();

      doc.fillColor('#000').fontSize(12).text(`Leads (${leads.length})`);
      doc.fontSize(9).fillColor('#333');
      leads.forEach(l => {
        doc.text(`${l.name}  |  ${l.company || '—'}  |  ${l.stage}  |  AED ${l.value || 0}  |  ${l.assignedTo?.name || '—'}`);
      });
      doc.end();
      return;
    }

    // CSV — built by hand, no dependency needed for a format this simple.
    const esc = v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Name', 'Company', 'Phone', 'Email', 'Country', 'Source', 'Stage', 'Value', 'Rep', 'Created'];
    const rows = leads.map(l => [
      l.name, l.company, l.phone, l.email, l.country, l.source, l.stage, l.value,
      l.assignedTo?.name || '', l.createdAt.toISOString().slice(0, 10),
    ]);
    const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="sales-crm-leads.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/leads/duplicates?phone=&email= ──────────────────────────
router.get('/duplicates', async (req, res) => {
  try {
    const matches = await findDuplicates(req.query.phone, req.query.email);
    res.json({ success: true, duplicates: matches });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

async function findDuplicates(phone, email, excludeId) {
  const or = [];
  if (phone && phone.trim()) or.push({ phone: phone.trim() });
  if (email && email.trim()) or.push({ email: email.trim().toLowerCase() });
  if (!or.length) return [];
  const query = { $or: or };
  if (excludeId) query._id = { $ne: excludeId };
  return Lead.find(query).select('name company phone email stage assignedTo').populate('assignedTo', 'name').limit(10);
}

// ── GET /api/leads ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const {
      stage, source, country, assignedTo, q,
      from, to, page = 1, limit = 50,
    } = req.query;

    const query = await getLeadQuery(req.user);

    if (stage)   query.stage   = stage;
    if (source)  query.source  = source;
    if (country) query.country = new RegExp(country, 'i');

    if (assignedTo) {
      const allowed = await assignableUserIds(req.user);
      if (!allowed.includes(String(assignedTo))) {
        return res.status(403).json({ success: false, message: 'You cannot see that rep\'s leads.' });
      }
      query.assignedTo = assignedTo;
    }

    Object.assign(query, dateRangeQuery(from, to));

    if (q && q.trim()) {
      const re = new RegExp(q.trim(), 'i');
      query.$or = [{ name: re }, { company: re }, { phone: re }, { email: re }];
    }

    const total = await Lead.countDocuments(query);
    const leads = await Lead.find(query)
      .populate('assignedTo', 'name username')
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    res.json({ success: true, total, page: Number(page), limit: Number(limit), leads });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/leads ───────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, company, phone, email, country, source, notes, value, assignedTo } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required.' });
    }

    let owner = req.user._id;
    if (assignedTo && assignedTo !== String(req.user._id)) {
      const allowed = await assignableUserIds(req.user);
      if (!allowed.includes(String(assignedTo))) {
        return res.status(403).json({ success: false, message: 'You cannot assign a lead to that person.' });
      }
      owner = assignedTo;
    }

    const duplicates = await findDuplicates(phone, email);

    const lead = await Lead.create({
      name: name.trim(), company, phone, email, country,
      source: source || 'Manual Entry', notes, value: Number(value) || 0,
      assignedTo: owner, createdBy: req.user._id,
      possibleDuplicateOf: duplicates.map(d => d._id),
    });

    logActivity(lead._id, 'created', req.user, `Lead created${duplicates.length ? ' (possible duplicate flagged)' : ''}.`);
    await Audit.create({
      user: req.user._id, userName: req.user.name, action: 'Lead Created',
      detail: `Created lead "${lead.name}"${lead.company ? ` (${lead.company})` : ''}.`, ip: req.ip,
    });

    res.status(201).json({ success: true, lead, duplicates });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: Object.values(err.errors)[0].message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/leads/:id ────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    if (!(await leadInScope(Lead, req.user, req.params.id))) {
      return res.status(404).json({ success: false, message: 'Lead not found.' });
    }
    const lead = await Lead.findById(req.params.id)
      .populate('assignedTo', 'name username')
      .populate('createdBy', 'name');
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    const [calls, followUps, activity] = await Promise.all([
      Call.find({ lead: lead._id }).populate('loggedBy', 'name').sort({ calledAt: -1 }),
      FollowUp.find({ lead: lead._id }).sort({ scheduledFor: -1 }),
      LeadActivity.find({ lead: lead._id }).populate('actor', 'name').sort({ createdAt: -1 }),
    ]);

    res.json({ success: true, lead, calls, followUps, activity });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/leads/:id ────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    if (!(await leadInScope(Lead, req.user, req.params.id))) {
      return res.status(404).json({ success: false, message: 'Lead not found.' });
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    const fields = ['name', 'company', 'phone', 'email', 'country', 'source', 'notes', 'value', 'stage', 'lostReason'];
    const prevStage = lead.stage;
    fields.forEach(f => { if (req.body[f] !== undefined) lead[f] = req.body[f]; });
    if (lead.stage !== 'lost') lead.lostReason = '';

    await lead.save();

    if (lead.stage !== prevStage) {
      logActivity(lead._id, 'status_change', req.user, `Stage changed from "${prevStage}" to "${lead.stage}"${lead.lostReason ? ` — ${lead.lostReason}` : ''}.`);
    } else {
      logActivity(lead._id, 'updated', req.user, 'Lead details updated.');
    }

    res.json({ success: true, lead });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: Object.values(err.errors)[0].message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/leads/:id ─────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    if (!(await leadInScope(Lead, req.user, req.params.id))) {
      return res.status(404).json({ success: false, message: 'Lead not found.' });
    }
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    await Promise.all([
      Call.deleteMany({ lead: lead._id }),
      FollowUp.deleteMany({ lead: lead._id }),
      LeadActivity.deleteMany({ lead: lead._id }),
    ]);

    await Audit.create({
      user: req.user._id, userName: req.user.name, action: 'Lead Deleted',
      detail: `Deleted lead "${lead.name}"${lead.company ? ` (${lead.company})` : ''}.`, ip: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/leads/:id/reassign ───────────────────────────────────────
router.put('/:id/reassign', async (req, res) => {
  try {
    if (!(await leadInScope(Lead, req.user, req.params.id))) {
      return res.status(404).json({ success: false, message: 'Lead not found.' });
    }
    if (req.user.role === 'employee' || req.user.role === 'hr') {
      return res.status(403).json({ success: false, message: 'Only a manager, admin or superadmin can reassign a lead.' });
    }
    const { assignedTo } = req.body;
    const allowed = await assignableUserIds(req.user);
    if (!assignedTo || !allowed.includes(String(assignedTo))) {
      return res.status(403).json({ success: false, message: 'You cannot assign a lead to that person.' });
    }

    const lead = await Lead.findById(req.params.id).populate('assignedTo', 'name');
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });

    const fromName = lead.assignedTo?.name || 'nobody';
    const toUser = await User.findById(assignedTo).select('name');
    lead.assignedTo = assignedTo;
    await lead.save();

    logActivity(lead._id, 'reassignment', req.user, `Reassigned from ${fromName} to ${toUser.name}.`);
    await Audit.create({
      user: req.user._id, userName: req.user.name, action: 'Lead Reassigned',
      detail: `Reassigned lead "${lead.name}" from ${fromName} to ${toUser.name}.`, ip: req.ip,
    });

    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/leads/:id/calls ─────────────────────────────────────────
router.post('/:id/calls', async (req, res) => {
  try {
    if (!(await leadInScope(Lead, req.user, req.params.id))) {
      return res.status(404).json({ success: false, message: 'Lead not found.' });
    }
    const { calledAt, duration, outcome, notes, newStage, lostReason } = req.body;
    if (!outcome || !Call.OUTCOMES.includes(outcome)) {
      return res.status(400).json({ success: false, message: 'A valid call outcome is required.' });
    }

    const call = await Call.create({
      lead: req.params.id, loggedBy: req.user._id,
      calledAt: calledAt ? new Date(calledAt) : new Date(),
      duration: Number(duration) || 0, outcome, notes,
    });
    logActivity(req.params.id, 'call', req.user, `Logged a call — ${outcome}${notes ? `: ${notes}` : '.'}`);

    let lead = null;
    if (newStage && Lead.STAGES.includes(newStage)) {
      lead = await Lead.findById(req.params.id);
      const prevStage = lead.stage;
      lead.stage = newStage;
      if (newStage === 'lost') lead.lostReason = lostReason || lead.lostReason;
      await lead.save();
      if (lead.stage !== prevStage) {
        logActivity(req.params.id, 'status_change', req.user, `Stage changed from "${prevStage}" to "${newStage}" from the call log.`);
      }
    }

    res.status(201).json({ success: true, call, lead });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: Object.values(err.errors)[0].message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/leads/:id/followups ─────────────────────────────────────
router.post('/:id/followups', async (req, res) => {
  try {
    if (!(await leadInScope(Lead, req.user, req.params.id))) {
      return res.status(404).json({ success: false, message: 'Lead not found.' });
    }
    const { scheduledFor, note } = req.body;
    if (!scheduledFor) {
      return res.status(400).json({ success: false, message: 'A date/time is required.' });
    }
    const lead = await Lead.findById(req.params.id).select('assignedTo');

    const followUp = await FollowUp.create({
      lead: req.params.id, assignedTo: lead.assignedTo, createdBy: req.user._id,
      scheduledFor: new Date(scheduledFor), note,
    });
    logActivity(req.params.id, 'followup_scheduled', req.user, `Follow-up scheduled for ${new Date(scheduledFor).toLocaleString()}.`);

    res.status(201).json({ success: true, followUp });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/leads/:id/followups/:fid ─────────────────────────────────
// action: 'done' | 'reschedule' | 'cancel'
router.put('/:id/followups/:fid', async (req, res) => {
  try {
    if (!(await leadInScope(Lead, req.user, req.params.id))) {
      return res.status(404).json({ success: false, message: 'Lead not found.' });
    }
    const followUp = await FollowUp.findOne({ _id: req.params.fid, lead: req.params.id });
    if (!followUp) return res.status(404).json({ success: false, message: 'Follow-up not found.' });

    const { action, scheduledFor, note } = req.body;
    if (action === 'done') {
      followUp.status = 'done';
      logActivity(req.params.id, 'followup_done', req.user, 'Follow-up marked done.');
    } else if (action === 'reschedule') {
      if (!scheduledFor) return res.status(400).json({ success: false, message: 'A new date/time is required.' });
      followUp.scheduledFor = new Date(scheduledFor);
      followUp.status = 'pending';
      followUp.remindedAt = null;
      followUp.overdueNotifiedAt = null;
      if (note !== undefined) followUp.note = note;
      logActivity(req.params.id, 'followup_rescheduled', req.user, `Follow-up rescheduled to ${new Date(scheduledFor).toLocaleString()}.`);
    } else if (action === 'cancel') {
      followUp.status = 'cancelled';
      logActivity(req.params.id, 'followup_cancelled', req.user, 'Follow-up cancelled.');
    } else {
      return res.status(400).json({ success: false, message: 'action must be done, reschedule, or cancel.' });
    }

    await followUp.save();
    res.json({ success: true, followUp });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
