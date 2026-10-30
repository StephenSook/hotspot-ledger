import type { Cell, ItemKind } from '../data/types'

export const NO_ITEMS: Record<ItemKind, number> = { tires: 0, furniture: 0, appliances: 0, bags: 0, construction: 0 }

/**
 * Reports in a cell through a given year. Cells with fewer than 3 reports publish no per-year
 * detail (privacy), so they count only in the unfiltered view. Nothing per account is published at
 * spot level, so there is no per-spot view without the most active account.
 */
export function cellCount(c: Cell, throughYear?: number, lastYear?: number): number {
  const unfiltered = throughYear == null || (lastYear != null && throughYear >= lastYear)
  if (unfiltered) return c.n
  if (!c.hotspot || !c.years) return 0
  return Object.entries(c.years).reduce((s, [y, v]) => (Number(y) <= throughYear! ? s + v : s), 0)
}

export const recentOf = (c: Cell): number => c.last_12_months ?? 0

export const itemsOf = (c: Cell): Record<ItemKind, number> => c.items ?? NO_ITEMS
