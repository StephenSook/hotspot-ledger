import { Frame } from '../components/hud'
import { NOTICE_PUBLIC_KEY, REPORT_URL, issuedLabel, useVerifiedNotice } from '../lib/notice'

const WHY: Record<'format' | 'signature' | 'payload', string> = {
  format: 'The link is incomplete or damaged.',
  signature: 'The signature does not match. The notice may have been changed.',
  payload: 'The signed content is not a notice this system writes.',
}

/** What a resident sees after scanning the QR code on a printed notice. */
export default function VerifyNotice({ token }: { token: string }) {
  const state = useVerifiedNotice(token)
  return (
    <div className="page-scroll">
      <div className="stack" style={{ maxWidth: 640, margin: '0 auto', gap: 14 }}>
        {state.status === 'checking' && <p className="lbl" role="status">Checking the signature</p>}

        {state.status === 'unsupported' && (
          <Frame className="stack" label="Cannot check">
            <h1>This browser cannot check the signature.</h1>
            <p className="dim">Open the link in a current version of Chrome, Safari, Edge or Firefox.</p>
          </Frame>
        )}

        {state.status === 'invalid' && (
          <Frame className="stack" label="Not verified">
            <h1 className="red">Not a verified notice.</h1>
            <p>{WHY[state.reason]} Do not rely on it.</p>
            <p><a href={REPORT_URL}>Report dumping to the City of Mableton</a></p>
          </Frame>
        )}

        {state.status === 'valid' && (
          <>
            <Frame className="stack" label="Verified">
              <p className="ok mono" role="status">Signature checked</p>
              <h1>This notice is genuine.</h1>
              <p className="dim">
                Signed by Hotspot Ledger, a prototype built for the City of Mableton. Issued {issuedLabel(state.payload.dt, 'en')} for Plus Code{' '}
                <a href={`https://plus.codes/${encodeURIComponent(state.payload.p)}`}>{state.payload.p}</a>
                {state.payload.d ? `, council district ${state.payload.d}` : ''}.
              </p>
            </Frame>
            <Frame className="stack" label="Notice">
              <p style={{ fontSize: 16 }}>{state.notice.en}</p>
              <hr className="rule" />
              <p style={{ fontSize: 16 }} lang="es">{state.notice.es}</p>
            </Frame>
            <a className="btn solid" style={{ height: 36, justifyContent: 'center', fontSize: 12 }} href={REPORT_URL}>
              Report dumping / Reportar basura tirada
            </a>
          </>
        )}

        <details className="lbl">
          <summary>How this check works</summary>
          <p style={{ marginTop: 6, textTransform: 'none' }}>
            Staff sign each notice with a private key that stays on the server. This page checks the signature in your
            browser with the public key below and rebuilds the text from the signed data, so an edited notice fails.
            Nothing you do here is sent anywhere.
          </p>
          <p className="mono" style={{ marginTop: 6, wordBreak: 'break-all', textTransform: 'none' }}>Ed25519 public key: {NOTICE_PUBLIC_KEY}</p>
        </details>
      </div>
    </div>
  )
}
