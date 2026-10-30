/** RFC 4180 quoting, plus formula neutralising: a cell that starts with = + - @ tab or CR is
 * prefixed with an apostrophe so a spreadsheet shows it as text instead of running it. */
export function csvCell(v: string | number): string {
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

export function csv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n')
}
