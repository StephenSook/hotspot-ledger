import { useState } from 'react'
import LedgerMap from '../components/LedgerMap'
import { Frame, Reveal } from '../components/hud'
import type { LedgerData, ModelEval } from '../data/types'
import { int, pct } from '../lib/format'

type Row = { label: string; lo: number; hi: number; ours?: boolean; dashed?: boolean }

function rows(ev: Pick<ModelEval, 'baselines' | 'models'>): Row[] {
  const b = ev.baselines
  return [
    { label: 'Random', lo: 0.3, hi: 0.3, dashed: true },
    { label: 'Dead ends', lo: b.dead_ends.capture30, hi: b.dead_ends.capture30 },
    { label: 'Major road', lo: b.near_major_road.capture30, hi: b.near_major_road.capture30 },
    { label: 'Road density', lo: b.road_density.capture30, hi: b.road_density.capture30 },
    { label: 'Old-spot rule', lo: b.near_old_hotspots.capture30, hi: b.near_old_hotspots.capture30 },
    { label: 'Model, map', lo: ev.models.map_only.min, hi: ev.models.map_only.max, ours: true },
    { label: 'Model + old spots', lo: ev.models.map_plus_old_spots.min, hi: ev.models.map_plus_old_spots.max, ours: true },
  ]
}

function EvalChart({ ev, nulls }: { ev: Pick<ModelEval, 'baselines' | 'models'>; nulls: ModelEval['nulls'] }) {
  const data = rows(ev)
  const W = 300, L = 112, H = data.length * 24 + 26
  const x = (v: number) => L + v * (W - L - 44)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Share of new dumping spots caught in each method's top 30 percent">
      {nulls && (
        <g>
          <rect x={x(nulls.min)} y={4} width={Math.max(1, x(nulls.max) - x(nulls.min))} height={H - 22} fill="rgba(255,255,255,0.06)" />
          <text x={x(nulls.max) + 3} y={H - 6} fontSize="8" fill="#7a7a7a" fontFamily="Geist Mono">shuffled labels</text>
        </g>
      )}
      {data.map((r, i) => {
        const y = 10 + i * 24
        const mid = (r.lo + r.hi) / 2
        return (
          <g key={r.label}>
            <text x={0} y={y + 9} fontSize="9.5" fill={r.ours ? '#ffffff' : '#afafaf'} fontFamily="Geist Mono">{r.label.toUpperCase()}</text>
            <rect x={L} y={y} width={Math.max(1, x(mid) - L)} height={11} fill={r.ours ? '#e8271c' : r.dashed ? 'none' : '#6e6e6e'} stroke={r.dashed ? '#afafaf' : 'none'} strokeDasharray={r.dashed ? '3 2' : undefined} />
            {r.hi > r.lo && <line x1={x(r.lo)} x2={x(r.hi)} y1={y + 5.5} y2={y + 5.5} stroke="#ffffff" strokeWidth="1.4" />}
            <text x={x(r.hi) + 4} y={y + 9} fontSize="9.5" fill="#ffffff" fontFamily="Geist Mono">
              {r.hi > r.lo ? `${Math.round(r.lo * 100)}-${Math.round(r.hi * 100)}%` : `${Math.round(mid * 100)}%`}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export default function WhereNext({ data }: { data: LedgerData }) {
  const { model, metrics: m } = data
  const [noTop, setNoTop] = useState(false)
  const ev = noTop && model.without_top_account ? model.without_top_account : model
  const eq = Object.entries(m.equity)
  const maxShare = Math.max(...eq.map(([, v]) => Math.max(v.reported_share, v.flagged_share)), 0.01)

  return (
    <div className="page">
      <LedgerMap map={data.map} cells={data.cells} risk={data.risk} mode="next" pitch={35} />
      <div className="hud hud-left stack">
        <Frame className="stack" label="Where next">
          <Reveal>
            <span className="lbl-w">Where next</span>
            <h1>Red dots are places with no report yet that look like the places that have them.</h1>
            <p className="dim" style={{ fontSize: 13 }}>
              A random forest from Google's Yggdrasil Decision Forests learns from roads, dead ends, rail, streams,
              streetlight outages and tract income and renter share. Grey dots are spots already reported.
            </p>
          </Reveal>
        </Frame>
        <Frame className="stack" label="Test on 2026">
          <div className="between">
            <span className="lbl-w">The test</span>
            <span className="lbl">Train {model.train_years} / test {model.test_year}</span>
          </div>
          <p style={{ fontSize: 12 }}>
            Trained only on {model.train_years}, then asked to rank the {int(ev.eligible)} places with no dumping yet.
            Below: the share of the {int(ev.new_cells)} places that first got dumping in {model.test_year} that landed in each method's top 30%.
          </p>
          <EvalChart ev={ev} nulls={ev.nulls} />
          <button className="btn" aria-pressed={noTop} onClick={() => setNoTop((v) => !v)} disabled={!model.without_top_account}>
            {noTop ? 'Back to all accounts' : 'Rerun without the most active account'}
          </button>
          <p className="dim" style={{ fontSize: 11 }}>
            {noTop
              ? `Only ${ev.new_cells} new places without that account, so the signal is weaker and noisier. We say so.`
              : `Ranges are ${model.seeds.length} runs with different random seeds. ${model.null_runs} runs on shuffled labels scored ${pct(ev.nulls?.min)} to ${pct(ev.nulls?.max)}.`}
          </p>
        </Frame>
      </div>
      <div className="hud hud-right stack">
        <Frame className="stack" label="Equity">
          <span className="lbl-w">Quiet is not clean</span>
          <p style={{ fontSize: 12 }}>
            Share of reported spots against share of flagged, unreported places, by council district. Where the second bar is
            longer, reports are quieter than the ground suggests.
          </p>
          <table className="t">
            <thead><tr><th>District</th><th>Reported</th><th>Flagged</th></tr></thead>
            <tbody>
              {eq.map(([d, v]) => (
                <tr key={d}>
                  <td>{d}</td>
                  <td>
                    <div className="row"><span className="track" style={{ width: 70, height: 6, background: '#141414', position: 'relative' }}><span style={{ position: 'absolute', inset: 0, width: `${(v.reported_share / maxShare) * 100}%`, background: '#c8c8c8' }} /></span><span className="mono">{pct(v.reported_share, 1)}</span></div>
                  </td>
                  <td>
                    <div className="row"><span className="track" style={{ width: 70, height: 6, background: '#141414', position: 'relative' }}><span style={{ position: 'absolute', inset: 0, width: `${(v.flagged_share / maxShare) * 100}%`, background: '#e8271c' }} /></span><span className="mono">{pct(v.flagged_share, 1)}</span></div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">These are model flags, not observed dumping. The plan sends a person to look before anything else happens.</p>
        </Frame>
      </div>
    </div>
  )
}
