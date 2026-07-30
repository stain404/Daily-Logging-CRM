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

  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

UserSchema.methods.matchPassword = async function (entered) {
  return bcrypt.compare(entered, this.password);
};

module.exports = mongoose.model('User', UserSchema);
