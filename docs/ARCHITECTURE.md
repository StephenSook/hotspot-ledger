# Hotspot Ledger: architecture

Illegal-dumping prevention and resource allocation for the City of Mableton, Georgia.
Georgia 311 Challenge 2026, Track 3 (Tiny Desk, Civic Style).

This file is the single source of truth for how the system is built. The README, the team
learning guides and the pitch must agree with it.

## One sentence

A nightly Python pipeline turns Cobb County's public SeeClickFix reports into a measured ledger of
where dumping keeps coming back and where it is likely next; a static web app shows that ledger in
3D and turns it into a weekly plan a staff member approves; small serverless functions handle the
two jobs that need a server (route ordering and Gemini drafting), and nothing identifies a person.

## System map

```
                 GitHub Actions (nightly + on push)                      Vercel (free Hobby plan)
 ┌──────────────────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
 │ pipeline/  (Python 3.12, uv)                          │   │ web/  (Vite + React + TypeScript)         │
 │  1 fetch    SeeClickFix API v2, 20 req/min, cached    │   │  deck.gl 3D map, no third-party tiles     │
 │  2 clip     official city-limit polygon (Cobb GIS)    │   │  pages: Ledger, Where next, Plan,         │
 │  3 cells    ~150 m grid, hotspots, item mix (text)    │──▶│         Camera, Evidence                  │
 │  4 metrics  yearly counts, return rates, districts,   │   │  reads web/public/data/*.json             │
 │             capture-recapture, top-account share      │   │  MediaPipe Tasks (in the browser):        │
 │  5 model    YDF random forest, temporal holdout,      │   │    face blur, object detection            │
 │             baselines, shuffled-label nulls, scores   │   ├──────────────────────────────────────────┤
 │  6 export   aggregate JSON only (no text, no IDs)     │   │ api/ serverless functions                 │
 │  7 tests    pytest guards: no reporter IDs, no text   │   │  route.py   Google OR-Tools stop order    │
 └──────────────────────────────────────────────────────┘   │  draft.ts   Gemini notice drafts (staff)  │
                                                            │  classify.ts Gemini item check (staff)    │
                                                            └──────────────────────────────────────────┘
```

## Data flow, step by step

1. **Fetch.** `pipeline/fetch_scf.py` pages through `https://seeclickfix.com/api/v2/issues` for the
   city's bounding box, at most 20 requests a minute, with a User-Agent that names the project.
   Every response is content-checked (JSON with an `issues` array) so an error page can never be
   saved as data. Reporter IDs are replaced by a salted hash the moment they arrive.
2. **Clip.** Point-in-polygon against Cobb County's official Mableton city-limit polygon. The
   SeeClickFix "Mableton" place tag misses about 35% of in-city reports, so it is never used.
3. **Cells.** Each report goes into a ~150 m grid cell (0.00135° latitude × 0.0016° longitude).
   A hotspot is a cell with 3 or more dumping-type reports since 2021. Dumping-type means the
   request types "Debris on Shoulder" and "Litter|Graffiti".
4. **Metrics.** Reports per year; per council district; return rate (share of closed reports
   followed by a new report in the same cell within 28, 56 and 84 days); capture-recapture
   estimate of unreported dumping places (Chapman, top account vs everyone else); the share filed
   by the single most active account (computed from hashes, never published per account).
5. **Model.** Yggdrasil Decision Forests (Google, the engine behind TensorFlow Decision Forests),
   positive-unlabeled random forest. Features: distance to major roads, tertiary roads, rail and
   streams; road and service-road density; dead ends; streetlight-outage reports; tract income and
   renter share (ACS via Google Data Commons); distance to the nearest other past dumping cell.
   Trained on 2021-2025 only, tested on the cells that first got a dumping report in 2026, with
   spatial cross-fitting, single-feature baselines and shuffled-label nulls.
6. **Export.** Only aggregates leave the pipeline: cell centroids and counts, metrics, model
   evaluation and per-cell scores. No report text, no addresses, no reporter IDs, no photos.
