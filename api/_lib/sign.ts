// POST /api/sign logic: signs an approved notice so the printed copy carries a QR code anyone can
// check. Staff only. The request uses the same allow-lists as /api/draft: a spot (codes and counts)
// and a list of sentence ids. The server re-composes the notice, so a signature always covers a
// well-formed notice from the sentence bank, never text sent by a client.
import { parseChoice, validateDraftRequest } from './draft'
import { InputError, exactKeys, isPlainObject, json, methodNotAllowed, readEnv, readJsonBody } from './http'
import { b64urlEncode, composeNotice, encodePayload, payloadFromNotice, wordingDigest, type SentenceId, type Spot } from './notice'
import { createGateLimiters, staffGate, type GateDeps } from './staff'

export const SIGN_MAX_BODY_BYTES = 4 * 1024

/** Ed25519 signature of the ASCII payload string, with a PKCS8 private key in base64. */
export async function signPayload(payloadB64: string, pkcs8Base64: string): Promise<string> {
  const der = Uint8Array.from(atob(pkcs8Base64), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign'])
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(payloadB64))
  return b64urlEncode(new Uint8Array(sig))
}

const signLimiters = createGateLimiters()

// Order: 405, staff auth configured (503), staff token (401/429), signing key (503), input (400).
export async function handleSign(request: Request, deps: GateDeps = {}): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed()
  const denied = staffGate(request, deps.limiters ?? signLimiters, deps)
  if (denied) return denied
  const key = (deps.env ?? readEnv)('NOTICE_SIGNING_KEY')
  if (!key) return json(503, { error: 'signing_not_configured' })

  let spot: Spot
  let chosen: SentenceId[]
  try {
    const body = await readJsonBody(request, SIGN_MAX_BODY_BYTES)
    if (!isPlainObject(body)) throw new InputError('body must be a JSON object')
    exactKeys(body, ['spot', 'sentences'], 'body')
    spot = validateDraftRequest({ spot: body.spot })
    try {
      chosen = parseChoice({ sentences: body.sentences })
    } catch (err) {
      throw new InputError(`sentences: ${err instanceof Error ? err.message : 'invalid'}`)
    }
  } catch (err) {
    if (err instanceof InputError) return json(400, { error: err.message })
    throw err
  }

  const now = (deps.now ?? (() => new Date()))()
  const notice = composeNotice(spot, chosen)
  const digest = await wordingDigest(notice.en, notice.es)
  const payloadB64 = encodePayload(payloadFromNotice(spot, notice.sentences, now.toISOString().slice(0, 10), digest))
  let signature: string
  try {
    signature = await signPayload(payloadB64, key)
  } catch {
    console.error('sign: NOTICE_SIGNING_KEY could not be used')
    return json(503, { error: 'signing_not_configured' })
  }
  const token = `${payloadB64}.${signature}`
  return json(200, { token, path: `/#/v/${token}`, en: notice.en, es: notice.es, sentences: notice.sentences, signed_at: now.toISOString() })
}
