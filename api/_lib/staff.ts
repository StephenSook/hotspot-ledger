// Staff-only gate for the Gemini functions, plus a best-effort per-IP rate limit.
//
// Every Gemini call must carry the header x-staff-token, compared in constant time with the
// STAFF_TOKEN env var. Residents never call Gemini: the token lives only in the staff console.
import { timingSafeEqual } from 'node:crypto'
import { json, readEnv } from './http'

export const STAFF_HEADER = 'x-staff-token'
// A shorter secret is treated as "not configured" rather than silently accepted.
export const MIN_STAFF_TOKEN_CHARS = 32
export const FAILED_AUTH_PER_MINUTE = 10
export const AUTHORIZED_PER_MINUTE = 30
const MAX_HEADER_CHARS = 512

const encoder = new TextEncoder()

/** Constant-time for equal lengths; a length mismatch only reveals that the lengths differ. */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = encoder.encode(provided)
  const b = encoder.encode(expected)
  if (a.byteLength !== b.byteLength) {
    timingSafeEqual(b, b) // spend comparable time, then refuse
    return false
  }
  return timingSafeEqual(a, b)
}

export interface RateLimiter {
  /** Records one request for `key`; returns seconds to wait if it is over the limit, else 0. */
  hit(key: string, nowMs: number): number
  /** Same answer as `hit`, without recording anything. */
  blocked(key: string, nowMs: number): number
}

/**
 * Sliding-window limiter held in this function instance's memory. Best effort only: serverless
 * instances do not share memory, so the real ceiling is `limit` per instance, and a cold start
 * resets it. It protects the free-tier Gemini quota from a runaway client, not from a botnet.
 */
export function createRateLimiter(limit = 10, windowMs = 60_000, maxKeys = 5_000): RateLimiter {
  const hits = new Map<string, number[]>()
  const waitFor = (recent: number[], nowMs: number) =>
    recent.length >= limit ? Math.max(1, Math.ceil((recent[0] + windowMs - nowMs) / 1000)) : 0
  return {
    blocked(key, nowMs) {
      return waitFor((hits.get(key) ?? []).filter((t) => nowMs - t < windowMs), nowMs)
    },
    hit(key, nowMs) {
      const recent = (hits.get(key) ?? []).filter((t) => nowMs - t < windowMs)
      const wait = waitFor(recent, nowMs)
      if (wait > 0) {
        hits.set(key, recent)
        return wait
      }
      recent.push(nowMs)
      hits.delete(key) // re-insert so Map order tracks recency
      hits.set(key, recent)
      if (hits.size > maxKeys) {
        const oldest = hits.keys().next().value
        if (oldest !== undefined) hits.delete(oldest)
      }
      return 0
    },
  }
}

/**
 * Two separate budgets per client address. Wrong-token requests spend `failed`; valid-token
 * requests spend `authorized`, so heavy staff use never counts as guessing.
 *
 * While an address is over its failed-auth budget, every request from it gets the same 429,
 * including one carrying the valid token. Otherwise a lockout would answer 429 to wrong guesses
 * and 200 to the right one, which tells a guesser the answer at any speed. The cost: a stranger
 * guessing from a shared address (city hall Wi-Fi, a carrier NAT) can delay staff on that address
 * until the one-minute window passes. Guessing itself is hopeless, because STAFF_TOKEN must be at
 * least 32 characters.
 */
export interface GateLimiters {
  failed: RateLimiter
  authorized: RateLimiter
}

export function createGateLimiters(
  failedPerMinute = FAILED_AUTH_PER_MINUTE,
  authorizedPerMinute = AUTHORIZED_PER_MINUTE,
): GateLimiters {
  return { failed: createRateLimiter(failedPerMinute), authorized: createRateLimiter(authorizedPerMinute) }
}

/** First entry of x-forwarded-for. Vercel overwrites this header, so clients cannot spoof it. */
export function clientKey(request: Request): string {
  const first = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
  return first.slice(0, 64) || 'unknown'
}

export interface GateDeps {
  env?: (name: string) => string | undefined
  limiters?: GateLimiters
  now?: () => Date
}

const tooMany = (wait: number) => json(429, { error: 'rate_limited' }, { 'Retry-After': String(wait) })

/**
 * Runs the checks that come after the method check: staff auth configured (503), then the token.
 * An address that has used its failed-auth budget gets 429 before the token is even compared.
 * Otherwise a wrong or missing token answers 401, and a valid token answers 429 only when the
 * address has used its authorized budget.
 * Returns a Response to send, or null when the caller may proceed.
 */
export function staffGate(request: Request, limiters: GateLimiters, deps: GateDeps = {}): Response | null {
  const expected = (deps.env ?? readEnv)('STAFF_TOKEN')
  if (!expected || expected.length < MIN_STAFF_TOKEN_CHARS) return json(503, { error: 'staff_auth_not_configured' })

  const key = clientKey(request)
  const nowMs = (deps.now ?? (() => new Date()))().getTime()
  const locked = limiters.failed.blocked(key, nowMs)
  if (locked > 0) return tooMany(locked)

  const provided = request.headers.get(STAFF_HEADER) ?? ''
  const valid = provided.length > 0 && provided.length <= MAX_HEADER_CHARS && tokensMatch(provided, expected)

  if (!valid) {
    const wait = limiters.failed.hit(key, nowMs)
    return wait > 0 ? tooMany(wait) : json(401, { error: 'staff_only' })
  }
  const wait = limiters.authorized.hit(key, nowMs)
  return wait > 0 ? tooMany(wait) : null
}
