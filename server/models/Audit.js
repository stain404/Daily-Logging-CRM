const mongoose = require('mongoose');

const AuditSchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName:  { type: String },
  action:    { type: String, required: true },
  detail:    { type: String },
  ip:        { type: String },
  userAgent: { type: String },
  method:    { type: String },
  path:      { type: String },
}, { timestamps: true });

AuditSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Audit', AuditSchema);
