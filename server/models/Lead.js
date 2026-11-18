const mongoose = require('mongoose');

// Matches the stages in the Sales CRM spec: New, Contacted, Interested,
// Proposal Sent, Negotiation, Won, Lost.
const STAGES = ['new', 'contacted', 'interested', 'proposal_sent', 'negotiation', 'won', 'lost'];
const SOURCES = ['Referral', 'Website', 'Exhibition', 'Cold Call', 'Manual Entry', 'Other'];

const LeadSchema = new mongoose.Schema({
  name:    { type: String, required: true, trim: true },
  company: { type: String, trim: true, default: '' },
  phone:   { type: String, trim: true, default: '' },
  email:   { type: String, trim: true, lowercase: true, default: '' },
  country: { type: String, trim: true, default: '' },
  source:  { type: String, enum: SOURCES, default: 'Other' },
  notes:   { type: String, trim: true, default: '' },
  value:   { type: Number, default: 0, min: 0 },

  stage: { type: String, enum: STAGES, default: 'new' },
  // Required once a lead is marked Lost — enforced below, not just in the UI.
  lostReason: { type: String, trim: true, default: '' },

  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Leads this one was flagged as a possible duplicate of at creation time
  // (matched by phone or email). Informational — never blocks the save.
  possibleDuplicateOf: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Lead' }],
}, { timestamps: true });

LeadSchema.index({ phone: 1 });
LeadSchema.index({ email: 1 });
LeadSchema.index({ assignedTo: 1, stage: 1 });
LeadSchema.index({ createdAt: -1 });

LeadSchema.pre('validate', function (next) {
  if (this.stage === 'lost' && !this.lostReason) {
    this.invalidate('lostReason', 'A reason is required when marking a lead Lost.');
  }
  next();
});

const Lead = mongoose.model('Lead', LeadSchema);
Lead.STAGES = STAGES;
Lead.SOURCES = SOURCES;
module.exports = Lead;
