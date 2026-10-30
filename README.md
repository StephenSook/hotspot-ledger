# Hotspot Ledger

**See where illegal dumping keeps coming back in Mableton, Georgia, where it is likely next, and turn that into a short weekly plan a person approves.**

Built for the Georgia 311 Challenge 2026 (Track 3, Tiny Desk, Civic Style) by Stephen Sookra, Khadim Drame and Chris, GDG on Campus at Kennesaw State University.

- **Live app:** https://hotspot-ledger-web.vercel.app
- **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## What it measures, on the city's own public data

| | |
|---|---|
| Dumping reports inside today's city limits since 2021 | **1,841** (Cobb County SeeClickFix, clipped to the official city polygon) |
| Recurring spots (3+ reports in a ~150 m cell) | **187**, holding about 70% of reports |
| Closed reports followed by a new report at the same spot within 12 weeks | **30%** |
| Places with dumping, estimated by capture-recapture | **~1,256**, against 571 reported from 2021 to 2025 |
| Where-next model, trained 2021-2025, tested on 2026's new spots | **77 to 85%** of new spots in its top 30% (random 30%, "near old hotspots" 68%, shuffled labels 25 to 51%) |

Every number is recomputed by the pipeline and shown with its method on the app's Evidence page.

## How it works

```
pipeline/  Python 3.12 + uv      public SeeClickFix reports -> clip to city -> ~150 m cells
                                 -> metrics -> YDF where-next model -> aggregate JSON only
web/       Vite + React + TS     deck.gl 3D map with no third-party tiles, five pages:
                                 Ledger, Where next, Plan, Camera, Evidence
api/       Vercel functions      route.py (Google OR-Tools stop order)
                                 draft.ts (Gemini notice drafts, staff only)
                                 classify.ts (Gemini pile check on a face-blurred photo, staff only)
```

Google technology: Yggdrasil Decision Forests, MediaPipe Tasks, Gemini API, OR-Tools, Data Commons, Plus Codes.

## Run it

```bash
# pipeline (needs the private report cache in pipeline/cache, or run with --fetch)
cd pipeline && uv sync --group dev && uv run python -m hotspot.cli && uv run pytest -q

# web
cd web && pnpm install && pnpm dev          # http://localhost:5173
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e

# api (from the repo root)
uv run --with pytest --with-requirements requirements.txt pytest -q api/_tests
```

Staff features (Gemini drafts and the photo check) need two server environment variables: `STAFF_TOKEN`, a shared secret staff type into the Plan page, and `GEMINI_API_KEY` (a free Google AI Studio key from a project with **no billing**) Without them those two functions answer `503` (`staff_auth_not_configured` or `gemini_not_configured`) and the app says so; everything else works.

## Privacy and data rules

- Public data only. Published files are aggregates: no report text, no addresses, no reporter identifiers, no photos. A test fails the build otherwise.
- Spots sit at the center of a ~150 m cell, never at a report's location. Spots with fewer than 3 reports publish only a count. Street names come from OpenStreetMap, never from report text.
- Reporter IDs become keyed pseudonyms inside the pipeline and never leave it. Raw reports stay in the gitignored local cache; there is no scheduled refresh in CI.
- No license-plate reading anywhere. The camera page runs on the device and sees people and vehicles as boxes.
- Field photos are face-blurred on the device before they leave it.
- Gemini is used only behind staff actions, because free-tier terms bar services likely to be used by people under 18.
- Nothing is approved until a person confirms who owns the ground.

## Data and credits

- SeeClickFix API v2 (Cobb County queue), CC BY-NC-SA 3.0 US, credit seeclickfix.com. Derived data in `web/public/data` is shared under the same license.
- OpenStreetMap contributors, ODbL. Cobb County GIS (city limit, council districts). ACS via Google Data Commons.
- Space-time cube idea: Tube by Amani Bobo (Hacklanta 2026), rebuilt from scratch with credit.
- Interface style inspired by a HUD-style designer portfolio; all code here is our own. Fonts: Geist and Geist Mono (SIL OFL).

## License

Code: Apache-2.0 (see [LICENSE](LICENSE)). Data in `web/public/data`: CC BY-NC-SA 3.0 US, following the source license.
