// One small client for Gemini's REST generateContent with structured (JSON) output.
// The key travels only in the x-goog-api-key header, never in the URL, and nothing here logs a
// request or response body.
import { isPlainObject, json } from './http'

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
export const GEMINI_TIMEOUT_MS = 20_000

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }

export interface GeminiRequest {
  model: string
  apiKey: string
  system: string
  parts: GeminiPart[]
  /** OpenAPI-subset schema, as accepted by generationConfig.responseSchema. */
  responseSchema: Record<string, unknown>
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
  maxOutputTokens?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export type GeminiOutcome = { ok: true; value: unknown } | { ok: false; response: Response }

const BLOCKED_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY'])

const fail = (status: number, body: Record<string, unknown>): GeminiOutcome => ({ ok: false, response: json(status, body) })

// AbortSignal.timeout rejects with a DOMException named TimeoutError (AbortError on some runtimes).
const isTimeout = (err: unknown): boolean => {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined
  return name === 'TimeoutError' || name === 'AbortError'
}

export function buildGeminiBody(req: GeminiRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseSchema: req.responseSchema,
    maxOutputTokens: req.maxOutputTokens ?? 2048,
  }
  // No temperature / topP / topK: Gemini 3.x ignores them and later models reject them.
  if (req.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: req.thinkingLevel }
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: req.parts }],
    generationConfig,
  }
}

/** Concatenated non-thought text of the first candidate, or a reason it has none. */
export function extractCandidateText(data: unknown): { text: string } | { error: 'gemini_blocked' | 'gemini_bad_output' } {
  if (!isPlainObject(data)) return { error: 'gemini_bad_output' }
  const feedback = data.promptFeedback
  if (isPlainObject(feedback) && typeof feedback.blockReason === 'string') return { error: 'gemini_blocked' }
  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : undefined
  if (!isPlainObject(candidate)) return { error: 'gemini_bad_output' }
  if (typeof candidate.finishReason === 'string' && BLOCKED_FINISH.has(candidate.finishReason)) {
    return { error: 'gemini_blocked' }
  }
  const content = candidate.content
  const parts = isPlainObject(content) && Array.isArray(content.parts) ? content.parts : []
  const text = parts
    .filter((p): p is { text: string } => isPlainObject(p) && typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text)
    .join('')
  return text.trim() ? { text } : { error: 'gemini_bad_output' }
}

export async function generateJson(req: GeminiRequest): Promise<GeminiOutcome> {
  const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(req.model)}:generateContent`
  const doFetch = req.fetchImpl ?? fetch
  let res: Response
  let data: unknown
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': req.apiKey },
      body: JSON.stringify(buildGeminiBody(req)),
      // Covers the whole exchange, including reading the response body.
      signal: AbortSignal.timeout(req.timeoutMs ?? GEMINI_TIMEOUT_MS),
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      console.error(`gemini ${req.model}: upstream HTTP ${res.status}`)
      return fail(502, { error: 'gemini_failed', status: res.status })
    }
    data = await res.json()
  } catch (err) {
    if (isTimeout(err)) return fail(504, { error: 'gemini_timeout' })
    if (err instanceof SyntaxError) return fail(502, { error: 'gemini_bad_output' })
    console.error(`gemini ${req.model}: network error`)
    return fail(502, { error: 'gemini_failed', status: 0 })
  }

  const extracted = extractCandidateText(data)
  if ('error' in extracted) return fail(502, { error: extracted.error })
  try {
    return { ok: true, value: JSON.parse(extracted.text) }
  } catch {
    return fail(502, { error: 'gemini_bad_output' })
  }
}
