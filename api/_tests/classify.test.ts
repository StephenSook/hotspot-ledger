import { afterEach, describe, expect, it, vi } from 'vitest'
import classifyFunction from '../classify'
import {
  CLASSIFY_MODEL,
  MAX_IMAGE_BYTES,
  handleClassify,
  parseClassification,
  validateClassifyRequest,
} from '../_lib/classify'
import { createRateLimiter } from '../_lib/staff'

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes))
const pad = (head: number[], total = 32) => [...head, ...new Array(Math.max(0, total - head.length)).fill(0)]
const JPEG = b64(pad([0xff, 0xd8, 0xff, 0xe0]))
const PNG = b64(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const WEBP = b64(pad([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0)))))
const JPEG_URL = `data:image/jpeg;base64,${JPEG}`

const TOKEN = 'staff-token-for-tests-0123456789abcdef'

const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', 'x-staff-token': TOKEN }) =>
  new Request('https://hotspot.test/api/classify', { method: 'POST', headers, body: JSON.stringify(body) })

const geminiReply = (value: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(value) }] }, finishReason: 'STOP' }] }))

const ENV: Record<string, string> = { GEMINI_API_KEY: 'test-key-456', STAFF_TOKEN: TOKEN }
const withKey = (fetchImpl: typeof fetch) => ({
  env: (name: string) => ENV[name],
  fetchImpl,
  now: () => new Date('2026-10-30T15:00:00.000Z'),
  limiter: createRateLimiter(1000), // fresh per test so the module limiter never leaks a 429
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('validateClassifyRequest', () => {
  it('accepts jpeg, png and webp data URLs whose bytes match their type', () => {
    expect(validateClassifyRequest({ image: JPEG_URL })).toEqual({ mimeType: 'image/jpeg', data: JPEG })
    expect(validateClassifyRequest({ image: `data:image/png;base64,${PNG}` }).mimeType).toBe('image/png')
    expect(validateClassifyRequest({ image: `data:image/webp;base64,${WEBP}` }).mimeType).toBe('image/webp')
  })

  const bad: [string, unknown, string][] = [
    ['non-object body', 'data:image/jpeg;base64,AAAA', 'body must be a JSON object'],
    ['missing image', {}, 'missing "image"'],
    ['extra key', { image: JPEG_URL, lat: 33.8 }, 'unknown key "lat"'],
    ['image not a string', { image: 42 }, 'data URL string'],
    ['plain base64 without a data URL', { image: JPEG }, 'base64 data URL'],
    ['gif', { image: `data:image/gif;base64,${JPEG}` }, 'base64 data URL'],
    ['svg', { image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }, 'base64 data URL'],
    ['non-base64 characters', { image: 'data:image/jpeg;base64,/9j/4AAQ$$$$' }, 'base64 data URL'],
    ['bad padding', { image: `data:image/jpeg;base64,${JPEG.slice(0, -1)}` }, 'padded'],
    ['label does not match bytes', { image: `data:image/jpeg;base64,${PNG}` }, 'not image/jpeg'],
    ['webp label on png bytes', { image: `data:image/webp;base64,${PNG}` }, 'not image/webp'],
    ['too small', { image: 'data:image/jpeg;base64,/9j/' }, 'too small'],
  ]
  it.each(bad)('rejects %s', (_name, body, needle) => {
    expect(() => validateClassifyRequest(body)).toThrow(needle)
  })

  it('rejects an image over 1.5 MB decoded and accepts one just under', () => {
    const over = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 3) / 3) * 4)
    expect(() => validateClassifyRequest({ image: `data:image/jpeg;base64,/9j/${over}` })).toThrow('larger than 1.5 MB')
    const underBytes = Math.floor(MAX_IMAGE_BYTES / 3) * 3 // exactly 1.5 MB, no padding
    const under = '/9j/' + 'A'.repeat((underBytes / 3) * 4 - 4)
    expect(validateClassifyRequest({ image: `data:image/jpeg;base64,${under}` }).mimeType).toBe('image/jpeg')
  })
})

