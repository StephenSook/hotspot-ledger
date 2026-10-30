// Shared request/response helpers for the TypeScript functions.
// This folder starts with "_" so Vercel does not deploy it as a function of its own.

export class InputError extends Error {}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } })
}

export const methodNotAllowed = (): Response => json(405, { error: 'method_not_allowed' }, { Allow: 'POST' })

// Read an env var without depending on Node's type definitions (none are installed for api/).
export function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const value = env?.[name]
  return value && value.trim() ? value.trim() : undefined
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require exactly the given keys: no missing ones, no extra ones. */
export function exactKeys(obj: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) throw new InputError(`${where} is missing "${key}"`)
  }
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) throw new InputError(`${where} has unknown key "${key}"`)
  }
}

// Control characters (incl. newlines) and bidi overrides have no place in a 100-character label,
// and stripping them keeps the prompt's data block on one line.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/

export function safeText(value: unknown, where: string, maxLen = 100): string {
  if (typeof value !== 'string') throw new InputError(`${where} must be a string`)
  const text = value.trim()
  if (!text) throw new InputError(`${where} must not be empty`)
  if (text.length > maxLen) throw new InputError(`${where} must be at most ${maxLen} characters`)
  if (UNSAFE_TEXT.test(text)) throw new InputError(`${where} contains control characters`)
  return text
}

export function boundedInt(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InputError(`${where} must be an integer from ${min} to ${max}`)
  }
  return value
}

/**
 * Parse a JSON request body, refusing anything that is not application/json or is larger than
 * maxBytes. Requiring the JSON content type also means a cross-site page cannot send this request
 * without a CORS preflight, which these functions never approve.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') throw new InputError('Content-Type must be application/json')

  const declared = Number(request.headers.get('content-length') ?? 'NaN')
  if (Number.isFinite(declared) && declared > maxBytes) throw new InputError(`body larger than ${maxBytes} bytes`)
  if (!request.body) throw new InputError('body is empty')

  // Count bytes as they arrive: Content-Length can be absent or wrong.
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new InputError(`body larger than ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new InputError('body is not UTF-8')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new InputError('body is not valid JSON')
  }
}
