const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  empId: {
    type: String, required: true, unique: true,
    uppercase: true, trim: true,
  },
  username: {
    type: String, required: true, unique: true,
    lowercase: true, trim: true,
  },
  name: { type: String, required: true, trim: true },
  email: {
    type: String, unique: true, sparse: true,
    lowercase: true, trim: true,
    set: v => (v === '' ? undefined : v),
  },
  password: {
    type: String, required: true, minlength: 6, select: false,
  },
  role: {
    type: String,
    enum: ['superadmin', 'admin', 'manager', 'employee', 'hr'],
    default: 'employee',
  },
  designation: { type: String, required: true, trim: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  team:       { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
  manager:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  color:      { type: String, default: '#2563eb' },
  initials:   { type: String },
  active:     { type: Boolean, default: true },
  joined:     { type: Date, default: Date.now },
  lastLogin:  { type: Date },

  // A capability, deliberately separate from `role`. Lets a specific person
  // reset other people's passwords without being made an admin — the IT desk
  // needs the reset, not the run of admin powers that comes with the role.
  // Off by default and never exposed in the role/edit UI; set it from a script
  // (scripts/grantResetPower.js) so it cannot be handed out by a mis-click.
  // The reset route enforces it; the client only uses it to reveal the tool.
  canResetPasswords: { type: Boolean, default: false },

  // Gates the Sales CRM nav item. Off by default; only the CEO can grant or
  // revoke it (routes/users.js PUT /:id/sales-crm-access — not the general
  // user-edit route), the same reasoning as canResetPasswords above: a
  // capability the CEO hands out one person at a time, not a role.
  salesCrmAccess: { type: Boolean, default: false },

  // Per-type email opt-outs. Default on, so existing rows (which have no
  // subdocument at all) read as opted in without a migration.
  //
  // Note these are preferences, not permissions: a manager may switch
  // emailTaskSubmitted off in the UI but the send layer overrides it, because
  // submission alerts are the one notification the review chain must receive.
  // See services/mailer.js — the server is the authority, not this field.
  notificationPrefs: {
    emailTaskAssigned:  { type: Boolean, default: true },
    emailTaskSubmitted: { type: Boolean, default: true },
    emailTaskReviewed:  { type: Boolean, default: true },
  },

  // Set from an SES bounce/complaint notification. Stops us re-sending to a
  // dead address, which is what damages a sending domain's reputation.
  emailBounced: { type: Boolean, default: false },
}, { timestamps: true });

// Hash password + auto-generate initials before save
UserSchema.pre('save', async function (next) {
  // Auto-generate initials from name
  if (this.isModified('name') || !this.initials) {
    this.initials = this.name
      .split(' ')
      .map(n => n[0])
      .join('')
      .substring(0, 2)
      .toUpperCase();
  }

  // A pending change request stores an already-hashed password — it can sit
  // for days awaiting the CEO and must never hold plaintext. The applier in
  // services/changeRequests.js sets this flag so the hash isn't hashed twice,
  // which would leave an account nobody can log into.
  if (!this.isModified('password') || this.$locals.passwordPreHashed) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

UserSchema.methods.matchPassword = async function (entered) {
  return bcrypt.compare(entered, this.password);
};

module.exports = mongoose.model('User', UserSchema);
