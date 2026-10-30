// POST /api/classify (Vercel Node.js runtime, Web-standard fetch handler). Logic: ./_lib/classify.ts
import { handleClassify } from './_lib/classify'
import { json } from './_lib/http'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleClassify(request)
    } catch {
      // Deliberately no error detail: the request body is a photo and must never reach the logs.
      console.error('classify: unexpected error')
      return json(500, { error: 'internal_error' })
    }
  },
}
