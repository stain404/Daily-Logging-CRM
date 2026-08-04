// CSV export. No dependency, and Excel opens it directly — which covers the
// "Excel" export without adding a spreadsheet library to a live service.
// PDF is handled client-side via print stylesheet; a server-side XLSX/PDF
// writer can slot in beside this without touching the report routes, since
// they only ever call toCsv() with rows + a column spec.

/**
 * @param {Array<Object>} rows
 * @param {Array<{key:string,label:string,format?:Function}>} columns
 */
function toCsv(rows, columns) {
  const head = columns.map(c => escapeCell(c.label)).join(',');
  const body = rows.map(r =>
    columns.map(c => {
      const raw = c.format ? c.format(r[c.key], r) : r[c.key];
      return escapeCell(raw);
    }).join(',')
  );
  // UTF-8 BOM so Excel on Windows reads accented names correctly instead of
  // rendering them as mojibake.
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

function escapeCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);

  // Neutralise spreadsheet formula injection: a cell starting with = + - @
  // is executed on open in Excel/Sheets. Employee names and free-text comments
  // reach this export, so the guard is not optional.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;

  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Sets the headers that make a browser download the response as a file. */
function sendCsv(res, filename, csv) {
  const safe = String(filename).replace(/[^\w.\-]+/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  res.send(csv);
}

module.exports = { toCsv, sendCsv, escapeCell };
