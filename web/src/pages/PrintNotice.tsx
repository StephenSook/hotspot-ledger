import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { issuedLabel, useVerifiedNotice, verifyUrl } from '../lib/notice'

/** A printable letter-size notice. Only a token that verifies can be printed. */
export default function PrintNotice({ token }: { token: string }) {
  const state = useVerifiedNotice(token)
  // Keyed by URL, so a new print link never shows the previous notice's QR code while its own renders.
  const [made, setMade] = useState<{ url: string; src: string | null } | null>(null)
  const url = verifyUrl(token)
  const qr = made && made.url === url ? made.src : null

  useEffect(() => {
    let live = true
    QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })
      .then((svg) => { if (live) setMade({ url, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }) })
      .catch(() => { if (live) setMade({ url, src: null }) })
    return () => { live = false }
  }, [url])

  if (state.status === 'checking') return <div className="page-scroll"><p className="lbl" role="status">Checking the signature</p></div>
  if (state.status !== 'valid') {
    return (
      <div className="page-scroll">
        <p className="note" role="alert">This notice does not verify, so it cannot be printed. Sign it again from the Plan page.</p>
      </div>
    )
  }

  const { payload: p, notice } = state
  return (
    <div className="page-scroll print-page">
      <div className="row no-print" style={{ maxWidth: 816, margin: '0 auto 12px', justifyContent: 'space-between' }}>
        <a className="btn" href="#/plan">Back to plan</a>
        <button className="btn solid" onClick={() => window.print()}>Print</button>
      </div>
      <article className="sheet" aria-label="Printable notice">
        <header className="sheet-head">
          <span>City of Mableton</span>
          <span>Plus Code {p.p}{p.d ? ` / District ${p.d}` : ''}</span>
        </header>
        <h1 className="sheet-title">Keep this spot clean<span lang="es">Mantengamos limpio este lugar</span></h1>
        <p className="sheet-text">{notice.en}</p>
        <p className="sheet-text" lang="es">{notice.es}</p>
        <footer className="sheet-foot">
          {qr ? <img src={qr} alt="QR code that opens the signed copy of this notice" width={150} height={150} /> : <span>QR code unavailable</span>}
          <div className="stack" style={{ gap: 4 }}>
            <strong>Scan to check this notice is real and to report dumping.</strong>
            <span lang="es">Escanee para confirmar que este aviso es real y para reportar basura tirada.</span>
            <span className="sheet-small">Issued {issuedLabel(p.dt, 'en')} / Emitido el {issuedLabel(p.dt, 'es')}. Signed with Ed25519. Prototype, Georgia 311 Challenge 2026.</span>
          </div>
        </footer>
      </article>
    </div>
  )
}
