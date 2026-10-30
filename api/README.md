# api/: serverless functions

Three Vercel functions. All take `POST` with `Content-Type: application/json` and answer JSON.
Every error is `{"error": "..."}` with a matching HTTP status. Responses carry `Cache-Control: no-store`.

| Function | Runtime | Needs | Calls |
|---|---|---|---|
| `route.py` | Python 3.12 | nothing | Google OR-Tools, locally |
| `draft.ts` | Node.js | `STAFF_TOKEN`, `GEMINI_API_KEY` | Gemini `gemini-3.8-flash` |
| `classify.ts` | Node.js | `STAFF_TOKEN`, `GEMINI_API_KEY` | Gemini `gemini-3.5-flash-lite` |

Files and folders starting with `_` are never deployed as functions (Vercel rule), so shared code
lives in `_lib/` and tests in `_tests/`.

## POST /api/route

Orders a crew's stops as an open path (starts at `start_id`, or the first stop, and does not return),
minimising great-circle distance. OR-Tools routing, guided local search, 2 second limit.

```json
{"stops": [{"id": "25052_-52864", "lat": 33.820056, "lng": -84.582258}, {"id": "25051_-52864", "lat": 33.818992, "lng": -84.582179}], "start_id": null}
```

Answer: `{"order": ["25052_-52864", "25051_-52864"], "distance_km": 0.119, "solver": "ortools"}`

Rules: 2 to 25 stops; ids are 1 to 64 characters of `A-Z a-z 0-9 _ . : + -` and unique; `lat` 33.6 to
34.0, `lng` -84.8 to -84.3 (numbers, not strings); no other keys; body at most 8 KB.
Errors: `400` bad input, `405` not POST, `500 {"error":"solver_failed"}`.

## POST /api/draft (staff only)

Drafts a short neighbor notice in English and Spanish for one spot, from aggregate facts only.

```json
{"spot": {"plus_code": "865QRCC9+23", "district": "5", "items": {"tires": 11, "furniture": 9, "appliances": 3, "bags": 14, "construction": 1}, "n": 57, "last": "2026-10-25", "treatment": "sign_qr", "owner_label": "Local road or private parcel: confirm the owner"}}
```

Answer: `{"en": "...", "es": "...", "model": "gemini-3.8-flash", "drafted_at": "2026-10-30T14:00:00.000Z", "status": "draft"}`

- The notice is a draft. A staff member approves it before anything is posted.
- Location is given only as the Plus Code and council district. `owner_label` is validated but is not
  sent to Gemini, because it can name a road.
- The bulk-pickup tip is added when furniture plus appliances is the largest item group; the tire
  amnesty tip when tires are. Ties add both.
- Known treatment codes from the planner (`sign_qr`, `close_access`, `bulk_outreach`, `tire_play`,
  `commercial_check`, `cleanup`, `camera`) are turned into plain sentences; other text is passed as written.
- Input rules: all seven keys, no others; strings 1 to 100 characters with no control characters;
  `plus_code` a full Plus Code; `district` a string or `null`; item counts and `n` integers 0 to 10000;
  `last` a real `YYYY-MM-DD` date; body at most 4 KB.

## POST /api/classify (staff only)

Says which kinds of dumped items are in one field photo. The browser blurs faces before upload.

```json
{"image": "data:image/jpeg;base64,/9j/4AAQ..."}
```

Answer: `{"items": ["tires", "bags"], "tire_count_estimate": 6, "is_dumping_likely": true, "notes": "...", "model": "gemini-3.5-flash-lite", "classified_at": "..."}`

- `image/jpeg`, `image/png` or `image/webp` only, at most 1.5 MB decoded. The file signature must match
  the declared type.
- `items` uses only `tires`, `furniture`, `appliances`, `bags`, `construction`, `other`.
- `notes` is capped at 140 characters, and dropped entirely if it mentions a person.
- The image is never logged or stored.

## Staff-only access (draft and classify)

Gemini runs only behind staff actions, and the server enforces that, not just the UI.

Checks, in this order:

| Step | Answer when it fails |
|---|---|
| Method is POST | `405 {"error":"method_not_allowed"}` |
| `STAFF_TOKEN` is set and at least 32 characters | `503 {"error":"staff_auth_not_configured"}` |
| Rate limit: 10 requests a minute per client address | `429 {"error":"rate_limited"}` with `Retry-After` |
| Header `x-staff-token` equals `STAFF_TOKEN` | `401 {"error":"staff_only"}` |
| `GEMINI_API_KEY` is set | `503 {"error":"gemini_not_configured"}` |
| Input is valid | `400 {"error":"<what is wrong>"}` |
| Gemini answers | `502 {"error":"gemini_failed","status":<upstream status, 0 if unreachable>}`, `504 {"error":"gemini_timeout"}` after 20 s, `502 {"error":"gemini_blocked"}`, `502 {"error":"gemini_bad_output"}` |

- The token is compared with `crypto.timingSafeEqual`. A wrong length is refused after an equal amount
  of comparison work, so timing reveals at most that the length differs.
- The rate limit runs before the token check, so guessing is throttled as well. The client address is
  the first `x-forwarded-for` entry, which Vercel sets itself and does not let clients spoof.
- The rate limit is best effort: it lives in one function instance's memory, serverless instances do
  not share memory, and a cold start resets it. It protects the free Gemini quota from a runaway
  client, not from a determined attacker. A shared store would be needed for a hard limit.
- The token check comes before the Gemini key check, so a stranger cannot tell whether Gemini is set up.
- Requiring `application/json` and a custom header means a page on another site cannot send these
  requests without a CORS preflight, and these functions never approve one.
- Nothing logs tokens, keys, prompts or images. The only log lines are the upstream HTTP status.

## Environment variables

| Name | Used by | Notes |
|---|---|---|
| `STAFF_TOKEN` | draft, classify | Long random string, shared only with city staff. The staff console sends it as `x-staff-token`. Never put it in a `VITE_*` variable: those are compiled into the public bundle. Generate: `python3 -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `GEMINI_API_KEY` | draft, classify | Free Google AI Studio key from a project with no billing account. Sent only in the `x-goog-api-key` header, never in a URL. |

Set both in the Vercel project (Settings, Environment Variables). See `.env.example` at the repo root.

## Tests

From the repo root:

```sh
uv run --no-project --python 3.12 --with pytest --with-requirements requirements.txt pytest -q api/_tests
pnpm dlx vitest@5 run api/_tests --root .
```

The Python tests solve small known cases (including a brute-force optimum check), reject bad input, and
start the real request handler on a local port. The TypeScript tests mock `fetch`, so they never call
Gemini, and cover validation, every error status, the staff gate and the rate limit.

Type check (no `tsconfig.json` in `api/`, on purpose):

```sh
cd api && pnpm --package=typescript@5.9.3 dlx tsc --noEmit --strict --target ES2022 --lib ES2022,DOM \
  --module nodenext --moduleResolution nodenext --skipLibCheck draft.ts classify.ts _lib/node-crypto.d.ts
```
