/** RFC 4180 quoting, plus formula neutralising: a cell that starts with = + - @ tab or CR is
 * prefixed with an apostrophe so a spreadsheet shows it as text instead of running it. */
export function csvCell(v: string | number): string {
  let s = String(v)
  // oxlint-disable-next-line no-control-regex -- leading control characters are the bypass being blocked
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(s) || /^[\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

export function csv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n')
}
