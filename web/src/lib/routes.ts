export type Route = 'ledger' | 'next' | 'plan' | 'camera' | 'evidence'

export const ROUTES: { id: Route; label: string }[] = [
  { id: 'ledger', label: 'Ledger' },
  { id: 'next', label: 'Where next' },
  { id: 'plan', label: 'Plan' },
  { id: 'camera', label: 'Camera' },
  { id: 'evidence', label: 'Evidence' },
]

/** A notice link (#/v/<token>) or print view (#/print/<token>), else null. */
export function noticeFromHash(hash: string): { view: 'verify' | 'print'; token: string } | null {
  const m = /^#\/?(v|print)\/([A-Za-z0-9_.-]{1,1200})$/.exec(hash)
  return m ? { view: m[1] === 'v' ? 'verify' : 'print', token: m[2] } : null
}
