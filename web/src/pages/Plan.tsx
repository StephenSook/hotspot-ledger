import { useMemo, useRef, useState } from 'react'
import LedgerMap from '../components/LedgerMap'
import FieldPhoto from '../components/FieldPhoto'
import { Frame } from '../components/hud'
import type { Cell, LngLat, LedgerData } from '../data/types'
import { draftNotice, explain, getStaffToken, orderStops, setStaffToken, signNotice, type DraftResult, type SignResult } from '../lib/api'
import { int } from '../lib/format'
import { STAR, TREATMENT_LABEL, earliestAmnesty, isoWeek, propose, starReimbursable, weeklyPlan, type Proposal } from '../lib/plan'
import { useStored } from '../lib/store'
import { csv } from '../lib/csv'
import { itemsOf, recentOf } from '../lib/cells'

type Owner = '' | 'city' | 'cobb' | 'gdot' | 'private'
const OWNER_LABEL: Record<Exclude<Owner, ''>, string> = { city: 'City of Mableton', cobb: 'Cobb County DOT', gdot: 'Georgia DOT', private: 'Private owner' }
type Decision = { status: 'approved' | 'deferred' | 'rejected'; owner: Owner; at: string }
type TireLog = { tires: number; pte: number; manifest: string; cost: number }


export default function Plan({ data, pinned }: { data: LedgerData; pinned: string[] }) {
  const { cells } = data
  const [today] = useState(() => new Date())
  const week = isoWeek(today)
  const [capacity, setCapacity] = useStored<number>('capacity', 8)
  const [decisions, setDecisions] = useStored<Record<string, Decision>>(`decisions:${week}`, {})
  const [owners, setOwners] = useStored<Record<string, Owner>>(`owners:${week}`, {})
  const [tireLog, setTireLog] = useStored<Record<string, TireLog>>('star-log', {})
  const [firstTime, setFirstTime] = useStored<boolean>('star-first-time', true)
  const [route, setRoute] = useState<{ order: string[]; km: number } | null>(null)
  const [routeMsg, setRouteMsg] = useState('')
  const [drafts, setDrafts] = useState<Record<string, DraftResult | string>>({})
  const [signed, setSigned] = useState<Record<string, SignResult | string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [staffSet, setStaffSet] = useState(() => getStaffToken() !== '')
  const [staffInput, setStaffInput] = useState('')

  const byId = useMemo(() => new Map(cells.map((c) => [c.id, c])), [cells])
  const proposals: Proposal[] = useMemo(() => {
    const auto = weeklyPlan(cells, capacity)
    const have = new Set(auto.map((p) => p.cellId))
    const extra = pinned.filter((id) => !have.has(id) && byId.has(id)).map((id) => propose(byId.get(id)!))
    return [...auto, ...extra]
  }, [cells, capacity, pinned, byId])

  const approved = proposals.filter((p) => decisions[p.cellId]?.status === 'approved')
  const routable = approved.filter((p) => p.treatment === 'cleanup' || p.also.includes('cleanup') || p.treatment === 'sign_qr' || p.also.includes('sign_qr'))
  const tireSpots = proposals.filter((p) => p.treatment === 'tire_play')
  const routePath: LngLat[] | undefined = route?.order.map((id) => { const c = byId.get(id)!; return [c.lng, c.lat] })

  // Any decision change voids that spot's draft and signature, and answers still in flight for it.
  const epoch = useRef<Record<string, number>>({})
  const drop = <T,>(m: Record<string, T>, id: string) => { const { [id]: _gone, ...rest } = m; return rest }
  const decide = (id: string, status: Decision['status']) => {
    epoch.current[id] = (epoch.current[id] ?? 0) + 1
    setDrafts((m) => drop(m, id))
    setSigned((m) => drop(m, id))
    setDecisions((d) => ({ ...d, [id]: { status, owner: owners[id] ?? '', at: new Date().toISOString() } }))
  }

  async function makeRoute() {
    setRouteMsg('Ordering stops with OR-Tools')
    const stops = routable.map((p) => { const c = byId.get(p.cellId)!; return { id: c.id, lat: c.lat, lng: c.lng } })
    const r = await orderStops(stops, stops[0]?.id ?? null)
    if (r.ok) { setRoute({ order: r.data.order, km: r.data.distance_km }); setRouteMsg('') } else { setRoute(null); setRouteMsg(explain(r.error, r.status)) }
  }

  // Codes only: the server allow-lists every field, and free text never reaches the model.
  const spotOf = (p: Proposal) => {
    const c = byId.get(p.cellId)!
    return {
      plus_code: c.plus_code, district: c.district, items: itemsOf(c), n: c.n, recent: recentOf(c),
      treatment: p.treatment, owner_label: owners[p.cellId] || c.owner_hint.owner,
    }
  }

  async function draft(p: Proposal) {
    const e = epoch.current[p.cellId]
    setDrafts((d) => ({ ...d, [p.cellId]: 'Drafting' }))
    setSigned((m) => drop(m, p.cellId))
    const r = await draftNotice(spotOf(p))
    if (epoch.current[p.cellId] !== e) return
    setDrafts((d) => ({ ...d, [p.cellId]: r.ok ? r.data : explain(r.error, r.status) }))
  }

  async function sign(p: Proposal, d: DraftResult) {
    const e = epoch.current[p.cellId]
    setSigned((s) => ({ ...s, [p.cellId]: 'Signing' }))
    const r = await signNotice(spotOf(p), d.sentences)
    if (epoch.current[p.cellId] !== e) return
    setSigned((s) => ({ ...s, [p.cellId]: r.ok ? r.data : explain(r.error, r.status) }))
  }

  function exportWeek() {
    const rows: (string | number)[][] = [['week', 'plus_code', 'street', 'district', 'treatment', 'also', 'owner', 'decision', 'decided_at', 'reasons', 'flags']]
    for (const p of proposals) {
      const c = byId.get(p.cellId)!
      const d = decisions[p.cellId]
      rows.push([week, c.plus_code, c.street, c.district ?? '', TREATMENT_LABEL[p.treatment], p.also.map((t) => TREATMENT_LABEL[t]).join('; '),
        owners[p.cellId] ? OWNER_LABEL[owners[p.cellId] as Exclude<Owner, ''>] : '', d?.status ?? 'open', d?.at ?? '', p.reasons.join('; '), p.flags.join('; ')])
    }
    const url = URL.createObjectURL(new Blob([csv(rows)], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url; a.download = `hotspot-ledger-plan-${week}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  const pteTotal = Object.values(tireLog).reduce((s, t) => s + (t.pte || 0), 0)
  const reimbursable = Object.values(tireLog).reduce((s, t) => s + starReimbursable(t.pte || 0, t.cost || 0), 0)
  const amnesty = earliestAmnesty(today, firstTime)

  return (
    <div className="page">
      <LedgerMap map={data.map} cells={cells} mode="plan" highlightIds={proposals.map((p) => p.cellId)} selectedId={selected} route={routePath} onSelect={(c: Cell | null) => setSelected(c?.id ?? null)} pitch={40} />

      <div className="hud hud-left stack">
        <Frame className="stack" label="This week">
          <span className="lbl-w">Week {week} // plan</span>
          <h1>A short list a person approves.</h1>
          <p className="dim" style={{ fontSize: 12 }}>
            Code ranks active hotspots by recent reports, history and model risk, then picks the least intrusive step that fits.
            Nothing goes out until a staff member approves it and confirms who owns the ground.
          </p>
          <form className="stack" style={{ gap: 4 }} onSubmit={(e) => { e.preventDefault(); setStaffToken(staffInput.trim()); setStaffSet(staffInput.trim() !== ''); setStaffInput('') }}>
            <label className="lbl" htmlFor="staff-token">Staff token (Gemini drafts and photo checks are staff only)</label>
            <div className="row">
              <input id="staff-token" className="field" type="password" autoComplete="off" value={staffInput} onChange={(e) => setStaffInput(e.target.value)} placeholder={staffSet ? 'Set for this tab' : 'Paste token'} style={{ flex: 1 }} />
              <button className="btn" type="submit" disabled={!staffInput.trim()}>Use</button>
              {staffSet && <button className="btn" type="button" onClick={() => { setStaffToken(''); setStaffSet(false) }}>Clear</button>}
            </div>
          </form>
          <label className="between">
            <span className="lbl">Actions this week</span>
            <input type="range" min={3} max={20} value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} aria-label="Actions this week" style={{ width: 140 }} />
            <span className="mono white">{capacity}</span>
          </label>
          <div className="row">
            <button className="btn" onClick={makeRoute} disabled={routable.length < 2}>Order approved stops</button>
            <button className="btn" onClick={exportWeek}>Export week (CSV)</button>
          </div>
          {route && <p className="lbl ok">Route: {route.order.length} stops, {route.km.toFixed(1)} km, ordered by Google OR-Tools</p>}
          {routable.length < 2 && <p className="lbl">Approve at least two cleanup or sign stops to order a route.</p>}
          {routeMsg && <p className="note" role="status">{routeMsg}</p>}
        </Frame>

        <Frame className="stack" label="STAR tire grant">
          <span className="lbl-w">STAR tire grant // evidence log</span>
          <p style={{ fontSize: 12 }}>
            Georgia EPD repays up to ${int(STAR.fiscalYearCap)} a state fiscal year for tire amnesty events and roadside cleanups, for permitted hauling
            and processing at up to ${STAR.perPassengerTireEquivalent.toFixed(2)} per passenger tire equivalent. Never labor.
          </p>
          <label className="row lbl"><input type="checkbox" checked={firstTime} onChange={(e) => setFirstTime(e.target.checked)} /> First application</label>
          <p className="lbl">Earliest amnesty date if applying today: <span className="white">{amnesty.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span></p>
          {tireSpots.length === 0 && <p className="lbl">No tire spots on this week's plan.</p>}
          {tireSpots.map((p) => {
            const c = byId.get(p.cellId)!
            const t = tireLog[p.cellId] ?? { tires: 0, pte: 0, manifest: '', cost: 0 }
            const set = (k: keyof TireLog, v: string) => setTireLog((l) => ({ ...l, [p.cellId]: { ...t, [k]: k === 'manifest' ? v : Number(v) || 0 } }))
            return (
              <div key={p.cellId} className="stack" style={{ gap: 4, borderTop: '1px solid var(--line)', paddingTop: 6 }}>
                <span className="lbl-w">{c.street || 'Unnamed spot'} // {c.plus_code}</span>
                <div className="grid2">
                  <label className="stack lbl" style={{ gap: 2 }}>Tires counted<input className="field" inputMode="numeric" value={t.tires || ''} onChange={(e) => set('tires', e.target.value)} /></label>
                  <label className="stack lbl" style={{ gap: 2 }}>Passenger tire equiv.<input className="field" inputMode="numeric" value={t.pte || ''} onChange={(e) => set('pte', e.target.value)} /></label>
                  <label className="stack lbl" style={{ gap: 2 }}>Carrier manifest no.<input className="field" value={t.manifest} onChange={(e) => set('manifest', e.target.value)} /></label>
                  <label className="stack lbl" style={{ gap: 2 }}>Haul + process cost ($)<input className="field" inputMode="decimal" value={t.cost || ''} onChange={(e) => set('cost', e.target.value)} /></label>
                </div>
                {t.tires > 25 && <p className="note">More than 25 tires: refer to EPD (Rule 391-3-4-.19).</p>}
              </div>
            )
          })}
          <dl className="readout lbl">
            <dt>Logged passenger tire equivalents</dt><dd>{int(pteTotal)}</dd>
            <dt>Reimbursable (capped)</dt><dd>${int(reimbursable)}</dd>
            <dt>Left this fiscal year</dt><dd>${int(Math.max(0, STAR.fiscalYearCap - reimbursable))}</dd>
          </dl>
        </Frame>
        <FieldPhoto />
      </div>

      <div className="hud hud-right stack" style={{ width: 400 }}>
        <Frame className="stack" label="Proposals">
          <div className="between"><span className="lbl-w">Proposals</span><span className="lbl">{approved.length} approved / {proposals.length}</span></div>
          <ol className="list">
            {proposals.map((p, i) => {
              const c = byId.get(p.cellId)!
              const d = decisions[p.cellId]
              const owner = owners[p.cellId] ?? ''
              const draftState = drafts[p.cellId]
              const signState = signed[p.cellId]
              return (
                <li key={p.cellId} style={{ padding: '8px 0' }} aria-current={selected === p.cellId}>
                  <div className="between">
                    <button className="btn" style={{ border: 0, padding: 0, height: 'auto' }} onClick={() => setSelected(p.cellId)}>
                      <span className="lbl">{String(i + 1).padStart(2, '0')}</span>
                      <span className="white" style={{ textTransform: 'none', fontFamily: 'var(--font-sans)', fontSize: 13 }}>{c.street || 'Unnamed spot'}</span>
                    </button>
                    <span className="lbl">{d ? d.status : 'open'}</span>
                  </div>
                  <p style={{ fontSize: 13, margin: '4px 0' }} className="white">{TREATMENT_LABEL[p.treatment]}</p>
                  {p.also.length > 0 && <p className="lbl">Also: {p.also.map((t) => TREATMENT_LABEL[t]).join(' / ')}</p>}
                  <p className="dim" style={{ fontSize: 12 }}>{p.reasons.join('. ')}.</p>
                  {p.flags.map((f) => <p key={f} className="note" style={{ margin: '4px 0' }}>{f}</p>)}
                  <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                    <select className="sel" aria-label={`Who owns the ground at ${c.plus_code}`} value={owner} onChange={(e) => setOwners((o) => ({ ...o, [p.cellId]: e.target.value as Owner }))}>
                      <option value="">Owner?</option>
                      {(Object.keys(OWNER_LABEL) as Exclude<Owner, ''>[]).map((k) => <option key={k} value={k}>{OWNER_LABEL[k]}</option>)}
                    </select>
                    <button className="btn solid" onClick={() => decide(p.cellId, 'approved')} disabled={!owner} title={owner ? '' : 'Confirm who owns the ground first'}>Approve</button>
                    <button className="btn" onClick={() => decide(p.cellId, 'deferred')}>Defer</button>
                    <button className="btn" onClick={() => decide(p.cellId, 'rejected')}>Reject</button>
                    {d?.status === 'approved' && <button className="btn" onClick={() => draft(p)} disabled={draftState === 'Drafting'}>Draft notice EN / ES</button>}
                  </div>
                  {typeof draftState === 'string' && draftState !== 'Drafting' && <p className="note" role="status">{draftState}</p>}
                  {draftState && typeof draftState === 'object' && (
                    <div className="grid2" style={{ marginTop: 6 }}>
                      <div><span className="lbl">English (draft)</span><p style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{draftState.en}</p></div>
                      <div><span className="lbl">Español (borrador)</span><p style={{ fontSize: 12, whiteSpace: 'pre-wrap' }} lang="es">{draftState.es}</p></div>
                    </div>
                  )}
                  {d?.status === 'approved' && draftState && typeof draftState === 'object' && (
                    <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                      {!(signState && typeof signState === 'object') && (
                        <button className="btn" onClick={() => sign(p, draftState)} disabled={signState === 'Signing'}>Approve text and sign</button>
                      )}
                      {signState && typeof signState === 'object' && (
                        <>
                          <a className="btn solid" href={`#/print/${signState.token}`} target="_blank" rel="noopener">Print signed notice</a>
                          <a className="btn" href={`#/v/${signState.token}`} target="_blank" rel="noopener">Check link</a>
                        </>
                      )}
                    </div>
                  )}
                  {typeof signState === 'string' && signState !== 'Signing' && <p className="note" role="status">{signState}</p>}
                </li>
              )
            })}
          </ol>
          <p className="lbl">Decisions are kept in this browser for week {week}. In a pilot they go to the city's own records.</p>
        </Frame>
      </div>
    </div>
  )
}
