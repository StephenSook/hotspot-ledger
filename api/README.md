# api/: serverless functions

Four Vercel functions. All take `POST` with `Content-Type: application/json` and answer JSON.
Every error is `{"error": "..."}` with a matching HTTP status. Responses carry `Cache-Control: no-store`.

| Function | Runtime | Needs | Calls |
|---|---|---|---|
| `route.py` | Python 3.12 | nothing | Google OR-Tools, locally |
| `draft.ts` | Node.js | `STAFF_TOKEN`, `GEMINI_API_KEY` | Gemini `gemini-3.8-flash` |
| `classify.ts` | Node.js | `STAFF_TOKEN`, `GEMINI_API_KEY` | Gemini `gemini-3.5-flash-lite` |
| `sign.ts` | Node.js | `STAFF_TOKEN`, `NOTICE_SIGNING_KEY` | Web Crypto Ed25519, locally |

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

Drafts a short neighbor notice in English and Spanish for one spot. **Gemini chooses, code writes:**
Gemini picks which sentences to use and in what order from a bank the team wrote and translated, and
code renders the notice with every number taken from the request. No word the model writes reaches a
resident, so a draft cannot contain an invented name, address, date or number.

```json
{"spot": {"plus_code": "865QRCC9+23", "district": "5", "items": {"tires": 11, "furniture": 9, "appliances": 3, "bags": 14, "construction": 1}, "n": 57, "recent": 9, "treatment": "sign_qr", "owner_label": "confirm"}}
```

Answer: `{"en": "...", "es": "...", "sentences": ["where", "total", "action", "how_to_report"], "model": "gemini-3.8-flash", "drafted_at": "2026-10-30T14:00:00.000Z", "status": "draft"}`

- The notice is a draft. A staff member approves it before anything is posted.
- Input rules (anything else is `400`): exactly these seven keys; `plus_code` a full Plus Code
  (`^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,3}$`); `district` `null` or `"1"` to `"6"`;
  `treatment` one of the planner codes `close_access`, `sign_qr`, `bulk_outreach`, `tire_play`,
  `commercial_check`, `cleanup`, `camera`; `owner_label` one of `city`, `cobb`, `gdot`, `private`,
  `confirm`; item counts, `n` and `recent` (reports in the last 12 months, never a date) integers
  0 to 10000, with `recent` no larger than `n`; body at most 4 KB.
- What the model sees: only the English text of the sentences this spot can use (`sentenceBank`), each
  with an id. A sentence whose fact is zero is not offered, and a disposal tip is offered only when
  its item group is the largest (bulk pickup for furniture plus appliances, tire amnesty for tires;
  ties offer both). `owner_label` is validated but never sent.
- What the model returns: `{"sentences": [ids]}`, constrained by a response schema whose items are
  an enum of the sentence ids. Anything else (free text, an unknown id, an extra key, an empty list,
  more than 20 ids) is refused with `502 {"error":"gemini_bad_output"}` and never returned or logged.
- How code renders it (`composeNotice`): a fixed opening and closing line; ids this spot cannot use
  and repeats are dropped; at most five optional sentences; "where", "action" and "how_to_report" are
  always present, in that order around the model's choices. A test checks that every character of a
  rendered notice comes from the bank.
- Why this design: five rounds of adversarial review showed that a filter on model-written text
  cannot be complete (a sentence-leading business name or a date built from allowed numbers always
  found a way through, and ordinary Spanish was rejected). Constraining the output to choices closes
  that class of problems instead of chasing it.

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

## POST /api/sign (staff only)

Signs an approved notice so the printed copy carries a QR code anyone can check.

```json
{"spot": {"plus_code": "865QRCC9+32", "district": "5", "items": {"tires": 11, "furniture": 9, "appliances": 3, "bags": 14, "construction": 1}, "n": 57, "recent": 23, "treatment": "camera", "owner_label": "confirm"}, "sentences": ["where", "total", "bags", "action", "how_to_report"], "digest": "<wordingDigest of the reviewed EN and ES text>"}
```

Answer: `{"token": "<payload>.<signature>", "path": "/#/v/<token>", "en": "...", "es": "...", "sentences": [...], "signed_at": "..."}`

- Same input rules as `/api/draft` for `spot`; `sentences` must be ids from the bank; `digest` is the
  wording digest of the English and Spanish text the staff member reviewed. The server re-composes
  the notice with `composeNotice`, so a signature only ever covers a well-formed notice from the
  sentence bank, never text a client sent, and it answers `409 {"error":"wording_changed"}` if that
  text is not the text the staff member reviewed (for example, the bank changed after the draft).
- The payload is base64url JSON with fixed keys: Plus Code, district, treatment, counts, sentence
  indexes, the issue date (UTC) and a digest (first 128 bits of SHA-256) of the exact English and
  Spanish text. No free text. The signature is Ed25519 over the payload string.
- The browser checks it (`verifyNoticeToken` in `_lib/notice.ts`) with the public key in the same
  file: strict decode (exact keys, allow-listed codes, bounded counts, a real date), then it rebuilds
  the text and requires its digest to match the signed one, so a later change to the sentence bank
  cannot change what an issued notice says. An edited payload, a token signed by another key, a
  stale wording, or a damaged link is refused.
- The check page says what a signature can prove: this exact text was signed on this date for this
  Plus Code. A QR code can be copied onto other paper, so the page asks the reader to compare the
  paper with the signed text and place, and flags notices older than six months.
- Errors: as for the staff gate, then `503 {"error":"signing_not_configured"}` when the key is missing
  or unusable, then `400` for bad input, then `409 {"error":"wording_changed"}`.

## Staff-only access (draft, classify and sign)

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
| `NOTICE_SIGNING_KEY` | sign | Ed25519 private key, PKCS8 DER in base64. Server only. Its public half is `NOTICE_PUBLIC_KEY` in `_lib/notice.ts`; replace both together. |

Set them in the Vercel project (Settings, Environment Variables). See `.env.example` at the repo root.

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

Type check (CI runs this; the config lives at the repo root as `tsconfig.api.json`, not
`api/tsconfig.json`, so Vercel's function builder never reads it):

```sh
pnpm --package=typescript@7.0.2 dlx tsc -p tsconfig.api.json
```
