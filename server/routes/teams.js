const express = require('express');
const router  = express.Router();
const Team    = require('../models/Team');
const User    = require('../models/User');
const Audit   = require('../models/Audit');
const Department = require('../models/Department');
const { protect, authorize } = require('../middleware/auth');
const {
  canPropose, denyAddRemove, submitRequest, pendingResponse, pendingTargetRequest,
} = require('../services/changeRequests');

// ── GET /api/teams ────────────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    const teams = await Team.find()
      .populate('department', 'name color')
      .populate('manager',   'name empId color initials designation')
      .populate('members',   'name empId color initials designation active');

    res.json({ success: true, count: teams.length, teams });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/teams ───────────────────────────────────────────────────
// Raised by HR, created only once the CEO approves.
router.post('/', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    if (!canPropose(req.user.role)) return denyAddRemove(req, res, 'teams');

    if (!req.body.name) {
      return res.status(400).json({ success: false, message: 'A team name is required.' });
    }
    if (!req.body.department) {
      return res.status(400).json({ success: false, message: 'A department is required to create a team.' });
    }
    if (!await Department.exists({ _id: req.body.department })) {
      return res.status(400).json({ success: false, message: 'That department does not exist.' });
    }

    const request = await submitRequest(req, {
      entity: 'team', action: 'create', payload: req.body,
      summary: `Add team "${req.body.name}"`,
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

    // Update the team field on affected users
    if (add.length)    await User.updateMany({ _id: { $in: add }    }, { team: team._id });
    if (remove.length) await User.updateMany({ _id: { $in: remove } }, { $unset: { team: 1 } });

    const populated = await Team.findById(team._id)
      .populate('department', 'name color')
      .populate('manager',   'name empId color initials')
      .populate('members',   'name empId color initials designation active');

    res.json({ success: true, team: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/teams/:id ─────────────────────────────────────────────
router.delete('/:id', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    if (!canPropose(req.user.role)) return denyAddRemove(req, res, 'teams');

    const team = await Team.findById(req.params.id);
    if (!team) {
      return res.status(404).json({ success: false, message: 'Team not found.' });
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
