import { describe, expect, it } from 'vitest'
import type { Cell } from '../data/types'
import { earliestAmnesty, isoWeek, propose, starReimbursable, weeklyPlan } from './plan'

function cell(over: Partial<Cell> = {}): Cell {
  return {
    id: '1_1', lat: 33.82, lng: -84.58, street: 'Front St SW',
    n: 12, hotspot: true, years: { '2021': 2, '2026': 3 },
    items: { tires: 0, furniture: 0, appliances: 0, bags: 1, construction: 0 },
    first_year: 2021, last_12_months: 3, district: '3',
    plus_code: '865QRC9C+XX', risk: 0.5,
    owner_hint: { owner: 'confirm', label: 'Local road or private parcel: confirm the owner' },
    context: { dead_ends_within_250: 0, d_major_m: 40, road_m_within_150: 900, streetlight_out_within_300: 0 },
    ...over,
  }
}

describe('propose', () => {
  it('sends tire-heavy spots to the tire play and flags big piles for EPD', () => {
    const p = propose(cell({ items: { tires: 12, furniture: 0, appliances: 0, bags: 0, construction: 0 } }))
    expect(p.treatment).toBe('tire_play')
    expect(p.flags.join(' ')).toMatch(/25 stored tires/)
    expect(p.also).not.toContain('cleanup')
  })

  it('lets the item mentioned most lead, and still flags a big tire count', () => {
    const p = propose(cell({ items: { tires: 11, furniture: 9, appliances: 3, bags: 14, construction: 1 } }))
    expect(p.treatment).toBe('sign_qr')
    expect(p.also).toContain('tire_play')
    expect(p.flags.join(' ')).toMatch(/25 stored tires/)
  })

  it('sends spots where furniture and appliances lead to bulk-pickup outreach even with some tires', () => {
    const p = propose(cell({ items: { tires: 4, furniture: 6, appliances: 3, bags: 2, construction: 0 } }))
    expect(p.treatment).toBe('bulk_outreach')
  })

  it('flags construction debris as a possible commercial dump', () => {
    const p = propose(cell({ items: { tires: 0, furniture: 0, appliances: 0, bags: 0, construction: 3 } }))
    expect(p.treatment).toBe('commercial_check')
    expect(p.flags.join(' ')).toMatch(/16-7-51/)
  })

  it('sends furniture and appliance spots to bulk-pickup outreach', () => {
    const p = propose(cell({ items: { tires: 0, furniture: 4, appliances: 2, bags: 0, construction: 0 } }))
    expect(p.treatment).toBe('bulk_outreach')
  })

  it('closes access at quiet dead ends away from major roads', () => {
    const p = propose(cell({ context: { dead_ends_within_250: 5, d_major_m: 400, road_m_within_150: 300, streetlight_out_within_300: 0 } }))
    expect(p.treatment).toBe('close_access')
  })

  it('reserves the camera for busy spots where cheaper steps did not hold', () => {
    const p = propose(cell({ n: 30, last_12_months: 6 }))
    expect(p.treatment).toBe('camera')
  })

  it('falls back to a QR sign and carries a GDOT note on state routes', () => {
    const p = propose(cell({ n: 4, last_12_months: 1, owner_hint: { owner: 'gdot', label: 'State route US 78: coordinate with GDOT' } }))
    expect(p.treatment).toBe('sign_qr')
    expect(p.flags).toContain('State route US 78: coordinate with GDOT')
  })
})

describe('weeklyPlan', () => {
  it('keeps only active hotspots, sorted by priority, capped', () => {
    const cells = [
      cell({ id: 'a', last_12_months: 1 }),
      cell({ id: 'b', last_12_months: 9 }),
      cell({ id: 'c', last_12_months: 0 }),
      cell({ id: 'd', hotspot: false, last_12_months: 20 }),
    ]
    const plan = weeklyPlan(cells, 5)
    expect(plan.map((p) => p.cellId)).toEqual(['b', 'a'])
  })
})

describe('STAR helpers', () => {
  it('needs 90 days of notice, more for a first application', () => {
    const today = new Date('2026-10-30T12:00:00')
    expect(earliestAmnesty(today, false).toISOString().slice(0, 10)).toBe('2027-01-28')
    expect(earliestAmnesty(today, true).getTime()).toBeGreaterThan(earliestAmnesty(today, false).getTime())
  })

  it('caps reimbursement at $4 per passenger tire equivalent and never above cost', () => {
    expect(starReimbursable(100, 1000)).toBe(400)
    expect(starReimbursable(100, 250)).toBe(250)
    expect(starReimbursable(-5, 100)).toBe(0)
  })
})

describe('isoWeek', () => {
  it('formats ISO weeks', () => {
    expect(isoWeek(new Date('2026-10-30T12:00:00'))).toBe('2026-W44')
    expect(isoWeek(new Date('2027-01-01T12:00:00'))).toBe('2026-W53')
  })
})
