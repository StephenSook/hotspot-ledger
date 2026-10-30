export const int = (n: number) => Math.round(n).toLocaleString('en-US')
export const pct = (x: number | null | undefined, digits = 0) => (x == null ? 'n/a' : `${(x * 100).toFixed(digits)}%`)
export const pctRange = (a: number, b: number) => `${Math.round(a * 100)} to ${Math.round(b * 100)}%`

export function dateLabel(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function daysAgo(iso: string, now = new Date()): number {
  return Math.max(0, Math.round((now.getTime() - new Date(`${iso.slice(0, 10)}T12:00:00`).getTime()) / 86400000))
}
