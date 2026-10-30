export type Route = 'ledger' | 'next' | 'plan' | 'camera' | 'evidence'

export const ROUTES: { id: Route; label: string }[] = [
  { id: 'ledger', label: 'Ledger' },
  { id: 'next', label: 'Where next' },
  { id: 'plan', label: 'Plan' },
  { id: 'camera', label: 'Camera' },
  { id: 'evidence', label: 'Evidence' },
]
