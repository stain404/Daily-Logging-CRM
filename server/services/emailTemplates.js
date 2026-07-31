// HTML + plain-text email bodies.
//
// Two constraints drive the odd-looking markup here:
//   1. Email clients (Outlook especially) ignore <style> blocks and external
//      CSS, so every rule is inlined and layout is table-based. This is not
//      how the app itself is written and should not be copied back into it.
//   2. Every interpolated value is user-authored (task titles, descriptions,
//      names), so all of it goes through esc() before reaching the HTML body.
//
// Palette is taken from the client's own light theme (client/index.html :root)
// rather than DESIGN.md, which documents an amber accent the app no longer
// uses. Emails are deliberately built light: a dark-background email renders
// unpredictably across clients and often inverts badly.

const BRAND = {
  name:    process.env.MAIL_BRAND_NAME || 'TaskFlow',
  // --accent is #ff3d81, but pink-on-white is ~3.3:1 — too low for a button
  // label. --accent-ink (#c41f66) is the client's own light-theme answer to
  // exactly this problem, so buttons and links use it and the bright pink is
  // kept for non-text accents like the header rule.
  accent:  '#ff3d81',
  ink:     '#c41f66',
  bg:      '#f6f3ec',
  panel:   '#ffffff',
  text:    '#2a2318',
  muted:   '#5c5540',
  faint:   '#8a8168',
  border:  '#ddd6c3',
  font:    "'IBM Plex Sans', 'Segoe UI', Helvetica, Arial, sans-serif",
};

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
}

// ── Shell ─────────────────────────────────────────────────────────────
// No logo image: the repo ships no brand asset, and a hotlinked remote image
// would be blocked by default in most clients anyway. A text wordmark always
// renders. Drop an <img> in here if a hosted logo URL appears later.
function layout({ heading, introLine, rows, ctaLabel, ctaUrl, footerNote }) {
  const rowHtml = rows
    .filter(r => r.value)
    .map(r => `
              <tr>
                <td style="padding:7px 0;vertical-align:top;width:132px;font:600 11px ${BRAND.font};letter-spacing:.5px;text-transform:uppercase;color:${BRAND.faint};">${esc(r.label)}</td>
                <td style="padding:7px 0;vertical-align:top;font:400 14px ${BRAND.font};color:${BRAND.text};">${esc(r.value)}</td>
              </tr>`)
    .join('');

  const cta = ctaUrl ? `
              <tr><td colspan="2" style="padding:22px 0 4px;">
                <a href="${esc(ctaUrl)}" style="display:inline-block;padding:11px 22px;border-radius:4px;background:${BRAND.ink};color:#ffffff;font:700 14px ${BRAND.font};text-decoration:none;">${esc(ctaLabel)}</a>
              </td></tr>` : '';

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.bg};margin:0;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${BRAND.panel};border:1px solid ${BRAND.border};border-radius:6px;">
      <tr><td style="height:3px;background:${BRAND.accent};border-radius:6px 6px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:24px 28px 0;">
        <div style="font:700 13px ${BRAND.font};letter-spacing:1px;text-transform:uppercase;color:${BRAND.ink};">${esc(BRAND.name)}</div>
        <h1 style="margin:14px 0 6px;font:700 21px ${BRAND.font};color:${BRAND.text};">${esc(heading)}</h1>
        <p style="margin:0 0 4px;font:400 14px ${BRAND.font};color:${BRAND.muted};">${esc(introLine)}</p>
      </td></tr>
      <tr><td style="padding:10px 28px 26px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowHtml}${cta}</table>
      </td></tr>
      <tr><td style="padding:16px 28px 22px;border-top:1px solid ${BRAND.border};">
        <p style="margin:0;font:400 12px ${BRAND.font};color:${BRAND.faint};">${esc(footerNote)}</p>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

function plain({ heading, introLine, rows, ctaLabel, ctaUrl, footerNote }) {
  const lines = [heading, '='.repeat(heading.length), '', introLine, ''];
  rows.filter(r => r.value).forEach(r => lines.push(`${r.label}: ${r.value}`));
  if (ctaUrl) lines.push('', `${ctaLabel}: ${ctaUrl}`);
  lines.push('', footerNote);
  return lines.join('\n');
}

function build(parts) {
  return { subject: parts.subject, html: layout(parts), text: plain(parts) };
}

// ── Templates ─────────────────────────────────────────────────────────

// Task assigned → the assignee.
function taskAssigned({ task, assignedByName, recipientName, url }) {
  return build({
    subject:   `New task assigned: ${task.title}`,
    heading:   'A task was assigned to you',
    introLine: `${recipientName ? recipientName.split(' ')[0] + ', ' : ''}${assignedByName} has assigned you a new task.`,
    rows: [
      { label: 'Task',        value: task.title },
      { label: 'Description', value: task.description },
      { label: 'Project',     value: task.project },
      { label: 'Priority',    value: task.priority },
      { label: 'Deadline',    value: fmtDate(task.dueDate) || 'No deadline set' },
      { label: 'Assigned by', value: assignedByName },
    ],
    ctaLabel: 'Open task',
    ctaUrl:   url,
    footerNote: `You are receiving this because a task was assigned to you in ${BRAND.name}. You can turn these emails off in Settings.`,
  });
}

// Task submitted → the review chain (managers, admins, CEO).
function taskSubmitted({ task, submittedByName, submittedAt, url, late }) {
  return build({
    subject:   late
      ? `Late submission: ${task.title}`
      : `Task submitted: ${task.title}`,
    heading:   late ? 'A task was submitted late' : 'A task is ready for review',
    introLine: `${submittedByName} has submitted work${late ? ' after the deadline' : ''} and it is awaiting your review.`,
    rows: [
      { label: 'Task',         value: task.title },
      { label: 'Submitted by', value: submittedByName },
      { label: 'Submitted at', value: fmtDate(submittedAt || task.submittedAt) },
      { label: 'Deadline',     value: fmtDate(task.dueDate) },
      { label: 'Project',      value: task.project },
      { label: 'Completion',   value: task.completion !== undefined ? `${task.completion}%` : null },
    ],
    ctaLabel: 'Review submission',
    ctaUrl:   url,
    // Deliberately different from the other footers: this alert is mandatory
    // for the review chain, so it must not imply an opt-out that won't work.
    footerNote: `You are receiving this because you oversee this submission in ${BRAND.name}. Submission alerts cannot be switched off for reviewers.`,
  });
}

// Task reviewed → the task owner.
function taskReviewed({ task, reviewerName, action, url }) {
  const verb = action === 'approve' ? 'approved'
             : action === 'reject'  ? 'rejected'
             : 'requested clarification on';
  const head = action === 'approve' ? 'Your task was approved'
             : action === 'reject'  ? 'Your task was rejected'
             : 'Clarification requested';

  return build({
    subject:   `${head}: ${task.title}`,
    heading:   head,
    introLine: `${reviewerName} ${verb} your submission.`,
    rows: [
      { label: 'Task',     value: task.title },
      { label: 'Reviewer', value: reviewerName },
      { label: 'Comment',  value: task.mgComment },
      { label: 'Rating',   value: task.mgRating ? `${task.mgRating} / 5` : null },
    ],
    ctaLabel: 'View task',
    ctaUrl:   url,
    footerNote: `You are receiving this because you submitted this task in ${BRAND.name}. You can turn these emails off in Settings.`,
  });
}

module.exports = { taskAssigned, taskSubmitted, taskReviewed, BRAND, esc, fmtDate };
