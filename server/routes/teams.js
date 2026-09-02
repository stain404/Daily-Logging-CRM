const express = require('express');
const router  = express.Router();
const Team    = require('../models/Team');
const User    = require('../models/User');
const Audit   = require('../models/Audit');
const Department = require('../models/Department');
const { protect, authorize } = require('../middleware/auth');
const {
  canPropose, canActDirectly, denyAddRemove, submitRequest, pendingResponse, pendingTargetRequest,
} = require('../services/changeRequests');

const MEMBER_FIELDS = 'name empId color initials designation active team';

// ── GET /api/teams ────────────────────────────────────────────────────
// Membership lives in two places — Team.members and User.team — and they can
// disagree: a team created before the org was restructured still lists people
// who have since been moved, so a manager's card showed members who are in
// somebody else's team now, or in none.
//
// User.team is the tie-breaker, because a person belongs to exactly one team
// and that field is the only one that can say so. Team.members is kept in sync
// on write (see below) and is used only to catch a row whose user document has
// not been updated yet.
router.get('/', protect, async (req, res) => {
  try {
    // "My Team" means the teams this manager actually manages. Without this
    // the page is a company-wide directory of every team, which is what the
    // sidebar label promises it is not.
    const query = req.user.role === 'manager' ? { manager: req.user._id } : {};

    const teams = await Team.find(query)
      .populate('department', 'name color')
      .populate('manager',   'name empId color initials designation')
      .populate('members',   MEMBER_FIELDS);

    // One query for every team on the page rather than one per team.
    const claimed = await User.find({ team: { $in: teams.map(t => t._id) } })
      .select(MEMBER_FIELDS)
      .sort({ name: 1 });

    const byTeam = new Map();
    claimed.forEach(u => {
      const key = String(u.team);
      if (!byTeam.has(key)) byTeam.set(key, []);
      byTeam.get(key).push(u);
    });

    const reconciled = teams.map(t => {
      const obj  = t.toObject();
      const mine = byTeam.get(String(t._id)) || [];
      const ids  = new Set(mine.map(u => String(u._id)));
      // Anyone still on Team.members whose user document points somewhere else
      // is stale and drops out; anyone pointing here is in, listed or not.
      const kept = (obj.members || []).filter(m => m && !m.team && !ids.has(String(m._id)));
      obj.members = [...mine, ...kept];
      return obj;
    });

    res.json({ success: true, count: reconciled.length, teams: reconciled });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/teams ───────────────────────────────────────────────────
// Raised by HR, created only once the CEO approves.
router.post('/', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const direct = canActDirectly(req.user.role);
    if (!direct && !canPropose(req.user.role)) return denyAddRemove(req, res, 'teams');

    if (!req.body.name) {
      return res.status(400).json({ success: false, message: 'A team name is required.' });
    }
    if (!req.body.department) {
      return res.status(400).json({ success: false, message: 'A department is required to create a team.' });
    }
    const dept = await Department.findById(req.body.department).select('name');
    if (!dept) {
      return res.status(400).json({ success: false, message: 'That department does not exist.' });
    }

    // The CEO decides on this request, possibly days from now, and he cannot
    // judge a team whose manager and members read as ObjectIds. Resolve the
    // names here — the last point at which the documents are in hand — and
    // store them on the request next to the payload.
    let manager = null;
    if (req.body.manager) {
      manager = await User.findById(req.body.manager).select('name empId');
      if (!manager) {
        return res.status(400).json({ success: false, message: 'That manager could not be found.' });
      }
    }

    const memberIds = Array.isArray(req.body.members) ? req.body.members.filter(Boolean) : [];
    const members = memberIds.length
      ? await User.find({ _id: { $in: memberIds } }).select('name empId')
      : [];
    if (members.length !== memberIds.length) {
      return res.status(400).json({ success: false, message: 'One or more of those members could not be found.' });
    }

    if (direct) {
      const team = await Team.create({ ...req.body, members: members.map(m => m._id) });
      if (team.members?.length) {
        // Both stores, same as the approval path — see routes/teams.js GET /.
        await Team.updateMany(
          { _id: { $ne: team._id }, members: { $in: team.members } },
          { $pull: { members: { $in: team.members } } },
        );
        await User.updateMany({ _id: { $in: team.members } }, { team: team._id });
      }
      await Audit.create({
        user: req.user._id, userName: req.user.name,
        action: 'Team Created', detail: `Created team: ${team.name}`, ip: req.ip,
      });
      return res.status(201).json({ success: true, team });
    }

    const request = await submitRequest(req, {
      entity: 'team', action: 'create',
      payload: { ...req.body, members: members.map(m => m._id) },
      summary: `Add team "${req.body.name}" in ${dept.name}`,
      details: [
        { label: 'Team',       value: req.body.name },
        { label: 'Department', value: dept.name },
        { label: 'Manager',    value: manager ? `${manager.name} (${manager.empId})` : 'None assigned' },
        {
          label: members.length === 1 ? 'Member' : 'Members',
          value: members.length ? members.map(m => m.name).join(', ') : 'None yet',
        },
      ],
    });

    return pendingResponse(res, request, `The team will be created`);
  } catch (err) {
    if (err.name === 'CastError' || err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: 'A department is required to create a team.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/teams/:id ────────────────────────────────────────────────
router.put('/:id', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const team = await Team.findByIdAndUpdate(req.params.id, req.body, {
      new: true, runValidators: true,
    })
      .populate('department', 'name color')
      .populate('manager',   'name empId')
      .populate('members',   'name empId color initials');

    if (!team) {
      return res.status(404).json({ success: false, message: 'Team not found.' });
    }

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'Team Updated',
      detail:   `Updated team: ${team.name}`,
      ip:       req.ip,
    });

    res.json({ success: true, team });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/teams/:id/members ────────────────────────────────────────
// Add or remove team members. Body: { add: [userId], remove: [userId] }
router.put('/:id/members', protect, authorize('hr', 'manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { add = [], remove = [] } = req.body;
    const team = await Team.findById(req.params.id);
    if (!team) {
      return res.status(404).json({ success: false, message: 'Team not found.' });
    }

    // Managers may only manage membership of a team they actually manage.
    if (req.user.role === 'manager' && (!team.manager || team.manager.toString() !== req.user._id.toString())) {
      return res.status(403).json({ success: false, message: 'You can only manage members of your own team.' });
    }

    if (add.length)    team.members.addToSet(...add);
    if (remove.length) team.members.pull(...remove);
    await team.save();

    // A person belongs to one team, so joining this one means leaving the last.
    // Pulling them out of the old roster here is what stops the two stores
    // drifting apart — the drift GET / above now has to clean up after.
    if (add.length) {
      await Team.updateMany(
        { _id: { $ne: team._id }, members: { $in: add } },
        { $pull: { members: { $in: add } } },
      );
    }

    // Update the team field on affected users
    if (add.length)    await User.updateMany({ _id: { $in: add }    }, { team: team._id });
    if (remove.length) await User.updateMany({ _id: { $in: remove } }, { $unset: { team: 1 } });

    const populated = await Team.findById(team._id)
      .populate('department', 'name color')
      .populate('manager',   'name empId color initials')
      .populate('members',   MEMBER_FIELDS);

    res.json({ success: true, team: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/teams/:id ─────────────────────────────────────────────
router.delete('/:id', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const direct = canActDirectly(req.user.role);
    if (!direct && !canPropose(req.user.role)) return denyAddRemove(req, res, 'teams');

    const team = await Team.findById(req.params.id);
    if (!team) {
      return res.status(404).json({ success: false, message: 'Team not found.' });
    }

    if (direct) {
      await Team.findByIdAndDelete(team._id);
      // Members keep working; they simply stop belonging to a team.
      await User.updateMany({ team: team._id }, { $unset: { team: 1 } });
      await Audit.create({
        user: req.user._id, userName: req.user.name,
        action: 'Team Deleted', detail: `Deleted team: ${team.name}`, ip: req.ip,
      });
      return res.json({ success: true, message: `${team.name} has been deleted.` });
    }

    if (await pendingTargetRequest('team', team._id)) {
      return res.status(400).json({ success: false, message: 'This team already has a change waiting for the CEO.' });
    }

    const request = await submitRequest(req, {
      entity: 'team', action: 'delete', target: team._id,
      targetLabel: team.name,
      summary: `Delete team "${team.name}"${team.members?.length ? ` (${team.members.length} members)` : ''}`,
    });

    return pendingResponse(res, request, 'The team will be deleted');
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
