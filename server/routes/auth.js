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

    // Accept login by username OR empId
    const user = await User.findOne({
      $or: [
        { username: username.toLowerCase() },
        { empId: username.toUpperCase() },
      ],
      active: true,
    })
      .select('+password')
      .populate('department', 'name color')
      .populate('team',       'name')
      .populate('manager',    'name empId designation');

    if (!user || !(await user.matchPassword(password))) {
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
