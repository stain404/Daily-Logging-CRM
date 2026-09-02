// Raising, describing and applying org-chart change requests.
//
// The rule this file encodes: HR proposes additions and removals, the CEO
// approves them, and nothing touches the real collections in between. The
// routes stay thin — they decide *whether* a call needs approval; everything
// about what approval then does lives here, in one place, so the two can't
// drift.
//
// Ordinary edits never come through here. See models/ChangeRequest.js.

const bcrypt        = require('bcryptjs');
const ChangeRequest = require('../models/ChangeRequest');
const User          = require('../models/User');
const Team          = require('../models/Team');
const Department    = require('../models/Department');
const Audit         = require('../models/Audit');
const { notify, ceos } = require('./notify');

// ── Who may do what ──────────────────────────────────────────────────
// Only HR proposes. Only the CEO decides. Admin does neither: if an admin
// could still add and remove directly they would outrank the person whose
// approval the whole flow exists to require.
const PROPOSER_ROLE = 'hr';
const DECIDER_ROLE  = 'superadmin';

const canPropose = role => role === PROPOSER_ROLE;
const canDecide  = role => role === DECIDER_ROLE;

// The CEO is the approver, so routing his own additions and removals through
// a queue only he can clear is theatre — he would approve his own request one
// click later, and in the meantime his Employees page has fewer actions on it
// than HR's, which reads as a bug rather than as a policy. He acts directly;
// admin still has neither path, which is what keeps the flow meaningful.
const canActDirectly = role => role === DECIDER_ROLE;

// Role-specific refusal text. A generic 403 here reads as a bug to the CEO —
// he is the most senior user in the system and has just been told no.
function denialMessage(role, what) {
  if (role === DECIDER_ROLE) {
    return `Adding and removing ${what} is HR's to raise and yours to approve. Ask HR to submit it and it will appear in your Approvals list.`;
  }
  if (role === 'admin') {
    return `Adding and removing ${what} now goes through HR, and the CEO approves it. Ask HR to raise the request.`;
  }
  return `Your role does not have permission to add or remove ${what}.`;
}

// Send a 403 that explains the workflow rather than just refusing.
function denyAddRemove(req, res, what) {
  return res.status(403).json({
    success: false,
    message: denialMessage(req.user.role, what),
  });
}

// ── Raise a request ───────────────────────────────────────────────────
// Called by the routes in place of the mutation they used to perform.
async function submitRequest(req, { entity, action, payload = {}, target, targetLabel, summary, details = [] }) {
  const doc = await ChangeRequest.create({
    entity, action, payload, target,
    targetLabel: targetLabel || '',
    // Resolved by the caller — the only place that still holds the department
    // and manager documents. Blank values are dropped so the CEO's card never
    // carries an empty row.
    details: (details || []).filter(d => d && d.label && d.value),
    summary,
    requestedBy:     req.user._id,
    requestedByName: req.user.name,
  });

  await Audit.create({
    user:     req.user._id,
    userName: req.user.name,
    action:   'Change Requested',
    detail:   `Requested approval: ${summary}`,
    ip:       req.ip,
  });

  // The CEO is the only person who can act on this, so he is the only person
  // told about it. Not awaited — notify() swallows its own errors, and a
  // notification must never fail the request HR just raised.
  ceos().then(chiefs => notify(chiefs, {
    type:     'change-request',
    title:    'Approval needed',
    message:  `${req.user.name} requested: ${summary}`,
    actor:    req.user._id,
    severity: 'warning',
  })).catch(() => { /* notify() already logged it */ });

  return doc;
}

// The response every intercepted route returns. 202 Accepted, not 201: the
// thing HR asked for has not happened yet, and a client that treats this as a
// success and refreshes its list would otherwise show nothing and look broken.
function pendingResponse(res, request, what) {
  return res.status(202).json({
    success: true,
    pending: true,
    request,
    message: `Sent to the CEO for approval. ${what} once it is approved.`,
  });
}

// ── Describe ──────────────────────────────────────────────────────────
// Built at request time and stored, so the queue stays readable after the
// target is gone. Kept here so the wording is consistent across all six paths.
function describeUserCreate(body) {
  return `Add ${body.role || 'employee'} "${body.name}" (${body.empId})`;
}
function describeUserRemoval(user, action) {
  const verb = action === 'delete' ? 'Delete' : action === 'reactivate' ? 'Reactivate' : 'Deactivate';
  return `${verb} ${user.role} "${user.name}" (${user.empId})`;
}

