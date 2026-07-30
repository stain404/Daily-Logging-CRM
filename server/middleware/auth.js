const jwt   = require('jsonwebtoken');
const User  = require('../models/User');
const Audit = require('../models/Audit');

// ── Protect: verify JWT and attach req.user ──────────────────────────
exports.protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer ')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized — no token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id)
      .populate('department', 'name color')
      .populate('team',       'name')
      .populate('manager',    'name empId designation');

    if (!req.user || !req.user.active) {
      return res.status(401).json({ success: false, message: 'Account not found or has been deactivated.' });
    }
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token is invalid or has expired.' });
  }
};

// ── Authorize: restrict to specific roles ────────────────────────────
exports.authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Your role ('${req.user.role}') does not have permission to perform this action.`,
    });
  }
  next();
};

// ── Audit logger middleware ──────────────────────────────────────────
// Usage: router.post('/path', protect, auditLog('Action', req => `detail`), handler)
exports.auditLog = (action, getDetail) => async (req, res, next) => {
  // Wrap res.json to log after a successful response
  const originalJson = res.json.bind(res);

  res.json = async (data) => {
    if (data && data.success !== false && req.user) {
      try {
        await Audit.create({
          user:      req.user._id,
          userName:  req.user.name,
          action,
          detail:    typeof getDetail === 'function' ? getDetail(req, data) : action,
          ip:        req.ip || req.connection?.remoteAddress,
          userAgent: req.headers['user-agent'],
          method:    req.method,
          path:      req.originalUrl,
        });
      } catch (_) { /* silent — audit failure must never break the request */ }
    }
    return originalJson(data);
  };

  next();
};