7. **Serve.** The web app loads the JSON and draws everything client-side.

## Front end

- **Vite + React + TypeScript.** Static build, served by Vercel.
- **deck.gl** draws the city boundary, council districts and roads (OpenStreetMap, ODbL) as thin
  lines on black, with no third-party map tiles, so no key, no quota and no outage risk. Hotspots
  are 3D columns extruded by report count; the where-next risk layer is a halftone dot grid.
- **Design system** (inspired by a HUD-style portfolio, rebuilt from scratch): black ground,
  `#c8c8c8` text, `#e8271c` signal red, a fixed 28 px bottom bar with section links and a live
  Mableton clock, 10 px uppercase labels with tight tracking, corner-bracket frames, a light film
  grain, and a blur-in line reveal. Fonts: Geist and Geist Mono (SIL Open Font License).
- **Pages**
  - **Ledger:** the 3D map, the toggle that hides the single most active account, the year
    scrubber, top spots, and the measured numbers.
  - **Where next:** the risk layer, the evaluation chart with every baseline, equity by district.
  - **Plan:** the weekly plan from the treatment ladder, approve / defer / reject, owner tag,
    route order, bilingual notice drafts, STAR tire-grant evidence log and 90-day calendar.
  - **Camera:** the space-time cube for reviewing a clip, with the left-behind signature.
  - **Evidence:** sources, licenses, privacy rules, method notes, every number's origin.

## Serverless functions (Vercel)

| Function | Does | Needs |
|---|---|---|
| `api/route.py` | Orders a crew's stops with Google OR-Tools (traveling-salesman on haversine distances) | nothing |
| `api/draft.ts` | Drafts an English and Spanish notice for an approved spot with `gemini-3.8-flash`, from aggregate facts only | `GEMINI_API_KEY` (free tier, project with no billing) |
| `api/classify.ts` | Classifies a face-blurred field photo into tires / furniture / bags / construction with `gemini-3.5-flash-lite` | `GEMINI_API_KEY` |

When the key is missing the functions answer `503 {"error":"gemini_not_configured"}` and the UI
says so plainly. Nothing is faked.

## Rules the code enforces

| Rule | Where |
|---|---|
| Public data only | pipeline fetches only public APIs |
| No personal data in public output | pytest guard fails the build if an export contains a reporter hash, description text or an address |
| No resident ever talks to free-tier Gemini | Gemini calls exist only behind staff actions; text sent is aggregate facts; photos are face-blurred on device first |
| Human in the loop | Notices and plans are drafts until a person approves them |
| No license-plate reading | no LPR code exists; the camera page detects objects and people as boxes only |
| Credit sources | SeeClickFix (CC BY-NC-SA 3.0 US), OpenStreetMap contributors (ODbL), Cobb County GIS, ACS via Google Data Commons |

## Google technology used

Yggdrasil Decision Forests, MediaPipe Tasks (face detector, object detector), Gemini API
(`gemini-3.8-flash`, `gemini-3.5-flash-lite`), Google OR-Tools, Google Data Commons, Plus Codes
(Open Location Code) on every spot.

## Testing and CI (GitHub Actions)

- `pipeline`: ruff, pytest (privacy guards, schema, metric sanity, model must beat the
  near-old-hotspots baseline on the holdout).
- `web`: eslint, `tsc --noEmit`, vitest (planner rules, formatting), `vite build`,
  Playwright end-to-end with an axe accessibility scan on every page.
- `deployed`: a smoke test against the live URL after each deploy.

## Known limits (said out loud)

- 53 test cells is a small sample; without the most active account the model signal is weaker.
- SeeClickFix asks to be contacted before large-scale reuse; the pipeline fetches incrementally and
  caches, and a city pilot should get Cobb County's data directly.
- Resident photos on SeeClickFix are never republished; field photos in the demo are our own.
- The camera page needs footage; the dumping benchmark (MIVIA-IWDD-500) has no published license
  yet, so its clips are not shown publicly.
