// Sales CRM visibility — same shape as routes/tasks.js's getTaskQuery/inScope,
// just keyed on Lead.assignedTo instead of Task.userId. Reuses
// utils/scope.js's managedUserIds rather than re-deriving "who does this
// manager oversee".

const { managedUserIds } = require('./scope');

async function getLeadQuery(user) {
  if (['superadmin', 'admin'].includes(user.role)) return {};
  if (user.role === 'manager') {
    return { assignedTo: { $in: [user._id, ...(await managedUserIds(user))] } };
  }
  return { assignedTo: user._id };  // employee / hr with salesCrmAccess — own leads only
}

async function leadInScope(Lead, user, leadId) {
  const query = await getLeadQuery(user);
  return Boolean(await Lead.exists({ _id: leadId, ...query }));
}

// The nav/page + every route in routes/leads.js is gated on this, same rule
// client/index.html already enforces for the nav item itself.
function hasSalesCrmAccess(user) {
  return user.role === 'superadmin' || user.role === 'admin' || user.salesCrmAccess === true;
}

function requireSalesCrmAccess(req, res, next) {
  if (!hasSalesCrmAccess(req.user)) {
    return res.status(403).json({ success: false, message: 'You do not have access to the Sales CRM.' });
  }
  next();
}

// Who a given user is allowed to assign or reassign a lead to.
async function assignableUserIds(user) {
  if (['superadmin', 'admin'].includes(user.role)) {
    const User = require('../models/User');
    const all = await User.find({ active: true }).select('_id');
    return all.map(u => String(u._id));
  }
  if (user.role === 'manager') {
    return [...new Set([String(user._id), ...(await managedUserIds(user))])];
  }
  return [String(user._id)];
}

module.exports = { getLeadQuery, leadInScope, hasSalesCrmAccess, requireSalesCrmAccess, assignableUserIds };
