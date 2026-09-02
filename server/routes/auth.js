const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const Audit   = require('../models/Audit');
const { protect } = require('../middleware/auth');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE || '7d' });

// ── POST /api/auth/login ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Please provide a username and password.' });
    }

    // Accept login by username OR employee ID. Looked up in that order rather
    // than as one $or: the two namespaces are separate and can collide — one
    // person's username can be another person's employee ID — and $or would
    // hand back whichever document Mongo reached first. What someone typed is
    // their own username if such a username exists; only then is it read as an
    // employee ID.
    const identifier = String(username).trim();

    const find = where => User.findOne({ ...where, active: true })
      .select('+password')
      .populate('department', 'name color')
      .populate('team',       'name')
      .populate('manager',    'name empId designation');

    // Both candidates, username first, and whichever one the password actually
    // belongs to wins. Trying them in order rather than as one $or is what
    // makes a collision resolvable at all: with $or, Mongo returned whichever
    // document it reached first, so the person whose username it was could be
    // told their own credentials were invalid.
    const candidates = [
      await find({ username: identifier.toLowerCase() }),
      await find({ empId:    identifier.toUpperCase() }),
    ].filter(Boolean);

    let user = null;
    for (const candidate of candidates) {
      if (await candidate.matchPassword(password)) { user = candidate; break; }
    }

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    }

    // Update last login timestamp
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    // Write audit entry
    await Audit.create({
      user:      user._id,
      userName:  user.name,
      action:    'Login',
      detail:    'Successful login',
      ip:        req.ip,
      userAgent: req.headers['user-agent'],
    });

    const token   = signToken(user._id);
    const userObj = user.toObject();
    delete userObj.password;

    res.json({ success: true, token, user: userObj });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'An error occurred during login.' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────────────
router.get('/me', protect, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ── PUT /api/auth/profile ─────────────────────────────────────────────
// Lets any signed-in user set their own email (nothing else — role,
// department, etc. still require an admin/HR/superadmin edit).
router.put('/profile', protect, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findByIdAndUpdate(req.user._id, { email }, {
      new: true, runValidators: true,
    })
      .populate('department', 'name color')
      .populate('team',       'name')
      .populate('manager',    'name empId designation');

    res.json({ success: true, user });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'That email is already in use by another account.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/auth/change-password ───────────────────────────────────
router.post('/change-password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Both current and new passwords are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!(await user.matchPassword(currentPassword))) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    user.password = newPassword;
    await user.save();

    await Audit.create({
      user:     req.user._id,
      userName: req.user.name,
      action:   'Password Changed',
      detail:   'User changed their password',
      ip:       req.ip,
    });

    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
