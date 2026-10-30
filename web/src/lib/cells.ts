import type { Cell } from '../data/types'

/** Reports in a cell through a given year, optionally without the single most active account. */
export function cellCount(c: Cell, hideTop: boolean, throughYear?: number): number {
  if (throughYear == null) return hideTop ? c.n_others : c.n
  const years = hideTop ? c.years_others : c.years
  return Object.entries(years).reduce((s, [y, v]) => (Number(y) <= throughYear ? s + v : s), 0)
}
