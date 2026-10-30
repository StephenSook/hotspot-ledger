import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleClassify } from '../_lib/classify'
import { handleDraft } from '../_lib/draft'
import {
  AUTHORIZED_PER_MINUTE,
  FAILED_AUTH_PER_MINUTE,
  MIN_STAFF_TOKEN_CHARS,
  clientKey,
  createGateLimiters,
  createRateLimiter,
  tokensMatch,
} from '../_lib/staff'

const TOKEN = 'staff-token-for-tests-0123456789abcdef'
const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, ...new Array(28).fill(0)))
const SHARED_NAT = '203.0.113.7'

const geminiReply = (value: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: 'STOP' }] }))

// Both Gemini functions share the gate; every case below runs against each of them.
const CASES = [
  {
    name: 'draft',
    handle: handleDraft,
    body: {
      spot: {
        plus_code: '865QRCC9+23', district: '5', items: { tires: 11, furniture: 9, appliances: 3, bags: 14, construction: 1 },
        n: 57, recent: 9, treatment: 'sign_qr', owner_label: 'confirm',
      },
    },
    reply: { en: 'Thank you, neighbors.', es: 'Gracias, vecinos.' },
  },
  {
    name: 'classify',
    handle: handleClassify,
    body: { image: `data:image/jpeg;base64,${JPEG}` },
    reply: { items: ['tires'], tire_count_estimate: 3, is_dumping_likely: true },
  },
] as const

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://hotspot.test/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `${SHARED_NAT}, 10.0.0.1`, ...headers },
    body: JSON.stringify(body),
  })
}

function deps(env: Record<string, string | undefined>, reply: unknown, limiters = createGateLimiters()) {
  const fetchImpl = vi.fn(async () => geminiReply(reply))
  return { fetchImpl, deps: { env: (n: string) => env[n], fetchImpl: fetchImpl as unknown as typeof fetch, limiters, now: () => new Date(0) } }
}

const FULL_ENV = { STAFF_TOKEN: TOKEN, GEMINI_API_KEY: 'test-key' }
const staff = { 'x-staff-token': TOKEN }
const stranger = { 'x-staff-token': 'guess' }

afterEach(() => vi.restoreAllMocks())

