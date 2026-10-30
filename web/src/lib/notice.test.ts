import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { verifyNoticeToken } from '../../../api/_lib/notice'
import { noticeFromHash } from './routes'

// A real notice signed with the production key; only the public key is in this repo.
const SAMPLE = readFileSync(new URL('../../e2e/sample-notice-token.txt', import.meta.url), 'utf8').trim()

describe('notice links', () => {
  it('parses verify and print hashes, and nothing else', () => {
    expect(noticeFromHash(`#/v/${SAMPLE}`)).toEqual({ view: 'verify', token: SAMPLE })
    expect(noticeFromHash(`#/print/${SAMPLE}`)).toEqual({ view: 'print', token: SAMPLE })
    expect(noticeFromHash('#/plan')).toBeNull()
    expect(noticeFromHash('#/v/')).toBeNull()
    expect(noticeFromHash('#/v/<script>')).toBeNull()
  })

  it('the shipped sample verifies against the published key and re-renders the notice', async () => {
    const r = await verifyNoticeToken(SAMPLE)
    expect(r.status).toBe('valid')
    if (r.status !== 'valid') return
    expect(r.payload.p).toBe('865QRCC9+32')
    expect(r.notice.en).toContain('Plus Code 865QRCC9+32')
    expect(r.notice.es).toContain('Plus Code 865QRCC9+32')
  })

  it('one changed character in the signed payload fails the signature', async () => {
    const [body, sig] = SAMPLE.split('.')
    const flipped = body.slice(0, 20) + (body[20] === 'A' ? 'B' : 'A') + body.slice(21)
    expect(await verifyNoticeToken(`${flipped}.${sig}`)).toEqual({ status: 'invalid', reason: 'signature' })
  })
})