describe('parseClassification', () => {
  it('keeps only known labels, once each, in order', () => {
    const out = parseClassification({
      items: ['tires', 'mattress', 'tires', 'bags'],
      tire_count_estimate: 6,
      is_dumping_likely: true,
      notes: 'Six tires and two black bags beside the curb.',
    })
    expect(out).toEqual({ items: ['tires', 'bags'], tire_count_estimate: 6, is_dumping_likely: true, notes: 'Six tires and two black bags beside the curb.' })
  })
  it('turns an unusable tire count into null and caps notes at 140 characters', () => {
    const out = parseClassification({ items: [], tire_count_estimate: 2.5, is_dumping_likely: false, notes: 'x'.repeat(300) })
    expect(out.tire_count_estimate).toBeNull()
    expect(out.notes).toHaveLength(140)
    expect(parseClassification({ items: [], tire_count_estimate: -1, is_dumping_likely: false, notes: '' }).tire_count_estimate).toBeNull()
    expect(parseClassification({ items: [], tire_count_estimate: null, is_dumping_likely: false, notes: '' }).tire_count_estimate).toBeNull()
  })
  it('drops notes that describe a person', () => {
    expect(parseClassification({ items: ['furniture'], tire_count_estimate: 0, is_dumping_likely: true, notes: 'A man in a red shirt next to a couch' }).notes).toBe('')
    expect(parseClassification({ items: ['bags'], tire_count_estimate: 0, is_dumping_likely: true, notes: 'Someone left bags here' }).notes).toBe('')
    expect(parseClassification({ items: ['bags'], tire_count_estimate: 0, is_dumping_likely: true, notes: 'Other debris and bags' }).notes).toBe('Other debris and bags')
  })
  it.each([[null], [{ items: 'tires', is_dumping_likely: true }], [{ items: [], is_dumping_likely: 'yes' }]])('rejects %j', (value) => {
    expect(() => parseClassification(value)).toThrow()
  })
})

describe('handleClassify', () => {
  it('answers 405 for other methods', async () => {
    const res = await handleClassify(new Request('https://hotspot.test/api/classify', { method: 'PUT' }), withKey(vi.fn()))
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('answers 503 gemini_not_configured when the key is missing, including from the default export', async () => {
    const fetchImpl = vi.fn()
    const env = (name: string) => (name === 'STAFF_TOKEN' ? TOKEN : undefined)
    const res = await handleClassify(post({ image: JPEG_URL }), { env, fetchImpl, limiter: createRateLimiter() })
    expect([res.status, await res.json()]).toEqual([503, { error: 'gemini_not_configured' }])
    expect(fetchImpl).not.toHaveBeenCalled()

    vi.stubEnv('STAFF_TOKEN', TOKEN)
    vi.stubEnv('GEMINI_API_KEY', '')
    const viaDefault = await classifyFunction.fetch(post({ image: JPEG_URL }))
    expect([viaDefault.status, await viaDefault.json()]).toEqual([503, { error: 'gemini_not_configured' }])
  })

  it('answers 400 on bad input', async () => {
    const res = await handleClassify(post({ image: 'https://example.com/photo.jpg' }), withKey(vi.fn()))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('data URL')
  })

  it('sends the image inline to flash-lite and never logs it', async () => {
    const logs: string[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')))
    }
    const fetchImpl = vi.fn(async () =>
      geminiReply({ items: ['tires', 'other'], tire_count_estimate: 4, is_dumping_likely: true, notes: 'Four tires in tall grass.' }),
    )
    const res = await handleClassify(post({ image: JPEG_URL }), withKey(fetchImpl as unknown as typeof fetch))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      items: ['tires', 'other'],
      tire_count_estimate: 4,
      is_dumping_likely: true,
      notes: 'Four tires in tall grass.',
      model: CLASSIFY_MODEL,
      classified_at: '2026-10-30T15:00:00.000Z',
    })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key-456')
    const sent = JSON.parse(init.body as string)
    expect(sent.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: JPEG } })
    expect(sent.generationConfig.responseSchema.properties.items.items.enum).toEqual([
      'tires', 'furniture', 'appliances', 'bags', 'construction', 'other',
    ])
    expect(logs.some((line) => line.includes(JPEG))).toBe(false)
  })

  it('answers 502 with the upstream status and does not log the image on failure', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')))
    const fetchImpl = vi.fn(async () => new Response('quota', { status: 429 }))
    const res = await handleClassify(post({ image: JPEG_URL }), withKey(fetchImpl as unknown as typeof fetch))
    expect([res.status, await res.json()]).toEqual([502, { error: 'gemini_failed', status: 429 }])
    expect(logs.join('\n')).not.toContain(JPEG)
  })
})
