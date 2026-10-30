import { useEffect, useMemo, useState } from 'react'
import LedgerMap from '../components/LedgerMap'
import { cellCount } from '../lib/cells'
import { Frame, HBar, Reveal, Stat } from '../components/hud'
import SpotFile from '../components/SpotFile'
import type { Cell, LedgerData } from '../data/types'
import { int, pct } from '../lib/format'

export default function Ledger({ data, onAddToPlan, pinned }: { data: LedgerData; onAddToPlan: (id: string) => void; pinned: string[] }) {
  const { metrics: m, cells, map } = data
  const years = Object.keys(m.yearly).map(Number)
  const lastYear = years[years.length - 1]
  const [hideTop, setHideTop] = useState(false)
  const [through, setThrough] = useState<number>(lastYear)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState<Cell | null>(null)

  useEffect(() => {
    if (!playing) return
    const t = window.setInterval(() => {
      setThrough((y) => {
        if (y >= lastYear) {
          setPlaying(false)
          return lastYear
        }
        return y + 1
      })
    }, 900)
    return () => window.clearInterval(t)
  }, [playing, lastYear])

  const ranked = useMemo(
    () => cells
      .map((c) => ({ c, v: cellCount(c, hideTop, through) }))
      .filter((d) => d.v >= 3)
      .sort((a, b) => b.v - a.v),
    [cells, hideTop, through],
  )
  const shown = ranked.reduce((s, d) => s + d.v, 0)
  const total = cells.reduce((s, c) => s + cellCount(c, hideTop, through), 0)
  const yearly = hideTop ? m.yearly_without_top_account : m.yearly
  const maxYear = Math.max(...Object.values(m.yearly))
  const r84 = m.return_rates['84']
  const cr = m.capture_recapture

  return (
    <div className="page">
      <LedgerMap map={map} cells={cells} mode="ledger" hideTop={hideTop} throughYear={through} selectedId={selected?.id} onSelect={setSelected} />

      <div className="hud hud-left stack">
        <Frame className="stack" label="Summary">
          <Reveal>
            <span className="lbl-w">Hotspot Ledger</span>
            <span className="lbl">City of Mableton, Georgia // Illegal dumping</span>
            <h1>Dumping keeps coming back to the same {int(m.hotspots)} places.</h1>
            <p className="dim" style={{ fontSize: 13 }}>
              Every column is a ~150 m spot, as tall as its public 311 reports since 2021. Drag to orbit. Click a column.
            </p>
          </Reveal>
        </Frame>
        <Frame className="stack" label="Measured">
          <span className="lbl slashes">Measured from Cobb County's public SeeClickFix data</span>
          <div className="grid2">
            <Stat value={int(m.dumping_reports)} label="dumping reports inside today's city limits since 2021" />
            <Stat value={`${m.median_close_days} d`} label="median time to close one" />
            <Stat value={pct(r84.share)} label="of closed reports see dumping return to the same spot within 12 weeks" red />
            <Stat value={`~${int(cr.estimate)}`} label={`places with dumping, estimated, against ${int(cr.seen)} with a report from ${cr.years.replace('-', ' to ')}`} />
          </div>
        </Frame>
        <Frame className="stack" label="Reporting bias">
          <div className="between">
            <span className="lbl">One account filed</span>
            <span className="white mono">{pct(m.top_account_share, 1)}</span>
          </div>
          <button className="btn" aria-pressed={hideTop} onClick={() => setHideTop((v) => !v)}>
            {hideTop ? 'Show every account' : 'Hide the most active account'}
          </button>
          <p className="dim" style={{ fontSize: 12 }}>
            {hideTop
              ? 'Most columns shrink. A complaint map is mostly a map of who reports, which is why the plan also looks where reports are quiet.'
              : 'We never name or map a reporter. This share comes from hashed account IDs.'}
          </p>
        </Frame>
        <Frame className="stack" label="By year">
          <div className="between">
            <span className="lbl">Dumping reports per year</span>
            <button className="btn" onClick={() => { setThrough(years[0]); setPlaying(true) }} disabled={playing}>
              {playing ? 'Playing' : 'Play 2021 to now'}
            </button>
          </div>
          {years.map((y) => (
            <HBar key={y} label={y === lastYear ? `${y} so far` : String(y)} value={yearly[String(y)]} max={maxYear} text={int(yearly[String(y)])} red={y === through} />
          ))}
          <label className="stack" style={{ gap: 4 }}>
            <span className="lbl">Show reports through {through}</span>
            <input type="range" min={years[0]} max={lastYear} step={1} value={through} onChange={(e) => { setPlaying(false); setThrough(Number(e.target.value)) }} />
          </label>
        </Frame>
      </div>

      <div className="hud hud-right stack">
        {selected ? (
          <SpotFile cell={selected} cells={cells} onClose={() => setSelected(null)} onAddToPlan={onAddToPlan} pinned={pinned.includes(selected.id)} />
        ) : (
          <Frame className="stack" label="Most reported spots">
            <div className="between">
              <span className="lbl-w">Most reported spots</span>
              <span className="lbl">[{ranked.length}] in total</span>
            </div>
            <span className="lbl">{pct(total ? shown / total : 0)} of the reports shown sit on these spots</span>
            <ol className="list">
              {ranked.slice(0, 14).map((d, i) => (
                <li key={d.c.id}>
                  <button className="rowbtn" onClick={() => setSelected(d.c)}>
                    <span className="lbl">{String(i + 1).padStart(2, '0')}</span>
                    <span>{d.c.street || 'Unnamed spot'} <span className="lbl">D{d.c.district ?? '?'}</span></span>
                    <span className="n">{d.v}</span>
                  </button>
                </li>
              ))}
            </ol>
          </Frame>
        )}
      </div>
    </div>
  )
}