describe.each(CASES)('staff gate on /api/$name', ({ handle, body, reply }) => {
  it('answers 503 staff_auth_not_configured when STAFF_TOKEN is unset, before anything else', async () => {
    const { fetchImpl, deps: d } = deps({ GEMINI_API_KEY: 'test-key' }, reply)
    const res = await handle(request(body, staff), d)
    expect([res.status, await res.json()]).toEqual([503, { error: 'staff_auth_not_configured' }])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it(`treats a STAFF_TOKEN shorter than ${MIN_STAFF_TOKEN_CHARS} characters as not configured`, async () => {
    const { deps: d } = deps({ STAFF_TOKEN: 'short-token', GEMINI_API_KEY: 'test-key' }, reply)
    const res = await handle(request(body, { 'x-staff-token': 'short-token' }), d)
    expect([res.status, await res.json()]).toEqual([503, { error: 'staff_auth_not_configured' }])
  })

  it('answers 401 staff_only when the token header is missing', async () => {
    const { fetchImpl, deps: d } = deps(FULL_ENV, reply)
    const res = await handle(request(body), d)
    expect([res.status, await res.json()]).toEqual([401, { error: 'staff_only' }])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('answers 401 staff_only for a wrong token of the same or a different length', async () => {
    const { fetchImpl, deps: d } = deps(FULL_ENV, reply)
    const sameLength = TOKEN.slice(0, -1) + (TOKEN.endsWith('f') ? 'e' : 'f')
    for (const wrong of [sameLength, 'nope', TOKEN + 'x', 'x'.repeat(600)]) {
      const res = await handle(request(body, { 'x-staff-token': wrong }), d)
      expect([res.status, await res.json()]).toEqual([401, { error: 'staff_only' }])
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('checks the token before the Gemini key, so a stranger cannot learn whether Gemini is set up', async () => {
    const { deps: d } = deps({ STAFF_TOKEN: TOKEN }, reply)
    const res = await handle(request(body, stranger), d)
    expect(res.status).toBe(401)
  })

  it('reaches the (mocked) upstream with the correct token and never forwards the token', async () => {
    const { fetchImpl, deps: d } = deps(FULL_ENV, reply)
    const res = await handle(request(body, staff), d)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject(reply)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.stringify(init)).not.toContain(TOKEN)
  })

  it('a failed-auth lockout answers a correct token exactly like a wrong one, until the window passes', async () => {
    const { fetchImpl, deps: base } = deps(FULL_ENV, reply)
    let nowMs = 0
    const d = { ...base, now: () => new Date(nowMs) }
    for (let i = 0; i < FAILED_AUTH_PER_MINUTE; i++) {
      expect((await handle(request(body, stranger), d)).status).toBe(401)
    }
    const guessing = await handle(request(body, stranger), d)
    const rightGuess = await handle(request(body, staff), d)
    expect([guessing.status, await guessing.json()]).toEqual([429, { error: 'rate_limited' }])
    expect([rightGuess.status, await rightGuess.json()]).toEqual([429, { error: 'rate_limited' }])
    expect(rightGuess.headers.get('retry-after')).toBe(guessing.headers.get('retry-after'))
    expect(fetchImpl).not.toHaveBeenCalled()

    nowMs = 60_001
    expect((await handle(request(body, staff), d)).status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it(`limits authorized use to ${AUTHORIZED_PER_MINUTE} a minute per address, without touching the failed-auth budget`, async () => {
    const { fetchImpl, deps: d } = deps(FULL_ENV, reply)
    for (let i = 0; i < AUTHORIZED_PER_MINUTE; i++) {
      expect((await handle(request(body, staff), d)).status).toBe(200)
    }
    const limited = await handle(request(body, staff), d)
    expect([limited.status, await limited.json()]).toEqual([429, { error: 'rate_limited' }])
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(fetchImpl).toHaveBeenCalledTimes(AUTHORIZED_PER_MINUTE)

    // Authorized use spent none of the failed-auth budget: a wrong token still gets a plain 401.
    expect((await handle(request(body, stranger), d)).status).toBe(401)
    // Another address has its own budget.
    expect((await handle(request(body, { ...staff, 'x-forwarded-for': '198.51.100.9' }), d)).status).toBe(200)
  })
})

describe('tokensMatch', () => {
  it('accepts only the identical string', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true)
    expect(tokensMatch(TOKEN.toUpperCase(), TOKEN)).toBe(false)
    expect(tokensMatch('', TOKEN)).toBe(false)
    expect(tokensMatch(TOKEN + ' ', TOKEN)).toBe(false)
    expect(tokensMatch('é'.repeat(4), 'e'.repeat(8))).toBe(false) // same UTF-8 byte length, different bytes
  })
})

describe('createRateLimiter', () => {
  it('lets requests through again once the window has passed', () => {
    const limiter = createRateLimiter(2, 60_000)
    expect(limiter.hit('a', 0)).toBe(0)
    expect(limiter.hit('a', 1_000)).toBe(0)
    expect(limiter.hit('a', 2_000)).toBe(58)
    expect(limiter.hit('a', 60_001)).toBe(0)
  })
  it('blocked() reports the same wait as hit() without spending the budget', () => {
    const limiter = createRateLimiter(1, 60_000)
    expect(limiter.blocked('a', 0)).toBe(0)
    expect(limiter.blocked('a', 0)).toBe(0)
    expect(limiter.hit('a', 0)).toBe(0)
    expect(limiter.blocked('a', 30_000)).toBe(30)
    expect(limiter.hit('a', 30_000)).toBe(30)
    expect(limiter.blocked('a', 60_001)).toBe(0)
  })
  it('keeps memory bounded by evicting the least recent address', () => {
    const limiter = createRateLimiter(1, 60_000, 2)
    limiter.hit('a', 0)
    limiter.hit('b', 0)
    limiter.hit('c', 0) // evicts "a"
    expect(limiter.hit('a', 1)).toBe(0)
    expect(limiter.hit('c', 1)).toBeGreaterThan(0)
  })
})

describe('clientKey', () => {
  it('uses the first x-forwarded-for entry', () => {
    const req = (xff?: string) => new Request('https://h.test', { headers: xff ? { 'x-forwarded-for': xff } : {} })
    expect(clientKey(req('203.0.113.7, 10.0.0.1'))).toBe('203.0.113.7')
    expect(clientKey(req())).toBe('unknown')
  })
})
