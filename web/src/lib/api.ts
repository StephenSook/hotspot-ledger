// Thin client for the serverless functions in /api. Errors come back as values, never thrown,
// so every screen can say plainly what went wrong.
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

const STAFF_KEY = 'hotspot-ledger:staff-token'

/** The staff token lives only in this tab's session storage; it is never put in the URL or the bundle. */
export function getStaffToken(): string {
  try { return window.sessionStorage.getItem(STAFF_KEY) || '' } catch { return '' }
}
export function setStaffToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(STAFF_KEY, token)
    else window.sessionStorage.removeItem(STAFF_KEY)
  } catch { /* session storage unavailable */ }
}

async function post<T>(path: string, body: unknown, timeoutMs = 30000): Promise<ApiResult<T>> {
  const ctl = new AbortController()
  const t = window.setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const staff = getStaffToken()
    if (staff) headers['x-staff-token'] = staff
    const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal })
    const text = await res.text()
    let json: unknown = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    if (!res.ok) {
      const err = json && typeof json === 'object' && 'error' in json ? String((json as { error: unknown }).error) : `http_${res.status}`
      return { ok: false, status: res.status, error: err }
    }
    if (json === null) return { ok: false, status: res.status, error: 'not_json' }
    return { ok: true, data: json as T }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof DOMException && e.name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    window.clearTimeout(t)
  }
}

export interface RouteResult { order: string[]; distance_km: number; solver: string }
export interface DraftResult { en: string; es: string; model: string; drafted_at: string; status: 'draft' }
export interface ClassifyResult {
  items: string[]
  tire_count_estimate: number | null
  is_dumping_likely: boolean
  notes: string
}

export const orderStops = (stops: { id: string; lat: number; lng: number }[], start_id: string | null) =>
  post<RouteResult>('/api/route', { stops, start_id })

export const draftNotice = (spot: {
  plus_code: string; district: string | null; items: Record<string, number>; n: number; last: string; treatment: string; owner_label: string
}) => post<DraftResult>('/api/draft', { spot })

export const classifyPhoto = (image: string) => post<ClassifyResult>('/api/classify', { image }, 40000)

export function explain(error: string, status: number): string {
  if (error === 'gemini_not_configured') {
    return 'Gemini is not switched on for this deployment yet. It needs a free Google AI Studio key from a project with no billing, added as a server secret. Nothing else on this page depends on it.'
  }
  if (error === 'staff_only') return 'Staff only. Paste the staff token in the Plan page header first.'
  if (error === 'staff_auth_not_configured') return 'The staff token is not set on this deployment yet, so the Gemini functions stay locked.'
  if (error === 'rate_limited') return 'Too many requests in a minute. Wait a moment and try again.'
  if (error === 'timeout') return 'The request took too long. Try again.'
  if (error === 'network') return 'Could not reach the server. Check the connection and try again.'
  if (status === 404) return 'This function is not deployed here. It runs on the Vercel deployment.'
  return `The server answered ${status || 'with an error'} (${error}).`
}
