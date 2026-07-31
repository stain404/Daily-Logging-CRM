const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', required: true,
  },
  date:    { type: String, required: true },   // "YYYY-MM-DD"
  title:   { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },
  project: { type: String, required: true, trim: true },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium',
  },
  status: {
    type: String,
    enum: ['completed', 'in-progress', 'not-started', 'delayed', 'on-hold'],
    default: 'not-started',
  },
  startTime:  { type: String, default: '09:00' },
  endTime:    { type: String, default: '17:00' },
  // Real deadline. Distinct from `date` (the working day the entry covers):
  // dueDate can sit days out, which is what gives the client a window wide
  // enough for the green → amber → red proximity dot to mean anything.
  // Left unset on legacy rows; the client falls back to date + endTime.
  dueDate:    { type: Date },
  // Stamped the first time an employee actually submits work against the
  // task, so lateness is measured against the submission, not the last edit.
  submittedAt: { type: Date },
  hours:      { type: Number, default: 0, min: 0, max: 24 },
  completion: { type: Number, default: 0, min: 0, max: 100 },
  challenges: { type: String, default: '' },
  support:    { type: String, default: 'No' },
  nextPlan:   { type: String, default: '' },
  approved:   { type: Boolean, default: false },
  rejected:   { type: Boolean, default: false },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  mgComment:  { type: String, default: '' },
  mgRating:   { type: Number, min: 1, max: 5 },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Denormalised so a task list can show a paperclip without one Attachment
  // query per row. Maintained by routes/attachments.js; treat the Attachment
  // collection as the source of truth if the two ever disagree.
  attachmentCount: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

// Indexes for fast queries
TaskSchema.index({ userId: 1, date: -1 });
TaskSchema.index({ date: -1 });
TaskSchema.index({ status: 1 });
TaskSchema.index({ dueDate: 1 });

module.exports = mongoose.model('Task', TaskSchema);
