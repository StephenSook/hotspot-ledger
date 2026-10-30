// The weekly planner. Deterministic rules, no model: code proposes, a person approves.
// Each rule cites the evidence that triggered it so staff can see why.
import type { Cell } from '../data/types'
import { itemsOf, recentOf } from './cells'

export type Treatment =
  | 'close_access'
  | 'sign_qr'
  | 'bulk_outreach'
  | 'tire_play'
  | 'commercial_check'
  | 'cleanup'
  | 'camera'

export const TREATMENT_LABEL: Record<Treatment, string> = {
  close_access: 'Close the access',
  sign_qr: 'Post a sign with a QR code',
  bulk_outreach: 'Bulk-pickup outreach, English and Spanish',
  tire_play: 'Tire amnesty and STAR grant claim',
  commercial_check: 'Commercial-dumping check',
  cleanup: 'Crew cleanup stop',
  camera: 'Move a camera here (no plate reading)',
}

export interface Proposal {
  cellId: string
  treatment: Treatment
  also: Treatment[]
  reasons: string[]
  flags: string[]
  priority: number
}

/** Priority favors recent activity, then history, then model risk. Documented in the UI. */
export function priority(c: Cell): number {
  return Math.round((recentOf(c) * 2 + Math.min(c.n, 60) / 10 + c.risk * 5) * 100) / 100
}

export function propose(c: Cell): Proposal {
  const recent = recentOf(c)
  const reasons: string[] = [`${c.n} dumping reports since 2021, ${recent} in the last 12 months`]
  const flags: string[] = []
  const items = itemsOf(c)
  const bulky = items.furniture + items.appliances
  let treatment: Treatment = 'sign_qr'
  const also: Treatment[] = []

  // The item mentioned most decides the first step; ties go to the more specific program.
  const lead = Math.max(items.tires, items.construction, bulky, items.bags)
  if (items.tires >= 3 && items.tires === lead) {
    treatment = 'tire_play'
    reasons.push(`Tires are the item mentioned most (${items.tires} reports)`)
  } else if (items.construction >= 2 && items.construction === lead) {
    treatment = 'commercial_check'
    reasons.push(`Construction debris is the item mentioned most (${items.construction} reports)`)
    flags.push('Dumping for profit is egregious litter at any size (O.C.G.A. 16-7-51)')
  } else if (bulky >= 2 && bulky === lead) {
    treatment = 'bulk_outreach'
    reasons.push(`Furniture, mattresses and appliances are mentioned most (${bulky} reports)`)
  } else if (c.context.dead_ends_within_250 >= 3 && c.context.d_major_m > 150) {
    treatment = 'close_access'
    reasons.push(`${c.context.dead_ends_within_250} dead ends within 250 m, ${c.context.d_major_m} m from a major road`)
  } else if (recent >= 4 && c.n >= 10) {
    treatment = 'camera'
    reasons.push('One of the busiest spots: a camera shows what actually happens here before anyone guesses')
  } else {
    reasons.push('Recurring spot: a sign also turns it into a reporting point')
  }

  if (items.tires >= 10) {
    if (treatment !== 'tire_play') {
      also.push('tire_play')
      reasons.push(`${items.tires} reports also mention tires`)
    }
    flags.push('Check for more than 25 stored tires: a state violation to refer to EPD (Rule 391-3-4-.19)')
  }
  if (recent >= 1 && treatment !== 'tire_play') also.push('cleanup')
  if (treatment !== 'sign_qr' && treatment !== 'camera') also.push('sign_qr')
  if (c.owner_hint.owner === 'gdot') flags.push(c.owner_hint.label)

  return { cellId: c.id, treatment, also, reasons, flags, priority: priority(c) }
}

/** The week's list: active hotspots first, capped so the list stays short on purpose. */
export function weeklyPlan(cells: Cell[], capacity = 8): Proposal[] {
  return cells
    .filter((c) => c.hotspot && recentOf(c) > 0)
    .map(propose)
    .sort((a, b) => b.priority - a.priority || a.cellId.localeCompare(b.cellId))
    .slice(0, Math.max(1, capacity))
}

/** ISO week key like 2026-W44, used to store decisions per week. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// STAR scrap tire grant (Georgia EPD), as verified Oct 29 2026.
export const STAR = {
  fiscalYearCap: 150000,
  perPassengerTireEquivalent: 4,
  leadDays: 90,
  firstTimeLeadDays: 150,
}

/** Earliest date a tire amnesty event can be scheduled if the application goes in today. */
export function earliestAmnesty(today: Date, firstTime: boolean): Date {
  const d = new Date(today)
  d.setDate(d.getDate() + (firstTime ? STAR.firstTimeLeadDays : STAR.leadDays))
  return d
}

/** STAR reimburses hauling and processing up to $4.00 per passenger tire equivalent, never labor. */
export function starReimbursable(pte: number, haulAndProcessCost: number): number {
  return Math.max(0, Math.min(haulAndProcessCost, pte * STAR.perPassengerTireEquivalent))
}
