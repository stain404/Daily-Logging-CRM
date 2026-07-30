const express    = require('express');
const router     = express.Router();
const Task       = require('../models/Task');
const User       = require('../models/User');
const Team       = require('../models/Team');
const Department = require('../models/Department');
const { protect, authorize } = require('../middleware/auth');

// ── GET /api/reports/employee?from=&to= ───────────────────────────────
router.get('/employee', protect, authorize('hr', 'manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { from, to, userId } = req.query;
    const dateQuery = {};
    if (from) dateQuery.$gte = from;
    if (to)   dateQuery.$lte = to;
    const taskFilter = Object.keys(dateQuery).length ? { date: dateQuery } : {};

    const userQuery = { role: { $in: ['employee', 'manager'] } };

    // Managers only get reports for members of teams they manage.
    if (req.user.role === 'manager') {
      const teams     = await Team.find({ manager: req.user._id });
      const memberIds = teams.flatMap(t => t.members.map(m => m.toString()));
      userQuery._id = { $in: memberIds };
    }

    if (userId) {
      if (req.user.role === 'manager' && !(userQuery._id?.$in || []).includes(userId)) {
        return res.status(403).json({ success: false, message: 'You can only view reports for your own team.' });
      }
      userQuery._id = userId;
    }

    const employees = await User.find(userQuery)
      .populate('department', 'name');

    const report = await Promise.all(employees.map(async (u) => {
      const tasks     = await Task.find({ userId: u._id, ...taskFilter });
      const completed = tasks.filter(t => t.status === 'completed').length;
      const delayed   = tasks.filter(t => t.status === 'delayed').length;
      const pending   = tasks.filter(t => !t.approved && !t.rejected).length;
      const hours     = tasks.reduce((s, t) => s + (t.hours || 0), 0);
      const rate      = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;

      return {
        id:             u._id,
        name:           u.name,
        empId:          u.empId,
        department:     u.department?.name || '—',
        color:          u.color,
        initials:       u.initials,
        total:          tasks.length,
        completed,
        delayed,
        pending,
        completionRate: rate,
        totalHours:     hours,
      };
    }));

    const filtered = report
      .filter(r => r.total > 0)
      .sort((a, b) => b.completionRate - a.completionRate);

    res.json({ success: true, count: filtered.length, report: filtered });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/reports/team?from=&to= ──────────────────────────────────
router.get('/team', protect, authorize('hr', 'manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateQuery = {};
    if (from) dateQuery.$gte = from;
    if (to)   dateQuery.$lte = to;
    const taskFilter = Object.keys(dateQuery).length ? { date: dateQuery } : {};

    const teamQuery = req.user.role === 'manager' ? { manager: req.user._id } : {};
    const teams = await Team.find(teamQuery)
      .populate('department', 'name')
      .populate('manager',   'name');

    const report = await Promise.all(teams.map(async (tm) => {
      const memberIds = tm.members.map(m => m.toString());
      const tasks     = await Task.find({ userId: { $in: memberIds }, ...taskFilter });
      const completed = tasks.filter(t => t.status === 'completed').length;
      const rate      = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;

      return {
        id:             tm._id,
        name:           tm.name,
        department:     tm.department?.name || '—',
        manager:        tm.manager?.name    || '—',
        memberCount:    memberIds.length,
        total:          tasks.length,
        completed,
        completionRate: rate,
      };
    }));

    res.json({ success: true, count: report.length, report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/reports/department?from=&to= ────────────────────────────
router.get('/department', protect, authorize('hr', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateQuery = {};
    if (from) dateQuery.$gte = from;
    if (to)   dateQuery.$lte = to;
    const taskFilter = Object.keys(dateQuery).length ? { date: dateQuery } : {};

    const departments = await Department.find();

    const report = await Promise.all(departments.map(async (d) => {
      const members   = await User.find({ department: d._id });
      const memberIds = members.map(m => m._id);
      const tasks     = await Task.find({ userId: { $in: memberIds }, ...taskFilter });
      const completed = tasks.filter(t => t.status === 'completed').length;
      const rate      = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
      const teams     = await Team.countDocuments({ department: d._id });

      return {
        id:             d._id,
        name:           d.name,
        color:          d.color,
        members:        members.length,
        teams,
        total:          tasks.length,
        completed,
        completionRate: rate,
      };
    }));

    res.json({ success: true, count: report.length, report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/reports/employee-of-month ────────────────────────────────
// Ranks workers by this month's completion rate (min. 3 tasks to qualify),
// tie-broken by average manager rating, then total completed.
router.get('/employee-of-month', protect, authorize('hr', 'manager', 'admin', 'superadmin'), async (req, res) => {
  try {
    const now        = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const todayStr   = now.toISOString().split('T')[0];

    const userQuery = { role: { $in: ['employee', 'manager'] } };
    if (req.user.role === 'manager') {
      const teams     = await Team.find({ manager: req.user._id });
      const memberIds = teams.flatMap(t => t.members);
      userQuery._id = { $in: memberIds };
    }
    const eligible   = await User.find(userQuery).select('_id');
    const eligibleIds = eligible.map(u => u._id);

    const stats = await Task.aggregate([
      { $match: { userId: { $in: eligibleIds }, date: { $gte: monthStart, $lte: todayStr } } },
      { $group: {
          _id:         '$userId',
          total:       { $sum: 1 },
          completed:   { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          ratingSum:   { $sum: { $ifNull: ['$mgRating', 0] } },
          ratingCount: { $sum: { $cond: [{ $ne: ['$mgRating', null] }, 1, 0] } },
      } },
    ]);

    const ranked = stats
      .map(s => ({
        userId:         s._id,
        total:          s.total,
        completed:      s.completed,
        completionRate: Math.round((s.completed / s.total) * 100),
        avgRating:      s.ratingCount ? +(s.ratingSum / s.ratingCount).toFixed(1) : null,
      }))
      .filter(s => s.total >= 3)
      .sort((a, b) =>
        b.completionRate - a.completionRate ||
        (b.avgRating || 0) - (a.avgRating || 0) ||
        b.completed - a.completed
      );

    if (!ranked.length) {
      return res.json({ success: true, winner: null });
    }

    const top  = ranked[0];
    const user = await User.findById(top.userId)
      .select('name empId designation color initials')
      .populate('department', 'name');

    res.json({
      success: true,
      winner: {
        user,
        total:          top.total,
        completed:      top.completed,
        completionRate: top.completionRate,
        avgRating:      top.avgRating,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
