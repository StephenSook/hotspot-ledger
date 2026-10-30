import { Suspense, lazy, useEffect, useState } from 'react'
import { BottomBar } from './components/hud'
import { ROUTES, type Route } from './lib/routes'
import { loadLedger } from './data/load'
import type { LedgerData } from './data/types'
import Ledger from './pages/Ledger'
import WhereNext from './pages/WhereNext'
import Plan from './pages/Plan'
import Evidence from './pages/Evidence'
import { useStored } from './lib/store'

const CameraLab = lazy(() => import('./camera/CameraLab'))

function routeFromHash(): Route {
  const id = window.location.hash.replace(/^#\/?/, '') as Route
  return ROUTES.some((r) => r.id === id) ? id : 'ledger'
}

const TITLES: Record<Route, string> = {
  ledger: 'Ledger', next: 'Where next', plan: 'Plan', camera: 'Camera', evidence: 'Evidence',
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash)
  const [data, setData] = useState<LedgerData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pinned, setPinned] = useStored<string[]>('pinned', [])

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    document.title = `${TITLES[route]} // Hotspot Ledger`
  }, [route])

  useEffect(() => {
    loadLedger().then(setData).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const addToPlan = (id: string) => setPinned((p) => (p.includes(id) ? p : [...p, id]))

  return (
    <>
      <main className="app" id="main">
        {error && (
          <div className="page-scroll"><p className="note" role="alert">Could not load the ledger data: {error}. Reload the page; if it persists, the data files are missing from this deployment.</p></div>
        )}
        {!error && !data && (
          <div className="page-scroll" aria-live="polite"><span className="lbl">Loading the ledger</span></div>
        )}
        {data && route === 'ledger' && <Ledger data={data} onAddToPlan={addToPlan} pinned={pinned} />}
        {data && route === 'next' && <WhereNext data={data} />}
        {data && route === 'plan' && <Plan data={data} pinned={pinned} />}
        {route === 'camera' && (
          <Suspense fallback={<div className="page-scroll"><span className="lbl">Loading the camera lab</span></div>}>
            <div className="page-scroll"><CameraLab /></div>
          </Suspense>
        )}
        {data && route === 'evidence' && <Evidence data={data} />}
      </main>
      <BottomBar route={route} />
      <div className="grain" aria-hidden="true" />
    </>
  )
}
