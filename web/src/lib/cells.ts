import type { Cell, ItemKind } from '../data/types'

export const NO_ITEMS: Record<ItemKind, number> = { tires: 0, furniture: 0, appliances: 0, bags: 0, construction: 0 }

/**
 * Reports in a cell through a given year, optionally without the single most active account.
 * Cells with fewer than 3 reports publish no per-year or per-account detail (privacy), so they
 * count only in the unfiltered view.
 */
export function cellCount(c: Cell, hideTop: boolean, throughYear?: number, lastYear?: number): number {
  const unfiltered = throughYear == null || (lastYear != null && throughYear >= lastYear)
  if (!c.hotspot || !c.years) return !hideTop && unfiltered ? c.n : 0
  if (unfiltered) return hideTop ? (c.n_others ?? 0) : c.n
  const years = hideTop ? c.years_others ?? {} : c.years
  return Object.entries(years).reduce((s, [y, v]) => (Number(y) <= throughYear! ? s + v : s), 0)
}

export const itemsOf = (c: Cell): Record<ItemKind, number> => c.items ?? NO_ITEMS
