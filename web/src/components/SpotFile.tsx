import { Frame, HBar } from './hud'
import type { Cell, ItemKind } from '../data/types'
import { int } from '../lib/format'
import { TREATMENT_LABEL, propose } from '../lib/plan'

const ITEM_LABEL: Record<ItemKind, string> = {
  tires: 'Tires', furniture: 'Furniture', appliances: 'Appliances', bags: 'Bags of trash', construction: 'Construction',
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 15).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

export default function SpotFile({ cell, cells, onClose, onAddToPlan, pinned }: {
  cell: Cell
  cells: Cell[]
  onClose: () => void
  onAddToPlan?: (id: string) => void
  pinned?: boolean
}) {
  const years = cell.years ? Object.entries(cell.years) : []
  const maxY = Math.max(...years.map(([, v]) => v), 1)
  const items = cell.items ? (Object.entries(cell.items) as [ItemKind, number][]) : []
  const maxI = Math.max(...items.map(([, v]) => v), 1)
  const rank = 1 + cells.filter((c) => c.risk > cell.risk).length
  const p = propose(cell)

  return (
    <Frame className="stack" label="Spot file">
      <div className="between">
        <span className="lbl-w">Spot file // {cell.plus_code}</span>
        <button className="btn" onClick={onClose} aria-label="Close spot file">Close</button>
      </div>
      <h2>{cell.street || 'Unnamed spot'}</h2>
      <dl className="readout lbl">
        <dt>Council district</dt><dd>{cell.district ?? 'n/a'}</dd>
        <dt>Reports since 2021</dt><dd>{int(cell.n)}</dd>
        {cell.n_others != null && <><dt>Without the most active account</dt><dd>{int(cell.n_others)}</dd></>}
        <dt>Last 12 months</dt><dd>{cell.last_12_months}</dd>
        {cell.last_month && <><dt>Last report</dt><dd>{monthLabel(cell.last_month)}</dd></>}
        <dt>Model risk rank</dt><dd>{rank} of {cells.length}</dd>
      </dl>
      {cell.hotspot ? (
        <>
          <hr className="rule" />
          <span className="lbl">Reports by year</span>
          {years.map(([y, v]) => <HBar key={y} label={y} value={v} max={maxY} text={String(v)} />)}
          <hr className="rule" />
          <span className="lbl">What the reports mention (from text, never shown)</span>
          {items.map(([k, v]) => <HBar key={k} label={ITEM_LABEL[k]} value={v} max={maxI} text={String(v)} red={k === 'tires' && v > 0} />)}
        </>
      ) : (
        <p className="note">Fewer than 3 reports here, so per-year counts, dates and item details are not published. One report must never be traceable.</p>
      )}
      <hr className="rule" />
      <span className="lbl">Ground</span>
      <p style={{ fontSize: 12 }}>{cell.owner_hint.label}</p>
      <p className="dim" style={{ fontSize: 12 }}>
        {cell.context.dead_ends_within_250} dead ends within 250 m, {int(cell.context.d_major_m)} m to a major road.
        Street names come from OpenStreetMap, not from reports.
      </p>
      <hr className="rule" />
      <span className="lbl">Planner suggests</span>
      <p className="white">{TREATMENT_LABEL[p.treatment]}</p>
      {p.flags.map((f) => <p key={f} className="note">{f}</p>)}
      {onAddToPlan && cell.hotspot && (
        <button className="btn solid" onClick={() => onAddToPlan(cell.id)} disabled={pinned}>
          {pinned ? 'On this week\'s plan' : 'Add to this week\'s plan'}
        </button>
      )}
    </Frame>
  )
}
