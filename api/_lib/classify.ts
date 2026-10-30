// POST /api/classify logic: what kind of dumped items are in one field photo. The browser blurs
// faces before upload. The image is passed straight to Gemini and is never logged or stored.
import { generateJson } from './gemini'
import { InputError, exactKeys, isPlainObject, json, methodNotAllowed, readEnv, readJsonBody } from './http'
import { createRateLimiter, staffGate, type GateDeps } from './staff'

export const CLASSIFY_MODEL = 'gemini-3.5-flash-lite'
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024
// Base64 of the largest image plus the data-URL prefix and the {"image":"..."} wrapper.
export const CLASSIFY_MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 256
export const CLASSIFY_LABELS = ['tires', 'furniture', 'appliances', 'bags', 'construction', 'other'] as const
export type ClassifyLabel = (typeof CLASSIFY_LABELS)[number]
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp'

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/

/** First bytes of a base64 payload, enough for a file signature check. */
function headBytes(base64: string, count: number): number[] {
  const chunk = base64.slice(0, Math.ceil(count / 3) * 4)
  const binary = atob(chunk)
  return Array.from(binary.slice(0, count), (ch) => ch.charCodeAt(0))
}

function signatureMatches(mime: ImageMime, b: number[]): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to))
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  if (mime === 'image/png') return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)
  return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
}

export function validateClassifyRequest(body: unknown): { mimeType: ImageMime; data: string } {
  if (!isPlainObject(body)) throw new InputError('body must be a JSON object')
  exactKeys(body, ['image'], 'body')
  const image = body.image
  if (typeof image !== 'string') throw new InputError('image must be a data URL string')
  if (image.length > CLASSIFY_MAX_BODY_BYTES) throw new InputError('image is larger than 1.5 MB')
  const match = DATA_URL.exec(image)
  if (!match) throw new InputError('image must be a base64 data URL of type image/jpeg, image/png or image/webp')
  const mimeType = match[1] as ImageMime
  const data = match[2]
  if (data.length % 4 !== 0) throw new InputError('image base64 is not padded correctly')

  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const decodedBytes = (data.length / 4) * 3 - padding
  if (decodedBytes > MAX_IMAGE_BYTES) throw new InputError('image is larger than 1.5 MB')
  if (decodedBytes < 12) throw new InputError('image is too small to be a photo')
  // Check the bytes, not just the label, so a mislabelled file never reaches the model.
  if (!signatureMatches(mimeType, headBytes(data, 12))) throw new InputError(`image bytes are not ${mimeType}`)
  return { mimeType, data }
}

export const CLASSIFY_SYSTEM = [
  'You look at one photo that city staff took at a possible illegal dumping spot in Mableton, Georgia. Faces in the photo were blurred before upload.',
  '',
  'Return:',
  '- items: which kinds of dumped items you can see. Use only these labels: tires, furniture, appliances, bags, construction, other. Use each label at most once. Use an empty list if you see none.',
  '- tire_count_estimate: about how many tires you can see. 0 if there are no tires. null if you cannot tell.',
  '- is_dumping_likely: true if this looks like illegally dumped material, false otherwise.',
  '- notes: at most 140 characters about the items and the scene only.',
  '',
  'Never describe people, faces, bodies or clothing. Never read out license plates, house numbers, street signs or any other text in the photo. If you are unsure, say so in notes.',
].join('\n')

export const CLASSIFY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: { type: 'ARRAY', items: { type: 'STRING', enum: [...CLASSIFY_LABELS] } },
    tire_count_estimate: { type: 'INTEGER', nullable: true },
    is_dumping_likely: { type: 'BOOLEAN' },
    notes: { type: 'STRING' },
  },
  required: ['items', 'tire_count_estimate', 'is_dumping_likely', 'notes'],
}

export const MAX_NOTES_CHARS = 140
const MAX_TIRES = 1000
// A last guard behind the prompt: notes that mention a person are dropped, not shown.
const PEOPLE_WORDS =
  /\b(person|persons|people|man|men|woman|women|boy|boys|girl|girls|child|children|kid|kids|guy|guys|lady|ladies|someone|somebody|driver|drivers|resident|residents|face|faces|he|she|him|her|his|hers)\b/i

export interface Classification {
  items: ClassifyLabel[]
  tire_count_estimate: number | null
  is_dumping_likely: boolean
  notes: string
}

export function parseClassification(value: unknown): Classification {
  if (!isPlainObject(value)) throw new Error('classification is not an object')
  if (!Array.isArray(value.items)) throw new Error('items is not an array')
  if (typeof value.is_dumping_likely !== 'boolean') throw new Error('is_dumping_likely is not a boolean')

  const items: ClassifyLabel[] = []
  for (const item of value.items) {
    if ((CLASSIFY_LABELS as readonly unknown[]).includes(item) && !items.includes(item as ClassifyLabel)) {
      items.push(item as ClassifyLabel)
    }
  }
  const tires = value.tire_count_estimate
  const tireCount = typeof tires === 'number' && Number.isInteger(tires) && tires >= 0 && tires <= MAX_TIRES ? tires : null

  let notes = typeof value.notes === 'string' ? value.notes.replace(/\s+/g, ' ').trim() : ''
  if (PEOPLE_WORDS.test(notes)) notes = ''
  notes = Array.from(notes).slice(0, MAX_NOTES_CHARS).join('')

  return { items, tire_count_estimate: tireCount, is_dumping_likely: value.is_dumping_likely, notes }
}

export interface Deps extends GateDeps {
  fetchImpl?: typeof fetch
}

const classifyLimiter = createRateLimiter()

// Order: 405, staff auth configured (503), rate limit (429), staff token (401), Gemini key (503),
// input (400), then Gemini.
export async function handleClassify(request: Request, deps: Deps = {}): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed()
  const denied = staffGate(request, deps.limiter ?? classifyLimiter, deps)
  if (denied) return denied
  const apiKey = (deps.env ?? readEnv)('GEMINI_API_KEY')
  if (!apiKey) return json(503, { error: 'gemini_not_configured' })

  let image: { mimeType: ImageMime; data: string }
  try {
    image = validateClassifyRequest(await readJsonBody(request, CLASSIFY_MAX_BODY_BYTES))
  } catch (err) {
    if (err instanceof InputError) return json(400, { error: err.message })
    throw err
  }

  const outcome = await generateJson({
    model: CLASSIFY_MODEL,
    apiKey,
    system: CLASSIFY_SYSTEM,
    parts: [{ inlineData: image }, { text: 'Classify the dumped items in this photo.' }],
    responseSchema: CLASSIFY_SCHEMA,
    thinkingLevel: 'minimal',
    maxOutputTokens: 1024,
    fetchImpl: deps.fetchImpl,
  })
  if (!outcome.ok) return outcome.response

  let result: Classification
  try {
    result = parseClassification(outcome.value)
  } catch {
    return json(502, { error: 'gemini_bad_output' })
  }
  return json(200, {
    ...result,
    model: CLASSIFY_MODEL,
    classified_at: (deps.now ?? (() => new Date()))().toISOString(),
  })
}
