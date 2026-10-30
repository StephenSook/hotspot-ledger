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
{"spot": {"plus_code": "865QRCC9+23", "district": "5", "items": {"tires": 11, "furniture": 9, "appliances": 3, "bags": 14, "construction": 1}, "n": 57, "last": "2026-10-25", "treatment": "sign_qr", "owner_label": "confirm"}}
```

Answer: `{"en": "...", "es": "...", "model": "gemini-3.8-flash", "drafted_at": "2026-10-30T14:00:00.000Z", "status": "draft"}`

- The notice is a draft. A staff member approves it before anything is posted.
- Input rules (anything else is `400`): exactly these seven keys; `plus_code` a full Plus Code
  (`^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,3}$`); `district` `null` or `"1"` to `"6"`;
  `treatment` one of the planner codes `close_access`, `sign_qr`, `bulk_outreach`, `tire_play`,
  `commercial_check`, `cleanup`, `camera`; `owner_label` one of `city`, `cobb`, `gdot`, `private`,
  `confirm`; item counts and `n` integers 0 to 10000; `last` a real `YYYY-MM` or `YYYY-MM-DD`;
  body at most 4 KB.
- Prompt-injection defence: no free text reaches the prompt. Every value is a number, a fixed code,
  or a strictly patterned string. Each treatment code becomes a fixed sentence written in this repo.
  `owner_label` is validated but not sent. `last` is sent as words ("within the last three months"),
  not as a date, and counts of 100 or more as "over one hundred".
- Output check before any `200`: each language is at most 2000 characters, and the answer is refused
  with `502 {"error":"gemini_bad_output"}` if, after removing the spot's own Plus Code, it contains
  a run of 3 or more digits (`(^|[^A-Z0-9+])\d{3,}(?![A-Z0-9])`, which catches years, dates, phone
  and house numbers), any other Plus Code, license plate wording (plate, placa, matrícula, tablilla,
  tag number), or a street address (a number, capitalized words and a street suffix, or Calle /
  Avenida / Carretera / Camino followed by a name). The refused text is never returned or logged.
- The bulk-pickup tip is added when furniture plus appliances is the largest item group; the tire
  amnesty tip when tires are. Ties add both.

## POST /api/classify (staff only)

Says which kinds of dumped items are in one field photo. The browser blurs faces before upload.

```json
{"image": "data:image/jpeg;base64,/9j/4AAQ..."}
```

Answer: `{"items": ["tires", "bags"], "tire_count_estimate": 6, "is_dumping_likely": true, "model": "gemini-3.5-flash-lite", "classified_at": "..."}`

- `image/jpeg`, `image/png` or `image/webp` only, at most 1.5 MB decoded. The file signature must match
  the declared type.
- The answer has no free text at all: `items` uses only `tires`, `furniture`, `appliances`, `bags`,
  `construction`, `other`; `tire_count_estimate` is an integer 0 to 1000 or `null`;
  `is_dumping_likely` is a boolean. Anything else the model returns is dropped, so it has no channel
  to describe a person, read a plate, or repeat an instruction hidden in the photo.
- The image is never logged or stored.

## Staff-only access (draft and classify)

Gemini runs only behind staff actions, and the server enforces that, not just the UI.

Checks, in this order:

| Step | Answer when it fails |
|---|---|
| Method is POST | `405 {"error":"method_not_allowed"}` |
| `STAFF_TOKEN` is set and at least 32 characters | `503 {"error":"staff_auth_not_configured"}` |
| Header `x-staff-token` equals `STAFF_TOKEN` | `401 {"error":"staff_only"}`, or `429 {"error":"rate_limited"}` after 10 failed attempts a minute from that address |
| Authorized budget: 30 requests a minute per address | `429 {"error":"rate_limited"}` with `Retry-After` |
| `GEMINI_API_KEY` is set | `503 {"error":"gemini_not_configured"}` |
| Input is valid | `400 {"error":"<what is wrong>"}` |
| Gemini answers | `502 {"error":"gemini_failed","status":<upstream status, 0 if unreachable>}`, `504 {"error":"gemini_timeout"}` after 20 s, `502 {"error":"gemini_blocked"}` |
| Answer passes the output check (draft) or parses (classify) | `502 {"error":"gemini_bad_output"}` |

- The token is compared with `crypto.timingSafeEqual`. A wrong length is refused after an equal amount
  of comparison work, so timing reveals at most that the length differs.
- Two separate budgets per client address. Wrong or missing tokens spend the failed-auth budget
  (10 a minute), which throttles guessing. A valid token spends the authorized budget (30 a minute),
  so heavy staff use never counts as guessing.
- While an address is over its failed-auth budget, every request from it gets the same 429, valid
  token included, and the token is not even compared. Letting the right token through would answer
  429 to wrong guesses and 200 to the right one, which tells a guesser the answer at any speed. The
  cost: a stranger guessing from a shared address (city hall Wi-Fi, a carrier NAT) can delay staff on
  that address for up to one minute. The client address is the first `x-forwarded-for` entry, which
  Vercel sets itself and does not let clients spoof.
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
Gemini, and cover validation, injected input, unsafe model output, every error status, the staff gate,
both rate-limit budgets and the shared-address lockout case.

Type check (no `tsconfig.json` in `api/`, on purpose):

```sh
cd api && pnpm --package=typescript@5.9.3 dlx tsc --noEmit --strict --target ES2022 --lib ES2022,DOM \
  --module nodenext --moduleResolution nodenext --skipLibCheck draft.ts classify.ts _lib/node-crypto.d.ts
```
