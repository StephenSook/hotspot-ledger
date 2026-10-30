import { Suspense, lazy, useEffect, useState } from 'react'
import { BottomBar } from './components/hud'
import { ROUTES, noticeFromHash, type Route } from './lib/routes'
import { loadLedger } from './data/load'
import type { LedgerData } from './data/types'
import VerifyNotice from './pages/VerifyNotice'
import PrintNotice from './pages/PrintNotice'
import { useStored } from './lib/store'

// Pages load on demand, so a resident who scans a notice's QR code downloads only the check page,
// not the 3D map engine or the on-device camera models.
const Ledger = lazy(() => import('./pages/Ledger'))
const WhereNext = lazy(() => import('./pages/WhereNext'))
const Plan = lazy(() => import('./pages/Plan'))
const Evidence = lazy(() => import('./pages/Evidence'))
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
  const [notice, setNotice] = useState(() => noticeFromHash(window.location.hash))
  const [data, setData] = useState<LedgerData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pinned, setPinned] = useStored<string[]>('pinned', [])

  useEffect(() => {
    const onHash = () => { setRoute(routeFromHash()); setNotice(noticeFromHash(window.location.hash)) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    document.title = notice ? `${notice.view === 'print' ? 'Print notice' : 'Check a notice'} // Hotspot Ledger` : `${TITLES[route]} // Hotspot Ledger`
  }, [route, notice])

  // A resident opening a notice link on a phone does not need the ledger data, so it loads only
  // once a ledger page is shown.
  const wantData = notice === null
  useEffect(() => {
    if (!wantData) return
    loadLedger().then(setData).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [wantData])

  const addToPlan = (id: string) => setPinned((p) => (p.includes(id) ? p : [...p, id]))

  if (notice) {
    return (
      <>
        <main className="app" id="main">
          {notice.view === 'verify' ? <VerifyNotice token={notice.token} /> : <PrintNotice token={notice.token} />}
        </main>
        <BottomBar route={null} />
      </>
    )
  }

  return (
    <>
      <main className="app" id="main">
        {error && (
          <div className="page-scroll"><p className="note" role="alert">Could not load the ledger data: {error}. Reload the page; if it persists, the data files are missing from this deployment.</p></div>
        )}
        {!error && !data && (
          <div className="page-scroll" aria-live="polite"><span className="lbl">Loading the ledger</span></div>
        )}
        <Suspense fallback={<div className="page-scroll" aria-live="polite"><span className="lbl">Loading</span></div>}>
          {data && route === 'ledger' && <Ledger data={data} onAddToPlan={addToPlan} pinned={pinned} />}
          {data && route === 'next' && <WhereNext data={data} />}
          {data && route === 'plan' && <Plan data={data} pinned={pinned} />}
          {route === 'camera' && <div className="page-scroll"><CameraLab /></div>}
          {data && route === 'evidence' && <Evidence data={data} />}
        </Suspense>
      </main>
      <BottomBar route={route} />
      <div className="grain" aria-hidden="true" />
    </>
  )
}
