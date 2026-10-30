import { Frame, Reveal } from '../components/hud'
import type { LedgerData } from '../data/types'
import { dateLabel, int, pct } from '../lib/format'

const REPO = 'https://github.com/StephenSook/hotspot-ledger'

export default function Evidence({ data }: { data: LedgerData }) {
  const { metrics: m, model, meta } = data
  const best = model.models.map_plus_old_spots
  const rr = m.return_rates
  return (
    <div className="page-scroll">
      <div style={{ maxWidth: 1080, margin: '0 auto' }} className="stack">
        <Reveal>
          <span className="lbl-w">Evidence</span>
          <h1>Every number on this site, and where it came from.</h1>
          <p className="dim">Data refreshed {dateLabel(meta.generated_at)}. Code, tests and the pipeline: <a href={REPO}>{REPO.replace('https://', '')}</a>.</p>
        </Reveal>

        <div className="grid2" style={{ gap: 14 }}>
          <Frame className="stack" label="Numbers">
            <span className="lbl-w">The numbers</span>
            <table className="t">
              <thead><tr><th>Claim</th><th>Value</th><th>How</th></tr></thead>
              <tbody>
                <tr><td>Dumping reports inside today's city limits</td><td className="num">{int(m.dumping_reports)}</td><td>"Debris on Shoulder" plus "Litter|Graffiti", {m.window}, clipped to Cobb County's official city-limit polygon</td></tr>
                <tr><td>Share of all reports in the city</td><td className="num">{pct(m.dumping_share, 1)}</td><td>of {int(m.reports_total_in_city)} reports of any type</td></tr>
                <tr><td>Recurring spots</td><td className="num">{int(m.hotspots)}</td><td>~150 m cells with 3 or more reports; they hold {pct(m.hotspot_report_share, 1)} of reports</td></tr>
                <tr><td>Median time to close</td><td className="num">{m.median_close_days} d</td><td>created to closed, closed reports only</td></tr>
                <tr><td>Return within 4 / 8 / 12 weeks</td><td className="num">{pct(rr['28'].share)} / {pct(rr['56'].share)} / {pct(rr['84'].share)}</td><td>share of closed reports followed by a new report in the same cell; a new report can also mean the pile was not fully removed</td></tr>
                <tr><td>Places with dumping, estimated</td><td className="num">~{int(m.capture_recapture.estimate)}</td><td>two-source capture-recapture (Chapman), {m.capture_recapture.years}, 95% CI {int(m.capture_recapture.ci95[0])} to {int(m.capture_recapture.ci95[1])}, against {int(m.capture_recapture.seen)} reported. {m.capture_recapture.note}</td></tr>
                <tr><td>Filed by one account</td><td className="num">{pct(m.top_account_share, 1)}</td><td>computed from hashed IDs inside the pipeline; no ID, name or hash is ever published</td></tr>
                <tr><td>Where-next model</td><td className="num">{pct(best.min)} to {pct(best.max)}</td><td>share of the {model.new_cells} cells first reported in {model.test_year} that landed in the model's top 30%, trained on {model.train_years} only ({model.seeds.length} seeds; random picking 30%; near old hotspots {pct(model.baselines.near_old_hotspots.capture30)}; shuffled labels {pct(model.nulls?.min)} to {pct(model.nulls?.max)})</td></tr>
              </tbody>
            </table>
          </Frame>

          <div className="stack" style={{ gap: 14 }}>
            <Frame className="stack" label="Method">
              <span className="lbl-w">How the model is tested</span>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13 }} className="stack">
                <li>Temporal holdout: nothing from {model.test_year} is used for training.</li>
                <li>Spatial cross-fitting: no cell is scored by a model that saw it.</li>
                <li>Baselines: random, single features, and the simple rule "near old hotspots".</li>
                <li>Shuffled-label nulls: the same model on scrambled labels, to show what luck looks like.</li>
                <li>Stress test: rerun without the most active account. Weaker on a small sample, and we say so.</li>
              </ul>
            </Frame>
            <Frame className="stack" label="Georgia rules">
              <span className="lbl-w">Georgia rules built into the plan</span>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13 }} className="stack">
                <li>STAR scrap tire grant (Georgia EPD): up to $150,000 per state fiscal year since Sept 1 2026, permitted hauling and processing only, up to $4.00 per passenger tire equivalent, 90 days' notice.</li>
                <li>More than 25 stored scrap tires is a state violation (Rule 391-3-4-.19): the plan flags it for referral to EPD.</li>
                <li>Dumping for profit is egregious litter at any size (O.C.G.A. 16-7-51): construction-debris spots get a commercial-dumping check.</li>
              </ul>
            </Frame>
          </div>
        </div>

        <div className="grid2" style={{ gap: 14 }}>
          <Frame className="stack" label="Privacy">
            <span className="lbl-w">Privacy and safety rules the code enforces</span>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13 }} className="stack">
              <li>{meta.privacy} A test fails the build if anything identifying reaches a public file.</li>
              <li>Street names come from OpenStreetMap, never from report text. Reporter IDs become keyed pseudonyms inside the pipeline and never leave it.</li>
              <li>No license-plate reading anywhere. The camera page sees people and vehicles as boxes, on the device.</li>
              <li>Field photos are face-blurred on the device before they leave it.</li>
              <li>Gemini runs only behind staff actions on free-tier terms, which bar services likely used by people under 18.</li>
              <li>Notices and plans are drafts until a person approves them, and nothing is approved until the owner of the ground is confirmed.</li>
            </ul>
          </Frame>
          <Frame className="stack" label="Sources">
            <span className="lbl-w">Sources and licenses</span>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13 }} className="stack">
              {meta.sources.map((s) => <li key={s.name}>{s.name}: {s.license}{s.credit ? `, credit ${s.credit}` : ''}</li>)}
              <li>Space-time cube idea: Tube by Amani Bobo (Hacklanta 2026), rebuilt from scratch with credit.</li>
              <li>Fonts: Geist and Geist Mono, SIL Open Font License.</li>
            </ul>
          </Frame>
        </div>

        <Frame className="stack" label="Limits">
          <span className="lbl-w">Limits we say out loud</span>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13 }} className="stack">
            <li>{model.new_cells} test cells is a small sample.</li>
            <li>Complaint data measures who reports as well as where dumping happens. That is why the plan also looks where reports are quiet.</li>
            <li>SeeClickFix asks to be contacted before large-scale reuse. The pipeline fetches incrementally; a city pilot should get Cobb County's records directly.</li>
            <li>The owner hint only knows state routes. Everything else needs a person to confirm whether it is a city, county or private parcel.</li>
          </ul>
        </Frame>
      </div>
    </div>
  )
}
