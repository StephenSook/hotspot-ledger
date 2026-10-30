// Staff-only gate for the Gemini functions, plus a best-effort per-IP rate limit.
//
// Every Gemini call must carry the header x-staff-token, compared in constant time with the
// STAFF_TOKEN env var. Residents never call Gemini: the token lives only in the staff console.
import { timingSafeEqual } from 'node:crypto'
import { json, readEnv } from './http'

export const STAFF_HEADER = 'x-staff-token'
// A shorter secret is treated as "not configured" rather than silently accepted.
export const MIN_STAFF_TOKEN_CHARS = 32
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
}

/**
 * Sliding-window limiter held in this function instance's memory. Best effort only: serverless
 * instances do not share memory, so the real ceiling is `limit` per instance, and a cold start
 * resets it. It protects the free-tier Gemini quota from a runaway client, not from a botnet.
 */
export function createRateLimiter(limit = 10, windowMs = 60_000, maxKeys = 5_000): RateLimiter {
  const hits = new Map<string, number[]>()
  return {
    hit(key, nowMs) {
      const recent = (hits.get(key) ?? []).filter((t) => nowMs - t < windowMs)
      if (recent.length >= limit) {
        hits.set(key, recent)
        return Math.max(1, Math.ceil((recent[0] + windowMs - nowMs) / 1000))
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

/** First entry of x-forwarded-for. Vercel overwrites this header, so clients cannot spoof it. */
export function clientKey(request: Request): string {
  const first = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
  return first.slice(0, 64) || 'unknown'
}

export interface GateDeps {
  env?: (name: string) => string | undefined
  limiter?: RateLimiter
  now?: () => Date
}

/**
 * Runs the checks that come after the method check: staff auth configured (503), rate limit (429),
 * staff token (401). Returns a Response to send, or null when the caller may proceed.
 * The limiter runs before the token check so token guessing is throttled too.
 */
export function staffGate(request: Request, limiter: RateLimiter, deps: GateDeps = {}): Response | null {
  const expected = (deps.env ?? readEnv)('STAFF_TOKEN')
  if (!expected || expected.length < MIN_STAFF_TOKEN_CHARS) return json(503, { error: 'staff_auth_not_configured' })

  const wait = limiter.hit(clientKey(request), (deps.now ?? (() => new Date()))().getTime())
  if (wait > 0) return json(429, { error: 'rate_limited' }, { 'Retry-After': String(wait) })

  const provided = request.headers.get(STAFF_HEADER) ?? ''
  if (!provided || provided.length > MAX_HEADER_CHARS || !tokensMatch(provided, expected)) {
    return json(401, { error: 'staff_only' })
  }
  return null
}