// ── Apply ─────────────────────────────────────────────────────────────
// Runs on approval. Throws with a human-readable message if the world has
// moved since the request was raised — the caller records that as `failed`
// rather than pretending the change went through.
async function applyRequest(doc) {
  const { entity, action, payload, target } = doc;

  if (entity === 'user') {
    if (action === 'create') {
      // Re-check uniqueness now: the request may have sat for days, and the
      // duplicate-key error alone would surface as an unreadable 500.
      const clash = await User.findOne({
        $or: [
          { empId:    payload.empId },
          { username: payload.username },
          ...(payload.email ? [{ email: payload.email }] : []),
        ],
      });
      if (clash) {
        const field = clash.empId === payload.empId ? 'employee ID'
                    : clash.username === payload.username ? 'username' : 'email';
        throw new Error(`Another user with that ${field} was created while this request was waiting.`);
      }

      // payload.password is already a bcrypt hash — see models/ChangeRequest.js.
      const user = new User(payload);
      user.$locals.passwordPreHashed = true;
      await user.save();
      return { resultId: user._id, detail: `Created user: ${user.name} (${user.empId})` };
    }

    const user = await User.findById(target);
    if (!user) throw new Error('That user no longer exists.');

    if (action === 'delete') {
      await User.findByIdAndDelete(target);
      return { detail: `Deleted user: ${user.name} (${user.empId})` };
    }
    // deactivate / reactivate
    user.active = action === 'reactivate';
    await user.save();
    return { detail: `${user.active ? 'Reactivated' : 'Deactivated'} user: ${user.name} (${user.empId})` };
  }

  if (entity === 'team') {
    if (action === 'create') {
      if (payload.department && !await Department.exists({ _id: payload.department })) {
        throw new Error('That department was deleted while this request was waiting.');
      }
      const team = await Team.create(payload);
      // Membership lives in two places — Team.members and User.team — and both
      // are read independently elsewhere. Setting only the first produces a
      // team with members whose members claim to have no team.
      if (team.members?.length) {
        await User.updateMany({ _id: { $in: team.members } }, { team: team._id });
      }
      return { resultId: team._id, detail: `Created team: ${team.name}` };
    }
    const team = await Team.findByIdAndDelete(target);
    if (!team) throw new Error('That team no longer exists.');
    // Members keep working; they simply stop belonging to a team, the same as
    // the direct delete this replaced.
    await User.updateMany({ team: team._id }, { $unset: { team: 1 } });
    return { detail: `Deleted team: ${team.name}` };
  }

  // department
  if (action === 'create') {
    const dept = await Department.create(payload);
    return { resultId: dept._id, detail: `Created department: ${dept.name}` };
  }
  const dept = await Department.findByIdAndDelete(target);
  if (!dept) throw new Error('That department no longer exists.');
  return { detail: `Deleted department: ${dept.name}` };
}

// ── Already asked for? ────────────────────────────────────────────────
// Two pending requests to add the same person would both look approvable to
// the CEO, and the second would fail on the unique index after he'd already
// clicked it. Cheaper to catch while HR is still on the form.
async function pendingUserCreateClash(empId, username) {
  return ChangeRequest.findOne({
    entity: 'user', action: 'create', status: 'pending',
    $or: [
      { 'payload.empId':    empId },
      { 'payload.username': username },
    ],
  });
}

// The same for a target that is already queued for removal.
async function pendingTargetRequest(entity, target) {
  return ChangeRequest.findOne({ entity, target, status: 'pending' });
}

// ── Password handling for a pending user ─────────────────────────────
// Hashed at request time so a pending request never holds plaintext.
async function hashPassword(plain) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

module.exports = {
  PROPOSER_ROLE, DECIDER_ROLE,
  canPropose, canDecide, canActDirectly, denyAddRemove, denialMessage,
  submitRequest, pendingResponse, applyRequest, hashPassword,
  describeUserCreate, describeUserRemoval,
  pendingUserCreateClash, pendingTargetRequest,
};
