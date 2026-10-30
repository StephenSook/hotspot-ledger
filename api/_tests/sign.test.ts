import { beforeAll, describe, expect, it, vi } from 'vitest'
import signFunction from '../sign'
import { composeNotice, type Spot } from '../_lib/draft'
import {
  NOTICE_PUBLIC_KEY,
  b64urlEncode,
  decodePayload,
  encodePayload,
  payloadFromNotice,
  renderPayload,
  verifyNoticeToken,
  type NoticePayload,
} from '../_lib/notice'
import { handleSign, signPayload } from '../_lib/sign'
import { createGateLimiters } from '../_lib/staff'

const TOKEN = 'staff-token-for-tests-0123456789abcdef'
const NOW = new Date('2026-10-30T14:00:00.000Z')
const SPOT: Spot = {
  plus_code: '865QRCC9+32',
  district: '5',
  items: { tires: 11, furniture: 9, appliances: 3, bags: 14, construction: 1 },
  n: 57,
  recent: 23,
  treatment: 'camera',
  owner_label: 'confirm',
}
const SENTENCES = ['where', 'total', 'bags', 'action', 'no_blame', 'how_to_report']
let PRIV = ''
let PUB = ''

beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  PRIV = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))))
  PUB = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
})

const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', 'x-staff-token': TOKEN }) =>
  new Request('https://hotspot.test/api/sign', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
const deps = (env: Record<string, string | undefined>) => ({ env: (n: string) => env[n], now: () => NOW, limiters: createGateLimiters(1000, 1000) })

describe('handleSign', () => {
  it('signs a notice that the public key verifies and that re-renders to the same text', async () => {
    const res = await handleSign(post({ spot: SPOT, sentences: SENTENCES }), deps({ STAFF_TOKEN: TOKEN, NOTICE_SIGNING_KEY: PRIV }))
    expect(res.status).toBe(200)
    const body = await res.json()
    const expected = composeNotice(SPOT, SENTENCES as never)
    expect(body).toMatchObject({ en: expected.en, es: expected.es, sentences: expected.sentences, signed_at: NOW.toISOString() })
    expect(body.path).toBe(`/#/v/${body.token}`)
    const v = await verifyNoticeToken(body.token, PUB)
    expect(v.status).toBe('valid')
    if (v.status === 'valid') {
      expect(v.notice).toEqual(expected)
      expect(v.payload.dt).toBe('2026-10-30')
      expect(v.payload.p).toBe('865QRCC9+32')
    }
  })

  it('answers 405, 503 without staff auth or a signing key, 401 for a wrong token, 400 for bad input', async () => {
    expect((await handleSign(new Request('https://hotspot.test/api/sign'), deps({}))).status).toBe(405)
    const noStaff = await handleSign(post({ spot: SPOT, sentences: SENTENCES }), deps({ NOTICE_SIGNING_KEY: PRIV }))
    expect([noStaff.status, await noStaff.json()]).toEqual([503, { error: 'staff_auth_not_configured' }])
    const noKey = await handleSign(post({ spot: SPOT, sentences: SENTENCES }), deps({ STAFF_TOKEN: TOKEN }))
    expect([noKey.status, await noKey.json()]).toEqual([503, { error: 'signing_not_configured' }])
    const wrong = await handleSign(post({ spot: SPOT, sentences: SENTENCES }, { 'content-type': 'application/json', 'x-staff-token': 'nope' }), deps({ STAFF_TOKEN: TOKEN, NOTICE_SIGNING_KEY: PRIV }))
    expect(wrong.status).toBe(401)
    const env = deps({ STAFF_TOKEN: TOKEN, NOTICE_SIGNING_KEY: PRIV })
    for (const bad of [
      { spot: SPOT },
      { spot: SPOT, sentences: SENTENCES, text: 'free text' },
      { spot: SPOT, sentences: ['where', 'Walmart is helping'] },
      { spot: { ...SPOT, n: 3, items: { ...SPOT.items, tires: 4 } }, sentences: SENTENCES },
      { spot: { ...SPOT, plus_code: '123 Main St' }, sentences: SENTENCES },
    ]) {
      const r = await handleSign(post(bad), env)
      expect(r.status, JSON.stringify(bad)).toBe(400)
    }
  })

  it('answers 503 rather than 500 when the configured key is not a usable Ed25519 key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await handleSign(post({ spot: SPOT, sentences: SENTENCES }), deps({ STAFF_TOKEN: TOKEN, NOTICE_SIGNING_KEY: 'bm90LWEta2V5' }))
    expect([res.status, await res.json()]).toEqual([503, { error: 'signing_not_configured' }])
  })

  it('the deployed default export reads its settings from the environment', async () => {
    vi.stubEnv('STAFF_TOKEN', '')
    const res = await signFunction.fetch(post({ spot: SPOT, sentences: SENTENCES }))
    expect([res.status, await res.json()]).toEqual([503, { error: 'staff_auth_not_configured' }])
    vi.unstubAllEnvs()
  })
})

describe('verifyNoticeToken', () => {
  async function token(payload: NoticePayload): Promise<string> {
    const p = encodePayload(payload)
    return `${p}.${await signPayload(p, PRIV)}`
  }
  const payload = () => payloadFromNotice(SPOT, composeNotice(SPOT, SENTENCES as never).sentences, '2026-10-30')

  it('rejects a notice whose payload was edited after signing', async () => {
    const t = await token(payload())
    const [p, s] = t.split('.')
    const edited = encodePayload({ ...decodePayload(p)!, n: 9 })
    expect(await verifyNoticeToken(`${edited}.${s}`, PUB)).toEqual({ status: 'invalid', reason: 'signature' })
  })

  it('rejects a notice signed with a different key, including the real city key', async () => {
    const t = await token(payload())
    expect(await verifyNoticeToken(t, NOTICE_PUBLIC_KEY)).toEqual({ status: 'invalid', reason: 'signature' })
  })

  it.each([['garbage'], ['a.b.c'], ['x'.repeat(1300)], ['!!!.???'], ['']])('rejects a malformed token %j', async (t) => {
    expect((await verifyNoticeToken(t, PUB)).status).toBe('invalid')
  })

  it('refuses a validly signed payload that breaks the schema', async () => {
    for (const bad of [
      { ...payload(), p: 'not a code' },
      { ...payload(), r: 99 },
      { ...payload(), i: [100, 0, 0, 0, 0] },
      { ...payload(), s: [99] },
      { ...payload(), dt: '2026-02-30' },
      { ...payload(), t: 'arrest' as never },
    ]) {
      expect(await verifyNoticeToken(await token(bad as NoticePayload), PUB), JSON.stringify(bad)).toEqual({ status: 'invalid', reason: 'payload' })
    }
  })

  it('renders only bank sentences and request numbers from a payload', () => {
    const r = renderPayload(payload())
    expect(r).toEqual(composeNotice(SPOT, SENTENCES as never))
    expect(decodePayload(encodePayload(payload()))).toEqual(payload())
  })

  it('keeps the QR payload short enough for a printable code', async () => {
    expect((await token(payload())).length).toBeLessThan(300)
  })
})
